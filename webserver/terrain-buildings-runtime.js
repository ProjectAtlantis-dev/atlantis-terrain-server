import * as THREE from 'three';

import { createTerrainVectorLayerRuntime } from './terrain-vector-layer-runtime.js';

// Grey extruded buildings from Asiaq Teknisk Grundkort footprints. Flask
// reads them from the shared catalog and serves GET /api/buildings. Rings
// arrive origin-relative (same ox/oy
// convention as /api/tiles) with per-vertex surveyed roof elevations; each
// building is extruded from its ingest-sampled ground up to the real roof
// outline. The scene is unlit, so wall shading is baked into vertex colors.

const WALL_BASE_SINK_M = 1.5;      // bury the base so slopes don't leave gaps
const LIGHT_DIR = { x: 0.5, y: -0.85 }; // grid-space sun for wall shading

function shadeForEdge(dx, dy) {
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return 0.55;
  // Outward normal of a CCW ring edge is (dy, -dx).
  const dot = (dy * LIGHT_DIR.x - dx * LIGHT_DIR.y) / length;
  return 0.55 + 0.17 * dot;
}

function normalizedBuildingColor(building) {
  if (!Array.isArray(building.color) || building.color.length < 3) {
    const fallback = roofShade(building.id ?? '');
    return [fallback, fallback, fallback];
  }
  return building.color.slice(0, 3).map(channel =>
    Math.max(0, Math.min(1, Number(channel) / 255)));
}

function roofShade(buildingId) {
  let hash = 0;
  for (let index = 0; index < buildingId.length; index++) {
    hash = (hash * 31 + buildingId.charCodeAt(index)) | 0;
  }
  return 0.72 + ((hash >>> 8) % 100) / 100 * 0.08;
}

export function buildBuildingsGeometry(buildings, {
  offsetX = 0, offsetY = 0, exaggeration = 1,
} = {}) {
  const positions = [];
  const colors = [];
  const indices = [];

  for (const building of buildings) {
    const ring = building.ring;
    if (!Array.isArray(ring) || ring.length < 3) continue;

    let xs = ring.map(point => point[0] + offsetX);
    let ys = ring.map(point => point[1] + offsetY);
    let zs = ring.map(point => point[2] * exaggeration);
    // Signed area > 0 means CCW, which the roof cap and wall winding assume.
    let area = 0;
    for (let index = 0; index < xs.length; index++) {
      const next = (index + 1) % xs.length;
      area += xs[index] * ys[next] - xs[next] * ys[index];
    }
    if (area < 0) {
      xs = xs.reverse(); ys = ys.reverse(); zs = zs.reverse();
    }

    const baseZ = (building.groundZ - WALL_BASE_SINK_M) * exaggeration;
    const roofColor = normalizedBuildingColor(building);

    // Roof cap: triangulate the footprint, lift each vertex to its own roof Z.
    const contour = xs.map((x, index) => new THREE.Vector2(x, ys[index]));
    let triangles;
    try {
      triangles = THREE.ShapeUtils.triangulateShape(contour, []);
    } catch (_) {
      continue;
    }
    const roofStart = positions.length / 3;
    for (let index = 0; index < xs.length; index++) {
      positions.push(xs[index], ys[index], zs[index]);
      colors.push(...roofColor);
    }
    for (const [a, b, c] of triangles) {
      indices.push(roofStart + a, roofStart + b, roofStart + c);
    }

    // Walls: one flat-shaded quad per edge, ground to per-vertex roof Z.
    for (let index = 0; index < xs.length; index++) {
      const next = (index + 1) % xs.length;
      const shade = shadeForEdge(xs[next] - xs[index], ys[next] - ys[index]);
      const wallStart = positions.length / 3;
      positions.push(
        xs[index], ys[index], baseZ,
        xs[next], ys[next], baseZ,
        xs[next], ys[next], zs[next],
        xs[index], ys[index], zs[index],
      );
      const wallColor = roofColor.map(channel => Math.max(0, Math.min(1, channel * shade)));
      for (let corner = 0; corner < 4; corner++) colors.push(...wallColor);
      indices.push(wallStart, wallStart + 1, wallStart + 2, wallStart, wallStart + 2, wallStart + 3);
    }
  }

  if (indices.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
  geometry.setIndex(indices);
  // The aerial-perspective passes (NormalPass / MRT normalView) relight the
  // scene from the normal buffer; geometry without normals renders black.
  geometry.computeVertexNormals();
  return geometry;
}

export function createTerrainBuildingsRuntime({
  terrainRoot, pipelineState, exaggeration = 1,
  endpoint = '/api/buildings',
  bootLog, onMutated, requestRender, fetchImpl,
}) {
  return createTerrainVectorLayerRuntime({
    terrainRoot, pipelineState,
    endpoint, itemsKey: 'buildings', logLabel: 'Buildings',
    buildKeyForItem: item => `${item.id}:${item.colorVersion ?? ''}:${item.color?.join(',') ?? ''}`,
    refreshIntervalMs: 10000,
    buildGeometry: (items, { offsetX, offsetY }) =>
      buildBuildingsGeometry(items, { offsetX, offsetY, exaggeration }),
    bootLog, onMutated, requestRender, fetchImpl,
  });
}
