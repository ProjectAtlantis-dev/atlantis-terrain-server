import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBuildingsGeometry, createTerrainBuildingsRuntime } from './terrain-buildings-runtime.js';

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

test('buildBuildingsGeometry skips degenerate rings', () => {
  assert.equal(buildBuildingsGeometry([{ id: 'x', groundZ: 0, ring: [[0, 0, 1], [1, 0, 1]] }]), null);
  assert.equal(buildBuildingsGeometry([]), null);
});

test('runtime fetches once frame is ready and skips small moves', async () => {
  const calls = [];
  const pipelineState = {
    ready: true, frameOffsetReady: true,
    originX: 1000, originY: 2000, frameOffsetX: 5, frameOffsetY: -5,
    lastFetchX: 1000, lastFetchY: 2000,
  };
  const terrainRoot = { add() {}, remove() {} };
  const runtime = createTerrainBuildingsRuntime({
    terrainRoot, pipelineState,
    fetchImpl: async url => {
      calls.push(url);
      return { ok: true, json: async () => ({ buildings: [squareBuilding], count: 1 }) };
    },
  });
  await runtime.start();
  runtime.stop();
  assert.equal(calls.length, 1);
  assert.match(calls[0], /sx=1000&sy=2000/);
  assert.match(calls[0], /ox=1000&oy=2000/);
  assert.ok(runtime.getMesh());

  // Camera barely moved: no refetch.
  pipelineState.lastFetchX = 1400;
  await runtime.start();
  runtime.stop();
  assert.equal(calls.length, 1);

  // Camera moved beyond the refetch distance: refetch.
  pipelineState.lastFetchX = 30000;
  await runtime.start();
  runtime.stop();
  assert.equal(calls.length, 2);
});
