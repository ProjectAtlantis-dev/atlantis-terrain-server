export function createVehicleControlUI({ document: documentRef = document } = {}) {
  const panel = documentRef.createElement('section');
  panel.id = 'vehicle-control-panel';
  panel.setAttribute('aria-label', 'Selected vehicle controls');
  panel.style.cssText = [
    'position:absolute',
    'left:50%',
    'bottom:54px',
    'transform:translateX(-50%)',
    'max-width:calc(100vw - 180px)',
    'padding:7px 11px',
    'background:rgba(4,10,16,0.82)',
    'border:1px solid rgba(143,208,255,0.42)',
    'border-radius:7px',
    'box-shadow:0 5px 16px rgba(0,0,0,0.3)',
    'color:#dbe5f1',
    'font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
    'pointer-events:none',
    'user-select:none',
    'white-space:nowrap',
    'z-index:8',
  ].join(';');

  const text = documentRef.createElement('div');
  panel.appendChild(text);
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

  const update = ({
    selected = false,
    loaded = false,
    active = false,
    mapMode = false,
    displayName = 'Vehicle',
    speedMps = 0,
    hasLights = false,
    hasTurret = false,
    turretActive = false,
    isAircraft = false,
    engineRunning = false,
    rotorSpool = 0,
    altitudeAGL = 0,
    verticalSpeedMs = 0,
    flightRegime = 'GROUND',
  } = {}) => {
    panel.hidden = !selected;
    crosshair.style.display = selected && turretActive ? '' : 'none';
    if (!selected) return;

    const speedKmh = Math.abs(speedMps) * 3.6;
    const status = !loaded ? 'LOADING' : mapMode ? 'MAP MODE' : active ? 'CONTROL' : 'SELECTED';
    const prefix = `${String(displayName).toUpperCase()} | ${status}`;
    if (isAircraft) {
      const knots = Math.abs(speedMps) * 1.943844;
      text.textContent = `${prefix} | ${speedKmh.toFixed(0)} km/h (${knots.toFixed(0)} kt) | `
        + `V/S ${verticalSpeedMs.toFixed(1)} m/s | ${altitudeAGL.toFixed(0)} m AGL | `
        + `${flightRegime} | engine ${engineRunning ? 'ON' : 'OFF'} | rotor ${Math.round(rotorSpool * 100)}% | `
        + 'E engine · W/S forward/back · A/D yaw · Space/Q climb/descend · V camera · Esc exit';
    } else {
      const optional = `${hasLights ? ' · L lights' : ''}${hasTurret ? ' · T turret' : ''}`;
      text.textContent = `${prefix} | ${speedKmh.toFixed(0)} km/h | W/S drive · A/D steer · V camera${optional} · Esc exit`;
    }
    if (!active && loaded && !mapMode) {
      text.textContent += ' · left-click select / right-click drive';
    }
    if (turretActive) {
      text.textContent = `${prefix} | ${speedKmh.toFixed(0)} km/h | mouse aim/fire · WASD drive · T/Esc exit turret`;
    }
  };

  return {
    element: panel,
    update,
    destroy() {
      panel.remove();
      crosshair.remove();
    },
  };
}
