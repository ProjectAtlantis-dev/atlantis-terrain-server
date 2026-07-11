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
