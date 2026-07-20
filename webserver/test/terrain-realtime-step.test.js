import assert from 'node:assert/strict';
import test from 'node:test';

import { advanceRealtimeMovement } from '../terrain-realtime-step.js';

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
