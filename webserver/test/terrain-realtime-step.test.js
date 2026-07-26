import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advanceRealtimeMovement,
  stepFreeFlightVelocity,
} from '../terrain-realtime-step.js';

test('realtime movement consumes delayed frame time without dropping distance', () => {
  let elapsed = 0;
  const steps = advanceRealtimeMovement(0.23, dt => { elapsed += dt; });

  assert.equal(steps, 5);
  assert.ok(Math.abs(elapsed - 0.23) < 1e-12);
});

test('realtime movement bounds catch-up work while preserving elapsed time', () => {
  const durations = [];
  const steps = advanceRealtimeMovement(12, dt => durations.push(dt));

  assert.equal(steps, 10);
  assert.equal(durations.length, 10);
  assert.ok(Math.abs(durations.reduce((sum, dt) => sum + dt, 0) - 12) < 1e-12);
});

test('realtime movement ignores invalid or empty elapsed time', () => {
  let calls = 0;
  assert.equal(advanceRealtimeMovement(0, () => { calls += 1; }), 0);
  assert.equal(advanceRealtimeMovement(Number.NaN, () => { calls += 1; }), 0);
  assert.equal(calls, 0);
});

test('forward lock preserves longitudinal velocity but bleeds lateral velocity', () => {
  const step = stepFreeFlightVelocity({
    speed: 300,
    strafeSpeed: 200,
    forwardPressed: false,
    backPressed: false,
    leftPressed: false,
    rightPressed: false,
    forwardLock: true,
    mapMode: false,
    acceleration: 1200,
    brake: 800,
    maxSpeed: 5000,
    maxStrafeSpeed: 800,
    dt: 0.1,
  });

  assert.equal(step.speed, 300);
  assert.equal(step.strafeSpeed, 120);
});

test('lateral thrusters accelerate normally while forward lock is active', () => {
  const step = stepFreeFlightVelocity({
    speed: 300,
    strafeSpeed: 0,
    forwardPressed: false,
    backPressed: false,
    leftPressed: false,
    rightPressed: true,
    forwardLock: true,
    mapMode: false,
    acceleration: 1200,
    brake: 800,
    maxSpeed: 5000,
    maxStrafeSpeed: 800,
    dt: 0.1,
  });

  assert.equal(step.speed, 300);
  assert.equal(step.strafeSpeed, 120);
});
