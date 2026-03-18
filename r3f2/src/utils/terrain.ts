import * as THREE from 'three';
import { EXAG } from './constants';
import type { TileData, ParsedTileAddress } from '@/types/terrain';

/**
 * Decode a base64-encoded heightmap to Float32Array.
 * Server sends raw float32 bytes in base64.
 */
export function decodeHM(b64: string): Float32Array {
  const raw = atob(b64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return new Float32Array(buf.buffer);
}

/**
 * Elevation-based color for untextured terrain vertices.
 */
export function elevationColor(elevation: number): [number, number, number] {
  const keys: Array<[number, number, number, number]> = [
    [-50, 0.08, 0.15, 0.35],
    [-2, 0.12, 0.22, 0.4],
    [0, 0.18, 0.32, 0.42],
    [5, 0.28, 0.38, 0.22],
    [15, 0.35, 0.42, 0.2],
    [100, 0.45, 0.4, 0.28],
    [200, 0.55, 0.48, 0.35],
    [800, 0.62, 0.58, 0.52],
    [3000, 0.78, 0.76, 0.74],
  ];

  if (elevation <= keys[0][0]) return [keys[0][1], keys[0][2], keys[0][3]];
  if (elevation >= keys[keys.length - 1][0])
    return [
      keys[keys.length - 1][1],
      keys[keys.length - 1][2],
      keys[keys.length - 1][3],
    ];

  for (let i = 0; i < keys.length - 1; i++) {
    if (elevation >= keys[i][0] && elevation < keys[i + 1][0]) {
      const t = (elevation - keys[i][0]) / (keys[i + 1][0] - keys[i][0]);
      return [
        keys[i][1] + (keys[i + 1][1] - keys[i][1]) * t,
        keys[i][2] + (keys[i + 1][2] - keys[i][2]) * t,
        keys[i][3] + (keys[i + 1][3] - keys[i][3]) * t,
      ];
    }
  }
  return [0.5, 0.5, 0.5];
}

/**
 * Parse tile ID "depth-col-row" → { depth, col, row }.
 */
export function parseTileAddress(tileId: string): ParsedTileAddress | null {
  const parts = tileId.split('-');
  if (parts.length !== 3) return null;
  const depth = parseInt(parts[0], 10);
  const col = parseInt(parts[1], 10);
  const row = parseInt(parts[2], 10);
  if (!Number.isFinite(depth) || !Number.isFinite(col) || !Number.isFinite(row))
    return null;
  return { depth, col, row };
}

export function tileIdFromAddress(depth: number, col: number, row: number): string {
  return `${depth}-${col}-${row}`;
}

export function tileDepthFromId(tileId: string): number {
  if (typeof tileId !== 'string') return -1;
  const depth = parseInt(tileId.split('-')[0], 10);
  return Number.isFinite(depth) ? depth : -1;
}

/**
 * Build a THREE.Mesh from tile data.
 * Creates a 65x65 vertex grid with positions, UVs, colors, and indices.
 */
export function buildTileMesh(
  tile: TileData,
  texture: THREE.Texture | null,
  frameOffsetX: number,
  frameOffsetY: number
): THREE.Mesh {
  const hm = decodeHM(tile.heightmap);
  const res = tile.resolution; // 65
  const [xMin, yMin, xMax, yMax] = tile.bbox;

  // Apply frame offset
  const ox = xMin + frameOffsetX;
  const oy = yMin + frameOffsetY;
  const dx = xMax - xMin;
  const dy = yMax - yMin;

  const vertCount = res * res;
  const positions = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const colors = new Float32Array(vertCount * 3);

  for (let r = 0; r < res; r++) {
    for (let c = 0; c < res; c++) {
      const i = r * res + c;
      const elevation = hm[i] * EXAG;

      positions[i * 3] = ox + (c / (res - 1)) * dx;
      positions[i * 3 + 1] = oy + (r / (res - 1)) * dy;
      positions[i * 3 + 2] = elevation;

      uvs[i * 2] = c / (res - 1);
      uvs[i * 2 + 1] = r / (res - 1);

      const [cr, cg, cb] = elevationColor(elevation);
      colors[i * 3] = cr;
      colors[i * 3 + 1] = cg;
      colors[i * 3 + 2] = cb;
    }
  }

  // Build index buffer (two triangles per quad)
  const quads = (res - 1) * (res - 1);
  const indices = new Uint32Array(quads * 6);
  let idx = 0;
  for (let r = 0; r < res - 1; r++) {
    for (let c = 0; c < res - 1; c++) {
      const tl = r * res + c;
      const tr = tl + 1;
      const bl = (r + 1) * res + c;
      const br = bl + 1;
      indices[idx++] = tl;
      indices[idx++] = bl;
      indices[idx++] = tr;
      indices[idx++] = tr;
      indices[idx++] = bl;
      indices[idx++] = br;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();

  // Polygon offset to prevent z-fighting between LOD levels
  const depthOffset = Math.max(0, 14 - tile.depth);

  const material = texture
    ? new THREE.MeshBasicMaterial({
        map: texture,
        polygonOffset: true,
        polygonOffsetFactor: depthOffset,
        polygonOffsetUnits: depthOffset,
      })
    : new THREE.MeshBasicMaterial({
        vertexColors: true,
        polygonOffset: true,
        polygonOffsetFactor: depthOffset,
        polygonOffsetUnits: depthOffset,
      });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `tile-${tile.id}`;
  mesh.userData = {
    tileId: tile.id,
    bbox: [ox, oy, ox + dx, oy + dy],
  };
  mesh.frustumCulled = false; // terrain root handles visibility

  return mesh;
}

/**
 * Apply a texture to an existing terrain mesh.
 */
export function applyTextureToMesh(mesh: THREE.Mesh, texture: THREE.Texture): void {
  const mat = mesh.material as THREE.MeshBasicMaterial;
  mat.map = texture;
  mat.vertexColors = false;
  mat.needsUpdate = true;
}

/**
 * Get all terrain tile meshes from a parent group (for raycasting).
 */
export function getTerrainMeshes(terrainRoot: THREE.Group): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  terrainRoot.traverse((obj) => {
    if (
      (obj as THREE.Mesh).isMesh &&
      obj.userData.tileId &&
      !(obj.userData as Record<string, unknown>).isHouse &&
      !(obj.userData as Record<string, unknown>).isVehicle
    ) {
      meshes.push(obj as THREE.Mesh);
    }
  });
  return meshes;
}
