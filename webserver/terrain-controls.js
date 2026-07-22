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

export function installTerrainPointerControls({
  element,
  controls,
  mouseSensitivity,
  mapPanFactor,
  isVehicleActive,
  isTurretActive = () => false,
  onVehicleOrbit,
  onTurretAim = () => {},
  onFireStart = () => {},
  onFireStop = () => {},
  onMapCameraChanged,
  onChanged = () => {},
}) {
  const onMouseDown = event => {
    if (isTurretActive() && event.button === 0) {
      onFireStart();
      onChanged();
      return;
    }
    controls.dragging = true;
    controls.dragButton = event.button;
    onChanged();
  };
  const onMouseUp = event => {
    if (event.button === 0) onFireStop();
    controls.dragging = false;
    controls.dragButton = 0;
    onChanged();
  };
  const onMouseMove = event => {
    if (isTurretActive()) {
      onTurretAim(event.movementX, event.movementY);
      onChanged();
      return;
    }
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

  element.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('mousemove', onMouseMove);
  return () => {
    element.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('mousemove', onMouseMove);
  };
}

export function installTerrainKeyboardControls({
  controls,
  isVehicleActive,
  isTurretActive = () => false,
  onForwardDoubleTap,
  onEscapeVehicle,
  onEscapeTurret = () => {},
  onToggleMap,
  onOpenGoogleMaps = () => {},
  onToggleGoogleNavigator = onOpenGoogleMaps,
  onOpenPipeline = () => {},
  onToggleHeatmap = () => {},
  onOpenHeatmap = onToggleHeatmap,
  onToggleClassifier = () => {},
  onToggleRoadDebug = () => {},
  onFlyToTile = () => {},
  onHouseAction,
  onToggleHeadlights,
  onCycleVehicleCamera = () => {},
  onToggleTurret = () => {},
  onToggleAircraftEngine = () => {},
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
    if (event.code === 'Escape' && isTurretActive()) {
      onEscapeTurret();
      controls.keys[event.code] = false;
      return;
    }
    if (event.code === 'Escape' && isVehicleActive()) {
      onEscapeVehicle();
      controls.keys[event.code] = false;
      return;
    }
    if (event.code === 'KeyM') return onToggleMap();
    if (event.code === 'KeyG') return onToggleGoogleNavigator();
    if (event.code === 'KeyP') return onOpenPipeline();
    if (event.code === 'KeyC') return onToggleClassifier();
    if (event.code === 'KeyT') {
      if (isVehicleActive()) return onToggleTurret();
      // Clear the key first — the prompt dialog swallows the keyup event,
      // which would leave KeyT stuck and force continuous rendering.
      controls.keys[event.code] = false;
      return onFlyToTile();
    }
    if (event.code === 'KeyR') return onToggleRoadDebug();
    if (event.code === 'KeyH') {
      if (event.shiftKey) return onHouseAction(true);
      return onOpenHeatmap();
    }
    if (event.code === 'KeyL' && isVehicleActive()) onToggleHeadlights();
    if (event.code === 'KeyV' && isVehicleActive() && !isTurretActive()) onCycleVehicleCamera();
    if (event.code === 'KeyE' && isVehicleActive()) onToggleAircraftEngine();
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
