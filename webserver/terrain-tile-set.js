import * as THREE from 'three';
import { findCoveredTileAncestors } from './tile-coverage.js';
import { createTerrainMeshBuilder } from './terrain-mesh-builder.js';
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
import { paintClassifierGridBorder } from './terrain-classifier-texture.js';

function parseTileId(tileId) {
  const match = /^(\d+)-(\d+)-(\d+)$/.exec(tileId || '');
  return match ? { depth: Number(match[1]), col: Number(match[2]), row: Number(match[3]) } : null;
}

function desiredDescendantIds(parentTileId, desiredTileIds) {
  const parent = parseTileId(parentTileId);
  if (!parent || desiredTileIds.size === 0) return [];
  const descendants = [];
  for (const id of desiredTileIds) {
    const address = parseTileId(id);
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

function disposeTileScatter(tileMesh) {
  for (const child of tileMesh.children) {
    if (!child.userData?.isScatter) continue;
    for (const mesh of child.children) {
      if (mesh.isInstancedMesh) mesh.dispose();
    }
  }
}

export function createDesaturatedTerrainTexture(texture, documentImpl = globalThis.document) {
  const image = texture?.image;
  const width = Number(image?.naturalWidth ?? image?.videoWidth ?? image?.width);
  const height = Number(image?.naturalHeight ?? image?.videoHeight ?? image?.height);
  if (!documentImpl?.createElement || !image || width <= 0 || height <= 0) return null;
  const canvas = documentImpl.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height);
  for (let index = 0; index < pixels.data.length; index += 4) {
    const gray = Math.round(
      pixels.data[index] * 0.299
      + pixels.data[index + 1] * 0.587
      + pixels.data[index + 2] * 0.114,
    );
    pixels.data[index] = gray;
    pixels.data[index + 1] = gray;
    pixels.data[index + 2] = gray;
  }
  context.putImageData(pixels, 0, 0);
  paintClassifierGridBorder(context, width, height);
  const desaturated = new THREE.CanvasTexture(canvas);
  desaturated.flipY = texture.flipY;
  desaturated.colorSpace = texture.colorSpace;
  desaturated.generateMipmaps = texture.generateMipmaps;
  desaturated.minFilter = texture.minFilter;
  desaturated.magFilter = texture.magFilter;
  desaturated.anisotropy = texture.anisotropy;
  desaturated.needsUpdate = true;
  return desaturated;
}

export function createTileLifecycle({
  terrainRoot,
  disposeScatter,
  log,
  onSceneMutated = () => {},
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

  function evictCoveredAncestors(childTileId, desiredTileIds = null) {
    const resident = new Map();
    for (const mesh of terrainRoot.children) {
      if (!mesh.isMesh || !mesh.userData.tileId) continue;
      resident.set(mesh.userData.tileId, Boolean(mesh.material?.map));
    }
    const evictable = new Set(findCoveredTileAncestors(childTileId, resident));
    const child = parseTileId(childTileId);
    if (child && desiredTileIds instanceof Set) {
      for (let depth = child.depth - 1; depth >= 0; depth--) {
        const divisor = 2 ** (child.depth - depth);
        const ancestorId = `${depth}-${Math.floor(child.col / divisor)}-${Math.floor(child.row / divisor)}`;
        if (!resident.has(ancestorId) || desiredTileIds.has(ancestorId)) continue;
        const demanded = desiredDescendantIds(ancestorId, desiredTileIds);
        if (demanded.length > 0 && demanded.every(id => resident.get(id) === true)) {
          evictable.add(ancestorId);
        }
      }
    }
    for (const ancestorId of evictable) {
      const mesh = terrainRoot.children.find(
        child => child.isMesh && child.userData.tileId === ancestorId,
      );
      if (!mesh) continue;
      const reason = desiredTileIds instanceof Set
        ? `demanded descendants textured (triggered by ${childTileId})`
        : `complete descendant coverage (triggered by ${childTileId})`;
      evict(mesh, reason);
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
    terrainRoot.add(mesh);
    onSceneMutated();
  }

  function sweepStaleParents(tiles, currentTileIds) {
    const meshById = new Map();
    for (const mesh of terrainRoot.children) {
      if (!mesh.isMesh || !mesh.userData.tileId) continue;
      const id = mesh.userData.tileId;
      meshById.set(id, mesh);
    }

    const staleIds = new Set();
    for (const [parentId] of meshById) {
      if (currentTileIds.has(parentId)) continue;
      const demanded = desiredDescendantIds(parentId, currentTileIds);
      if (
        demanded.length > 0
        && demanded.every(id => Boolean(meshById.get(id)?.material?.map))
      ) {
        staleIds.add(parentId);
      }
    }
    for (const parentId of staleIds) {
      const parent = meshById.get(parentId);
      if (!parent) continue;
      const reason = parent.material?.map
        ? 'stale parent (children now textured)'
        : 'stale noTex parent (children now textured)';
      evict(parent, reason);
    }
    return staleIds.size;
  }

  return { evict, evictCoveredAncestors, replaceForMaterialized, sweepStaleParents };
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
    let mesh;
    if (deferredTiles.has(tile.id)) {
      mesh = meshRuntime.materialize(tile.id, texture);
    } else {
      mesh = findMesh(tile.id);
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
    lifecycle.evictCoveredAncestors(tile.id, desiredTileIds);
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
      lifecycle.evictCoveredAncestors(tileId, desiredTileIds);
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
    const { tileIds, scored } = scoreTextureTiles(
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
      if (mesh.material.map !== texture) {
        log(tile.id, `apply cached tex (src=${textureStreamer.texSource.get(tile.id) || '?'})`);
      }
      meshById.set(tile.id, applyTexture(mesh, tile, texture));
    }

    textureStreamer.pump(scored, {
      isCovered: () => false,
      onPlaceholder: ({ tile, texture }) => applyPlaceholder(tile, texture),
      onTexture: ({ tile, texture }) => enqueueApplication(tile, texture, true),
    });
    lifecycle.sweepStaleParents(tiles, tileIds);
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
  const depth = Number.parseInt(tileId.split('-')[0], 10);
  applyDepthOffset(mesh, depth, enabled);
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
}) {
  const tileById = new Map(tiles.map(tile => [tile.id, tile]));
  const refreshedIds = new Set();

  // A tile ID alone does not identify its rendered geometry. The server
  // repairs edges against the neighbors in each response, so an unchanged ID
  // may carry a new heightmap after a nearby LOD transition. Treat those
  // payload changes like additions so the stale mesh is rebuilt in place.
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
  // it. Only demanded descendants matter: quadrants outside the circular
  // heatmap are intentionally absent and must not force a boundary hole.
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

  const staleRemoved = lifecycle.sweepStaleParents(tiles, nextTileIds);
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
            terrainRoot.add(mesh);
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
          terrainRoot.add(mesh);
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
    staleRemoved,
    sceneMeshes: terrainRoot.children.filter(mesh => mesh.isMesh).length,
    deferred: deferredTiles.size,
  };
}

export function createTerrainTileReconciler({
  terrainRoot,
  deferredTiles,
  lifecycle,
  priorityForTile,
  textureCache,
  meshRuntime,
  buildMesh,
  log,
  buildBudget = 200,
  prepareUntexturedMesh = () => {},
  onMeshAdded = () => {},
  depthOffsetEnabled = true,
}) {
  return (tiles, currentTileIds, {
    onDiff = () => {},
    completeCoverage = false,
  } = {}) => reconcileTerrainTiles({
    tiles,
    currentTileIds,
    deferredTiles,
    terrainRoot,
    lifecycle,
    priorityForTile,
    textureCache,
    materialize: meshRuntime.materialize,
    buildMesh,
    log,
    buildBudget,
    prepareUntexturedMesh,
    onMeshAdded,
    onDiff,
    depthOffsetEnabled,
    completeCoverage,
  });
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
  const desaturateTexture = testOverrides.createDesaturatedTexture
    ?? createDesaturatedTerrainTexture;
  const deferredTiles = new Map();
  let currentTileIds = new Set();
  let lastTiles = null;
  let classifierMode = false;
  const classifierTextures = new Map();
  const desaturatedTextures = new Map();

  function selectVertexColors(mesh, attribute) {
    if (!mesh?.geometry || !attribute) return false;
    if (mesh.geometry.getAttribute?.('color') === attribute) return false;
    mesh.geometry.setAttribute?.('color', attribute);
    return true;
  }

  function applyClassifierPresentation(mesh) {
    if (!mesh?.material) return;
    const classifierTexture = classifierTextures.get(mesh.userData?.tileId) ?? null;
    const baseTexture = mesh.userData?.terrainBaseTexture ?? null;
    let fallbackTexture = null;
    if (!classifierTexture && baseTexture) {
      const cached = desaturatedTextures.get(mesh.userData.tileId);
      if (cached?.source === baseTexture) {
        fallbackTexture = cached.texture;
      } else {
        cached?.texture?.dispose?.();
        fallbackTexture = desaturateTexture(baseTexture);
        if (fallbackTexture) {
          desaturatedTextures.set(mesh.userData.tileId, {
            source: baseTexture,
            texture: fallbackTexture,
          });
        } else {
          desaturatedTextures.delete(mesh.userData.tileId);
        }
      }
    }
    const presentationTexture = classifierTexture ?? fallbackTexture;
    let needsUpdate = false;
    if (mesh.material.map !== presentationTexture) {
      mesh.material.map = presentationTexture;
      needsUpdate = true;
    }
    const useFallbackColors = !presentationTexture;
    if (useFallbackColors) {
      needsUpdate = selectVertexColors(mesh, mesh.userData?.classifierColorAttribute) || needsUpdate;
    }
    if (mesh.material.vertexColors !== useFallbackColors) {
      mesh.material.vertexColors = useFallbackColors;
      needsUpdate = true;
    }
    mesh.material.color.set(0xffffff);
    if (needsUpdate) mesh.material.needsUpdate = true;
    onMutated();
  }

  function applyMaterial(mesh, texture) {
    if (!mesh?.material) return;
    mesh.userData.terrainBaseTexture = texture ?? null;
    if (classifierMode) {
      applyClassifierPresentation(mesh);
      return;
    }
    let needsUpdate = false;
    const resolvedTexture = texture;
    if (mesh.material.map !== resolvedTexture) {
      mesh.material.map = resolvedTexture;
      needsUpdate = true;
    }
    if (!resolvedTexture) {
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
    if (needsUpdate) {
      mesh.material.needsUpdate = true;
      onMutated();
    }
  }

  function prepareUntexturedMesh(mesh) {
    renderBackend.prepareUntexturedTerrain(mesh);
    if (classifierMode) applyClassifierPresentation(mesh);
  }
  const lifecycle = createTileLifecycle({
    terrainRoot, disposeScatter: disposeTileScatter, log, onSceneMutated: onMutated,
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
    lastTiles = tiles;
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
      onReleaseTile: textureStreamer.releaseTile,
    });
    currentTileIds = result.nextTileIds;
    for (const [tileId, cached] of desaturatedTextures) {
      if (currentTileIds.has(tileId)) continue;
      cached.texture?.dispose?.();
      desaturatedTextures.delete(tileId);
    }
    return result;
  }

  function updateTextures(tiles) {
    lastTiles = tiles;
    updateTextureDemand(tiles);
  }

  function refreshTextures() {
    if (lastTiles) updateTextureDemand(lastTiles);
  }

  function setClassifierMode(enabled) {
    const next = Boolean(enabled);
    if (classifierMode === next) return classifierMode;
    classifierMode = next;
    for (const mesh of terrainRoot.children) {
      if (!mesh.isMesh || !mesh.userData?.tileId) continue;
      if (classifierMode) {
        applyClassifierPresentation(mesh);
      } else {
        const baseTexture = mesh.userData.terrainBaseTexture
          ?? textureStreamer.texCache.get(mesh.userData.tileId)
          ?? null;
        applyMaterial(mesh, baseTexture);
      }
    }
    return classifierMode;
  }

  function setClassifierTexture(tileId, texture) {
    if (texture) classifierTextures.set(tileId, texture);
    else classifierTextures.delete(tileId);
    const mesh = terrainRoot.children.find(
      child => child.isMesh && child.userData?.tileId === tileId,
    );
    if (classifierMode && mesh) applyClassifierPresentation(mesh);
  }

  return {
    get currentTileIds() { return currentTileIds; },
    get classifierMode() { return classifierMode; },
    deferredTiles,
    reconcile,
    updateTextures,
    refreshTextures,
    setClassifierMode,
    setClassifierTexture,
    resetTextureApplications: updateTextureDemand.reset,
  };
}
