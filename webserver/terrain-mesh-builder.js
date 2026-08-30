import * as THREE from 'three';

/**
 * Elevation samples for a tile, from whichever transport delivered it.
 *
 * The binary payload hands back a Float32Array view over the response buffer
 * and keeps `heightmap` as a digest, so decoding is a no-op there. The JSON
 * transport still carries base64 and is decoded on demand.
 */
/**
 * Cheap identity for a tile's water footprint.
 *
 * Consumers that only care about where water is — the optical surface, for one
 * — must not rebuild when seam repair nudges elevations. Repair rewrites edge
 * samples on nearly every response, but almost never moves one across sea
 * level, so keying on the mask instead of the heightmap keeps derived meshes
 * alive through routine repair.
 */
export function terrainWaterMaskKey(waterMask) {
  if (!(waterMask instanceof Uint8Array)) return null;
  let hash = 0x811c9dc5;
  for (let index = 0; index < waterMask.length; index += 1) {
    hash ^= waterMask[index];
    hash = Math.imul(hash, 0x01000193);
  }
  return `${waterMask.length}:${(hash >>> 0).toString(16)}`;
}

export function terrainTileSamples(tile) {
  if (tile?.samples instanceof Float32Array) return tile.samples;
  return decodeTerrainHeightmap(tile?.heightmap);
}

/**
 * Whether this response contains a published water classification for the
 * effective heightmap. Until it does, the terrain samples are only the DEM's
 * sign-based fallback and must not replace the water renderer's explicit
 * no-coverage depth.
 *
 * Older terrain servers do not expose this metadata. Treat those tiles as
 * capture-ready so this readiness contract remains backward compatible.
 */
export function terrainTileBathymetryReady(tile) {
  const maskSource = tile?.dem?.heightmap?.maskSource;
  return maskSource == null || maskSource !== 'dem_nonpositive_fallback';
}

export function decodeTerrainHeightmap(base64, decodeBase64 = value => atob(value)) {
  const raw = decodeBase64(base64);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return new Float32Array(bytes.buffer);
}

function elevationColor(elevation) {
  const stops = [
    { e: -50, r: 0.04, g: 0.15, b: 0.35 }, { e: 5, r: 0.06, g: 0.18, b: 0.38 },
    { e: 15, r: 0.10, g: 0.35, b: 0.18 }, { e: 200, r: 0.35, g: 0.55, b: 0.22 },
    { e: 500, r: 0.52, g: 0.48, b: 0.20 }, { e: 800, r: 0.55, g: 0.40, b: 0.25 },
    { e: 1200, r: 0.58, g: 0.55, b: 0.50 }, { e: 2000, r: 0.80, g: 0.78, b: 0.75 },
    { e: 3000, r: 0.97, g: 0.97, b: 0.98 },
  ];
  if (elevation <= stops[0].e) return stops[0];
  if (elevation >= stops.at(-1).e) return stops.at(-1);
  for (let index = 0; index < stops.length - 1; index++) {
    const low = stops[index], high = stops[index + 1];
    if (elevation < low.e || elevation > high.e) continue;
    const amount = (elevation - low.e) / (high.e - low.e);
    return {
      r: low.r + amount * (high.r - low.r),
      g: low.g + amount * (high.g - low.g),
      b: low.b + amount * (high.b - low.b),
    };
  }
  return stops.at(-1);
}

function terrainEdgeIndices(resolution) {
  return [
    Array.from({ length: resolution }, (_, column) => column),
    Array.from(
      { length: resolution },
      (_, column) => (resolution - 1) * resolution + column,
    ),
    Array.from({ length: resolution }, (_, row) => row * resolution),
    Array.from(
      { length: resolution },
      (_, row) => row * resolution + resolution - 1,
    ),
  ];
}

export function updateTerrainMeshHeightmap(mesh, tile) {
  const resolution = Number(mesh?.userData?.resolution);
  if (
    !mesh?.geometry
    || !tile?.heightmap
    || !Number.isInteger(resolution)
    || resolution < 2
    || Number(tile.resolution) !== resolution
  ) return false;

  const heightmap = terrainTileSamples(tile);
  if (heightmap.length !== resolution * resolution) return false;
  const position = mesh.geometry.getAttribute?.('position');
  const color = mesh.geometry.getAttribute?.('color');
  const expectedVertices = resolution * resolution + resolution * 2 * 4;
  if (!position || position.count !== expectedVertices) return false;

  const exaggeration = Number.isFinite(Number(mesh.userData.terrainExaggeration))
    ? Number(mesh.userData.terrainExaggeration)
    : 1;
  const skirtDepth = Number(mesh.userData.skirtDepth) || 0;
  const surfaceVertexCount = resolution * resolution;
  for (let index = 0; index < surfaceVertexCount; index += 1) {
    const elevation = heightmap[index];
    position.setZ(index, elevation * exaggeration);
    if (color) {
      const nextColor = elevationColor(elevation);
      color.setXYZ(index, nextColor.r, nextColor.g, nextColor.b);
    }
  }

  let skirtVertex = surfaceVertexCount;
  for (const surfaceIndices of terrainEdgeIndices(resolution)) {
    for (const surfaceIndex of surfaceIndices) {
      const top = skirtVertex++;
      const bottom = skirtVertex++;
      const topZ = position.getZ(surfaceIndex);
      position.setZ(top, topZ);
      position.setZ(bottom, topZ - skirtDepth);
      if (color) {
        color.setXYZ(
          top,
          color.getX(surfaceIndex),
          color.getY(surfaceIndex),
          color.getZ(surfaceIndex),
        );
        color.setXYZ(
          bottom,
          color.getX(surfaceIndex),
          color.getY(surfaceIndex),
          color.getZ(surfaceIndex),
        );
      }
    }
  }

  position.needsUpdate = true;
  if (color) color.needsUpdate = true;
  mesh.geometry.computeVertexNormals?.();
  mesh.geometry.computeBoundingBox?.();
  mesh.geometry.computeBoundingSphere?.();
  const terrainWaterMask = Uint8Array.from(heightmap, elevation => (
    Number.isFinite(elevation) && elevation <= 0 ? 1 : 0
  ));
  Object.assign(mesh.userData, {
    heightmapPayload: tile.heightmap,
    terrainSource: tile.source,
    terrainBathymetryReady: terrainTileBathymetryReady(tile),
    terrainWaterMask,
    terrainWaterMaskKey: terrainWaterMaskKey(terrainWaterMask),
  });
  return true;
}

export function createTerrainMeshBuilder({
  exaggeration,
  attachScatter,
  geometryCache = null,
}) {
  // Everything except the grid itself is cheap to redo: decoding the heightmap
  // and deriving the water mask are linear passes over 65x65 samples, while the
  // parked geometry represents the per-vertex colouring, index assembly, and
  // normal computation that dominate a rebuild.
  function skirtDepthFor(tile) {
    const geometricError = Number.isFinite(Number(tile.geometric_error))
      ? Math.max(0, Number(tile.geometric_error))
      : 0;
    return Math.max(30, geometricError * 2) * Math.abs(exaggeration);
  }

  function finishMesh({
    tile, geometry, heightmap, resolution, skirtDepth,
    refreshElevations = false,
  }) {
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff, side: THREE.FrontSide, vertexColors: true,
    });
    const mesh = new THREE.Mesh(geometry, material);
    Object.assign(mesh.userData, {
      tileId: tile.id,
      bbox: tile.bbox,
      terrainSource: tile.source,
      terrainBathymetryReady: terrainTileBathymetryReady(tile),
      resolution,
      skirtDepth,
      terrainExaggeration: exaggeration,
      // The server's effective terrain contract puts tidal-water samples at
      // or below local sea level. Retain that footprint independently of the
      // rendered z values so the water renderer can place satellite colour on
      // a shallow optical-only surface while true bathymetry stays untouched.
      ...(() => {
        const terrainWaterMask = Uint8Array.from(heightmap, elevation => (
          Number.isFinite(elevation) && elevation <= 0 ? 1 : 0
        ));
        return {
          terrainWaterMask,
          terrainWaterMaskKey: terrainWaterMaskKey(terrainWaterMask),
        };
      })(),
      // Seam repair is response-dependent: the same physical tile can get a
      // different boundary when the rendered LOD of its neighbor changes.
      // Keep the exact payload that produced this mesh so reconciliation can
      // replace stale geometry without requiring a page refresh.
      heightmapPayload: tile.heightmap,
      terrainColorAttribute: geometry.getAttribute('color'),
    });
    // A revived grid carries the elevations it was parked with. Rewriting them
    // in place restores this response's seam repair without paying for index
    // assembly or attribute allocation again.
    if (refreshElevations) updateTerrainMeshHeightmap(mesh, tile);
    attachScatter(mesh, tile, heightmap);
    return mesh;
  }

  return function buildTerrainMesh(tile) {
    const resolution = tile.resolution;
    const heightmap = terrainTileSamples(tile);
    const parked = geometryCache?.take(tile) ?? null;
    if (parked) {
      return finishMesh({
        tile,
        geometry: parked.geometry,
        heightmap,
        resolution,
        // Derive from this response, not the parked one: the refresh rebuilds
        // skirts from userData, so a stale depth would bake in wrong skirts.
        skirtDepth: skirtDepthFor(tile),
        refreshElevations: !parked.payloadMatches,
      });
    }
    const [xMin, yMin, xMax, yMax] = tile.bbox;
    const surfaceVertexCount = resolution * resolution;
    // Each edge gets an independent top/bottom pair per surface vertex. The
    // resulting vertical skirts hide sub-pixel cracks between separately
    // rasterized tiles without changing the repaired surface edge itself.
    const skirtVertexCount = resolution * 2 * 4;
    const vertexCount = surfaceVertexCount + skirtVertexCount;
    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);

    for (let row = 0; row < resolution; row++) for (let column = 0; column < resolution; column++) {
      const index = row * resolution + column;
      const elevation = heightmap[index];
      positions[index * 3] = xMin + (column / (resolution - 1)) * (xMax - xMin);
      positions[index * 3 + 1] = yMin + (row / (resolution - 1)) * (yMax - yMin);
      positions[index * 3 + 2] = elevation * exaggeration;
      uvs[index * 2] = column / (resolution - 1);
      uvs[index * 2 + 1] = row / (resolution - 1);
      const color = elevationColor(elevation);
      colors.set([color.r, color.g, color.b], index * 3);
    }

    const indices = [];
    for (let row = 0; row < resolution - 1; row++) for (let column = 0; column < resolution - 1; column++) {
      const a = row * resolution + column, b = a + 1, d = a + resolution, f = d + 1;
      indices.push(a, b, d, b, f, d);
    }

    const skirtDepth = skirtDepthFor(tile);
    let nextVertex = surfaceVertexCount;
    function appendSkirt(surfaceIndices, outwardWinding) {
      const skirtStart = nextVertex;
      for (const surfaceIndex of surfaceIndices) {
        const top = nextVertex++;
        const bottom = nextVertex++;
        for (let component = 0; component < 3; component++) {
          const value = positions[surfaceIndex * 3 + component];
          positions[top * 3 + component] = value;
          positions[bottom * 3 + component] = value;
          colors[top * 3 + component] = colors[surfaceIndex * 3 + component];
          colors[bottom * 3 + component] = colors[surfaceIndex * 3 + component];
        }
        positions[bottom * 3 + 2] -= skirtDepth;
        uvs[top * 2] = uvs[surfaceIndex * 2];
        uvs[top * 2 + 1] = uvs[surfaceIndex * 2 + 1];
        uvs[bottom * 2] = uvs[surfaceIndex * 2];
        uvs[bottom * 2 + 1] = uvs[surfaceIndex * 2 + 1];
      }
      for (let index = 0; index < surfaceIndices.length - 1; index++) {
        const topA = skirtStart + index * 2;
        const bottomA = topA + 1;
        const topB = topA + 2;
        const bottomB = topA + 3;
        if (outwardWinding) {
          indices.push(topA, bottomA, topB, topB, bottomA, bottomB);
        } else {
          indices.push(topA, topB, bottomA, topB, bottomB, bottomA);
        }
      }
    }
    const [south, north, west, east] = terrainEdgeIndices(resolution);
    appendSkirt(south, true);
    appendSkirt(north, false);
    appendSkirt(west, false);
    appendSkirt(east, true);

    if (indices.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const terrainColorAttribute = new THREE.BufferAttribute(colors, 3);
    geometry.setAttribute('color', terrainColorAttribute);
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return finishMesh({ tile, geometry, heightmap, resolution, skirtDepth });
  };
}
