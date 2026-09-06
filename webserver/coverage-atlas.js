import { wgs84ToEpsg3413 } from './terrain-polar-stereo.js';
import { readCameraState } from './terrain-camera-storage.js';
import { createCoverageResource, mergeCoverageInventory } from './coverage-cache.js';
import {
  centerCoverageNavigation,
  createCoverageView,
  panCoverageNavigation,
  parseCoverageNavigationSnapshot,
  serializeCoverageNavigationSnapshot,
  zoomCoverageNavigation,
} from './coverage-navigation.js';

const CAMERA_STORAGE_KEY = 'clouds-cam';
const NAVIGATION_STORAGE_KEY = 'terrain-coverage-navigation-v1';

const canvas = document.querySelector('#atlas');
const context = canvas.getContext('2d');
const summary = document.querySelector('#summary');
const error = document.querySelector('#error');
const tooltip = document.querySelector('#tooltip');
const refresh = document.querySelector('#refresh');
const resetView = document.querySelector('#reset-view');
const centerCamera = document.querySelector('#center-camera');
const cameraStatus = document.querySelector('#camera-status');

let inventory = null;
let outline = null;
let availableCoastline = null;
let outlineExtent = null;
let view = null;
let navigation = (() => {
  try {
    return parseCoverageNavigationSnapshot(
      localStorage.getItem(NAVIGATION_STORAGE_KEY),
    ) ?? { zoom: 1, panX: 0, panY: 0 };
  } catch {
    return { zoom: 1, panX: 0, panY: 0 };
  }
})();
let drag = null;
let cameraPoint = null;
let navigationSaveTimer = null;

function saveNavigation() {
  if (navigationSaveTimer != null) {
    clearTimeout(navigationSaveTimer);
    navigationSaveTimer = null;
  }
  const snapshot = serializeCoverageNavigationSnapshot(navigation);
  if (snapshot == null) return;
  try {
    localStorage.setItem(NAVIGATION_STORAGE_KEY, snapshot);
  } catch {
    // Private browsing and hardened storage settings must not break the atlas.
  }
}

function scheduleNavigationSave() {
  if (navigationSaveTimer != null) clearTimeout(navigationSaveTimer);
  navigationSaveTimer = setTimeout(saveNavigation, 150);
}

function projectedOutline(geometry) {
  return geometry.coordinates.map(polygon => polygon.map(ring => ring.map(([lon, lat]) => {
    const point = wgs84ToEpsg3413(lat, lon);
    return [point.x, point.y];
  })));
}

function outlineBounds(polygons) {
  const points = polygons.flat(2);
  return points.reduce((bounds, [x, y]) => ({
    xMin: Math.min(bounds.xMin, x),
    yMin: Math.min(bounds.yMin, y),
    xMax: Math.max(bounds.xMax, x),
    yMax: Math.max(bounds.yMax, y),
  }), { xMin: Infinity, yMin: Infinity, xMax: -Infinity, yMax: -Infinity });
}

function resize() {
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * scale);
  canvas.height = Math.round(innerHeight * scale);
  context.setTransform(scale, 0, 0, scale, 0, 0);
  render();
}

function outlinePath(polygons) {
  const path = new Path2D();
  for (const polygon of polygons) {
    for (const ring of polygon) {
      ring.forEach(([x, y], index) => {
        if (index === 0) path.moveTo(view.x(x), view.y(y));
        else path.lineTo(view.x(x), view.y(y));
      });
      path.closePath();
    }
  }
  return path;
}

function coastlinePath(lines) {
  const path = new Path2D();
  for (const line of lines ?? []) {
    line.forEach(([x, y], index) => {
      if (index === 0) path.moveTo(view.x(x), view.y(y));
      else path.lineTo(view.x(x), view.y(y));
    });
  }
  return path;
}

function renderTile(tile) {
  const [xMin, yMin, xMax, yMax] = tile.bbox;
  const x = view.x(xMin);
  const y = view.y(yMax);
  const width = Math.max(0.7, view.x(xMax) - x);
  const height = Math.max(0.7, view.y(yMin) - y);
  context.fillStyle = tile.status === 'cured'
    ? 'rgb(20 184 106 / 82%)'
    : tile.depth === inventory.cureDepth
      ? 'rgb(216 144 24 / 82%)'
      : 'rgb(173 105 20 / 35%)';
  context.fillRect(x, y, width, height);
  if (tile.depth === inventory.cureDepth) {
    context.strokeStyle = 'rgb(255 255 255 / 10%)';
    context.lineWidth = 0.5;
    context.strokeRect(x, y, width, height);
  }
}

function renderCameraPosition() {
  if (!cameraPoint) return;
  const x = view.x(cameraPoint.x);
  const y = view.y(cameraPoint.y);
  context.save();
  context.fillStyle = '#57c7ff';
  context.strokeStyle = '#04121a';
  context.lineWidth = 2;
  context.beginPath();
  context.arc(x, y, 5, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.strokeStyle = '#bcecff';
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(x - 10, y);
  context.lineTo(x + 10, y);
  context.moveTo(x, y - 10);
  context.lineTo(x, y + 10);
  context.stroke();
  context.restore();
}

function render() {
  context.clearRect(0, 0, innerWidth, innerHeight);
  if (!inventory || !outline) return;
  view = createCoverageView(outlineExtent, innerWidth, innerHeight, navigation);
  const land = outlinePath(outline);
  context.fillStyle = '#111820';
  context.fill(land, 'evenodd');
  // Natural Earth is context only. It is intentionally not a coverage mask:
  // the cure inventory and locally acquired GTK50 data are more authoritative
  // than this deliberately coarse bundled outline.
  inventory.tiles.filter(tile => tile.depth < inventory.cureDepth).forEach(renderTile);
  inventory.tiles.filter(tile => tile.depth === inventory.cureDepth).forEach(renderTile);
  context.strokeStyle = '#8ca1b4';
  context.lineWidth = 1.1;
  context.stroke(land);
  if (availableCoastline?.lines?.length > 0) {
    context.strokeStyle = '#d6eef7';
    context.lineWidth = 0.8;
    context.stroke(coastlinePath(availableCoastline.lines));
  }
  renderCameraPosition();
}

function partialReason(tile) {
  if (tile.depth < inventory.cureDepth) return `only depth ${tile.depth} coverage`;
  const missing = [];
  if (!tile.dem) missing.push('DEM');
  if (!tile.coastline) missing.push('coastline cure');
  return missing.length ? `missing ${missing.join(' + ')}` : 'provisional';
}

function hoveredTile(clientX, clientY) {
  if (!view || !inventory) return null;
  const x = view.gridX(clientX);
  const y = view.gridY(clientY);
  return inventory.tiles
    .filter(tile => tile.bbox[0] <= x && x <= tile.bbox[2] && tile.bbox[1] <= y && y <= tile.bbox[3])
    .sort((left, right) => right.depth - left.depth)[0] ?? null;
}

function updateTooltip(event) {
  const tile = hoveredTile(event.clientX, event.clientY);
  if (!tile) {
    tooltip.style.display = 'none';
    return;
  }
  const state = tile.status === 'cured' ? 'FULLY CURED' : partialReason(tile);
  tooltip.textContent = `${tile.tile}  ${state}\nDEM ${tile.dem ? 'yes' : 'no'} · coastline ${tile.coastline ? 'fixed' : 'missing'}\ntexture ${tile.texture ?? 'none'}`;
  tooltip.style.left = `${Math.min(innerWidth - 330, event.clientX + 16)}px`;
  tooltip.style.top = `${Math.min(innerHeight - 90, event.clientY + 16)}px`;
  tooltip.style.display = 'block';
}

canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  canvas.classList.add('dragging');
  tooltip.style.display = 'none';
});

canvas.addEventListener('pointermove', event => {
  if (drag?.pointerId === event.pointerId) {
    navigation = panCoverageNavigation(
      navigation,
      event.clientX - drag.x,
      event.clientY - drag.y,
    );
    drag.x = event.clientX;
    drag.y = event.clientY;
    render();
    scheduleNavigationSave();
    return;
  }
  updateTooltip(event);
});

function finishDrag(event) {
  if (drag?.pointerId !== event.pointerId) return;
  drag = null;
  canvas.classList.remove('dragging');
  saveNavigation();
}

canvas.addEventListener('pointerup', finishDrag);
canvas.addEventListener('pointercancel', finishDrag);
canvas.addEventListener('pointerleave', () => {
  if (!drag) tooltip.style.display = 'none';
});
canvas.addEventListener('wheel', event => {
  if (!outlineExtent) return;
  event.preventDefault();
  navigation = zoomCoverageNavigation({
    bounds: outlineExtent,
    width: innerWidth,
    height: innerHeight,
    navigation,
    screenX: event.clientX,
    screenY: event.clientY,
    factor: Math.exp(-event.deltaY * 0.0015),
  });
  tooltip.style.display = 'none';
  render();
  scheduleNavigationSave();
}, { passive: false });

function resetNavigation() {
  navigation = { zoom: 1, panX: 0, panY: 0 };
  tooltip.style.display = 'none';
  render();
  saveNavigation();
}

canvas.addEventListener('dblclick', resetNavigation);
resetView.addEventListener('click', resetNavigation);

async function savedCameraPosition() {
  let raw = null;
  try {
    raw = await readCameraState(CAMERA_STORAGE_KEY);
  } catch {
    // Older builds and browsers without IndexedDB may still have the pose in
    // localStorage, so the atlas keeps the same fallback as the terrain view.
  }
  if (raw == null) raw = localStorage.getItem(CAMERA_STORAGE_KEY);
  if (raw == null) throw new Error('No saved camera position is available yet.');
  const saved = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Number.isFinite(saved?.lat) || !Number.isFinite(saved?.lon)) {
    throw new Error('The saved camera position is invalid.');
  }
  const projected = Number.isFinite(saved.gridX) && Number.isFinite(saved.gridY)
    ? { x: saved.gridX, y: saved.gridY }
    : wgs84ToEpsg3413(saved.lat, saved.lon);
  return { ...projected, lat: saved.lat, lon: saved.lon };
}

async function centerOnCamera() {
  if (!outlineExtent) {
    cameraStatus.textContent = 'Coverage map is still loading.';
    return;
  }
  centerCamera.disabled = true;
  cameraStatus.textContent = 'Reading camera position…';
  try {
    cameraPoint = await savedCameraPosition();
    navigation = centerCoverageNavigation({
      bounds: outlineExtent,
      width: innerWidth,
      height: innerHeight,
      navigation,
      gridX: cameraPoint.x,
      gridY: cameraPoint.y,
    });
    tooltip.style.display = 'none';
    cameraStatus.textContent = `Centered at ${cameraPoint.lat.toFixed(5)}°, ${cameraPoint.lon.toFixed(5)}°`;
    render();
    saveNavigation();
  } catch (cameraError) {
    cameraStatus.textContent = cameraError.message;
  } finally {
    centerCamera.disabled = false;
  }
}

centerCamera.addEventListener('click', () => { void centerOnCamera(); });

async function restoreCameraMarker() {
  try {
    cameraPoint = await savedCameraPosition();
    render();
  } catch {
    // A missing terrain-camera snapshot simply leaves the marker hidden.
    cameraPoint = null;
  }
}

let showingSavedCoverage = false;

function updateCoverage() {
  if (inventory) {
    const { cured, partial, coarse } = inventory.summary;
    const coastlineSummary = availableCoastline
      ? ` · ${availableCoastline.blocks.length.toLocaleString()} GTK50 coastline blocks`
      : '';
    const savedSummary = showingSavedCoverage ? ' · saved coverage' : '';
    summary.textContent = `${cured.toLocaleString()} cured D10 · ${partial.toLocaleString()} partial D10 · ${coarse.toLocaleString()} coarse tiles${coastlineSummary}${savedSummary}\n${inventory.definition}`;
  }
  render();
}

const coverageResource = createCoverageResource({
  url: '/api/coverage/cure.json',
  merge: mergeCoverageInventory,
  onData(data, { cached }) {
    inventory = data;
    showingSavedCoverage = cached;
    updateCoverage();
  },
});
const outlineResource = createCoverageResource({
  url: '/greenland-outline.json',
  maxAge: 24 * 60 * 60_000,
  onData(data) {
    outline = projectedOutline(data.geometry);
    outlineExtent = outlineBounds(outline);
    updateCoverage();
  },
});
const coastlineResource = createCoverageResource({
  url: '/api/coverage/coastline.json',
  maxAge: 60 * 60_000,
  onData(data) {
    availableCoastline = data;
    updateCoverage();
  },
});

let loading = null;
function load({ force = false } = {}) {
  if (loading) return loading;
  refresh.disabled = true;
  error.textContent = '';
  // Each resource renders as soon as it is available. Coastline downloads and
  // background revalidation must not hold up the saved inventory.
  loading = Promise.allSettled([
    coverageResource.load({ force }),
    outlineResource.load({ force }),
    coastlineResource.load({ force }),
  ]).then(([coverageResult, outlineResult]) => {
    const failed = [coverageResult, outlineResult].find(result => result.status === 'rejected');
    if (failed) error.textContent = failed.reason.message;
  }).finally(() => {
    refresh.disabled = false;
    loading = null;
  });
  return loading;
}

refresh.addEventListener('click', () => { void load({ force: true }); });
window.addEventListener('resize', resize);
window.addEventListener('beforeunload', saveNavigation);
resize();
void restoreCameraMarker();
load();
setInterval(load, 30_000);
