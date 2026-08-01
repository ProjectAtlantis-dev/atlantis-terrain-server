export const TERRAIN_HUD_LINKS = Object.freeze({
  debugLogLink: '/client_log.html',
  classifierOpsLink: '/classifier.html',
});

// The HUD action list is one link per line: stacked keeps the panel narrow,
// which matters because the HUD is anchored top-left over the terrain.
export function hudActionLink(id, label, color = '#0af') {
  return `<span id="${id}" style="color:${color};text-decoration:underline;`
    + `cursor:pointer;pointer-events:auto">${label}</span>`;
}

function appendPanel(cssText) {
  const element = document.createElement('div');
  element.style.cssText = cssText.join(';');
  document.body.appendChild(element);
  return element;
}

export function createTerrainHud({
  onToggleCollapsed = () => {},
  onToggleMapMode,
  onToggleSeamMode,
  onToggleTileInspector,
  onToggleGridlines,
  onToggleBathymetryMap,
  onToggleClassifierOverlay,
  onToggleWaterOverlay,
  onToggleHydrographyOverlay,
  onToggleProcgen,
  onToggleRenderBackend,
  onToggleRoadDebug,
  onOpenGoogleMaps,
  onStartFastTime,
  onReset,
  onClockAction,
}) {
  const hud = appendPanel([
    'position:absolute', 'top:12px', 'left:12px', 'padding:10px 12px',
    'background:rgba(0,0,0,0.7)', 'color:#dbe5f1',
    'font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
    'border-radius:8px', 'pointer-events:auto', 'user-select:text',
    'cursor:text', 'z-index:5',
  ]);
  hud.id = 'terrain-hud';
  hud.addEventListener('mousedown', event => {
    const isLink = (
      event.target.id === 'mapModeLink' ||
      event.target.id === 'seamModeLink' ||
      event.target.id === 'tileInspectorModeLink' ||
      event.target.id === 'gridlinesModeLink' ||
      event.target.id === 'bathymetryMapLink' ||
      event.target.id === 'classifierOverlayLink' ||
      event.target.id === 'waterOverlayLink' ||
      event.target.id === 'hydrographyOverlayLink' ||
      event.target.id === 'procgenLink' ||
      event.target.id === 'renderBackendLink' ||
      event.target.id === 'roadDebugLink' ||
      event.target.id === 'googleMaps3dLink' ||
      event.target.id === 'fastTimeLink' ||
      event.target.id === 'resetViewLink' ||
      event.target.id === 'hudToggleLink' ||
      TERRAIN_HUD_LINKS[event.target.id]
    );
    if (!isLink) hud.dataset.selecting = 'true';
    if (event.target.id === 'mapModeLink') {
      event.stopPropagation();
      event.preventDefault();
      onToggleMapMode();
      return;
    }
    if (event.target.id === 'seamModeLink') {
      event.stopPropagation();
      event.preventDefault();
      onToggleSeamMode();
      return;
    }
    if (event.target.id === 'tileInspectorModeLink') {
      event.stopPropagation();
      event.preventDefault();
      onToggleTileInspector();
      return;
    }
    if (event.target.id === 'gridlinesModeLink') {
      event.stopPropagation();
      event.preventDefault();
      onToggleGridlines();
      return;
    }
    if (event.target.id === 'bathymetryMapLink') {
      event.stopPropagation();
      event.preventDefault();
      onToggleBathymetryMap();
      return;
    }
    if (event.target.id === 'classifierOverlayLink') {
      event.stopPropagation();
      event.preventDefault();
      onToggleClassifierOverlay();
      return;
    }
    if (event.target.id === 'waterOverlayLink') {
      event.stopPropagation();
      event.preventDefault();
      onToggleWaterOverlay();
      return;
    }
    if (event.target.id === 'hydrographyOverlayLink') {
      event.stopPropagation();
      event.preventDefault();
      onToggleHydrographyOverlay();
      return;
    }
    if (event.target.id === 'procgenLink') {
      event.stopPropagation();
      event.preventDefault();
      onToggleProcgen();
      return;
    }
    if (event.target.id === 'renderBackendLink') {
      event.stopPropagation();
      event.preventDefault();
      onToggleRenderBackend();
      return;
    }
    if (event.target.id === 'roadDebugLink') {
      event.stopPropagation();
      event.preventDefault();
      onToggleRoadDebug();
      return;
    }
    if (event.target.id === 'googleMaps3dLink') {
      event.stopPropagation();
      event.preventDefault();
      onOpenGoogleMaps();
      return;
    }
    if (event.target.id === 'fastTimeLink') {
      event.stopPropagation();
      event.preventDefault();
      onStartFastTime();
      return;
    }
    if (event.target.id === 'resetViewLink') {
      event.stopPropagation();
      event.preventDefault();
      onReset();
      return;
    }
    const url = TERRAIN_HUD_LINKS[event.target.id];
    if (url) {
      event.stopPropagation();
      event.preventDefault();
      window.open(url, '_blank');
    }
  });
  // The selecting flag pauses HUD rewrites mid-drag. Clear it on every event
  // that can end a drag: a plain mouseup, but also contextmenu (right-click
  // swallows the mouseup, which used to freeze the HUD permanently) and the
  // window losing focus mid-drag.
  const clearSelecting = () => {
    hud.dataset.selecting = 'false';
  };
  window.addEventListener('mouseup', clearSelecting);
  window.addEventListener('contextmenu', clearSelecting);
  window.addEventListener('blur', clearSelecting);
  hud.addEventListener('click', event => {
    if (event.target.id === 'hudToggleLink') {
      event.stopPropagation();
      event.preventDefault();
      onToggleCollapsed();
      return;
    }
    if (
      event.target.id === 'mapModeLink' || event.target.id === 'seamModeLink' ||
      event.target.id === 'tileInspectorModeLink' ||
      event.target.id === 'gridlinesModeLink' ||
      event.target.id === 'bathymetryMapLink' ||
      event.target.id === 'classifierOverlayLink' ||
      event.target.id === 'waterOverlayLink' ||
      event.target.id === 'hydrographyOverlayLink' ||
      event.target.id === 'procgenLink' ||
      event.target.id === 'renderBackendLink' ||
      event.target.id === 'roadDebugLink' ||
      event.target.id === 'googleMaps3dLink' ||
      event.target.id === 'fastTimeLink' || event.target.id === 'resetViewLink' ||
      TERRAIN_HUD_LINKS[event.target.id]
    ) {
      event.stopPropagation();
      event.preventDefault();
    }
  });

  const alt = appendPanel([
    'position:absolute', 'right:12px', 'bottom:12px', 'padding:8px 10px',
    'background:rgba(0,0,0,0.7)', 'color:#8fd0ff',
    'font:13px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
    'border-radius:6px', 'pointer-events:none', 'z-index:5',
  ]);

  const gameClock = appendPanel([
    'position:absolute', 'left:12px', 'bottom:12px', 'padding:8px 10px',
    'background:rgba(0,0,0,0.7)', 'color:#5af',
    'font:13px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
    'border-radius:6px', 'pointer-events:auto', 'z-index:5', 'user-select:none',
  ]);
  gameClock.addEventListener('mousedown', event => {
    const button = event.target.closest('button[data-gc]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    onClockAction(button.dataset.gc);
  });

  return { hud, alt, gameClock };
}

export function compassHeading(headingRad) {
  const degrees = (((-headingRad * 180) / Math.PI) % 360 + 360) % 360;
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return { degrees, compass: directions[Math.round(degrees / 45) % 8] };
}

export function cameraDriftIndicator(active) {
  if (!active) return '';
  return ' <span id="cameraDriftIndicator"'
    + ' title="Camera keeps its forward velocity. Double-tap W or ↑ to disable."'
    + ' style="display:inline-block;padding:0 5px;border:1px solid #ffb020;'
    + 'border-radius:4px;background:#7a4300;color:#fff1bd;font-weight:700">'
    + 'FORWARD LOCK</span>';
}

export function terrainHudHeader(collapsed) {
  const action = collapsed ? 'Show HUD details' : 'Hide HUD details';
  const arrow = collapsed ? '&#9660;' : '&#9650;';
  return '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px">'
    + '<b>Greenland HUD</b>'
    + `<button id="hudToggleLink" type="button" aria-expanded="${!collapsed}" `
    + `aria-label="${action}" title="${action}" `
    + 'style="border:0;padding:0 2px;background:none;color:#8fd0ff;'
    + 'font:inherit;line-height:1;cursor:pointer">'
    + `${arrow}</button></div>`;
}

export function renderGameClock(element, date, isPlaying, timeScale = 1) {
  const nuukTime = date.toLocaleString('en-GB', {
    timeZone: 'America/Nuuk', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const [hours, minutes] = nuukTime.split(':');
  // Rewriting per frame destroys the buttons mid-click and forces relayout;
  // only touch the DOM when the rendered minute or play state changes.
  const renderKey = `${hours}:${minutes}|${isPlaying}|${timeScale}`;
  if (element.dataset?.gcRendered === renderKey) return;
  if (element.dataset) element.dataset.gcRendered = renderKey;
  const style = 'cursor:pointer;padding:0 4px;border:none;background:none;font-size:12px;line-height:1;vertical-align:middle;';
  const color = '#5af';
  element.innerHTML = `<button data-gc="rw" style="${style}color:${color}" title="−15 min"><i class="fa-solid fa-backward"></i></button>`
    + ` <b>${hours}:${minutes}</b>`
    + (timeScale > 1 ? ` <span title="Fast time">×${timeScale}</span>` : '')
    + (isPlaying
      ? `<button data-gc="stop" style="${style}color:${color}" title="Pause"><i class="fa-solid fa-pause"></i></button>`
      : `<button data-gc="play" style="${style}color:${color}" title="Play"><i class="fa-solid fa-play"></i></button>`)
    + `<button data-gc="ff" style="${style}color:${color}" title="+15 min"><i class="fa-solid fa-forward"></i></button>`;
}
