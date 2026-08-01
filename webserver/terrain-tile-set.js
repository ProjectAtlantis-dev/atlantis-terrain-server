import * as THREE from 'three';
import { hasCompleteTerrainTileCoverage } from './tile-coverage.js';
import {
  isTerrainTileAncestor,
  parseTerrainTileId,
  terrainTileDepth,
} from './terrain-tile-address.js';
import {
  createTerrainMeshBuilder,
  updateTerrainMeshHeightmap,
} from './terrain-mesh-builder.js';
import { createTerrainGeometryCache } from './terrain-geometry-cache.js';
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
  releaseStaleTexture = () => false,
  residentById = null,
  parkGeometry = () => false,
}) {
  const residentMeshes = () => (
    residentById
      ? [...residentById.values()]
      : terrainRoot.children.filter(mesh => mesh.isMesh && mesh.userData?.tileId)
  );

  function retire(mesh, reason = 'unspecified lifecycle retirement') {
    if (!mesh) return;
    const tileId = mesh.userData?.tileId || '?';
    log(tileId, `evicted — ${reason}`);
    terrainRoot.remove(mesh);
    if (residentById?.get(tileId) === mesh) residentById.delete(tileId);
    disposeScatter(mesh);
    releaseStaleTexture(mesh.userData?.terrainBaseTexture ?? mesh.material?.map);
    mesh.userData?.terrainPlaceholderTexture?.dispose?.();
    if (mesh.userData) delete mesh.userData.terrainPlaceholderTexture;
    // Textures keep their own dormancy cache and are released above; only the
    // grid is parked here, so a tile that comes straight back skips the
    // expensive rebuild instead of paying for it twice per LOD oscillation.
    if (!parkGeometry(mesh)) mesh.geometry?.dispose();
    if (Array.isArray(mesh.material)) {
      for (const material of mesh.material) material?.dispose?.();
    } else {
      mesh.material?.dispose?.();
    }
    onSceneMutated();
    return true;
  }

  function sweepResidency(desiredTileIds) {
    const desired = desiredTileIds instanceof Set
      ? desiredTileIds
      : new Set(desiredTileIds ?? []);
    const residents = residentMeshes();
    const residentTextures = new Map(
      residents.map(mesh => [mesh.userData.tileId, hasTerrainCoverage(mesh)]),
    );
    const retired = [];
    const retainedFallbacks = [];
    // The desired set is fixed for the whole sweep; spreading it per candidate
    // rebuilt a few-hundred-entry array for every tile being evicted.
    const desiredIds = [...desired];

    for (const mesh of residents) {
      const tileId = mesh.userData?.tileId;
      if (!tileId || desired.has(tileId)) continue;
      const desiredDescendants = desiredDescendantIds(tileId, desired);
      const desiredAncestors = desiredIds.filter(
        desiredId => isTerrainTileAncestor(desiredId, tileId),
      );

      let replacementCoverage = true;
      if (desiredDescendants.length > 0) {
        replacementCoverage = hasCompleteTerrainTileCoverage(
          tileId,
          residentTextures,
          { excludeTileIds: [tileId] },
        );
      } else if (desiredAncestors.length > 0) {
        replacementCoverage = desiredAncestors.every(ancestorId => (
          hasCompleteTerrainTileCoverage(
            ancestorId,
            residentTextures,
            { excludeTileIds: [tileId] },
          )
        ));
      }

      if (!replacementCoverage) {
        retainedFallbacks.push(tileId);
        continue;
      }
      retire(mesh, 'absent from current browser heatmap with replacement coverage');
      onReleaseTile(tileId);
      residentTextures.delete(tileId);
      retired.push(tileId);
    }
    return { retired, retainedFallbacks };
  }

  function replaceForMaterialized(mesh, currentTileIds) {
    const tileId = mesh.userData.tileId;
    const existing = residentById?.get(tileId) ?? residentMeshes().find(
      resident => resident.userData.tileId === tileId,
    );
    if (existing) retire(existing, 'atomically replaced by textured self');
    addTerrainMesh(terrainRoot, mesh);
    residentById?.set(tileId, mesh);
    onSceneMutated();
    sweepResidency(currentTileIds);
  }

  return { retire, sweepResidency, replaceForMaterialized };
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
  onMaterialApplied = () => {},
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
    onMaterialApplied(mesh);
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
  residentById = null,
}) {
  const findMesh = tileId => (
    residentById?.get(tileId)
    ?? terrainRoot.children.find(child => child.userData.tileId === tileId)
  );
  const pendingApplications = new Map();
  let applicationFramePending = false;
  let desiredTileIds = new Set();

  function discardApplication(tileId, texture) {
    if (textureStreamer.discardTexture?.(tileId, texture)) return;
    if (textureStreamer.texCache.get(tileId) === texture) {
      textureStreamer.texCache.delete(tileId);
      textureStreamer.texSource.delete(tileId);
    }
    texture.dispose?.();
  }

  function applyTexture(mesh, texture) {
    const placeholderTexture = mesh.userData?.terrainPlaceholderTexture;
    const previousTexture = mesh.material?.map;
    const hadCoverage = Boolean(previousTexture);
    if (mesh.userData) delete mesh.userData.terrainPlaceholderTexture;
    applyMaterial(mesh, texture);
    if (placeholderTexture && placeholderTexture !== texture) placeholderTexture.dispose?.();
    if (previousTexture && previousTexture !== texture && previousTexture !== placeholderTexture) {
      textureStreamer.releaseStaleTexture?.(previousTexture);
    }
    onMaterialApplied(mesh);
    if (!hadCoverage) lifecycle.sweepResidency(desiredTileIds);
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
        const hadCoverage = Boolean(mesh.material?.map);
        const previousPlaceholder = mesh.userData?.terrainPlaceholderTexture;
        applyMaterial(mesh, texture);
        if (previousPlaceholder && previousPlaceholder !== texture) previousPlaceholder.dispose?.();
        onMaterialApplied(mesh);
        if (!hadCoverage) lifecycle.sweepResidency(desiredTileIds);
      }
    }
    if (!mesh) {
      texture.dispose?.();
      return;
    }
    mesh.userData.terrainPlaceholderTexture = texture;
  }

  function drainApplications() {
    applicationFramePending = false;
    let remaining = applicationsPerFrame;
    for (const [tileId, pending] of pendingApplications) {
      if (remaining-- <= 0) break;
      pendingApplications.delete(tileId);
      const { tile, texture, logArrival } = pending;
      if (!desiredTileIds.has(tileId)) {
        discardApplication(tileId, texture);
        continue;
      }
      if (deferredTiles.has(tileId)) {
        if (logArrival) log(tileId, 'cached + materialize (was deferred)');
        meshRuntime.materialize(tileId, texture);
      } else {
        const mesh = findMesh(tileId);
        if (mesh) {
          if (logArrival) log(tileId, 'cached + applied to existing mesh');
          applyTexture(mesh, texture);
        } else if (logArrival) {
          log(tileId, 'cached but NO mesh in scene');
        }
      }
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
      discardApplication(tile.id, texture);
      return;
    }
    pendingApplications.set(tile.id, { tile, texture, logArrival });
    scheduleApplicationFrame();
  }

  function updateTerrainTextures(tiles) {
    const { scored } = scoreTextureTiles(
      tiles, priorityForTile, Math.log(getVisibilityDistance()),
    );
    desiredTileIds = new Set(scored.map(item => item.tile.id));
    for (const tileId of desiredTileIds) textureStreamer.claimTile?.(tileId);

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
      const mesh = findMesh(tile.id);
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
      applyTexture(mesh, texture);
    }

    textureStreamer.pump(scored, {
      isCovered: () => false,
      onPlaceholder: ({ tile, texture }) => applyPlaceholder(tile, texture),
      onTexture: ({ tile, texture }) => enqueueApplication(tile, texture, true),
    });
  }

  updateTerrainTextures.reset = () => {
    desiredTileIds.clear();
    for (const [tileId, { texture }] of pendingApplications) {
      if (textureStreamer.texCache.get(tileId) === texture) continue;
      if (textureStreamer.releaseStaleTexture?.(texture)) continue;
      texture.dispose?.();
    }
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
  claimTile = () => {},
  residentById = null,
  materialize,
  buildMesh,
  log,
  buildBudget = 200,
  // A tile count says nothing about time: 200 grids cost whatever they cost,
  // and one response was measured spending 127ms uninterrupted. The deadline
  // is what actually protects the frame; the count stays as a coarse ceiling.
  buildBudgetMs = 8,
  // Refreshing is seam repair, so it gets its own slightly larger allowance
  // than building: a stale grid still renders, it just keeps last response's
  // edge until its turn comes.
  refreshBudgetMs = 6,
  now = () => performance.now(),
  prepareUntexturedMesh = () => {},
  onMeshAdded = () => {},
  onDiff = () => {},
  depthOffsetEnabled = true,
  completeCoverage = false,
  refreshMesh = updateTerrainMeshHeightmap,
}) {
  const meshesById = residentById ?? new Map(
    terrainRoot.children
      .filter(mesh => mesh.isMesh && mesh.userData?.tileId)
      .map(mesh => [mesh.userData.tileId, mesh]),
  );
  const tileById = new Map(tiles.map(tile => [tile.id, tile]));
  const refreshedIds = new Set();
  const refreshedInPlaceIds = new Set();

  // A tile ID alone does not identify its rendered geometry. The server
  // repairs edges against the neighbors in each response, so an unchanged ID
  // may carry a new heightmap after a nearby LOD transition. Update ordinary
  // resident grids in place: rebuilding them used to send unchanged topology
  // through defer -> ancestor placeholder -> exact texture on every response.
  const refreshStartedAt = now();
  const refreshCandidates = [];
  for (const mesh of meshesById.values()) {
    const tileId = mesh.userData?.tileId;
    const nextTile = tileById.get(tileId);
    const previousPayload = mesh.userData?.heightmapPayload;
    if (
      !mesh.isMesh
      || !nextTile?.heightmap
      || typeof previousPayload !== 'string'
      || previousPayload === nextTile.heightmap
    ) continue;
    refreshCandidates.push({ mesh, tileId, nextTile });
  }
  // A refresh costs about what a rebuild costs, and seam repair changes the
  // payload of nearly every resident tile on nearly every response — so this
  // loop could pay for a few hundred full grids in one uninterrupted block.
  // Nearest-first, then stop at a deadline: a deferred tile keeps its previous
  // grid and its skirt, which is what hides the seam in the meantime, and it
  // stays a candidate on the next response.
  if (refreshCandidates.length > 1) {
    refreshCandidates.sort(
      (a, b) => priorityForTile(a.nextTile) - priorityForTile(b.nextTile),
    );
  }
  const refreshDeadline = refreshStartedAt + refreshBudgetMs;
  let refreshed = 0;
  let refreshDeferred = 0;
  for (const { mesh, tileId, nextTile } of refreshCandidates) {
    if (!completeCoverage && refreshed > 0 && now() >= refreshDeadline) {
      refreshDeferred += 1;
      continue;
    }
    refreshed += 1;
    if (refreshMesh(mesh, nextTile)) {
      log(tileId, 'refreshed in place — repaired heightmap changed');
      refreshedInPlaceIds.add(tileId);
      onMeshAdded(mesh);
      continue;
    }
    log(tileId, 'refresh queued — repaired heightmap changed');
    refreshedIds.add(tileId);
  }
  const refreshMs = now() - refreshStartedAt;

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

  // The Flask response is only the newest heatmap snapshot. Browser
  // residency has one owner: sweep the live meshes against that snapshot.
  // Material arrivals may request another sweep as coverage improves, but
  // they never make an independent ancestor-eviction decision.
  // Eviction and building are separately expensive and fail in opposite
  // directions — a contraction removes hundreds of meshes while building
  // almost nothing. Time them apart so a spike names its own half.
  const sweepStartedAt = performance.now();
  const sweep = lifecycle.sweepResidency?.(nextTileIds) ?? {
    retired: [],
    retainedFallbacks: [],
  };
  const evictMs = performance.now() - sweepStartedAt;
  const released = sweep.retired.length;
  for (const tileId of sweep.retired) meshesById.delete(tileId);

  for (const mesh of meshesById.values()) {
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

  const buildStartedAt = performance.now();
  if (added.length > 0) {
    const existingIds = new Set(meshesById.keys());
    const candidates = prioritizeTerrainBuildCandidates(tiles, new Set(added), priorityForTile);
    let built = 0;
    // Candidates arrive ranked by camera distance, heading, pitch, and FOV, so
    // stopping at a deadline drops the tail — tiles behind the camera or
    // outside the frustum — rather than an arbitrary slice. Always allow the
    // first build: a deadline already passed on entry must not starve the
    // highest-priority tile forever.
    const buildDeadline = now() + buildBudgetMs;
    const canBuild = () => (
      completeCoverage
      || (built < buildBudget && (built === 0 || now() < buildDeadline))
    );
    // Stale coverage only ever comes from meshes that were already resident
    // and textured when this reconcile began. Nothing built below can join the
    // set: the cached-texture branch materializes without touching meshesById,
    // and both buildMesh branches publish untextured geometry. Collecting the
    // candidates once therefore preserves the original result while dropping a
    // full copy of the resident map per added tile — the loop rebuilt that
    // array up to buildBudget times per response.
    const texturedCoverage = [];
    for (const mesh of meshesById.values()) {
      if (mesh.isMesh && mesh.material?.map && mesh.userData?.bbox) {
        texturedCoverage.push(mesh);
      }
    }
    for (const { tile } of candidates) {
      if (existingIds.has(tile.id) && !refreshedIds.has(tile.id)) continue;
      const cachedTexture = textureCache.get(tile.id);
      if (cachedTexture) {
        claimTile(tile.id);
        deferredTiles.set(tile.id, tile);
        if (canBuild()) {
          log(tile.id, 'added — immediate build (cached tex)');
          materialize(tile.id, cachedTexture);
          built += 1;
        } else {
          log(tile.id, `added — deferred (build budget spent, built=${built})`);
        }
        continue;
      }

      deferredTiles.set(tile.id, tile);
      const existingRefreshMesh = refreshedIds.has(tile.id)
        ? meshesById.get(tile.id)
        : null;
      if (existingRefreshMesh) {
        if (existingRefreshMesh.material?.map) {
          log(tile.id, 'refresh deferred — textured geometry remains until atomic replacement');
        } else if (canBuild()) {
          const mesh = buildMesh(tile);
          if (mesh) {
            applyTileDepthOffset(mesh, tile.id, depthOffsetEnabled);
            prepareUntexturedMesh(mesh);
            addTerrainMesh(terrainRoot, mesh);
            meshesById.set(tile.id, mesh);
            onMeshAdded(mesh);
            lifecycle.retire(existingRefreshMesh, 'atomically replaced by repaired geometry');
          }
          built += 1;
        } else {
          log(tile.id, `refresh deferred — build budget spent, built=${built}`);
        }
        continue;
      }
      const hasStaleCoverage = texturedCoverage.some(
        mesh => overlaps(mesh.userData.bbox, tile.bbox),
      );
      if (hasStaleCoverage) {
        log(tile.id, 'added — deferred (stale coverage exists)');
      } else if (canBuild()) {
        log(tile.id, 'added — untextured fallback (no stale coverage)');
        const mesh = buildMesh(tile);
        if (mesh) {
          applyTileDepthOffset(mesh, tile.id, depthOffsetEnabled);
          prepareUntexturedMesh(mesh);
          addTerrainMesh(terrainRoot, mesh);
          meshesById.set(tile.id, mesh);
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
    evictMs: Number(evictMs.toFixed(1)),
    buildMs: Number((performance.now() - buildStartedAt).toFixed(1)),
    refreshMs: Number(refreshMs.toFixed(1)),
    refreshed,
    refreshDeferred,
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
  const geometryCache = testOverrides.geometryCache ?? createTerrainGeometryCache();
  const buildMesh = testOverrides.buildMesh ?? createTerrainMeshBuilder({
    exaggeration: terrain.exaggeration,
    attachScatter: terrain.attachScatter,
    geometryCache,
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
  const residentById = new Map();
  let currentTileIds = new Set();
  let lastTiles = null;
  const releaseTileDemand = tileId => textureStreamer.releaseTileDemand?.(tileId);

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
    releaseStaleTexture: textureStreamer.releaseStaleTexture,
    residentById,
    parkGeometry: mesh => geometryCache.park(mesh),
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
    onMaterialApplied,
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
    residentById,
    ...(testOverrides.scheduleFrame == null ? {} : { scheduleFrame: testOverrides.scheduleFrame }),
    ...(testOverrides.applicationsPerFrame == null
      ? {}
      : { applicationsPerFrame: testOverrides.applicationsPerFrame }),
  });
  function reconcile(tiles, {
    onDiff = () => {},
    completeCoverage = false,
  } = {}) {
    const previousTileIds = currentTileIds;
    // Publish the newest heatmap before any cached texture can materialize
    // synchronously. Every lifecycle sweep during this transaction must see
    // this response, never the preceding camera position.
    currentTileIds = new Set(tiles.map(tile => tile.id));
    let result;
    try {
      result = reconcileTerrainTiles({
        tiles,
        currentTileIds: previousTileIds,
        deferredTiles,
        terrainRoot,
        lifecycle,
        priorityForTile,
        textureCache: textureStreamer.texCache,
        claimTile: textureStreamer.claimTile,
        residentById,
        materialize: meshRuntime.materialize,
        buildMesh,
        log,
        buildBudget,
        prepareUntexturedMesh,
        onMeshAdded: onMutated,
        onDiff,
        depthOffsetEnabled,
        completeCoverage,
      });
      currentTileIds = result.nextTileIds;
    } catch (error) {
      currentTileIds = previousTileIds;
      throw error;
    }
    lastTiles = tiles;
    return { ...result, geometryCache: geometryCache.stats() };
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
