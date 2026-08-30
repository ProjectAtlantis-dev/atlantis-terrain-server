import * as THREE from 'three';

export const DEFAULT_OPTICAL_WATER_DEPTH_M = 5;
export const OPTICAL_WATER_RENDER_ORDER = 20;
export const WATER_SURFACE_RENDER_ORDER = 21;

function appendVertex(target, sourcePosition, sourceUv, index, z) {
  target.positions.push(
    sourcePosition.getX(index),
    sourcePosition.getY(index),
    z,
  );
  target.uvs.push(sourceUv.getX(index), sourceUv.getY(index));
}

function appendTriangle(target, sourcePosition, sourceUv, vertices, z) {
  for (const vertex of vertices) {
    appendVertex(target, sourcePosition, sourceUv, vertex, z);
  }
}

export function buildOpticalWaterGeometry(sourceMesh, {
  surfaceZ = 0,
} = {}) {
  const resolution = Number(sourceMesh?.userData?.resolution);
  const waterMask = sourceMesh?.userData?.terrainWaterMask;
  const sourcePosition = sourceMesh?.geometry?.getAttribute?.('position');
  const sourceUv = sourceMesh?.geometry?.getAttribute?.('uv');
  const expectedCount = resolution * resolution;
  if (
    !Number.isInteger(resolution)
    || resolution < 2
    || waterMask?.length !== expectedCount
    || sourcePosition?.count < expectedCount
    || sourceUv?.count < expectedCount
  ) {
    return null;
  }

  // Most tiles inland are entirely dry, and building every triangle only to
  // discover that costs the same as covering a full fjord. One pass over the
  // mask answers it before any geometry work starts.
  let hasWaterSample = false;
  for (let index = 0; index < waterMask.length; index += 1) {
    if (waterMask[index]) {
      hasWaterSample = true;
      break;
    }
  }
  if (!hasWaterSample) return null;

  // A fallback terrain tile may be carved by any union of deeper resident
  // tiles. Its optical-water twin must use the same holes; a full quad here
  // would reintroduce the exact coplanar LOD overlap removed from the terrain.
  const clipSignature = sourceMesh.userData?.terrainClipSignature ?? '';
  const activeSurfaceIndexCount = Number(
    sourceMesh.userData?.terrainActiveSurfaceIndexCount,
  );
  const sourceIndex = sourceMesh.geometry?.getIndex?.();
  if (
    clipSignature !== ''
    && Number.isInteger(activeSurfaceIndexCount)
    && activeSurfaceIndexCount >= 0
    && sourceIndex?.count >= activeSurfaceIndexCount
  ) {
    if (activeSurfaceIndexCount === 0) return null;
    const positions = new Float32Array(expectedCount * 3);
    const uvs = new Float32Array(expectedCount * 2);
    for (let index = 0; index < expectedCount; index += 1) {
      positions[index * 3] = sourcePosition.getX(index);
      positions[index * 3 + 1] = sourcePosition.getY(index);
      positions[index * 3 + 2] = surfaceZ;
      uvs[index * 2] = sourceUv.getX(index);
      uvs[index * 2 + 1] = sourceUv.getY(index);
    }
    const IndexArray = sourceIndex.array.constructor;
    const indices = new IndexArray(activeSurfaceIndexCount);
    indices.set(sourceIndex.array.subarray(0, activeSurfaceIndexCount));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  // A wet tile gets a complete flat twin. Do not clip the fake cover back to
  // the classification mask: a single missing/coarse mask cell over a deep
  // fjord exposes the real floor hundreds of metres below. Ordinary depth
  // testing is the precise final mask — land geometry stays in front of this
  // plane, while every genuinely submerged fragment is covered.
  // The proxy is flat and covers the complete tile, so its interior grid is
  // redundant. Two triangles are geometrically identical to the old 8,192
  // triangles on a 65x65 tile, while being cheap enough to create for every
  // newly streamed wet tile before the frame is rendered.
  const southWest = 0;
  const southEast = resolution - 1;
  const northWest = (resolution - 1) * resolution;
  const northEast = resolution * resolution - 1;
  const target = { positions: [], uvs: [] };
  appendTriangle(
    target, sourcePosition, sourceUv,
    [southWest, southEast, northWest], surfaceZ,
  );
  appendTriangle(
    target, sourcePosition, sourceUv,
    [southEast, northEast, northWest], surfaceZ,
  );
  if (target.positions.length === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(target.positions, 3),
  );
  geometry.setAttribute(
    'uv',
    new THREE.Float32BufferAttribute(target.uvs, 2),
  );
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function tileTexture(tile) {
  return tile?.userData?.terrainBaseTexture ?? tile?.material?.map ?? null;
}

function createOpticalMesh(source) {
  const geometry = buildOpticalWaterGeometry(source);
  if (geometry == null) return null;
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    map: tileTexture(source),
    side: THREE.FrontSide,
    transparent: false,
    depthTest: true,
    // This is visual depth only. It lets the atmosphere reconstruct the
    // shallow optical surface for cloud shadows and guarantees the dynamic
    // transparent water renders afterward. The bathymetry camera uses a
    // separate layer and never sees this mesh.
    depthWrite: true,
    fog: true,
  });
  material.name = 'WaterOpticalSurface.material';
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `WaterOpticalSurface.${source.userData.tileId}`;
  mesh.renderOrder = OPTICAL_WATER_RENDER_ORDER;
  mesh.castShadow = false;
  // Volumetric cloud shadows are applied by the atmosphere composition pass,
  // not Three's shadow-map receiver path.
  mesh.receiveShadow = false;
  mesh.raycast = () => {};
  mesh.userData.isOpticalWaterSurface = true;
  mesh.userData.sourceTerrainMesh = source;
  return mesh;
}

// Full-tile twins are two-triangle quads, so the default path can cover every
// admitted wet tile in the same frame. Deferring them exposed the fjord floor
// (and its cloud-shadow depth) during streaming. Finite budgets remain useful
// for deterministic lifecycle tests and diagnostics.
const DEFAULT_OPTICAL_BUILD_BUDGET_MS = Number.POSITIVE_INFINITY;
const DEFAULT_OPTICAL_BUILD_BUDGET = Number.POSITIVE_INFINITY;
// A footprint is a few hundred twins and oscillation swaps most of them, so
// hold several footprints' worth before discarding any.
const DEFAULT_OPTICAL_DORMANT_TWINS = 1500;
const TERRAIN_TILE_ID = /^\d+-\d+-\d+$/;

export function createOpticalWaterSurfaceRuntime({
  terrainRoot,
  opticalDepth = DEFAULT_OPTICAL_WATER_DEPTH_M,
  buildBudget = DEFAULT_OPTICAL_BUILD_BUDGET,
  buildBudgetMs = DEFAULT_OPTICAL_BUILD_BUDGET_MS,
  maxDormantTwins = DEFAULT_OPTICAL_DORMANT_TWINS,
  now = () => performance.now(),
  // Inversions are per-sync events at 60Hz; a counter sampled once a second
  // cannot say when one happened, which is the only thing that correlates
  // with something visible on screen. Emit them, rate-limited.
  onInversion = null,
  inversionLogIntervalMs = 400,
  evictionGate = null,
} = {}) {
  const group = new THREE.Group();
  group.name = 'WaterOpticalSurface';
  group.renderOrder = OPTICAL_WATER_RENDER_ORDER;
  group.userData.visualDepthProxy = true;
  terrainRoot.add(group);

  // Keyed by tile identity, not by source mesh: reconciliation builds a fresh
  // THREE.Mesh for a tile whose grid was revived unchanged, and keying on the
  // object threw away a still-valid optical twin on every LOD swap. Payload and
  // bbox decide reuse for the same reasons the geometry cache does — seam
  // repair rewrites elevations, and a re-centred frame offset moves the tile.
  const opticalByTile = new Map();
  // Tiles with no water produce no mesh, so opticalByTile can never remember
  // them. Without this they were rebuilt on every single frame for as long
  // as they stayed resident.
  const waterlessTiles = new Map();
  // LOD oscillation evicts and re-admits the same tiles continuously, and a
  // twin destroyed on eviction has to be rebuilt from scratch when the tile
  // returns moments later — measured at ~25 destroy/rebuild cycles per second,
  // which is visible as the water repainting. Park them instead; a twin is
  // just geometry plus a material reference, so holding a few hundred is
  // cheaper than rebuilding one.
  const dormantTwins = new Map();
  const debugRetainedTwins = new Set();
  let deferredBuilds = 0;
  // Rebuild churn is invisible on screen except as a repaint, so count it.
  let totalBuilds = 0;
  let totalRebuilds = 0;
  let totalEvictions = 0;
  let totalRevivals = 0;
  let inversions = 0;
  let worstInversionM = 0;
  let lastInversionLogAt = -Infinity;
  let totalVisibilityFlips = 0;
  let lastStatsSnapshot = {};
  let lastBuiltFarthestM = null;
  let lastDeferredNearestM = null;
  let totalDormantDrops = 0;

  function sameBbox(a, b) {
    // Two absent bboxes describe the same (unknown) placement; treating them
    // as different rebuilt the twin on every frame.
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return false;
    }
    return true;
  }

  function remove(tileId, entry) {
    if (evictionGate?.enabled === false) {
      debugRetainedTwins.add(entry);
    } else {
      group.remove(entry.optical);
      entry.optical.geometry?.dispose?.();
      entry.optical.material?.dispose?.();
    }
    opticalByTile.delete(tileId);
  }

  function evictDormantOverflow() {
    if (evictionGate?.enabled === false) return;
    while (dormantTwins.size > maxDormantTwins) {
      const oldest = dormantTwins.keys().next().value;
      const stale = dormantTwins.get(oldest);
      dormantTwins.delete(oldest);
      stale.optical.geometry?.dispose?.();
      stale.optical.material?.dispose?.();
      totalDormantDrops += 1;
    }
  }
  evictionGate?.onChange?.(enabled => {
    if (!enabled) return;
    for (const entry of debugRetainedTwins) {
      group.remove(entry.optical);
      entry.optical.geometry?.dispose?.();
      entry.optical.material?.dispose?.();
    }
    debugRetainedTwins.clear();
    evictDormantOverflow();
  });

  function bindTwin(entry, source) {
    // A revived tile is a different mesh object carrying the same grid.
    entry.optical.userData.sourceTerrainMesh = source;
    const texture = tileTexture(source);
    if (entry.optical.material.map !== texture) {
      entry.optical.material.map = texture;
      entry.optical.material.needsUpdate = true;
    }
    // A twin only becomes visible once its terrain tile has a texture, so a
    // freshly streamed tile renders with no water surface for a while and then
    // pops in. That flip changes depth under the cloud pass, so count it.
    const nextVisible = texture != null;
    if (entry.optical.visible !== nextVisible) totalVisibilityFlips += 1;
    entry.optical.visible = nextVisible;
  }

  function sync({
    visible = true, waterline = 0, cameraX = null, cameraY = null,
  } = {}) {
    group.visible = visible;
    group.position.z = Number(waterline) - Number(opticalDepth);

    const liveTiles = new Set();
    let built = 0;
    deferredBuilds = 0;
    const buildDeadline = now() + buildBudgetMs;
    // Ordering check, no behaviour change: record how far the built twins were
    // from the camera versus the nearest one skipped. If a skipped twin is
    // closer than a built one, the arbitrary scan order is starving near water
    // and the missing surface is right where the viewer is looking.
    const trackDistance = Number.isFinite(cameraX) && Number.isFinite(cameraY);
    const distanceTo = bbox => {
      if (!trackDistance || !Array.isArray(bbox) || bbox.length !== 4) return null;
      return Math.hypot(
        (bbox[0] + bbox[2]) * 0.5 - cameraX,
        (bbox[1] + bbox[3]) * 0.5 - cameraY,
      );
    };
    let builtFarthest = null;
    let deferredNearest = null;
    // Always allow one: a deadline already spent by earlier frame work must not
    // stall the surface forever.
    const canBuild = () => built < buildBudget && (built === 0 || now() < buildDeadline);
    // Two passes. The first resolves everything cheap — revivals, texture
    // rebinding — and collects only the tiles that need a twin built. The
    // second builds those nearest-first.
    //
    // A single pass built in scene-graph order, and with a budget that affords
    // one or two twins per frame that meant water 21 km away could be built
    // while a tile 3 km from the camera went without. Measured: 39 inversions
    // on one fjord run, worst 18 km.
    const candidates = [];
    for (const source of terrainRoot.children) {
      const tileId = source.userData?.tileId;
      if (!source.isMesh || !TERRAIN_TILE_ID.test(tileId ?? '')) continue;
      liveTiles.add(tileId);
      // Keyed on the water footprint, not the heightmap. Seam repair rewrites
      // the payload on nearly every response while leaving the shoreline
      // untouched, and rebuilding on that churn made the surface visibly
      // repaint. Falls back to the payload when no mask key is present.
      const payload = source.userData?.terrainWaterMaskKey
        ?? source.userData?.heightmapPayload
        ?? null;
      const bbox = source.userData?.bbox ?? null;
      const clipSignature = source.userData?.terrainClipSignature ?? '';

      let entry = opticalByTile.get(tileId);
      if (entry != null && (
        entry.payload !== payload
        || entry.clipSignature !== clipSignature
        || !sameBbox(entry.bbox, bbox)
      )) {
        remove(tileId, entry);
        totalRebuilds += 1;
        entry = null;
      }
      if (entry == null) {
        const parked = dormantTwins.get(tileId);
        if (parked != null
          && parked.payload === payload
          && parked.clipSignature === clipSignature
          && sameBbox(parked.bbox, bbox)) {
          dormantTwins.delete(tileId);
          group.add(parked.optical);
          opticalByTile.set(tileId, parked);
          totalRevivals += 1;
          entry = parked;
        }
      }
      if (entry == null) {
        const waterless = waterlessTiles.get(tileId);
        if (waterless !== undefined
          && waterless.payload === payload
          && waterless.clipSignature === clipSignature
          && sameBbox(waterless.bbox, bbox)) {
          continue;
        }
        candidates.push({
          source, tileId, payload, bbox, clipSignature, distance: distanceTo(bbox),
        });
        continue;
      }
      bindTwin(entry, source);
    }

    if (candidates.length > 1) {
      candidates.sort((a, b) => (
        (a.distance ?? Number.POSITIVE_INFINITY) - (b.distance ?? Number.POSITIVE_INFINITY)
      ));
    }
    for (const {
      source, tileId, payload, bbox, clipSignature, distance,
    } of candidates) {
      if (!canBuild()) {
        deferredBuilds += 1;
        if (distance != null && (deferredNearest == null || distance < deferredNearest)) {
          deferredNearest = distance;
        }
        continue;
      }
      built += 1;
      const optical = createOpticalMesh(source);
      if (optical == null) {
        waterlessTiles.set(tileId, { payload, bbox, clipSignature });
        continue;
      }
      waterlessTiles.delete(tileId);
      totalBuilds += 1;
      if (distance != null && (builtFarthest == null || distance > builtFarthest)) {
        builtFarthest = distance;
      }
      const entry = { optical, payload, bbox, clipSignature };
      opticalByTile.set(tileId, entry);
      group.add(optical);
      bindTwin(entry, source);
    }

    if (builtFarthest != null && deferredNearest != null && deferredNearest < builtFarthest) {
      inversions += 1;
      const excessM = builtFarthest - deferredNearest;
      worstInversionM = Math.max(worstInversionM, excessM);
      const at = now();
      if (onInversion != null && at - lastInversionLogAt >= inversionLogIntervalMs) {
        lastInversionLogAt = at;
        onInversion({
          builtFarthestM: Math.round(builtFarthest),
          deferredNearestM: Math.round(deferredNearest),
          excessM: Math.round(excessM),
          built,
          deferred: deferredBuilds,
          totalInversions: inversions,
          // Local ENU metres, so an event can be placed against the flight
          // path without needing the viewer to call it out live.
          cameraX: Math.round(cameraX),
          cameraY: Math.round(cameraY),
        });
      }
    }
    lastBuiltFarthestM = builtFarthest;
    lastDeferredNearestM = deferredNearest;

    for (const [tileId, entry] of opticalByTile) {
      if (liveTiles.has(tileId)) continue;
      if (evictionGate?.enabled === false) continue;
      group.remove(entry.optical);
      opticalByTile.delete(tileId);
      dormantTwins.delete(tileId);
      dormantTwins.set(tileId, entry);
      totalEvictions += 1;
      evictDormantOverflow();
    }
    for (const tileId of waterlessTiles.keys()) {
      if (evictionGate?.enabled !== false && !liveTiles.has(tileId)) waterlessTiles.delete(tileId);
    }
  }

  return {
    group,
    sync,
    get size() { return opticalByTile.size; },
    get waterlessSize() { return waterlessTiles.size; },
    get pendingBuilds() { return deferredBuilds; },
    // Cumulative counters answer "how much since load", which is never the
    // question during a flight. Deltas since the previous read answer "what is
    // happening now" — sampled at 1Hz against a 60Hz loop, that is the only
    // reading that correlates with something visible.
    stats() {
      const snapshot = {
        builds: totalBuilds,
        rebuilds: totalRebuilds,
        evictions: totalEvictions,
        revivals: totalRevivals,
        visibilityFlips: totalVisibilityFlips,
      };
      const delta = {};
      for (const [key, value] of Object.entries(snapshot)) {
        delta[key] = value - (lastStatsSnapshot[key] ?? 0);
      }
      lastStatsSnapshot = snapshot;
      return {
        perSample: delta,
        size: opticalByTile.size,
        waterless: waterlessTiles.size,
        pendingBuilds: deferredBuilds,
        builds: totalBuilds,
        rebuilds: totalRebuilds,
        evictions: totalEvictions,
        revivals: totalRevivals,
        dormant: dormantTwins.size,
        dormantDrops: totalDormantDrops,
        debugRetained: debugRetainedTwins.size,
        inversions,
        worstInversionM: Math.round(worstInversionM),
        builtFarthestM: lastBuiltFarthestM == null ? null : Math.round(lastBuiltFarthestM),
        deferredNearestM: lastDeferredNearestM == null ? null : Math.round(lastDeferredNearestM),
      };
    },
    dispose() {
      for (const [tileId, entry] of [...opticalByTile]) {
        remove(tileId, entry);
      }
      for (const entry of dormantTwins.values()) {
        entry.optical.geometry?.dispose?.();
        entry.optical.material?.dispose?.();
      }
      dormantTwins.clear();
      for (const entry of debugRetainedTwins) {
        group.remove(entry.optical);
        entry.optical.geometry?.dispose?.();
        entry.optical.material?.dispose?.();
      }
      debugRetainedTwins.clear();
      waterlessTiles.clear();
      terrainRoot.remove(group);
    },
  };
}
