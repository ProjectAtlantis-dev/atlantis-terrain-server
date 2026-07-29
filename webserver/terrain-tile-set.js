import * as THREE from 'three';
import { findCoveredTileAncestors } from './tile-coverage.js';
import {
  parseTerrainTileId,
  terrainTileDepth,
} from './terrain-tile-address.js';
import {
  createTerrainMeshBuilder,
  updateTerrainMeshHeightmap,
} from './terrain-mesh-builder.js';
import { priorityHeading, terrainTilePriority } from './terrain-priority.js';
import {
  diffTerrainTileIds,
  prioritizeTerrainBuildCandidates,
} from './terrain-tile-fetch.js';
import {
  scoreTextureTiles,
  tileDepthFromId,
  terrainVisibilityDistance,
} from './terrain-tile-runtime.js';
import { createTerrainDetailRuntime } from './terrain-detail-runtime.js';

function desiredDescendantIds(parentTileId, desiredTileIds) {
  const parent = parseTerrainTileId(parentTileId);
  if (!parent || desiredTileIds.size === 0) return [];
  const descendants = [];
  for (const id of desiredTileIds) {
    const address = parseTerrainTileId(id);
    if (!address || address.depth <= parent.depth) continue;
    const divisor = 2 ** (address.depth - parent.depth);
    if (
      Math.floor(address.col / divisor) !== parent.col
      || Math.floor(address.row / divisor) !== parent.row
    ) continue;
    descendants.push(id);
  }
  return descendants;
}

function hasTerrainCoverage(mesh) {
  return Boolean(mesh?.material?.map);
}

function addTerrainMesh(terrainRoot, mesh) {
  terrainRoot.add(mesh);
}

function disposeTileScatter(tileMesh) {
  for (const child of tileMesh.children) {
    if (!child.userData?.isScatter) continue;
    for (const mesh of child.children) {
      if (mesh.isInstancedMesh) mesh.dispose();
    }
  }
}

export function createTileLifecycle({
  terrainRoot,
  disposeScatter,
  log,
  onSceneMutated = () => {},
  onReleaseTile = () => {},
}) {
  function evict(mesh, reason = 'unspecified lifecycle eviction') {
    if (!mesh) return;
    const tileId = mesh.userData?.tileId || '?';
    log(tileId, `evicted — ${reason}`);
    terrainRoot.remove(mesh);
    disposeScatter(mesh);
    mesh.userData?.terrainPlaceholderTexture?.dispose?.();
    if (mesh.userData) delete mesh.userData.terrainPlaceholderTexture;
    mesh.geometry?.dispose();
    if (Array.isArray(mesh.material)) {
      for (const material of mesh.material) material?.dispose?.();
    } else {
      mesh.material?.dispose?.();
    }
    onSceneMutated();
    return true;
  }

  function evictCoveredAncestors(childTileId) {
    const resident = new Map();
    for (const mesh of terrainRoot.children) {
      if (!mesh.isMesh || !mesh.userData.tileId) continue;
      resident.set(mesh.userData.tileId, hasTerrainCoverage(mesh));
    }
    const evictable = new Set(findCoveredTileAncestors(childTileId, resident));
    for (const ancestorId of evictable) {
      const mesh = terrainRoot.children.find(
        child => child.isMesh && child.userData.tileId === ancestorId,
      );
      if (!mesh) continue;
      evict(mesh, `complete four-quadrant child coverage (triggered by ${childTileId})`);
      onReleaseTile(ancestorId);
      resident.delete(ancestorId);
    }
  }

  function replaceForMaterialized(mesh, currentTileIds) {
    const tileId = mesh.userData.tileId;
    const bbox = mesh.userData.bbox;
    for (const existing of [...terrainRoot.children]) {
      if (!existing.isMesh) continue;
      const existingId = existing.userData.tileId;
      let reason = null;
      if (existingId === tileId) {
        reason = 'replaced by textured self';
      } else if (bbox && !currentTileIds.has(existingId)) {
        const existingBox = existing.userData.bbox;
        if (existingBox && bbox[0] <= existingBox[0] && bbox[2] >= existingBox[2]
            && bbox[1] <= existingBox[1] && bbox[3] >= existingBox[3]) {
          reason = `contained by ${tileId}`;
        }
      }
      if (!reason) continue;
      evict(existing, reason);
    }
    addTerrainMesh(terrainRoot, mesh);
    onSceneMutated();
  }

  return { evict, evictCoveredAncestors, replaceForMaterialized };
}

function applyDepthOffset(mesh, depth, enabled = true) {
  if (!mesh?.material) return;
  if (!enabled) {
    mesh.material.polygonOffset = false;
    mesh.material.polygonOffsetFactor = 0;
    mesh.material.polygonOffsetUnits = 0;
    return;
  }
  if (!Number.isFinite(depth)) return;
  mesh.material.polygonOffset = true;
  mesh.material.polygonOffsetFactor = -depth;
  mesh.material.polygonOffsetUnits = -depth;
}

export function createTerrainMeshRuntime({
  terrainRoot,
  deferredTiles,
  buildMesh,
  applyMaterial,
  lifecycle,
  log,
  getCurrentTileIds,
  tileDepth,
  onMeshAdded = () => {},
  vehicleNearTile = () => false,
  getVehicleDepth = () => -1,
  requestVehicleResnap = () => {},
  depthOffsetEnabled = true,
}) {
  function materialize(tileId, texture) {
    const tile = deferredTiles.get(tileId);
    if (!tile) return null;
    deferredTiles.delete(tileId);
    log(tileId, `materialize tex=${texture.image.width}x${texture.image.height}`);
    const mesh = buildMesh(tile, texture);
    if (!mesh) return null;
    applyMaterial(mesh, texture);
    const depth = tileDepth(tileId);
    applyDepthOffset(mesh, depth, depthOffsetEnabled);
    lifecycle.replaceForMaterialized(mesh, getCurrentTileIds());
    if (vehicleNearTile(mesh.userData?.bbox)) {
      const previousDepth = getVehicleDepth();
      const reason = Number.isFinite(depth) && depth > previousDepth
        ? `terrain-refined-${previousDepth}->${depth}`
        : 'terrain-materialized-near-vehicle';
      requestVehicleResnap(reason);
    }
    return mesh;
  }

  return { materialize };
}

export function createTerrainTextureController({
  terrainRoot,
  deferredTiles,
  textureStreamer,
  meshRuntime,
  lifecycle,
  priorityForTile,
  getVisibilityDistance,
  applyMaterial,
  log,
  onMaterialApplied = () => {},
  scheduleFrame = callback => requestAnimationFrame(callback),
  applicationsPerFrame = 4,
}) {
  const findMesh = tileId => terrainRoot.children.find(child => child.userData.tileId === tileId);
  const pendingApplications = new Map();
  let applicationFramePending = false;
  let desiredTileIds = new Set();

  function applyTexture(mesh, tile, texture) {
    const placeholderTexture = mesh.userData?.terrainPlaceholderTexture;
    const previousTexture = mesh.material?.map;
    if (mesh.userData) delete mesh.userData.terrainPlaceholderTexture;
    applyMaterial(mesh, texture);
    if (placeholderTexture && placeholderTexture !== texture) placeholderTexture.dispose?.();
    if (previousTexture && previousTexture !== texture && previousTexture !== placeholderTexture) {
      textureStreamer.releaseStaleTexture?.(previousTexture);
    }
    onMaterialApplied(mesh);
    return mesh;
  }

  function applyPlaceholder(tile, texture) {
    if (!desiredTileIds.has(tile.id)) {
      texture.dispose?.();
      return;
    }
    const existing = findMesh(tile.id);
    if (
      deferredTiles.has(tile.id)
      && existing?.material?.map
      && !existing.userData?.terrainPlaceholderTexture
    ) {
      // A retained same-ID mesh already has exact imagery. This happens when
      // movement re-adds a tile that survived as descendant fallback. Keep
      // that good mesh until the exact replacement geometry/texture arrives;
      // materializing an ancestor crop here causes the visible coarse flash.
      log(tile.id, 'placeholder ignored — textured self retained');
      texture.dispose?.();
      return;
    }
    let mesh;
    if (deferredTiles.has(tile.id)) {
      mesh = meshRuntime.materialize(tile.id, texture);
    } else {
      mesh = existing;
      if (mesh) {
        const previousPlaceholder = mesh.userData?.terrainPlaceholderTexture;
        applyMaterial(mesh, texture);
        if (previousPlaceholder && previousPlaceholder !== texture) previousPlaceholder.dispose?.();
      }
    }
    if (!mesh) {
      texture.dispose?.();
      return;
    }
    mesh.userData.terrainPlaceholderTexture = texture;
    onMaterialApplied(mesh);
    lifecycle.evictCoveredAncestors(tile.id);
  }

  function drainApplications() {
    applicationFramePending = false;
    let remaining = applicationsPerFrame;
    for (const [tileId, pending] of pendingApplications) {
      if (remaining-- <= 0) break;
      pendingApplications.delete(tileId);
      const { tile, texture, logArrival } = pending;
      if (!desiredTileIds.has(tileId)) {
        if (textureStreamer.texCache.get(tileId) === texture) textureStreamer.texCache.delete(tileId);
        textureStreamer.texSource.delete(tileId);
        texture.dispose?.();
        continue;
      }
      if (deferredTiles.has(tileId)) {
        if (logArrival) log(tileId, 'cached + materialize (was deferred)');
        meshRuntime.materialize(tileId, texture);
      } else {
        const mesh = findMesh(tileId);
        if (mesh) {
          if (logArrival) log(tileId, 'cached + applied to existing mesh');
          applyTexture(mesh, tile, texture);
        } else if (logArrival) {
          log(tileId, 'cached but NO mesh in scene');
        }
      }
      lifecycle.evictCoveredAncestors(tileId);
    }
    if (pendingApplications.size > 0) scheduleApplicationFrame();
  }

  function scheduleApplicationFrame() {
    if (applicationFramePending) return;
    applicationFramePending = true;
    scheduleFrame(drainApplications);
  }

  function enqueueApplication(tile, texture, logArrival = false) {
    if (!desiredTileIds.has(tile.id)) {
      if (textureStreamer.texCache.get(tile.id) === texture) textureStreamer.texCache.delete(tile.id);
      textureStreamer.texSource.delete(tile.id);
      texture.dispose?.();
      return;
    }
    pendingApplications.set(tile.id, { tile, texture, logArrival });
    scheduleApplicationFrame();
  }

  function updateTerrainTextures(tiles) {
    const meshById = new Map();
    for (const child of terrainRoot.children) {
      if (child.userData.tileId) meshById.set(child.userData.tileId, child);
    }
    const { scored } = scoreTextureTiles(
      tiles, priorityForTile, Math.log(getVisibilityDistance()),
    );
    desiredTileIds = new Set(scored.map(item => item.tile.id));

    for (const id of [...deferredTiles.keys()]) {
      const texture = textureStreamer.texCache.get(id);
      if (!texture || pendingApplications.has(id)) continue;
      const tile = deferredTiles.get(id);
      if (tile) enqueueApplication(tile, texture);
    }

    for (const tile of tiles) {
      if (!tile.id) continue;
      const texture = textureStreamer.texCache.get(tile.id);
      if (!texture) continue;
      if (deferredTiles.has(tile.id) || pendingApplications.has(tile.id)) continue;
      const mesh = meshById.get(tile.id);
      if (!mesh) continue;
      // In classifier mode material.map is the overlay, not the cached
      // satellite texture. Compare against the remembered base texture so
      // the maintenance pass does not tear down and rebuild the graft node
      // every second for an unchanged tile.
      const appliedBaseTexture = mesh.userData?.terrainBaseTexture
        ?? mesh.material.map;
      const textureChanged = appliedBaseTexture !== texture;
      if (!textureChanged) continue;
      log(tile.id, `apply cached tex (src=${textureStreamer.texSource.get(tile.id) || '?'})`);
      meshById.set(tile.id, applyTexture(mesh, tile, texture));
      lifecycle.evictCoveredAncestors(tile.id);
    }

    textureStreamer.pump(scored, {
      isCovered: () => false,
      onPlaceholder: ({ tile, texture }) => applyPlaceholder(tile, texture),
      onTexture: ({ tile, texture }) => enqueueApplication(tile, texture, true),
    });
  }

  updateTerrainTextures.reset = () => {
    desiredTileIds.clear();
    for (const { texture } of pendingApplications.values()) texture.dispose?.();
    pendingApplications.clear();
    applicationFramePending = false;
  };
  return updateTerrainTextures;
}

const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

function applyTileDepthOffset(mesh, tileId, enabled = true) {
  applyDepthOffset(mesh, terrainTileDepth(tileId), enabled);
}

export function reconcileTerrainTiles({
  tiles,
  currentTileIds,
  deferredTiles,
  terrainRoot,
  lifecycle,
  priorityForTile,
  textureCache,
  materialize,
  buildMesh,
  log,
  buildBudget = 200,
  prepareUntexturedMesh = () => {},
  onMeshAdded = () => {},
  onDiff = () => {},
  depthOffsetEnabled = true,
  completeCoverage = false,
  onReleaseTile = () => {},
  refreshMesh = updateTerrainMeshHeightmap,
}) {
  const tileById = new Map(tiles.map(tile => [tile.id, tile]));
  const refreshedIds = new Set();
  const refreshedInPlaceIds = new Set();

  // A tile ID alone does not identify its rendered geometry. The server
  // repairs edges against the neighbors in each response, so an unchanged ID
  // may carry a new heightmap after a nearby LOD transition. Update ordinary
  // resident grids in place: rebuilding them used to send unchanged topology
  // through defer -> ancestor placeholder -> exact texture on every response.
  for (const mesh of [...terrainRoot.children]) {
    const tileId = mesh.userData?.tileId;
    const nextTile = tileById.get(tileId);
    const previousPayload = mesh.userData?.heightmapPayload;
    if (
      !mesh.isMesh
      || !nextTile?.heightmap
      || typeof previousPayload !== 'string'
      || previousPayload === nextTile.heightmap
    ) continue;
    if (refreshMesh(mesh, nextTile)) {
      log(tileId, 'refreshed in place — repaired heightmap changed');
      refreshedInPlaceIds.add(tileId);
      onMeshAdded(mesh);
      continue;
    }
    log(tileId, 'refresh queued — repaired heightmap changed');
    refreshedIds.add(tileId);
  }

  // Deferred tiles have no resident mesh to inspect, but must still use the
  // newest repaired payload when their texture eventually arrives.
  for (const [tileId, deferredTile] of deferredTiles) {
    const nextTile = tileById.get(tileId);
    if (!nextTile) continue;
    if (deferredTile.heightmap !== nextTile.heightmap) {
      deferredTiles.set(tileId, nextTile);
    }
  }

  const diffBaseIds = refreshedIds.size === 0
    ? currentTileIds
    : new Set([...currentTileIds].filter(id => !refreshedIds.has(id)));
  const { nextTileIds, added, removed } = diffTerrainTileIds(tiles, diffBaseIds);
  let purged = 0;
  for (const id of deferredTiles.keys()) {
    if (!nextTileIds.has(id)) {
      deferredTiles.delete(id);
      purged += 1;
    }
  }

  // Keep a coarse tile whenever the new demand contains descendants inside
  // it. At a circular-demand boundary, that parent remains the fallback for
  // omitted quadrants until resident descendants cover its entire footprint.
  let released = 0;
  const retainedFallbackIds = new Set(
    removed.filter(id => desiredDescendantIds(id, nextTileIds).length > 0),
  );
  const removedIds = new Set(removed);
  for (const tileId of removedIds) {
    if (!retainedFallbackIds.has(tileId)) onReleaseTile(tileId);
  }
  for (const mesh of [...terrainRoot.children]) {
    const tileId = mesh.userData?.tileId;
    if (!mesh.isMesh || !removedIds.has(tileId)) continue;
    if (retainedFallbackIds.has(tileId)) continue;
    lifecycle.evict(mesh, 'outside current terrain demand');
    released += 1;
  }

  for (const mesh of terrainRoot.children) {
    const tileId = mesh.userData?.tileId;
    if (!mesh.isMesh || !tileId) continue;
    if (
      nextTileIds.has(tileId)
      && mesh.material?.map
      && mesh.material.polygonOffset !== depthOffsetEnabled
    ) {
      applyTileDepthOffset(mesh, tileId, depthOffsetEnabled);
      mesh.material.needsUpdate = true;
    }
  }
  onDiff({
    added: added.length,
    removed: removed.length,
    purgedDeferred: purged,
    released,
    refreshedInPlace: refreshedInPlaceIds.size,
    refreshRebuilds: refreshedIds.size,
    sceneMeshes: terrainRoot.children.filter(mesh => mesh.isMesh).length,
  });

  if (added.length > 0) {
    const existingIds = new Set(
      terrainRoot.children.map(mesh => mesh.userData?.tileId).filter(Boolean),
    );
    const candidates = prioritizeTerrainBuildCandidates(tiles, new Set(added), priorityForTile);
    let built = 0;
    for (const { tile } of candidates) {
      if (existingIds.has(tile.id) && !refreshedIds.has(tile.id)) continue;
      const cachedTexture = textureCache.get(tile.id);
      if (cachedTexture) {
        deferredTiles.set(tile.id, tile);
        if (completeCoverage || built < buildBudget) {
          log(tile.id, 'added — immediate build (cached tex)');
          materialize(tile.id, cachedTexture);
          built += 1;
        } else {
          log(tile.id, `added — deferred (build budget exceeded, built=${built}/${buildBudget})`);
        }
        continue;
      }

      deferredTiles.set(tile.id, tile);
      const existingRefreshMesh = refreshedIds.has(tile.id)
        ? terrainRoot.children.find(mesh => mesh.isMesh && mesh.userData?.tileId === tile.id)
        : null;
      if (existingRefreshMesh) {
        if (existingRefreshMesh.material?.map) {
          log(tile.id, 'refresh deferred — textured geometry remains until atomic replacement');
        } else if (completeCoverage || built < buildBudget) {
          const mesh = buildMesh(tile);
          if (mesh) {
            applyTileDepthOffset(mesh, tile.id, depthOffsetEnabled);
            prepareUntexturedMesh(mesh);
            addTerrainMesh(terrainRoot, mesh);
            onMeshAdded(mesh);
            lifecycle.evict(existingRefreshMesh, 'atomically replaced by repaired geometry');
          }
          built += 1;
        } else {
          log(tile.id, `refresh deferred — build budget exceeded, built=${built}/${buildBudget}`);
        }
        continue;
      }
      const hasStaleCoverage = terrainRoot.children.some(mesh => (
        mesh.isMesh && mesh.material?.map && mesh.userData?.bbox && overlaps(mesh.userData.bbox, tile.bbox)
      ));
      if (hasStaleCoverage) {
        log(tile.id, 'added — deferred (stale coverage exists)');
      } else if (completeCoverage || built < buildBudget) {
        log(tile.id, 'added — untextured fallback (no stale coverage)');
        const mesh = buildMesh(tile);
        if (mesh) {
          applyTileDepthOffset(mesh, tile.id, depthOffsetEnabled);
          prepareUntexturedMesh(mesh);
          addTerrainMesh(terrainRoot, mesh);
          onMeshAdded(mesh);
        }
        built += 1;
      }
    }
  }

  return {
    nextTileIds,
    added,
    removed,
    purged,
    released,
    refreshedInPlace: refreshedInPlaceIds.size,
    refreshRebuilds: refreshedIds.size,
    sceneMeshes: terrainRoot.children.filter(mesh => mesh.isMesh).length,
    deferred: deferredTiles.size,
  };
}

/** Owns every decision about how requested terrain tiles exist in the scene. */
export function createTerrainTileSet({
  terrainRoot,
  textureStreamer,
  terrain,
  renderBackend,
  view,
  log,
  vehicle = {},
  events = {},
  testOverrides = {},
}) {
  const {
    onMutated = () => {},
    onMaterialApplied = () => {},
  } = events;
  const buildMesh = testOverrides.buildMesh ?? createTerrainMeshBuilder({
    exaggeration: terrain.exaggeration,
    attachScatter: terrain.attachScatter,
  });
  const priorityForTile = testOverrides.priorityForTile ?? (tile => {
    const relative = view.camera.position.clone().sub(view.anchorPosition);
    return terrainTilePriority(tile, {
      cameraX: relative.dot(view.east),
      cameraY: relative.dot(view.north),
      heading: view.getHeading?.() ?? priorityHeading(
        vehicle.vehicleControlActive,
        vehicle.vehicleHeadingRad,
        view.controls.yaw,
      ),
      pitch: view.controls.pitch,
      usePitch: !vehicle.vehicleControlActive,
      fovDeg: view.camera.fov,
      aspect: view.camera.aspect,
    });
  });
  const getVisibilityDistance = testOverrides.getVisibilityDistance ?? (() => {
    const altitude = view.camera.position.clone().sub(view.anchorPosition).dot(view.up);
    return terrainVisibilityDistance(altitude);
  });
  const buildBudget = testOverrides.buildBudget ?? 200;
  // WebGPU turns these values into native depth bias. At cross-LOD edges that
  // can pull depth-12 and depth-11 terrain apart, so keep this WebGL-only while
  // diagnosing the visible WebGPU seams.
  const depthOffsetEnabled = renderBackend.kind !== 'webgpu';
  const deferredTiles = new Map();
  let currentTileIds = new Set();
  let lastTiles = null;
  const releaseTileDemand = tileId => {
    if (typeof textureStreamer.releaseTileDemand === 'function') {
      return textureStreamer.releaseTileDemand(tileId);
    }
    return textureStreamer.releaseTile?.(tileId);
  };

  function selectVertexColors(mesh, attribute) {
    if (!mesh?.geometry || !attribute) return false;
    if (mesh.geometry.getAttribute?.('color') === attribute) return false;
    mesh.geometry.setAttribute?.('color', attribute);
    return true;
  }

  function applyMaterial(mesh, texture) {
    if (!mesh?.material) return;
    mesh.userData.terrainBaseTexture = texture ?? null;
    let needsUpdate = false;
    // Debug overlay hook: when the classifier resolver is installed, its
    // texture replaces the satellite map. The base texture is remembered
    // above, so dropping the overlay restores it.
    const overlayTexture = texture && textureOverlayResolver
      ? textureOverlayResolver(mesh.userData.tileId) ?? null
      : null;
    const resolvedTexture = overlayTexture ?? texture;
    if (mesh.material.map !== resolvedTexture) {
      mesh.material.map = resolvedTexture;
      needsUpdate = true;
    }
    if (!resolvedTexture) {
      if (mesh.material.userData?.terrainDetail) {
        // A detail colorNode captures its texture objects; without a live
        // satellite map it must not keep sampling a stale one.
        mesh.material.colorNode = null;
        mesh.material.userData.terrainDetailMap = null;
        mesh.material.userData.terrainDetailMask = null;
        needsUpdate = true;
      }
      needsUpdate = selectVertexColors(mesh, mesh.userData?.terrainColorAttribute) || needsUpdate;
      if (needsUpdate) mesh.material.needsUpdate = true;
      renderBackend.prepareUntexturedTerrain(mesh);
      return;
    }
    if (mesh.material.vertexColors) {
      mesh.material.vertexColors = false;
      needsUpdate = true;
    }
    mesh.material.color.set(0xffffff);
    if (overlayTexture && mesh.material.userData?.terrainDetail) {
      // The WebGPU detail colorNode captured the satellite texture when it
      // was patched — it would keep rendering that instead of the overlay.
      mesh.material.colorNode = null;
      mesh.material.userData.terrainDetailMap = null;
      mesh.material.userData.terrainDetailMask = null;
      needsUpdate = true;
    }
    if (needsUpdate) {
      mesh.material.needsUpdate = true;
      onMutated();
    }
    // Classifier view deliberately keeps cliff grafts visible as a coverage
    // diagnostic, but suppresses ordinary grain modulation so decision colors
    // remain legible. Tint still comes from the real base imagery rather than
    // from the classifier palette.
    terrainDetail.apply(mesh, {
      graftOnly: Boolean(overlayTexture),
      tintMap: texture,
    });
  }

  let textureOverlayResolver = null;

  /** Re-run material application on every live tile with its remembered
   *  base texture — how overlay changes propagate without a re-fetch. */
  function refreshTextureOverlay() {
    for (const child of terrainRoot.children) {
      if (!child.userData?.tileId || !child.material) continue;
      applyMaterial(child, child.userData.terrainBaseTexture ?? null);
    }
    onMutated();
  }

  function setTextureOverlay(resolver) {
    textureOverlayResolver = resolver;
    refreshTextureOverlay();
  }

  function prepareUntexturedMesh(mesh) {
    renderBackend.prepareUntexturedTerrain(mesh);
  }
  const terrainDetail = testOverrides.terrainDetail ?? createTerrainDetailRuntime({
    backendKind: renderBackend.kind,
    requestRender: () => {
      onMutated();
      renderBackend.requestRender?.();
    },
    log: (tileId, message) => log(tileId, message),
  });
  const lifecycle = createTileLifecycle({
    terrainRoot,
    disposeScatter: disposeTileScatter,
    log,
    onSceneMutated: onMutated,
    onReleaseTile: releaseTileDemand,
  });
  const meshRuntime = createTerrainMeshRuntime({
    terrainRoot,
    deferredTiles,
    buildMesh,
    applyMaterial,
    lifecycle,
    log,
    getCurrentTileIds: () => currentTileIds,
    tileDepth: tileDepthFromId,
    onMeshAdded: onMutated,
    vehicleNearTile: vehicle.vehicleNearTileBbox,
    getVehicleDepth: () => vehicle.vehicleLastContactDepth,
    requestVehicleResnap: vehicle.requestVehicleTerrainResnap,
    depthOffsetEnabled,
  });
  const updateTextureDemand = createTerrainTextureController({
    terrainRoot,
    deferredTiles,
    textureStreamer,
    meshRuntime,
    lifecycle,
    priorityForTile,
    getVisibilityDistance,
    applyMaterial,
    log,
    onMaterialApplied,
    ...(testOverrides.scheduleFrame == null ? {} : { scheduleFrame: testOverrides.scheduleFrame }),
    ...(testOverrides.applicationsPerFrame == null
      ? {}
      : { applicationsPerFrame: testOverrides.applicationsPerFrame }),
  });
  function reconcile(tiles, {
    onDiff = () => {},
    completeCoverage = false,
  } = {}) {
    const result = reconcileTerrainTiles({
      tiles,
      currentTileIds,
      deferredTiles,
      terrainRoot,
      lifecycle,
      priorityForTile,
      textureCache: textureStreamer.texCache,
      materialize: meshRuntime.materialize,
      buildMesh,
      log,
      buildBudget,
      prepareUntexturedMesh,
      onMeshAdded: onMutated,
      onDiff,
      depthOffsetEnabled,
      completeCoverage,
      onReleaseTile: releaseTileDemand,
    });
    currentTileIds = result.nextTileIds;
    lastTiles = tiles;
    return result;
  }

  function updateTextures(tiles) {
    lastTiles = tiles;
    updateTextureDemand(tiles);
  }

  function refreshTextures() {
    if (lastTiles) updateTextureDemand(lastTiles);
  }

  return {
    get currentTileIds() { return currentTileIds; },
    deferredTiles,
    reconcile,
    updateTextures,
    refreshTextures,
    resetTextureApplications: updateTextureDemand.reset,
    setTextureOverlay,
    refreshTextureOverlay,
  };
}
