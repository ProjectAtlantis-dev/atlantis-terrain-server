function setButtonState(button, { hidden = false, disabled = false } = {}) {
  button.hidden = hidden;
  button.disabled = disabled;
  button.style.opacity = disabled ? '0.45' : '1';
  button.style.cursor = disabled ? 'default' : 'pointer';
}

export function createVehicleControlUI({
  document: documentRef = document,
  onDrive = () => {},
  onExit = () => {},
  onCycleCamera = () => {},
  onToggleLights = () => {},
  onToggleTurret = () => {},
  onToggleEngine = () => {},
  onToggleConversion = () => {},
} = {}) {
  const panel = documentRef.createElement('section');
  panel.id = 'vehicle-control-panel';
  panel.setAttribute('aria-label', 'Selected vehicle controls');
  panel.style.cssText = [
    'position:absolute',
    'right:12px',
    'bottom:54px',
    'min-width:250px',
    'padding:10px 12px',
    'background:rgba(4,10,16,0.86)',
    'border:1px solid rgba(143,208,255,0.42)',
    'border-radius:8px',
    'box-shadow:0 6px 20px rgba(0,0,0,0.35)',
    'color:#dbe5f1',
    'font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
    'pointer-events:auto',
    'user-select:none',
    'z-index:8',
  ].join(';');

  const title = documentRef.createElement('div');
  title.style.cssText = 'font-weight:700;color:#8fd0ff;margin-bottom:4px';
  const identity = documentRef.createElement('div');
  identity.style.cssText = 'color:#aab8c5;margin-bottom:6px';
  const telemetry = documentRef.createElement('div');
  telemetry.style.cssText = 'margin-bottom:8px';
  const actions = documentRef.createElement('div');
  actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px';
  const help = documentRef.createElement('div');
  help.style.cssText = 'margin-top:8px;color:#8293a3;max-width:310px';

  const buttons = new Map();
  const addButton = (action, label) => {
    const button = documentRef.createElement('button');
    button.type = 'button';
    button.dataset.vehicleAction = action;
    button.textContent = label;
    button.style.cssText = [
      'padding:4px 8px',
      'border:1px solid rgba(143,208,255,0.48)',
      'border-radius:4px',
      'background:rgba(18,43,61,0.92)',
      'color:#dbe5f1',
      'font:inherit',
    ].join(';');
    actions.appendChild(button);
    buttons.set(action, button);
  };
  addButton('drive', 'Drive');
  addButton('exit', 'Exit');
  addButton('camera', 'Camera');
  addButton('lights', 'Lights');
  addButton('turret', 'Turret');
  addButton('engine', 'Engine');
  addButton('conversion', 'Convert');
  panel.append(title, identity, telemetry, actions, help);
  documentRef.body.appendChild(panel);

  const crosshair = documentRef.createElement('div');
  crosshair.id = 'vehicle-turret-crosshair';
  crosshair.style.cssText = [
    'position:fixed',
    'top:50%',
    'left:50%',
    'transform:translate(-50%,-50%)',
    'pointer-events:none',
    'z-index:10',
    'display:none',
  ].join(';');
  crosshair.innerHTML = '<svg width="60" height="60" viewBox="0 0 60 60" aria-hidden="true">'
    + '<circle cx="30" cy="30" r="18" stroke="#63ff79" stroke-width="1.5" fill="none" opacity="0.8"/>'
    + '<path d="M30 6V22M30 38V54M6 30H22M38 30H54" stroke="#63ff79" stroke-width="1.5" opacity="0.8"/>'
    + '<circle cx="30" cy="30" r="2" fill="#63ff79" opacity="0.7"/>'
    + '</svg>';
  documentRef.body.appendChild(crosshair);

  const handlers = {
    drive: onDrive,
    exit: onExit,
    camera: onCycleCamera,
    lights: onToggleLights,
    turret: onToggleTurret,
    engine: onToggleEngine,
    conversion: onToggleConversion,
  };
  const onClick = event => {
    const button = event.target.closest?.('[data-vehicle-action]');
    if (button == null || !panel.contains(button) || button.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    handlers[button.dataset.vehicleAction]?.();
  };
  panel.addEventListener('click', onClick);

  const update = ({
    selected = false,
    loaded = false,
    active = false,
    mapMode = false,
    displayName = 'Vehicle',
    id = '',
    cameraMode = '—',
    speedMps = 0,
    hasLights = false,
    lightsOn = false,
    hasTurret = false,
    turretActive = false,
    isAircraft = false,
    engineRunning = false,
    conversionMode = 'hover',
    collective = 0,
    rotorSpool = 0,
    altitudeAGL = 0,
    verticalSpeedMs = 0,
    flightRegime = 'GROUND',
  } = {}) => {
    panel.hidden = !selected;
    if (!selected) {
      crosshair.style.display = 'none';
      return;
    }
    title.textContent = `${active ? 'DRIVING' : 'SELECTED'} · ${displayName}`;
    title.style.color = active ? '#ff6b61' : '#8fd0ff';
    identity.textContent = id ? `id: ${id}` : '';
    const status = !loaded ? 'LOADING' : mapMode ? 'MAP MODE' : active ? 'CONTROL ACTIVE' : 'READY';
    telemetry.textContent = isAircraft
      ? `${status} · ${flightRegime} · ${(Math.abs(speedMps) * 3.6).toFixed(0)} km/h · ${altitudeAGL.toFixed(0)} m AGL`
        + `\nCOL ${Math.round(collective * 100)}% · RPM ${Math.round(rotorSpool * 100)}% · V/S ${verticalSpeedMs.toFixed(1)} m/s`
      : `${status} · ${(Math.abs(speedMps) * 3.6).toFixed(0)} km/h · camera ${cameraMode}`;
    telemetry.style.whiteSpace = isAircraft ? 'pre-line' : '';
    setButtonState(buttons.get('drive'), {
      hidden: active,
      disabled: !loaded || mapMode,
    });
    setButtonState(buttons.get('exit'), { hidden: !active });
    setButtonState(buttons.get('camera'), { disabled: !active || turretActive });
    setButtonState(buttons.get('lights'), { disabled: !active || !hasLights });
    setButtonState(buttons.get('turret'), { disabled: !active || !hasTurret });
    setButtonState(buttons.get('engine'), { hidden: !isAircraft, disabled: !active });
    setButtonState(buttons.get('conversion'), { hidden: !isAircraft, disabled: !active || !engineRunning });
    buttons.get('lights').textContent = lightsOn ? 'Lights off' : 'Lights on';
    buttons.get('turret').textContent = turretActive ? 'Exit turret' : 'Turret';
    buttons.get('engine').textContent = engineRunning ? 'Engine off' : 'Engine on';
    buttons.get('conversion').textContent = conversionMode === 'cruise' ? 'Convert to hover' : 'Convert to cruise';
    crosshair.style.display = turretActive ? '' : 'none';
    help.textContent = turretActive
      ? 'Mouse aims · WASD still drives · T or Esc exits turret · firing effects pending WebGPU validation'
      : active && isAircraft
      ? 'E engine · Space/Q collective · W/S move · A/D turn · F hover/cruise conversion · drag orbit · V camera · Esc exit'
      : active
      ? 'W/S drive · A/D steer · drag orbit · V camera · L lights · T turret · Esc exit'
      : mapMode
        ? 'Leave map mode before driving.'
        : 'Left-click a vehicle to select · right-click to select and drive · or use Drive.';
  };

  return {
    element: panel,
    update,
    destroy() {
      panel.removeEventListener('click', onClick);
      panel.remove();
      crosshair.remove();
    },
  };
}
