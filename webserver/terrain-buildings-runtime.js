import * as THREE from 'three';

import { createTerrainVectorLayerRuntime } from './terrain-vector-layer-runtime.js';

// Grey extruded buildings from Asiaq Teknisk Grundkort footprints. Flask
// reads them from the shared catalog while processing /api/tiles. Rings
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
  offsetX = 0, offsetY = 0, exaggeration = 1, onError = () => {},
} = {}) {
  const positions = [];
  const colors = [];
  const indices = [];
  // Per-vertex shade and per-building vertex spans, so a roof colour that
  // changes later can be rewritten in place instead of re-triangulating the
  // whole settlement. Colour is presentation; it must not invalidate geometry.
  const shades = [];
  const ranges = [];

  for (const building of buildings) {
    // Binary transport hands over a flat xyz Float32Array view; the JSON path
    // still produces [[x, y, z], ...]. Both fan out to the same three arrays.
    const flat = building.ringXYZ;
    const ring = building.ring;
    const pointCount = flat instanceof Float32Array
      ? Math.floor(flat.length / 3)
      : (Array.isArray(ring) ? ring.length : 0);
    if (pointCount < 3) continue;

    let xs = new Array(pointCount);
    let ys = new Array(pointCount);
    let zs = new Array(pointCount);
    for (let index = 0; index < pointCount; index++) {
      const x = flat ? flat[index * 3] : ring[index][0];
      const y = flat ? flat[index * 3 + 1] : ring[index][1];
      const z = flat ? flat[index * 3 + 2] : ring[index][2];
      xs[index] = x + offsetX;
      ys[index] = y + offsetY;
      zs[index] = z * exaggeration;
    }
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
    } catch (error) {
      onError(error, building);
      continue;
    }
    const buildingStart = positions.length / 3;
    const roofStart = buildingStart;
    for (let index = 0; index < xs.length; index++) {
      positions.push(xs[index], ys[index], zs[index]);
      colors.push(...roofColor);
      shades.push(1);
    }
    for (const [a, b, c] of triangles) {
      indices.push(roofStart + a, roofStart + b, roofStart + c);
    }

    // Walls: one flat-shaded quad per edge, ground to per-vertex roof Z.
    for (let index = 0; index < xs.length; index++) {
      const next = (index + 1) % xs.length;
      // Rounded here because it is stored in a Float32Array and read back by
      // applyBuildingColors; using the unrounded value would make the rebuilt
      // colour differ from the recomputed one in the last bit, and every
      // colour pass would then look like a change.
      const shade = Math.fround(
        shadeForEdge(xs[next] - xs[index], ys[next] - ys[index]),
      );
      const wallStart = positions.length / 3;
      positions.push(
        xs[index], ys[index], baseZ,
        xs[next], ys[next], baseZ,
        xs[next], ys[next], zs[next],
        xs[index], ys[index], zs[index],
      );
      const wallColor = roofColor.map(channel => Math.max(0, Math.min(1, channel * shade)));
      for (let corner = 0; corner < 4; corner++) {
        colors.push(...wallColor);
        shades.push(shade);
      }
      indices.push(wallStart, wallStart + 1, wallStart + 2, wallStart, wallStart + 2, wallStart + 3);
    }
    const vertexCount = positions.length / 3 - buildingStart;
    if (vertexCount > 0) {
      ranges.push({ id: building.id, start: buildingStart, count: vertexCount });
    }
  }

  if (indices.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
  geometry.setIndex(indices);
  geometry.userData.buildingRanges = ranges;
  geometry.userData.buildingShades = new Float32Array(shades);
  // The aerial-perspective passes (NormalPass / MRT normalView) relight the
  // scene from the normal buffer; geometry without normals renders black.
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Rewrite roof colours in place on an existing merged mesh.
 *
 * Roof colour arrives late and keeps changing as imagery streams in. Treating
 * that as a geometry change re-triangulated every footprint in the settlement
 * — 19ms and an 88k-vertex re-upload for Nuuk, once a second. Colour is a
 * vertex attribute, so it can simply be written.
 *
 * Returns true when anything actually changed.
 */
export function applyBuildingColors(geometry, buildings) {
  const ranges = geometry?.userData?.buildingRanges;
  const shades = geometry?.userData?.buildingShades;
  const attribute = geometry?.getAttribute?.('color');
  if (!ranges || !shades || !attribute) return false;

  const byId = new Map();
  for (const building of buildings) byId.set(building.id, building);
  const array = attribute.array;
  let changed = false;
  for (const { id, start, count } of ranges) {
    const building = byId.get(id);
    if (!building) continue;
    const roofColor = normalizedBuildingColor(building);
    for (let vertex = start; vertex < start + count; vertex++) {
      const shade = shades[vertex];
      for (let channel = 0; channel < 3; channel++) {
        // The attribute is float32, so the stored value is rounded on write.
        // Comparing against the unrounded double would report a change every
        // time and re-upload the buffer on every poll.
        const value = Math.fround(
          Math.max(0, Math.min(1, roofColor[channel] * shade)),
        );
        const index = vertex * 3 + channel;
        if (array[index] !== value) {
          array[index] = value;
          changed = true;
        }
      }
    }
  }
  if (changed) attribute.needsUpdate = true;
  return changed;
}

export function createTerrainBuildingsRuntime({
  terrainRoot, pipelineState, exaggeration = 1, bootLog = () => {},
  onMutated, requestRender,
}) {
  const layer = createTerrainVectorLayerRuntime({
    terrainRoot, pipelineState,
    endpoint: null, itemsKey: 'buildings', logLabel: 'Buildings',
    // Identity only — colour is applied through updateColors below.
    buildKeyForItem: item => item.id,
    updateColors: applyBuildingColors,
    buildGeometry: (items, { offsetX, offsetY }) =>
      buildBuildingsGeometry(items, {
        offsetX, offsetY, exaggeration,
        onError: (error, building) => bootLog('buildings.geometry.error', {
          buildingId: building?.id ?? null,
          message: error?.message ?? String(error),
        }, 'warn'),
      }),
    onMutated, requestRender,
  });
  return {
    reconcile: layer.reconcile,
    setVisible: layer.setVisible,
    getVisible: layer.getVisible,
    getMesh: layer.getMesh,
  };
}
