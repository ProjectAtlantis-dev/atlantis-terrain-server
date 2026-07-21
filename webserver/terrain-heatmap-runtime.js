import { radialPriorityDistance } from './terrain-priority.js';

function priorityColor(value) {
  if (value < 0.33) {
    const amount = value / 0.33;
    return `rgb(255,${Math.round(amount * 224)},32)`;
  }
  if (value < 0.66) {
    const amount = (value - 0.33) / 0.33;
    return `rgb(${Math.round(255 * (1 - amount))},224,${Math.round(32 + amount * 48)})`;
  }
  const amount = (value - 0.66) / 0.34;
  return `rgb(0,${Math.round(224 * (1 - amount))},${Math.round(80 + amount * 175)})`;
}

export function updateHeatmapViewPriorities(tiles, view) {
  if (!Array.isArray(tiles) || !view) return;
  const cameraX = Number(view.cameraX);
  const cameraY = Number(view.cameraY);
  const heading = Number(view.yaw);
  if (![cameraX, cameraY, heading].every(Number.isFinite)) return;
  const forwardX = -Math.sin(heading);
  const forwardY = Math.cos(heading);
  for (const tile of tiles) {
    const [xMin, yMin, xMax, yMax] = tile.bbox;
    const dx = (xMin + xMax) / 2 - cameraX;
    const dy = (yMin + yMax) / 2 - cameraY;
    const distance = Math.hypot(dx, dy);
    if (distance <= 0) {
      tile.priority = 0;
      continue;
    }
    const dot = (dx * forwardX + dy * forwardY) / distance;
    const priorityDistance = radialPriorityDistance(dx, dy);
    tile.priority = Math.log(Math.max(
      priorityDistance / Math.max(dot, 0.01), 1,
    ));
  }
  tiles.sort((a, b) => a.priority - b.priority);
  tiles.forEach((tile, order) => { tile.order = order; });
}

export function createTerrainHeatmapRuntime({
  getView,
  getTiles,
  onWheel,
  onDrag,
  onTileClick,
  documentImpl = document,
  windowImpl = window,
} = {}) {
  const layer = documentImpl.createElement('div');
  layer.id = 'terrain-heatmap-layer';
  layer.style.cssText = [
    'position:fixed', 'inset:0', 'display:none', 'z-index:4',
    'background:#060a10', 'overflow:hidden',
  ].join(';');

  const canvas = documentImpl.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;cursor:crosshair';
  const context = canvas.getContext('2d');
  layer.appendChild(canvas);

  const meta = documentImpl.createElement('div');
  meta.style.cssText = [
    'position:absolute', 'left:50%', 'top:12px', 'transform:translateX(-50%)',
    'padding:6px 10px', 'border:1px solid #1e2d3a', 'border-radius:4px',
    'background:rgba(10,16,24,.84)', 'color:#8aa7c2',
    'font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
    'pointer-events:none', 'white-space:nowrap',
  ].join(';');
  meta.textContent = 'waiting for browser terrain demand…';
  layer.appendChild(meta);

  const tip = documentImpl.createElement('div');
  tip.style.cssText = [
    'position:absolute', 'display:none', 'z-index:2', 'pointer-events:none',
    'padding:4px 8px', 'border:1px solid #2a3f55', 'border-radius:3px',
    'background:#111c28', 'color:#dbe5f1', 'white-space:pre-line',
    'font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
  ].join(';');
  layer.appendChild(tip);
  documentImpl.body.appendChild(layer);

  let presentation = 'hidden';
  let heatmap = null;
  let width = 0;
  let height = 0;
  let animationFrame = null;
  let dragging = false;
  let dragButton = 0;
  let dragged = false;
  let lastView = null;
  let lastPriorityView = null;
  let lastSourceTiles = null;

  function syncBrowserTiles() {
    const sourceTiles = getTiles?.();
    if (sourceTiles === lastSourceTiles) return;
    lastSourceTiles = sourceTiles;
    heatmap = {
      // Priority sorting is presentation state. Keep it off the renderer's
      // authoritative demand array so the heatmap cannot influence residency
      // or eviction order.
      tiles: Array.isArray(sourceTiles) ? sourceTiles.map(tile => {
        const demQuality = classifyDemSource(tile.source);
        const textureQuality = classifyTextureTile(tile);
        return {
          id: tile.id,
          bbox: Array.isArray(tile.bbox) ? [...tile.bbox] : tile.bbox,
          depth: tile.depth,
          source: tile.source,
          demQuality,
          textureQuality,
          hasTexture: Boolean(tile.hasTexture),
          hasHeightmap: Boolean(tile.heightmap),
          texStatus: tile.texStatus,
        };
      }) : [],
    };
    lastPriorityView = null;
    updateMeta();
  }

  function resize() {
    width = windowImpl.innerWidth;
    height = windowImpl.innerHeight;
    const ratio = windowImpl.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context?.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function screenToWorld(clientX, clientY, view) {
    const scale = (height / 2) / Math.max(500, view.zoom);
    const dx = clientX - width / 2;
    const dy = clientY - height / 2;
    const cosine = Math.cos(view.yaw);
    const sine = Math.sin(view.yaw);
    const rotatedX = dx * cosine + dy * sine;
    const rotatedY = -dx * sine + dy * cosine;
    return [view.x + rotatedX / scale, view.y - rotatedY / scale];
  }

  function hit(clientX, clientY) {
    if (!lastView || !heatmap?.tiles) return null;
    const [worldX, worldY] = screenToWorld(clientX, clientY, lastView);
    let best = null;
    for (const tile of heatmap.tiles) {
      const [xMin, yMin, xMax, yMax] = tile.bbox;
      if (
        worldX >= xMin && worldX < xMax && worldY >= yMin && worldY < yMax &&
        (!best || tile.depth > best.depth)
      ) best = tile;
    }
    return best;
  }

  function draw() {
    if (presentation === 'hidden' || !context) return;
    const view = getView?.();
    lastView = view;
    context.clearRect(0, 0, width, height);
    if (!view) {
      context.fillStyle = '#6889a8';
      context.textAlign = 'center';
      context.fillText('waiting for terrain position…', width / 2, height / 2);
      context.textAlign = 'left';
      animationFrame = windowImpl.requestAnimationFrame(draw);
      return;
    }

    syncBrowserTiles();
    const tiles = heatmap?.tiles || [];
    const priorityView = `${view.cameraX}:${view.cameraY}:${view.yaw}`;
    if (priorityView !== lastPriorityView) {
      updateHeatmapViewPriorities(tiles, view);
      lastPriorityView = priorityView;
    }
    const priorities = tiles.map(tile => tile.priority);
    const minPriority = priorities.length ? Math.min(...priorities) : 0;
    const maxPriority = priorities.length ? Math.max(...priorities) : 0;
    const scale = (height / 2) / Math.max(500, view.zoom);
    const labels = [];

    context.save();
    context.translate(width / 2, height / 2);
    context.rotate(view.yaw);
    for (const tile of tiles) {
      const [xMin, yMin, xMax, yMax] = tile.bbox;
      const x = (xMin - view.x) * scale;
      const y = -(yMax - view.y) * scale;
      const tileWidth = (xMax - xMin) * scale;
      const tileHeight = (yMax - yMin) * scale;
      if (x + tileWidth < -width || x > width || y + tileHeight < -height || y > height) continue;
      const normalized = maxPriority > minPriority
        ? (tile.priority - minPriority) / (maxPriority - minPriority)
        : 0;
      const tileColor = priorityColor(normalized);
      if (presentation === 'heatmap') {
        context.globalAlpha = 0.72;
        context.fillStyle = tileColor;
        context.fillRect(x, y, tileWidth, tileHeight);
        context.globalAlpha = 1;
      }
      if (tileWidth > 3) {
        context.strokeStyle = presentation === 'edges'
          ? 'rgba(190,200,210,0.55)'
          : tileColor;
        context.globalAlpha = presentation === 'edges' ? 1 : 0.7;
        context.lineWidth = presentation === 'edges' ? 1 : 1.25;
        context.strokeRect(x, y, tileWidth, tileHeight);
        context.globalAlpha = 1;
        context.lineWidth = 1;
      }
      if (
        presentation === 'heatmap' && tile.order != null &&
        tileWidth > 26 && tileHeight > 16
      ) {
        labels.push({
          text: tile.order,
          x: (xMin + xMax) / 2,
          y: (yMin + yMax) / 2,
          size: Math.min(tileWidth, tileHeight),
        });
      }
    }
    context.restore();

    const cosine = Math.cos(view.yaw);
    const sine = Math.sin(view.yaw);
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = '#000';
    for (const label of labels) {
      const dx = (label.x - view.x) * scale;
      const dy = -(label.y - view.y) * scale;
      const screenX = width / 2 + dx * cosine - dy * sine;
      const screenY = height / 2 + dx * sine + dy * cosine;
      context.font = `bold ${Math.min(Math.max(Math.floor(label.size * 0.35), 8), 14)}px ui-monospace`;
      context.fillText(label.text, screenX, screenY);
    }

    if (presentation === 'heatmap') {
      context.save();
      context.translate(width / 2, height / 2);
      context.fillStyle = '#ffe14a';
      context.strokeStyle = '#806c00';
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(0, -12);
      context.lineTo(8, 10);
      context.lineTo(0, 5);
      context.lineTo(-8, 10);
      context.closePath();
      context.fill();
      context.stroke();
      context.restore();
    }
    context.textAlign = 'left';
    context.textBaseline = 'alphabetic';
    animationFrame = windowImpl.requestAnimationFrame(draw);
  }

  function updateMeta() {
    const count = heatmap?.tiles?.length ?? 0;
    meta.innerHTML = count
      ? `<b style="color:#dbe5f1">${count}</b> quadtree tiles · priority ` +
        '<span style="display:inline-block;width:90px;height:10px;border:1px solid #000;' +
        'background:linear-gradient(to right,#ff2020,#ffff00,#00e050,#0066ff)"></span> hot→cold · numbers = fetch order'
      : 'waiting for browser terrain demand…';
  }

  function setPresentation(next) {
    if (!['hidden', 'edges', 'heatmap'].includes(next)) return;
    if (next === presentation) return;
    const wasVisible = presentation === 'heatmap';
    presentation = next;
    const visible = presentation === 'heatmap';
    layer.style.display = visible ? 'block' : 'none';
    layer.style.background = '#060a10';
    layer.style.pointerEvents = 'auto';
    canvas.style.pointerEvents = 'auto';
    meta.style.display = 'block';
    tip.style.display = 'none';
    if (visible && !wasVisible) {
      resize();
      syncBrowserTiles();
      animationFrame = windowImpl.requestAnimationFrame(draw);
    } else if (!visible && wasVisible) {
      if (animationFrame != null) windowImpl.cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }
  }

  function setActive(next) {
    setPresentation(next ? 'heatmap' : 'edges');
  }

  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    onWheel?.(event.deltaY);
  }, { passive: false });
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  canvas.addEventListener('mousedown', event => {
    dragging = true;
    dragged = false;
    dragButton = event.button;
  });
  windowImpl.addEventListener('mousemove', event => {
    if (presentation !== 'heatmap' || !dragging) return;
    if (event.movementX !== 0 || event.movementY !== 0) dragged = true;
    onDrag?.(event, dragButton);
  });
  windowImpl.addEventListener('mouseup', () => { dragging = false; });
  canvas.addEventListener('mousemove', event => {
    if (dragging) return;
    const tile = hit(event.clientX, event.clientY);
    if (!tile) {
      tip.style.display = 'none';
      return;
    }
    const confidence = tile.confidence
      ? `${tile.confidence.min}–${tile.confidence.max} · avg ${tile.confidence.mean}`
      : 'none';
    tip.textContent = `${tile.id} (d${tile.depth})\npriority ${tile.priority.toFixed(2)} · order ${tile.order}` +
      (tile.hasTexture ? ' · texture cached' : '') +
      `\nterrain ${tile.source || 'none'} · heightmap ${tile.hasHeightmap ? 'yes' : 'no'}` +
      ` · ${tile.demQuality?.synthetic ? 'synthetic' : tile.demQuality?.kind}` +
      `\nimage ${tile.textureQuality?.kind || 'missing'} · ${tile.textureQuality?.retryState || 'unknown'}` +
      `\nconfidence ${confidence}`;
    tip.style.left = `${event.clientX + 14}px`;
    tip.style.top = `${event.clientY + 10}px`;
    tip.style.display = 'block';
  });
  canvas.addEventListener('click', event => {
    if (dragged) return;
    const tile = hit(event.clientX, event.clientY);
    if (tile) onTileClick?.(tile);
  });
  windowImpl.addEventListener('resize', () => {
    if (presentation === 'heatmap') resize();
  });

  return {
    canvas,
    layer,
    get active() { return presentation === 'heatmap'; },
    get presentation() { return presentation; },
    setActive,
    setPresentation,
    toggle() { setActive(presentation !== 'heatmap'); },
  };
}
import { classifyDemSource, classifyTextureTile } from './terrain-tile-quality.js';
