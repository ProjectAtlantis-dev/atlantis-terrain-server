import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
  applyBuildingColors,
  createStableApplyScheduler,
  buildBuildingsGeometry,
  createTerrainBuildingsRuntime,
} from '../terrain-buildings-runtime.js';
import { createTerrainVectorLayerRuntime } from '../terrain-vector-layer-runtime.js';

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

test('runtime keeps direct reconcile while exposing independent fetch controls', () => {
  let fetches = 0;
  const runtime = createTerrainBuildingsRuntime({
    terrainRoot: { add() {}, remove() {} },
    pipelineState: {
      ready: false, originX: 1000, originY: 2000, frameOffsetX: 5, frameOffsetY: -5,
    },
    fetchImpl: async () => {
      fetches += 1;
      throw new Error('unexpected building fetch');
    },
  });

  runtime.reconcile([squareBuilding]);

  assert.ok(runtime.getMesh());
  assert.equal(fetches, 0);
  assert.equal(typeof runtime.start, 'function');
  assert.equal(typeof runtime.refresh, 'function');
});

test('runtime fetches buildings separately and defers their mesh application', async () => {
  const ring = new Float32Array(squareBuilding.ring.flat());
  const headerBytes = new TextEncoder().encode(JSON.stringify({
    tiles: [], count: 1,
    buildings: [{ id: squareBuilding.id, groundZ: 10, ringBytes: ring.byteLength }],
  }));
  const paddedHeaderLength = headerBytes.length + (-(headerBytes.length + 4) & 3);
  const buffer = new ArrayBuffer(4 + paddedHeaderLength + ring.byteLength);
  new DataView(buffer).setUint32(0, paddedHeaderLength, true);
  new Uint8Array(buffer, 4, headerBytes.length).set(headerBytes);
  new Uint8Array(buffer, 4 + headerBytes.length, paddedHeaderLength - headerBytes.length).fill(32);
  new Float32Array(buffer, 4 + paddedHeaderLength).set(ring);

  let requestedUrl = null;
  let deferredApply = null;
  const runtime = createTerrainBuildingsRuntime({
    terrainRoot: { add() {}, remove() {} },
    pipelineState: {
      ready: true, frameOffsetReady: true,
      originX: 1000, originY: 2000, frameOffsetX: 5, frameOffsetY: -5,
      lastFetchX: 1100, lastFetchY: 2100,
    },
    fetchImpl: async url => {
      requestedUrl = url;
      return { ok: true, arrayBuffer: async () => buffer };
    },
    scheduleApply: callback => { deferredApply = callback; },
  });

  await runtime.start();
  runtime.stop();
  assert.match(requestedUrl, /^\/api\/buildings\?sx=1100&sy=2100&range=9000/);
  assert.equal(runtime.getMesh(), null);
  deferredApply();
  assert.ok(runtime.getMesh());
});

test('runtime disables the optional buildings route after a 404', async () => {
  let fetches = 0;
  const logs = [];
  const runtime = createTerrainBuildingsRuntime({
    terrainRoot: { add() {}, remove() {} },
    pipelineState: {
      ready: true, frameOffsetReady: true,
      originX: 1000, originY: 2000, frameOffsetX: 0, frameOffsetY: 0,
      lastFetchX: 1100, lastFetchY: 2100,
    },
    fetchImpl: async () => {
      fetches += 1;
      return { ok: false, status: 404 };
    },
    bootLog: (...args) => logs.push(args),
  });

  await runtime.start();
  await runtime.refresh();
  runtime.stop();

  assert.equal(fetches, 1);
  assert.deepEqual(runtime.getTransportStatus(), {
    unavailable: true,
    consecutiveFailures: 0,
    retryAtMs: 0,
  });
  assert.deepEqual(logs, [[
    'buildings.unavailable',
    { endpoint: '/api/buildings', status: 404 },
    'warn',
  ]]);
});

test('a stationary camera polls loading buildings until the server publishes them', async t => {
  let poll;
  t.mock.method(globalThis, 'setInterval', callback => { poll = callback; return 1; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  let fetches = 0;
  const runtime = createTerrainBuildingsRuntime({
    terrainRoot: { add() {}, remove() {} },
    pipelineState: {
      ready: true, frameOffsetReady: true,
      originX: 1000, originY: 2000, frameOffsetX: 0, frameOffsetY: 0,
      lastFetchX: 1100, lastFetchY: 2100,
    },
    scheduleApply: callback => callback(),
    fetchImpl: async () => {
      fetches += 1;
      const loading = fetches === 1;
      const header = new TextEncoder().encode(JSON.stringify({
        tiles: [], buildings: loading ? [] : [squareBuilding],
        count: loading ? 0 : 1, shouldPoll: loading,
        buildingsStatus: loading ? 'loading' : 'ready',
      }));
      const padded = header.length + (-(header.length + 4) & 3);
      const buffer = new ArrayBuffer(4 + padded);
      new DataView(buffer).setUint32(0, padded, true);
      new Uint8Array(buffer, 4).fill(32);
      new Uint8Array(buffer, 4, header.length).set(header);
      return { ok: true, arrayBuffer: async () => buffer };
    },
  });
  try {
    await runtime.start();
    assert.equal(runtime.getMesh(), null);
    await poll();
    assert.equal(fetches, 2);
    assert.ok(runtime.getMesh(), 'the buildings arrive without moving the camera');
    await poll();
    assert.equal(fetches, 2, 'a completed view returns to distance-based fetching');
  } finally {
    runtime.stop();
  }
});

test('shared vector runtime backs off transient failures', async () => {
  let now = 100;
  let fetches = 0;
  const logs = [];
  const runtime = createTerrainVectorLayerRuntime({
    terrainRoot: { add() {}, remove() {} },
    pipelineState: {
      ready: true, frameOffsetReady: true,
      originX: 1000, originY: 2000, frameOffsetX: 0, frameOffsetY: 0,
      lastFetchX: 1100, lastFetchY: 2100,
    },
    endpoint: '/api/example',
    itemsKey: 'items',
    logLabel: 'Example',
    buildGeometry: () => null,
    pollMs: 2000,
    retryMaxMs: 8000,
    now: () => now,
    fetchImpl: async () => {
      fetches += 1;
      return { ok: false, status: 503 };
    },
    bootLog: (...args) => logs.push(args),
  });

  await runtime.start();
  now = 2099;
  await runtime.refresh();
  assert.equal(fetches, 1);
  now = 2100;
  await runtime.refresh();
  runtime.stop();

  assert.equal(fetches, 2);
  assert.deepEqual(logs.map(([, details]) => details.retryInMs), [2000, 4000]);
  assert.deepEqual(runtime.getTransportStatus(), {
    unavailable: false,
    consecutiveFailures: 2,
    retryAtMs: 6100,
  });
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

test('a moving camera still gets its buildings once the deadline passes', () => {
  let clock = 0;
  const pending = [];
  let applied = 0;
  const scheduleApply = createStableApplyScheduler({
    // Never still: every poll reports a new position, as in continuous flight.
    readPose: () => [clock, 0],
    stableMs: 350,
    maxDeferMs: 1200,
    now: () => clock,
    schedule: (callback, delay) => pending.push({ callback, at: clock + delay }),
  });

  scheduleApply(() => { applied += 1; });
  // Run the timer wheel forward well past the deadline, moving throughout.
  for (let step = 0; step < 40 && applied === 0; step++) {
    const next = pending.shift();
    if (!next) break;
    clock = Math.max(clock + 50, next.at);
    next.callback();
  }
  assert.equal(applied, 1, 'a permanently moving camera must still be served');
  assert.ok(clock >= 1200, 'and only after the deadline, not immediately');
});

test('a camera that settles applies on the stable window, not the deadline', () => {
  let clock = 0;
  const pending = [];
  let applied = 0;
  const scheduleApply = createStableApplyScheduler({
    readPose: () => [7, 7],           // perfectly still
    stableMs: 350,
    maxDeferMs: 1200,
    now: () => clock,
    schedule: (callback, delay) => pending.push({ callback, at: clock + delay }),
  });

  scheduleApply(() => { applied += 1; });
  for (let step = 0; step < 40 && applied === 0; step++) {
    const next = pending.shift();
    if (!next) break;
    clock = next.at;
    next.callback();
  }
  assert.equal(applied, 1);
  assert.ok(clock < 1200, 'a still camera must not wait for the deadline');
});
