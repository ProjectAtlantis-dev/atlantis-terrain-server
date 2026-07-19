import assert from 'node:assert/strict';
import test from 'node:test';

import {
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
