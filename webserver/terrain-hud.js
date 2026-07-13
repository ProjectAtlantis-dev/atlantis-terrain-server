export const TERRAIN_HUD_LINKS = Object.freeze({
  debugLogLink: '/client_log.html',
});

function appendPanel(cssText) {
  const element = document.createElement('div');
  element.style.cssText = cssText.join(';');
  document.body.appendChild(element);
  return element;
}

export function createTerrainHud({ onToggleMapMode, onToggleHeatmap, onClockAction }) {
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
      event.target.id === 'heatmapModeLink' ||
      TERRAIN_HUD_LINKS[event.target.id]
    );
    if (!isLink) hud.dataset.selecting = 'true';
    if (event.target.id === 'mapModeLink') {
      event.stopPropagation();
      event.preventDefault();
      onToggleMapMode();
      return;
    }
    if (event.target.id === 'heatmapModeLink') {
      event.stopPropagation();
      event.preventDefault();
      onToggleHeatmap();
      return;
    }
    const url = TERRAIN_HUD_LINKS[event.target.id];
    if (url) {
      event.stopPropagation();
      event.preventDefault();
      window.open(url, '_blank');
    }
  });
  window.addEventListener('mouseup', () => {
    hud.dataset.selecting = 'false';
  });
  hud.addEventListener('click', event => {
    if (
      event.target.id === 'mapModeLink' || event.target.id === 'heatmapModeLink' ||
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

export function renderGameClock(element, date, isPlaying) {
  const nuukTime = date.toLocaleString('en-GB', {
    timeZone: 'America/Nuuk', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const [hours, minutes] = nuukTime.split(':');
  const style = 'cursor:pointer;padding:0 4px;border:none;background:none;font-size:12px;line-height:1;vertical-align:middle;';
  const color = '#5af';
  element.innerHTML = `<button data-gc="rw" style="${style}color:${color}" title="−15 min"><i class="fa-solid fa-backward"></i></button>`
    + ` <b>${hours}:${minutes}</b>`
    + (isPlaying
      ? `<button data-gc="stop" style="${style}color:${color}" title="Pause"><i class="fa-solid fa-pause"></i></button>`
      : `<button data-gc="play" style="${style}color:${color}" title="Play"><i class="fa-solid fa-play"></i></button>`)
    + `<button data-gc="ff" style="${style}color:${color}" title="+15 min"><i class="fa-solid fa-forward"></i></button>`;
}
