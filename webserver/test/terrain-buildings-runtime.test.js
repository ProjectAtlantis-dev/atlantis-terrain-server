import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
  applyBuildingColors,
  buildBuildingsGeometry,
  createTerrainBuildingsRuntime,
} from '../terrain-buildings-runtime.js';

const squareBuilding = {
  id: '0600NUK_TEST_1',
  groundZ: 10,
  ring: [
    [0, 0, 20],
    [10, 0, 20],
    [10, 10, 22],
    [0, 10, 22],
  ],
};

test('buildBuildingsGeometry extrudes a square into roof + 4 walls', () => {
  const geometry = buildBuildingsGeometry([squareBuilding]);
  assert.ok(geometry);
  // 4 roof verts + 4 walls x 4 verts.
  assert.equal(geometry.getAttribute('position').count, 20);
  // Roof cap 2 tris + 4 walls x 2 tris = 10 tris.
  assert.equal(geometry.getIndex().count, 30);
  const positions = geometry.getAttribute('position');
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let index = 0; index < positions.count; index++) {
    minZ = Math.min(minZ, positions.getZ(index));
    maxZ = Math.max(maxZ, positions.getZ(index));
  }
  assert.equal(maxZ, 22);           // per-vertex roof height preserved
  assert.equal(minZ, 10 - 1.5);     // base sunk below sampled ground
  // Normals are required: the aerial-perspective relight pass renders
  // normal-less geometry black.
  const normals = geometry.getAttribute('normal');
  assert.ok(normals);
  assert.equal(normals.count, 20);
});

test('buildBuildingsGeometry applies frame offsets and handles CW rings', () => {
  const clockwise = {
    ...squareBuilding,
    ring: [...squareBuilding.ring].reverse(),
  };
  const geometry = buildBuildingsGeometry([clockwise], { offsetX: 100, offsetY: -50 });
  assert.ok(geometry);
  const positions = geometry.getAttribute('position');
  const xs = [];
  for (let index = 0; index < positions.count; index++) xs.push(positions.getX(index));
  assert.equal(Math.min(...xs), 100);
  assert.equal(Math.max(...xs), 110);
});

test('buildBuildingsGeometry uses sampled roof color and shaded wall variants', () => {
  const geometry = buildBuildingsGeometry([{
    ...squareBuilding,
    color: [204, 102, 51],
    colorVersion: '12-1-1:v1',
  }]);
  const colors = geometry.getAttribute('color');
  assert.ok(Math.abs(colors.getX(0) - 0.8) < 1e-6);
  assert.ok(Math.abs(colors.getY(0) - 0.4) < 1e-6);
  assert.ok(Math.abs(colors.getZ(0) - 0.2) < 1e-6);
  assert.ok(colors.getX(4) < colors.getX(0));
  assert.ok(colors.getY(4) < colors.getY(0));
});

test('buildBuildingsGeometry skips degenerate rings', () => {
  assert.equal(buildBuildingsGeometry([{ id: 'x', groundZ: 0, ring: [[0, 0, 1], [1, 0, 1]] }]), null);
  assert.equal(buildBuildingsGeometry([]), null);
});

test('buildBuildingsGeometry reports triangulation failures before skipping', () => {
  const errors = [];
  const original = THREE.ShapeUtils.triangulateShape;
  THREE.ShapeUtils.triangulateShape = () => {
    throw new Error('bad building contour');
  };
  try {
    assert.equal(buildBuildingsGeometry([squareBuilding], {
      onError: (error, building) => errors.push([error.message, building.id]),
    }), null);
  } finally {
    THREE.ShapeUtils.triangulateShape = original;
  }
  assert.deepEqual(errors, [['bad building contour', squareBuilding.id]]);
});

test('runtime reconciles Flask tile-response buildings without an HTTP fetch', () => {
  let fetches = 0;
  const runtime = createTerrainBuildingsRuntime({
    terrainRoot: { add() {}, remove() {} },
    pipelineState: {
      originX: 1000, originY: 2000, frameOffsetX: 5, frameOffsetY: -5,
    },
    fetchImpl: async () => {
      fetches += 1;
      throw new Error('unexpected building fetch');
    },
  });

  runtime.reconcile([squareBuilding]);

  assert.ok(runtime.getMesh());
  assert.equal(fetches, 0);
  assert.equal(runtime.start, undefined);
  assert.equal(runtime.refresh, undefined);
});

test('a binary flat ring builds the same geometry as the JSON ring', () => {
  const ring = [[0, 0, 5], [10, 0, 5], [10, 10, 5], [0, 10, 5]];
  const fromJson = buildBuildingsGeometry(
    [{ id: 'b', groundZ: 0, ring }], { exaggeration: 1 },
  );
  const fromBinary = buildBuildingsGeometry(
    [{
      id: 'b', groundZ: 0,
      ringXYZ: new Float32Array(ring.flat()),
    }], { exaggeration: 1 },
  );
  assert.ok(fromJson && fromBinary);
  assert.deepEqual(
    [...fromBinary.getAttribute('position').array],
    [...fromJson.getAttribute('position').array],
  );
  assert.deepEqual([...fromBinary.getIndex().array], [...fromJson.getIndex().array]);
});

test('a flat ring with fewer than three points is skipped', () => {
  assert.equal(
    buildBuildingsGeometry([{ id: 'b', groundZ: 0, ringXYZ: new Float32Array([0, 0, 1, 1, 0, 1]) }]),
    null,
  );
});

test('roof colour is rewritten in place without rebuilding geometry', () => {
  const buildings = [
    { id: 'a', groundZ: 0, ring: [[0, 0, 5], [10, 0, 5], [10, 10, 5], [0, 10, 5]] },
    { id: 'b', groundZ: 0, ring: [[20, 20, 5], [30, 20, 5], [30, 30, 5]] },
  ];
  const geometry = buildBuildingsGeometry(buildings, {});
  // Every building that produced vertices is addressable for later recolouring.
  assert.equal(geometry.userData.buildingRanges.length, 2);
  const positionsBefore = [...geometry.getAttribute('position').array];

  const recoloured = applyBuildingColors(geometry, [
    { ...buildings[0], color: [255, 0, 0], colorVersion: 'v2' },
    buildings[1],
  ]);
  assert.equal(recoloured, true);
  // Geometry is untouched — only the colour attribute moved.
  assert.deepEqual([...geometry.getAttribute('position').array], positionsBefore);

  const { start } = geometry.userData.buildingRanges[0];
  const colors = geometry.getAttribute('color').array;
  assert.ok(colors[start * 3] > colors[start * 3 + 1]);
  assert.ok(colors[start * 3] > colors[start * 3 + 2]);
});

test('re-applying identical colours reports no change so nothing re-uploads', () => {
  const buildings = [{
    id: 'a', groundZ: 0, color: [120, 90, 60], colorVersion: 'v1',
    ring: [[0, 0, 5], [10, 0, 5], [10, 10, 5], [0, 10, 5]],
  }];
  const geometry = buildBuildingsGeometry(buildings, {});
  assert.equal(applyBuildingColors(geometry, buildings), false);
});

test('walls keep their per-edge shading through a colour update', () => {
  const buildings = [{
    id: 'a', groundZ: 0, ring: [[0, 0, 5], [10, 0, 5], [10, 10, 5], [0, 10, 5]],
  }];
  const geometry = buildBuildingsGeometry(buildings, {});
  applyBuildingColors(geometry, [{ ...buildings[0], color: [200, 200, 200] }]);
  const shades = geometry.userData.buildingShades;
  const colors = geometry.getAttribute('color').array;
  // Roof vertices are unshaded; at least one wall vertex is darker than them.
  const roofValue = colors[0];
  let sawDarkerWall = false;
  for (let vertex = 0; vertex < shades.length; vertex++) {
    if (shades[vertex] < 1 && colors[vertex * 3] < roofValue) sawDarkerWall = true;
  }
  assert.ok(sawDarkerWall);
});

test('a colour update for an unknown building is ignored', () => {
  const buildings = [{
    id: 'a', groundZ: 0, ring: [[0, 0, 5], [10, 0, 5], [10, 10, 5], [0, 10, 5]],
  }];
  const geometry = buildBuildingsGeometry(buildings, {});
  assert.equal(
    applyBuildingColors(geometry, [{ id: 'ghost', groundZ: 0, color: [255, 0, 0] }]),
    false,
  );
});
