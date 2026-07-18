import * as THREE from 'three';

import { createTerrainVectorLayerRuntime } from './terrain-vector-layer-runtime.js';

// Road and path ribbons from Asiaq Teknisk Grundkort centerlines
// (/api/roads). Each polyline carries per-vertex surveyed surface elevations;
// the ribbon follows them, lifted slightly so it sits on our coarser DEM
// terrain instead of z-fighting with it.

const ROAD_LIFT_M = 0.5;

// kind/category → flat RGB. Asphalt reads dark, gravel and trails lighter.
const ROAD_COLORS = {
  'road:Hovedvej': [0.20, 0.20, 0.21],
  'road:Lokalvej': [0.24, 0.24, 0.25],
  'road:Adgangsvej': [0.28, 0.28, 0.29],
  'road:Kørespor': [0.38, 0.36, 0.33],
  'road:Under anlæg': [0.42, 0.40, 0.36],
  'road:Tunnel': [0.16, 0.16, 0.17],
  'path:Anlagt': [0.40, 0.39, 0.37],
  'path:Natursti': [0.48, 0.44, 0.38],
};
const DEFAULT_COLOR = [0.30, 0.30, 0.30];

export function buildRoadsGeometry(roads, {
  offsetX = 0, offsetY = 0, exaggeration = 1,
} = {}) {
  const positions = [];
  const colors = [];
  const indices = [];

  for (const road of roads) {
    const path = road.path;
    if (!Array.isArray(path) || path.length < 2) continue;
    const halfWidth = (Number.isFinite(road.widthM) ? road.widthM : 4) / 2;
    const color = ROAD_COLORS[`${road.kind}:${road.category}`] ?? DEFAULT_COLOR;

    const xs = path.map(point => point[0] + offsetX);
    const ys = path.map(point => point[1] + offsetY);
    const zs = path.map(point => (point[2] + ROAD_LIFT_M) * exaggeration);

    const stripStart = positions.length / 3;
    let emitted = 0;
    let lastX = null;
    let lastY = null;
    for (let index = 0; index < xs.length; index++) {
      if (lastX !== null && Math.hypot(xs[index] - lastX, ys[index] - lastY) < 1e-6) {
        continue; // duplicate survey point
      }
      // Averaged direction of the adjacent segments (ends use their only one).
      const previous = Math.max(0, index - 1);
      const next = Math.min(xs.length - 1, index + 1);
      const dirX = xs[next] - xs[previous];
      const dirY = ys[next] - ys[previous];
      const length = Math.hypot(dirX, dirY);
      const perpX = length < 1e-9 ? 0 : -dirY / length;
      const perpY = length < 1e-9 ? 1 : dirX / length;
      positions.push(
        xs[index] + perpX * halfWidth, ys[index] + perpY * halfWidth, zs[index],
        xs[index] - perpX * halfWidth, ys[index] - perpY * halfWidth, zs[index],
      );
      colors.push(...color, ...color);
      emitted++;
      lastX = xs[index];
      lastY = ys[index];
    }
    for (let segment = 0; segment < emitted - 1; segment++) {
      const left = stripStart + segment * 2;
      indices.push(left, left + 1, left + 3, left, left + 3, left + 2);
    }
  }

  if (indices.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
  geometry.setIndex(indices);
  // See terrain-buildings-runtime.js: the relight pass needs real normals.
  geometry.computeVertexNormals();
  return geometry;
}

export function createTerrainRoadsRuntime({
  terrainRoot, pipelineState, exaggeration = 1,
  bootLog, onMutated, requestRender, fetchImpl,
}) {
  return createTerrainVectorLayerRuntime({
    terrainRoot, pipelineState,
    endpoint: '/api/roads', itemsKey: 'roads', logLabel: 'Roads',
    buildGeometry: (items, { offsetX, offsetY }) =>
      buildRoadsGeometry(items, { offsetX, offsetY, exaggeration }),
    bootLog, onMutated, requestRender, fetchImpl,
  });
}
