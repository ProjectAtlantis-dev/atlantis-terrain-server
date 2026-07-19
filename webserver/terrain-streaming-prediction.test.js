import assert from 'node:assert/strict';
import test from 'node:test';

import {
  predictTerrainStreamingFocus,
  predictiveRefetchDecision,
} from './terrain-streaming-prediction.js';

test('stationary streaming focus remains on the player', () => {
  const focus = predictTerrainStreamingFocus({ x: 100, y: 200, heading: 1, speedMps: 0 });
  assert.equal(focus.x, 100);
  assert.equal(focus.y, 200);
  assert.equal(focus.lookaheadMetres, 0);
});

test('aircraft streaming focus follows the project heading convention', () => {
  const north = predictTerrainStreamingFocus({ x: 0, y: 0, heading: 0, speedMps: 120 });
  assert.equal(north.x, 0);
  assert.ok(north.y > 1000);
  const west = predictTerrainStreamingFocus({
    x: 0, y: 0, heading: Math.PI / 2, speedMps: 120,
  });
  assert.ok(west.x < -1000);
  assert.ok(Math.abs(west.y) < 1e-9);
});

test('streaming lookahead is bounded at extreme speed', () => {
  const focus = predictTerrainStreamingFocus({ x: 10, y: 20, heading: 0, speedMps: 2000 });
  assert.equal(focus.lookaheadSeconds, 20);
  assert.equal(focus.lookaheadMetres, 5000);
  assert.equal(focus.y, 5020);
});

test('predictive refetch requires displacement and interval hysteresis', () => {
  assert.equal(predictiveRefetchDecision({
    focusX: 1300, focusY: 0, lastFocusX: 0, lastFocusY: 0,
    nowMs: 900, lastTriggerMs: 0,
  }).shouldFetch, false);
  const ready = predictiveRefetchDecision({
    focusX: 1300, focusY: 0, lastFocusX: 0, lastFocusY: 0,
    nowMs: 1000, lastTriggerMs: 0,
  });
  assert.equal(ready.shouldFetch, true);
  assert.equal(ready.displacement, 1300);
  assert.equal(ready.nextTriggerMs, 1000);
});
