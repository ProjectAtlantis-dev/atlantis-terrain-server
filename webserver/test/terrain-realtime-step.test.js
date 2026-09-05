import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advanceRealtimeMovement,
  forwardLockLookYawOffset,
  stepFreeFlightVelocity,
  stepFreeFlightVerticalVelocity,
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

test('forward-lock altitude input builds vertical momentum toward a 100 m/s ceiling', () => {
  const first = stepFreeFlightVerticalVelocity({
    verticalSpeed: 0,
    upPressed: true,
    downPressed: false,
    forwardLock: true,
    maxVerticalSpeed: 400,
    dt: 0.05,
  });
  const second = stepFreeFlightVerticalVelocity({
    verticalSpeed: first,
    upPressed: true,
    downPressed: false,
    forwardLock: true,
    maxVerticalSpeed: 400,
    dt: 0.05,
  });
  const previousPower = stepFreeFlightVerticalVelocity({
    verticalSpeed: 0,
    upPressed: true,
    downPressed: false,
    forwardLock: true,
    maxVerticalSpeed: 400,
    dt: 0.05,
    inertiaResponse: 0.75,
  });
  const fullUp = stepFreeFlightVerticalVelocity({
    verticalSpeed: 100,
    upPressed: true,
    downPressed: false,
    forwardLock: true,
    maxVerticalSpeed: 400,
    dt: 0.05,
  });
  const fullDown = stepFreeFlightVerticalVelocity({
    verticalSpeed: -100,
    upPressed: false,
    downPressed: true,
    forwardLock: true,
    maxVerticalSpeed: 400,
    dt: 0.05,
  });

  assert.ok(first > 0);
  assert.ok(first > previousPower);
  assert.ok(second > first);
  assert.ok(second < 100);
  assert.equal(fullUp, 100);
  assert.equal(fullDown, -100);
});

test('forward-lock altitude momentum eases out after Q or Z is released', () => {
  const ascending = stepFreeFlightVerticalVelocity({
    verticalSpeed: 3,
    upPressed: false,
    downPressed: false,
    forwardLock: true,
    maxVerticalSpeed: 400,
    dt: 0.1,
  });
  const descending = stepFreeFlightVerticalVelocity({
    verticalSpeed: -3,
    upPressed: false,
    downPressed: false,
    forwardLock: true,
    maxVerticalSpeed: 400,
    dt: 0.1,
  });

  assert.ok(ascending > 0);
  assert.ok(ascending < 3);
  assert.ok(descending < 0);
  assert.ok(descending > -3);
});

test('ordinary altitude input keeps its direct full-strength response', () => {
  assert.equal(stepFreeFlightVerticalVelocity({
    verticalSpeed: 30,
    upPressed: true,
    downPressed: false,
    forwardLock: false,
    maxVerticalSpeed: 400,
    dt: 0.1,
  }), 400);
  assert.equal(stepFreeFlightVerticalVelocity({
    verticalSpeed: -30,
    upPressed: false,
    downPressed: false,
    forwardLock: false,
    maxVerticalSpeed: 400,
    dt: 0.1,
  }), 0);
});

test('forward-lock forward input ramps up instead of applying full thrust immediately', () => {
  const first = stepFreeFlightVelocity({
    speed: 0,
    strafeSpeed: 0,
    forwardPressed: true,
    backPressed: false,
    leftPressed: false,
    rightPressed: false,
    forwardLock: true,
    forwardLockThrottle: 0,
    mapMode: false,
    forwardAcceleration: 300,
    acceleration: 1200,
    brake: 800,
    maxSpeed: 5000,
    maxStrafeSpeed: 800,
    dt: 0.05,
  });
  const second = stepFreeFlightVelocity({
    speed: first.speed,
    strafeSpeed: 0,
    forwardPressed: true,
    backPressed: false,
    leftPressed: false,
    rightPressed: false,
    forwardLock: true,
    forwardLockThrottle: first.forwardLockThrottle,
    mapMode: false,
    forwardAcceleration: 300,
    acceleration: 1200,
    brake: 800,
    maxSpeed: 5000,
    maxStrafeSpeed: 800,
    dt: 0.05,
  });
  const reverse = stepFreeFlightVelocity({
    speed: 100,
    strafeSpeed: 0,
    forwardPressed: false,
    backPressed: true,
    leftPressed: false,
    rightPressed: false,
    forwardLock: true,
    forwardLockThrottle: 0,
    mapMode: false,
    forwardAcceleration: 300,
    acceleration: 1200,
    brake: 800,
    maxSpeed: 5000,
    maxStrafeSpeed: 800,
    dt: 0.05,
  });

  assert.ok(first.forwardLockThrottle > 0);
  assert.ok(first.forwardLockThrottle < 1);
  assert.ok(second.forwardLockThrottle > first.forwardLockThrottle);
  assert.ok(second.speed - first.speed > first.speed);
  assert.ok(reverse.forwardLockThrottle < 0);
  assert.ok(reverse.forwardLockThrottle > -1);
  assert.ok(reverse.speed < 100);
  assert.ok(reverse.speed > 60);
});

test('forward-lock throttle eases out after up or down input is released', () => {
  const forwardRelease = stepFreeFlightVelocity({
    speed: 100,
    strafeSpeed: 0,
    forwardPressed: false,
    backPressed: false,
    leftPressed: false,
    rightPressed: false,
    forwardLock: true,
    forwardLockThrottle: 0.5,
    mapMode: false,
    forwardAcceleration: 300,
    acceleration: 1200,
    brake: 800,
    maxSpeed: 5000,
    maxStrafeSpeed: 800,
    dt: 0.05,
  });
  const reverseRelease = stepFreeFlightVelocity({
    speed: 100,
    strafeSpeed: 0,
    forwardPressed: false,
    backPressed: false,
    leftPressed: false,
    rightPressed: false,
    forwardLock: true,
    forwardLockThrottle: -0.5,
    mapMode: false,
    forwardAcceleration: 300,
    acceleration: 1200,
    brake: 800,
    maxSpeed: 5000,
    maxStrafeSpeed: 800,
    dt: 0.05,
  });

  assert.ok(forwardRelease.forwardLockThrottle > 0);
  assert.ok(forwardRelease.forwardLockThrottle < 0.5);
  assert.ok(forwardRelease.speed > 100);
  assert.ok(reverseRelease.forwardLockThrottle < 0);
  assert.ok(reverseRelease.forwardLockThrottle > -0.5);
  assert.ok(reverseRelease.speed < 100);
});

test('ordinary flight discards forward-lock throttle and keeps direct input response', () => {
  const step = stepFreeFlightVelocity({
    speed: 0,
    strafeSpeed: 0,
    forwardPressed: true,
    backPressed: false,
    leftPressed: false,
    rightPressed: false,
    forwardLock: false,
    forwardLockThrottle: 0.75,
    mapMode: false,
    forwardAcceleration: 300,
    acceleration: 1200,
    brake: 800,
    maxSpeed: 5000,
    maxStrafeSpeed: 800,
    dt: 0.1,
  });

  assert.equal(step.speed, 30);
  assert.equal(step.forwardLockThrottle, 0);
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
  assert.ok(step.bank < 0.4);
  assert.equal(step.yawDelta, 0);
});

test('disabled forward lock keeps flattening smoothly after the coast stops', () => {
  const step = stepForwardLockTurn({
    bank: 0.3,
    bankVelocity: 0.1,
    leftPressed: false,
    rightPressed: false,
    active: false,
    stationary: true,
    dt: 0.05,
  });

  assert.ok(step.bank > 0);
  assert.ok(step.bank < 0.3);
  assert.equal(step.bankVelocity, 0);
  assert.equal(step.yawDelta, 0);
});

test('forward-lock camera snaps level when drift stops', () => {
  const step = stepForwardLockTurn({
    bank: 0.3,
    bankVelocity: 0.1,
    leftPressed: false,
    rightPressed: true,
    active: true,
    stationary: true,
    dt: 0.05,
  });

  assert.deepEqual(step, { bank: 0, bankVelocity: 0, yawDelta: 0 });
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
