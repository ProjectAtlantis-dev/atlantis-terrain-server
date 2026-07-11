import assert from 'node:assert/strict';
import test from 'node:test';

import {
  headingForward2D,
  priorityHeading,
  terrainTilePriority,
} from './terrain-priority.js';
import { compassHeading } from './terrain-hud.js';
import { applyMapDrag } from './terrain-controls.js';
import { stepSuspension, stepVehicleDrive } from './terrain-vehicle.js';
import { scoreTextureTiles, textureRetryDelay } from './terrain-tile-runtime.js';
import { createTextureStreamer } from './terrain-texture-streamer.js';
import { createTileLifecycle } from './terrain-tile-lifecycle.js';

test('cardinal headings use the vehicle convention', () => {
  const cases = [
    [0, 0, 1],
    [Math.PI / 2, -1, 0],
    [Math.PI, 0, -1],
    [-Math.PI / 2, 1, 0],
  ];
  for (const [heading, x, y] of cases) {
    const actual = headingForward2D(heading);
    assert.ok(Math.abs(actual.x - x) < 1e-12);
    assert.ok(Math.abs(actual.y - y) < 1e-12);
  }
});

test('stationary vehicle heading wins over orbiting camera yaw', () => {
  assert.equal(priorityHeading(true, 1.25, -0.75), 1.25);
  assert.equal(priorityHeading(false, 1.25, -0.75), -0.75);
});

test('tile ahead of vehicle is hotter than tile behind it', () => {
  const options = {
    cameraX: 0,
    cameraY: 0,
    heading: 0,
    usePitch: false,
    fovDeg: 60,
    aspect: 16 / 9,
  };
  const ahead = terrainTilePriority({ bbox: [-50, 4950, 50, 5050] }, options);
  const behind = terrainTilePriority({ bbox: [-50, -5050, 50, -4950] }, options);
  assert.ok(ahead < behind);
});

test('HUD compass uses the same heading convention', () => {
  assert.equal(compassHeading(0).compass, 'N');
  assert.equal(compassHeading(Math.PI / 2).compass, 'W');
  assert.equal(compassHeading(-Math.PI / 2).compass, 'E');
});

test('shared map pan respects map yaw', () => {
  globalThis.window = { innerWidth: 1000, innerHeight: 800 };
  const controls = {
    dragButton: 2,
    mapZoom: 1000,
    yaw: 0,
    mapPanEast: 0,
    mapPanNorth: 0,
  };
  assert.equal(
    applyMapDrag(controls, { movementX: 10, movementY: 0 }, 0.002, 1),
    'pan',
  );
  assert.equal(controls.mapPanEast, -20);
  assert.equal(controls.mapPanNorth, 0);
});

test('vehicle drive follows heading and respects speed limit', () => {
  const step = stepVehicleDrive({
    dt: 1, heading: 0, speed: 0, steer: 0, drive: 1,
    groundNormalX: 0, groundNormalY: 0,
    acceleration: 20, brake: 3, steerSpeed: 1.5, maxSpeed: 12,
  });
  assert.equal(step.speed, 12);
  assert.ok(Math.abs(step.deltaX) < 1e-12);
  assert.equal(step.deltaY, 12);
});

test('suspension converges without exceeding velocity limit', () => {
  const step = stepSuspension({
    dt: 0.05, position: 0, target: 10, velocity: 0,
    frequency: 1.8, dampingRatio: 0.72, maxVelocity: 3,
  });
  assert.equal(step.velocity, 3);
  assert.ok(Math.abs(step.position - 0.15) < 1e-12);
});

test('texture retries back off and cap', () => {
  assert.equal(textureRetryDelay(1), 2000);
  assert.equal(textureRetryDelay(2), 3000);
  assert.equal(textureRetryDelay(100), 30000);
});

test('texture candidates are filtered and priority sorted', () => {
  const tiles = [
    { id: 'far', bbox: [0, 0, 1, 1], priority: 9 },
    { id: 'hot', bbox: [0, 0, 1, 1], priority: 1 },
    { id: 'cold', bbox: [0, 0, 1, 1], priority: 20 },
  ];
  const result = scoreTextureTiles(tiles, tile => tile.priority, 10);
  assert.deepEqual(result.scored.map(item => item.tile.id), ['hot', 'far']);
  assert.deepEqual([...result.tileIds], ['far', 'hot', 'cold']);
});

test('shared texture pump records HTTP 202 retry state', async () => {
  const streamer = createTextureStreamer({
    log: () => {},
    fetchImpl: async () => ({ status: 202, ok: false }),
    now: () => 100,
  });
  streamer.pump([{ tile: { id: '12-1-2', bbox: [0, 0, 1, 1] } }], {
    isCovered: () => false,
    onPlaceholder: () => assert.fail('unexpected placeholder'),
    onTexture: () => assert.fail('unexpected texture'),
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(streamer.texFetching.has('12-1-2'), true);
  assert.equal(streamer.texRetryCount.get('12-1-2'), 1);
  assert.equal(streamer.texRetryAtMs.get('12-1-2'), 2100);
});

test('shared texture pump caches successful exact texture', async () => {
  let completed = null;
  const streamer = createTextureStreamer({
    log: () => {},
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      headers: { get: name => name === 'X-Tex-Source' ? 'dataforsyningen' : null },
      blob: async () => ({}),
    }),
    decodeImage: async () => ({ width: 256, height: 256 }),
  });
  streamer.pump([{ tile: { id: '12-3-4', bbox: [0, 0, 1, 1] } }], {
    isCovered: () => false,
    onPlaceholder: () => assert.fail('unexpected placeholder'),
    onTexture: result => { completed = result; },
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(streamer.texSource.get('12-3-4'), 'dataforsyningen');
  assert.equal(completed.tileId, '12-3-4');
});

test('shared lifecycle keeps parent until all four quadrants are textured', () => {
  const parent = {
    isMesh: true,
    userData: { tileId: '10-1-1', bbox: [0, 0, 10, 10] },
    material: { map: null, dispose() {} },
    geometry: { dispose() {} },
  };
  const children = ['11-2-2', '11-2-3', '11-3-2', '11-3-3'].map(tileId => ({
    isMesh: true, userData: { tileId },
    material: { map: {}, dispose() {} }, geometry: { dispose() {} },
  }));
  const root = {
    children: [parent, children[0]],
    remove(mesh) { this.children = this.children.filter(item => item !== mesh); },
    add(mesh) { this.children.push(mesh); },
  };
  const lifecycle = createTileLifecycle({
    terrainRoot: root, disposeScatter: () => {}, log: () => {},
  });
  assert.equal(lifecycle.sweepStaleParents([], new Set(['11-2-2'])), 0);
  root.children.push(...children.slice(1));
  assert.equal(lifecycle.sweepStaleParents([], new Set(children.map(c => c.userData.tileId))), 1);
  assert.deepEqual(root.children, children);
});
