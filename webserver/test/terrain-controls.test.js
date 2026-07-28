import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clampFreeFlightAltitude,
  MAX_FREE_FLIGHT_ALTITUDE_M,
} from '../terrain-controls.js';

test('free-flight camera can descend below sea level', () => {
  assert.equal(clampFreeFlightAltitude(-2), -2);
});

test('free-flight camera can descend through real bathymetry', () => {
  assert.equal(clampFreeFlightAltitude(-120), -120);
  assert.equal(clampFreeFlightAltitude(-10_000), -10_000);
});

test('free-flight camera retains its upper altitude ceiling', () => {
  assert.equal(
    clampFreeFlightAltitude(MAX_FREE_FLIGHT_ALTITUDE_M + 1),
    MAX_FREE_FLIGHT_ALTITUDE_M,
  );
});
