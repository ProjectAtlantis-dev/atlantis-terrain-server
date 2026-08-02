// Free flight has no terrain/land collision pass. Bathymetry is not
// range-limited and can sit far below the retired synthetic -5 m seabed, so
// imposing a global lower altitude clamp prevents underwater exploration.
export const MAX_FREE_FLIGHT_ALTITUDE_M = 6000;

export function clampFreeFlightAltitude(altitude, {
  maxAltitude = MAX_FREE_FLIGHT_ALTITUDE_M,
} = {}) {
  return Math.min(maxAltitude, altitude);
}

export function applyMapDrag(controls, event, mouseSensitivity, panFactor) {
  if (controls.dragButton === 2) {
    const panStep = controls.mapZoom * mouseSensitivity * panFactor;
    const dx = -event.movementX * panStep;
    const dy = event.movementY * panStep;
    const cosYaw = Math.cos(controls.yaw);
    const sinYaw = Math.sin(controls.yaw);
    controls.mapPanEast += dx * cosYaw + dy * sinYaw;
    controls.mapPanNorth += -dx * sinYaw + dy * cosYaw;
    return 'pan';
  }

  const centerX = window.innerWidth * 0.5;
  const centerY = window.innerHeight * 0.5;
  const previousAngle = Math.atan2(
    event.clientX - event.movementX - centerX,
    -(event.clientY - event.movementY - centerY),
  );
  const currentAngle = Math.atan2(event.clientX - centerX, -(event.clientY - centerY));
  let delta = currentAngle - previousAngle;
  if (delta > Math.PI) delta -= 2 * Math.PI;
  if (delta < -Math.PI) delta += 2 * Math.PI;
  controls.yaw += delta;
  return 'rotate';
}

export function createRefocusPointerGuard({
  graceMs = 250,
  scheduleRelease = (callback, delay) => setTimeout(callback, delay),
  cancelRelease = timer => clearTimeout(timer),
} = {}) {
  let armed = false;
  let releaseTimer = null;

  function clear() {
    armed = false;
    if (releaseTimer != null) cancelRelease(releaseTimer);
    releaseTimer = null;
  }

  return {
    arm() {
      armed = true;
      if (releaseTimer != null) cancelRelease(releaseTimer);
      releaseTimer = null;
    },
    releaseSoon() {
      if (!armed) return;
      if (releaseTimer != null) cancelRelease(releaseTimer);
      releaseTimer = scheduleRelease(clear, graceMs);
    },
    consume() {
      if (!armed) return false;
      clear();
      return true;
    },
    dispose: clear,
  };
}

export function installTerrainPointerControls({
  element,
  controls,
  mouseSensitivity,
  mapPanFactor,
  isVehicleActive,
  onVehicleOrbit,
  onMapCameraChanged,
  onChanged = () => {},
  windowTarget = window,
  refocusGuard = createRefocusPointerGuard(),
}) {
  const onMouseDown = event => {
    // Clicking an inactive browser window can deliver focus, mousedown, and a
    // small synthetic mousemove as one gesture. Consume that first mousedown;
    // otherwise the synthetic delta becomes an unintended camera drag.
    if (refocusGuard.consume()) {
      controls.dragging = false;
      controls.dragButton = 0;
      return;
    }
    controls.dragging = true;
    controls.dragButton = event.button;
    onChanged();
  };
  const onMouseUp = () => {
    controls.dragging = false;
    controls.dragButton = 0;
    onChanged();
  };
  const onMouseMove = event => {
    if (!controls.dragging) return;
    if (controls.mapMode) {
      const action = applyMapDrag(controls, event, mouseSensitivity, mapPanFactor);
      if (action === 'pan') onMapCameraChanged();
      onChanged();
      return;
    }
    if (isVehicleActive()) {
      onVehicleOrbit(event.movementX, event.movementY);
      onChanged();
      return;
    }
    controls.yaw += event.movementX * mouseSensitivity;
    controls.pitch += event.movementY * mouseSensitivity;
    controls.pitch = Math.max(-1.4, Math.min(1.2, controls.pitch));
    onChanged();
  };
  const onWindowBlur = () => {
    refocusGuard.arm();
    if (!controls.dragging) return;
    controls.dragging = false;
    controls.dragButton = 0;
    onChanged();
  };
  const onWindowFocus = () => refocusGuard.releaseSoon();

  element.addEventListener('mousedown', onMouseDown);
  windowTarget.addEventListener('mouseup', onMouseUp);
  windowTarget.addEventListener('mousemove', onMouseMove);
  windowTarget.addEventListener('blur', onWindowBlur);
  windowTarget.addEventListener('focus', onWindowFocus);
  return () => {
    element.removeEventListener('mousedown', onMouseDown);
    windowTarget.removeEventListener('mouseup', onMouseUp);
    windowTarget.removeEventListener('mousemove', onMouseMove);
    windowTarget.removeEventListener('blur', onWindowBlur);
    windowTarget.removeEventListener('focus', onWindowFocus);
    refocusGuard.dispose();
  };
}

export function installTerrainKeyboardControls({
  controls,
  isVehicleActive,
  onForwardDoubleTap,
  onEscapeVehicle,
  onToggleMap,
  onFlyToTile = () => {},
  onToggleHeadlights,
  onChanged = () => {},
  doubleTapMs = 300,
}) {
  let lastForwardTapTime = 0;
  const onKeyDown = event => {
    const tag = event.target?.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') return;
    controls.keys[event.code] = true;
    onChanged();

    if ((event.code === 'KeyW' || event.code === 'ArrowUp') && !event.repeat) {
      const now = performance.now();
      if (now - lastForwardTapTime < doubleTapMs) {
        onForwardDoubleTap();
        lastForwardTapTime = 0;
      } else {
        lastForwardTapTime = now;
      }
    }
    if (event.repeat) return;
    if (event.code === 'Escape' && isVehicleActive()) {
      onEscapeVehicle();
      controls.keys[event.code] = false;
      return;
    }
    if (event.code === 'KeyM') return onToggleMap();
    if (event.code === 'KeyT') {
      // Clear the key first — the prompt dialog swallows the keyup event,
      // which would leave KeyT stuck and force continuous rendering.
      controls.keys[event.code] = false;
      return onFlyToTile();
    }
    if (event.code === 'KeyL' && isVehicleActive()) onToggleHeadlights();
  };
  const onKeyUp = event => {
    controls.keys[event.code] = false;
    onChanged();
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
  };
}
