import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advanceRealtimeMovement,
  forwardLockLookYawOffset,
  stepFreeFlightVelocity,
  stepForwardLockTurn,
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
    forwardAcceleration: 300,
    acceleration: 1200,
    brake: 800,
    maxSpeed: 5000,
    maxStrafeSpeed: 800,
    dt: 0.1,
  });

  assert.equal(step.speed, 300);
  assert.equal(step.strafeSpeed, 120);
});

test('forward lock consumes lateral input without creating strafe velocity', () => {
  const step = stepFreeFlightVelocity({
    speed: 300,
    strafeSpeed: 0,
    forwardPressed: false,
    backPressed: false,
    leftPressed: false,
    rightPressed: true,
    forwardLock: true,
    mapMode: false,
    forwardAcceleration: 300,
    acceleration: 1200,
    brake: 800,
    maxSpeed: 5000,
    maxStrafeSpeed: 800,
    dt: 0.1,
  });

  assert.equal(step.speed, 300);
  assert.equal(step.strafeSpeed, 0);
});

test('lateral thrusters remain available outside forward lock', () => {
  const step = stepFreeFlightVelocity({
    speed: 300,
    strafeSpeed: 0,
    forwardPressed: false,
    backPressed: false,
    leftPressed: false,
    rightPressed: true,
    forwardLock: false,
    mapMode: false,
    forwardAcceleration: 300,
    acceleration: 1200,
    brake: 800,
    maxSpeed: 5000,
    maxStrafeSpeed: 800,
    dt: 0.1,
  });

  assert.equal(step.speed, 220);
  assert.equal(step.strafeSpeed, 120);
});

test('disabling forward lock coasts longitudinally with reduced braking', () => {
  const step = stepFreeFlightVelocity({
    speed: 300,
    strafeSpeed: 0,
    forwardPressed: false,
    backPressed: false,
    leftPressed: false,
    rightPressed: false,
    forwardLock: false,
    mapMode: false,
    forwardAcceleration: 300,
    acceleration: 1200,
    brake: 800,
    longitudinalBrakeScale: 0.125,
    maxSpeed: 5000,
    maxStrafeSpeed: 800,
    dt: 0.1,
  });

  assert.equal(step.speed, 290);
  assert.equal(step.strafeSpeed, 0);
});

test('single-W forward thrust accelerates at the gentler dedicated rate', () => {
  const step = stepFreeFlightVelocity({
    speed: 0,
    strafeSpeed: 0,
    forwardPressed: true,
    backPressed: false,
    leftPressed: false,
    rightPressed: false,
    forwardLock: false,
    mapMode: false,
    forwardAcceleration: 300,
    acceleration: 1200,
    brake: 800,
    maxSpeed: 5000,
    maxStrafeSpeed: 800,
    dt: 0.1,
  });

  assert.equal(step.speed, 30);
  assert.equal(step.strafeSpeed, 0);
});

test('S brakes forward velocity to zero before a later step can reverse', () => {
  const braking = stepFreeFlightVelocity({
    speed: 50,
    strafeSpeed: 0,
    forwardPressed: false,
    backPressed: true,
    leftPressed: false,
    rightPressed: false,
    forwardLock: false,
    mapMode: false,
    forwardAcceleration: 300,
    acceleration: 1200,
    brake: 800,
    maxSpeed: 5000,
    maxStrafeSpeed: 800,
    dt: 0.1,
  });
  const reversing = stepFreeFlightVelocity({
    speed: braking.speed,
    strafeSpeed: 0,
    forwardPressed: false,
    backPressed: true,
    leftPressed: false,
    rightPressed: false,
    forwardLock: false,
    mapMode: false,
    forwardAcceleration: 300,
    acceleration: 1200,
    brake: 800,
    maxSpeed: 5000,
    maxStrafeSpeed: 800,
    dt: 0.1,
  });

  assert.equal(braking.speed, 0);
  assert.equal(reversing.speed, -120);
});

test('forward-lock arrows glance 90 degrees and release straight ahead', () => {
  assert.equal(forwardLockLookYawOffset({
    active: true,
    leftPressed: true,
    rightPressed: false,
  }), Math.PI / 2);
  assert.equal(forwardLockLookYawOffset({
    active: true,
    leftPressed: false,
    rightPressed: true,
  }), -Math.PI / 2);
  assert.equal(forwardLockLookYawOffset({
    active: true,
    leftPressed: false,
    rightPressed: false,
  }), 0);
  assert.equal(forwardLockLookYawOffset({
    active: false,
    leftPressed: true,
    rightPressed: false,
  }), 0);
});

test('forward-lock right input banks right and coordinates heading into the turn', () => {
  const step = stepForwardLockTurn({
    bank: 0,
    bankVelocity: 0,
    leftPressed: false,
    rightPressed: true,
    active: true,
    dt: 0.1,
  });

  assert.ok(step.bank > 0);
  assert.ok(step.yawDelta < 0);
});

test('forward-lock left input banks and turns in the opposite direction', () => {
  const step = stepForwardLockTurn({
    bank: 0,
    bankVelocity: 0,
    leftPressed: true,
    rightPressed: false,
    active: true,
    dt: 0.1,
  });

  assert.ok(step.bank < 0);
  assert.ok(step.yawDelta > 0);
});

test('forward-lock bank returns smoothly to level after input release', () => {
  const held = stepForwardLockTurn({
    bank: 0,
    bankVelocity: 0,
    leftPressed: false,
    rightPressed: true,
    active: true,
    dt: 0.5,
  });
  const released = stepForwardLockTurn({
    bank: held.bank,
    bankVelocity: held.bankVelocity,
    leftPressed: false,
    rightPressed: false,
    active: true,
    dt: 0.5,
  });

  assert.ok(released.bank > 0);
  assert.ok(released.bank < held.bank);
  assert.ok(released.bank > held.bank * 0.8);
  assert.equal(released.bankVelocity, 0);
  assert.ok(released.yawDelta < 0);
});

test('leaving forward lock levels residual bank without steering', () => {
  const step = stepForwardLockTurn({
    bank: 0.5,
    bankVelocity: 0,
    leftPressed: false,
    rightPressed: false,
    active: false,
    dt: 0.5,
  });

  assert.ok(step.bank > 0);
  assert.ok(step.bank < 0.5);
  assert.equal(step.yawDelta, 0);
});

test('forward-lock banking accelerates into its roll instead of stepping to full roll rate', () => {
  const first = stepForwardLockTurn({
    bank: 0,
    bankVelocity: 0,
    leftPressed: false,
    rightPressed: true,
    active: true,
    dt: 0.05,
  });
  const second = stepForwardLockTurn({
    bank: first.bank,
    bankVelocity: first.bankVelocity,
    leftPressed: false,
    rightPressed: true,
    active: true,
    dt: 0.05,
  });

  assert.ok(first.bankVelocity > 0);
  assert.ok(second.bankVelocity > first.bankVelocity);
  assert.ok(second.bank - first.bank > first.bank);
});
