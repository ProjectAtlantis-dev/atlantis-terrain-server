import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clampFreeFlightAltitude,
  createRefocusPointerGuard,
  installTerrainPointerControls,
  MAX_FREE_FLIGHT_ALTITUDE_M,
} from '../terrain-controls.js';

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    emit(type, event = {}) { listeners.get(type)?.(event); },
    listeners,
  };
}

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

test('the focus-restoring click is consumed before it can drag the camera', () => {
  const element = eventTarget();
  const windowTarget = eventTarget();
  let scheduledRelease = null;
  const refocusGuard = createRefocusPointerGuard({
    scheduleRelease: callback => { scheduledRelease = callback; return 1; },
    cancelRelease: () => { scheduledRelease = null; },
  });
  const controls = {
    dragging: false, dragButton: 0, mapMode: false, yaw: 0, pitch: 0,
  };
  const dispose = installTerrainPointerControls({
    element,
    windowTarget,
    refocusGuard,
    controls,
    mouseSensitivity: 0.01,
    mapPanFactor: 1,
    isVehicleActive: () => false,
    onVehicleOrbit() {},
    onMapCameraChanged() {},
  });

  windowTarget.emit('blur');
  windowTarget.emit('focus');
  element.emit('mousedown', { button: 0 });
  windowTarget.emit('mousemove', { movementX: 20, movementY: 10 });

  assert.equal(controls.dragging, false);
  assert.equal(controls.yaw, 0);
  assert.equal(controls.pitch, 0);

  element.emit('mousedown', { button: 0 });
  windowTarget.emit('mousemove', { movementX: 20, movementY: 10 });
  assert.equal(controls.yaw, 0.2);
  assert.equal(controls.pitch, 0.1);
  dispose();
  assert.equal(element.listeners.size, 0);
  assert.equal(windowTarget.listeners.size, 0);
  assert.equal(scheduledRelease, null);
});

test('a keyboard refocus does not consume a later click after the grace period', () => {
  let release = null;
  const guard = createRefocusPointerGuard({
    scheduleRelease: callback => { release = callback; return 1; },
    cancelRelease: () => { release = null; },
  });

  guard.arm();
  guard.releaseSoon();
  release();

  assert.equal(guard.consume(), false);
});
