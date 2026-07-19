import * as THREE from 'three';

// Radially-graded water grid in the terrainRoot local frame (xy horizontal,
// z up): ~2 m spacing at the centre, growing geometrically to rMax. The mesh
// follows the camera each frame and world-space displacement sampling makes
// the vertex distribution invisible. Port of ~/work/ocean2 main.js, rotated
// from that scene's y-up onto our z-up tangent frame (winding flipped so the
// surface stays front-facing from above).
export function buildRadialGridGeometry({
  rings = 512,
  sectors = 720,
  rMin = 1.2,
  rMax = 120000,
} = {}) {
  const positions = new Float32Array((rings + 1) * sectors * 3);
  const growth = Math.pow(rMax / rMin, 1 / (rings - 1));
  let p = 0;
  for (let i = 0; i <= rings; i++) {
    const r = i === 0 ? 0 : rMin * Math.pow(growth, i - 1);
    for (let j = 0; j < sectors; j++) {
      const a = (j / sectors) * Math.PI * 2;
      positions[p++] = Math.cos(a) * r;
      positions[p++] = Math.sin(a) * r;
      positions[p++] = 0;
    }
  }
  const indices = new Uint32Array(rings * sectors * 6);
  let q = 0;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < sectors; j++) {
      const j1 = (j + 1) % sectors;
      const a = i * sectors + j, b = i * sectors + j1;
      const c = (i + 1) * sectors + j, e = (i + 1) * sectors + j1;
      indices[q++] = a; indices[q++] = c; indices[q++] = b;
      indices[q++] = b; indices[q++] = c; indices[q++] = e;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  // Flat +z normals: the relight/aerial-perspective pass reads the normal
  // buffer and renders normal-less geometry black (see memory: sprites,
  // Patria, buildings). Wave normals are shader-side only.
  const normals = new Float32Array(positions.length);
  for (let i = 2; i < normals.length; i += 3) normals[i] = 1;
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
}
