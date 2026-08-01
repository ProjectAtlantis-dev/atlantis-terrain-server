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

function appendMidpoint(target, sourcePosition, sourceUv, a, b, z) {
  target.positions.push(
    (sourcePosition.getX(a) + sourcePosition.getX(b)) * 0.5,
    (sourcePosition.getY(a) + sourcePosition.getY(b)) * 0.5,
    z,
  );
  target.uvs.push(
    (sourceUv.getX(a) + sourceUv.getX(b)) * 0.5,
    (sourceUv.getY(a) + sourceUv.getY(b)) * 0.5,
  );
}

function appendTriangle(target, sourcePosition, sourceUv, vertices, z) {
  for (const vertex of vertices) {
    if (Array.isArray(vertex)) {
      appendMidpoint(target, sourcePosition, sourceUv, vertex[0], vertex[1], z);
    } else {
      appendVertex(target, sourcePosition, sourceUv, vertex, z);
    }
  }
}

// Clip one terrain triangle against its binary water footprint. Mask changes
// happen at the midpoint between neighboring terrain samples, matching the
// raster convention while avoiding both a full-cell coastal overdraw and the
// full-cell retreat caused by accepting only all-water triangles.
function appendClippedTriangle(
  target,
  sourcePosition,
  sourceUv,
  waterMask,
  [a, b, c],
  z,
) {
  const input = [a, b, c];
  const polygon = [];
  for (let index = 0; index < input.length; index += 1) {
    const start = input[index];
    const end = input[(index + 1) % input.length];
    const startIsWater = waterMask[start] > 0;
    const endIsWater = waterMask[end] > 0;
    if (endIsWater) {
      if (!startIsWater) polygon.push([start, end]);
      polygon.push(end);
    } else if (startIsWater) {
      polygon.push([start, end]);
    }
  }
  if (polygon.length < 3) return;
  for (let index = 1; index < polygon.length - 1; index += 1) {
    appendTriangle(
      target,
      sourcePosition,
      sourceUv,
      [polygon[0], polygon[index], polygon[index + 1]],
      z,
    );
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

  // Most tiles inland are entirely dry, and clipping every triangle only to
  // discover that costs the same as clipping a full fjord. One pass over the
  // mask answers it before any geometry work starts.
  let hasWaterSample = false;
  for (let index = 0; index < waterMask.length; index += 1) {
    if (waterMask[index]) {
      hasWaterSample = true;
      break;
    }
  }
  if (!hasWaterSample) return null;

  const target = { positions: [], uvs: [] };
  for (let row = 0; row < resolution - 1; row += 1) {
    for (let column = 0; column < resolution - 1; column += 1) {
      const a = row * resolution + column;
      const b = a + 1;
      const d = a + resolution;
      const f = d + 1;
      appendClippedTriangle(
        target, sourcePosition, sourceUv, waterMask, [a, b, d], surfaceZ,
      );
      appendClippedTriangle(
        target, sourcePosition, sourceUv, waterMask, [b, f, d], surfaceZ,
      );
    }
  }
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

// A LOD expansion admits a few hundred tiles at once, and building every
// optical twin in the frame that notices them is what turned a streaming burst
// into a half-second freeze. The surface is a visual proxy, so spreading the
// work over the next few frames is invisible.
const DEFAULT_OPTICAL_BUILD_BUDGET = 4;
const TERRAIN_TILE_ID = /^\d+-\d+-\d+$/;

export function createOpticalWaterSurfaceRuntime({
  terrainRoot,
  opticalDepth = DEFAULT_OPTICAL_WATER_DEPTH_M,
  buildBudget = DEFAULT_OPTICAL_BUILD_BUDGET,
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
  // them. Without this they were re-clipped on every single frame for as long
  // as they stayed resident.
  const waterlessTiles = new Map();
  let deferredBuilds = 0;

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
    group.remove(entry.optical);
    entry.optical.geometry?.dispose?.();
    entry.optical.material?.dispose?.();
    opticalByTile.delete(tileId);
  }

  function sync({ visible = true, waterline = 0 } = {}) {
    group.visible = visible;
    group.position.z = Number(waterline) - Number(opticalDepth);

    const liveTiles = new Set();
    let built = 0;
    deferredBuilds = 0;
    for (const source of terrainRoot.children) {
      const tileId = source.userData?.tileId;
      if (!source.isMesh || !TERRAIN_TILE_ID.test(tileId ?? '')) continue;
      liveTiles.add(tileId);
      const payload = source.userData?.heightmapPayload ?? null;
      const bbox = source.userData?.bbox ?? null;

      let entry = opticalByTile.get(tileId);
      if (entry != null && (entry.payload !== payload || !sameBbox(entry.bbox, bbox))) {
        remove(tileId, entry);
        entry = null;
      }
      if (entry == null) {
        const waterless = waterlessTiles.get(tileId);
        if (waterless !== undefined
          && waterless.payload === payload
          && sameBbox(waterless.bbox, bbox)) {
          continue;
        }
        if (built >= buildBudget) {
          deferredBuilds += 1;
          continue;
        }
        built += 1;
        const optical = createOpticalMesh(source);
        if (optical == null) {
          waterlessTiles.set(tileId, { payload, bbox });
          continue;
        }
        waterlessTiles.delete(tileId);
        entry = { optical, payload, bbox };
        opticalByTile.set(tileId, entry);
        group.add(optical);
      }
      // A revived tile is a different mesh object carrying the same grid.
      entry.optical.userData.sourceTerrainMesh = source;

      const texture = tileTexture(source);
      if (entry.optical.material.map !== texture) {
        entry.optical.material.map = texture;
        entry.optical.material.needsUpdate = true;
      }
      entry.optical.visible = texture != null;
    }

    for (const [tileId, entry] of opticalByTile) {
      if (!liveTiles.has(tileId)) remove(tileId, entry);
    }
    for (const tileId of waterlessTiles.keys()) {
      if (!liveTiles.has(tileId)) waterlessTiles.delete(tileId);
    }
  }

  return {
    group,
    sync,
    get size() { return opticalByTile.size; },
    get waterlessSize() { return waterlessTiles.size; },
    get pendingBuilds() { return deferredBuilds; },
    dispose() {
      for (const [tileId, entry] of [...opticalByTile]) {
        remove(tileId, entry);
      }
      waterlessTiles.clear();
      terrainRoot.remove(group);
    },
  };
}
