import * as THREE from 'three';

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

export function createTerrainMeshBuilder({ exaggeration, attachScatter }) {
  return function buildTerrainMesh(tile) {
    const resolution = tile.resolution;
    const heightmap = decodeTerrainHeightmap(tile.heightmap);
    const [xMin, yMin, xMax, yMax] = tile.bbox;
    const positions = new Float32Array(resolution * resolution * 3);
    const colors = new Float32Array(resolution * resolution * 3);
    const uvs = new Float32Array(resolution * resolution * 2);

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
    if (indices.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff, side: THREE.FrontSide, vertexColors: true,
    });
    const mesh = new THREE.Mesh(geometry, material);
    Object.assign(mesh.userData, {
      tileId: tile.id, bbox: tile.bbox,
    });
    attachScatter(mesh, tile, heightmap);
    return mesh;
  };
}
