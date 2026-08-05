export const CLASS_COLORS = {
  bare_rock: [150, 105, 210], vegetation: [150, 225, 60],
  soil_scree: [255, 140, 0], snow_ice: [255, 255, 255],
  water: [255, 42, 161], unknown_shadow: [60, 120, 255],
  lake: [0, 200, 220], sand: [255, 230, 90],
  shore_rock: [105, 92, 125], ignore: [30, 38, 46],
};

export function parseD12(value) {
  const match = /^(\d+)-(\d+)-(\d+)$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const sourceDepth = Number(match[1]);
  let col = Number(match[2]);
  let row = Number(match[3]);
  if (sourceDepth > 12) {
    const scale = 2 ** (sourceDepth - 12);
    col = Math.floor(col / scale);
    row = Math.floor(row / scale);
  } else if (sourceDepth < 12) {
    const scale = 2 ** (12 - sourceDepth);
    col *= scale;
    row *= scale;
  }
  return { depth: 12, col, row };
}

export function decodeSegmentId(pixel) {
  const encoded = pixel[0] + pixel[1] * 256 + pixel[2] * 65536;
  return encoded - 1;
}

const $ = id => document.getElementById(id);
let tile = parseD12(new URLSearchParams(location.search).get('tile'))
  || { depth: 12, col: 1471, row: 826 };
let metadata = null;
let selectedClass = 'vegetation';
let painting = false;
let pointerStart = null;
let paintedSegments = new Set();
let overlayImage = null;
let activeView = 'annotation';
let inspectedPoint = null;
const canvas = $('annotation-canvas');
const context = canvas.getContext('2d');
const idsCanvas = document.createElement('canvas');
const idsContext = idsCanvas.getContext('2d', { willReadFrequently: true });

function tileId() { return `12-${tile.col}-${tile.row}`; }

function loadParentTile() {
  const parent = `11-${Math.floor(tile.col / 2)}-${Math.floor(tile.row / 2)}`;
  $('parent-id').textContent = parent;
  $('parent-message').textContent = 'Loading parent…';
  const quadrant = $('child-quadrant');
  quadrant.style.left = `${(tile.col % 2) * 50}%`;
  quadrant.style.top = `${(1 - (tile.row % 2)) * 50}%`;
  const image = $('parent-image');
  image.onload = () => { $('parent-message').textContent = ''; };
  image.onerror = () => { $('parent-message').textContent = 'Parent texture unavailable'; };
  image.src = `/api/texture/${parent}.jpg?t=${Date.now()}`;
}

function setStatus(element, message, className = '') {
  element.textContent = message;
  element.className = className;
}

function renderClasses() {
  const classes = metadata?.classes || Object.keys(CLASS_COLORS).filter(name => name !== 'ignore');
  $('classes').innerHTML = [...classes, 'ignore'].map(name => {
    const color = CLASS_COLORS[name];
    return `<button class="class-button${name === selectedClass ? ' selected' : ''}" data-class="${name}">
      <span class="swatch" style="background:rgb(${color.join(',')})"></span>${name.replaceAll('_', ' ')}
    </button>`;
  }).join('');
  for (const button of $('classes').querySelectorAll('[data-class]')) {
    button.addEventListener('click', () => {
      selectedClass = button.dataset.class;
      renderClasses();
    });
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = `${url}?t=${Date.now()}`;
  });
}

const VIEW_HELP = {
  annotation: 'Faint colors are existing classifier suggestions. Click a region to inspect why it received its default, or drag to correct it; stronger colors are saved human labels.',
  texture: 'The exact source RGB supplied to segmentation and the trained classifier.',
  elev: 'Elevation derived from the cached DEM, aligned to the tile image.',
  slope: 'Terrain steepness derived from the cached DEM; brighter pixels are steeper.',
  southness: 'Aspect derived from the DEM: red faces south and blue faces north.',
  sun: 'Terrain insolation derived from slope and aspect.',
  classifier: 'The persisted default class map. Select a point to see its actual source and confidence.',
};

function evidenceUrl(view) {
  if (view === 'texture') return `/api/texture/${tileId()}.jpg`;
  if (view === 'classifier') return `/api/classifier/${tileId()}.png?res=${metadata?.width || 512}`;
  return `/api/channel/${tileId()}/${view}.png?res=${metadata?.width || 512}`;
}

function setView(view) {
  activeView = view;
  const annotation = view === 'annotation';
  canvas.style.display = annotation ? 'block' : 'none';
  $('evidence-image').style.display = annotation ? 'none' : 'block';
  $('view-help').textContent = VIEW_HELP[view];
  for (const tab of document.querySelectorAll('.view-tab')) {
    const selected = tab.dataset.view === view;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
  }
  if (!annotation && metadata) {
    $('canvas-message').textContent = 'Loading evidence…';
    const image = $('evidence-image');
    image.onload = () => { $('canvas-message').textContent = ''; };
    image.onerror = () => { $('canvas-message').textContent = 'Evidence unavailable'; };
    image.src = `${evidenceUrl(view)}${evidenceUrl(view).includes('?') ? '&' : '?'}t=${Date.now()}`;
  }
}

async function loadTile() {
  $('tile').value = tileId();
  loadParentTile();
  $('canvas-message').textContent = 'Loading segmentation…';
  const url = new URL(location);
  url.searchParams.set('tile', tileId());
  history.replaceState(null, '', url);
  try {
    const response = await fetch(`/api/classifier/training/${tileId()}`, { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    metadata = result;
    [overlayImage] = await Promise.all([
      loadImage(result.overlayUrl),
      loadImage(result.segmentIdsUrl).then(image => {
        idsCanvas.width = result.width;
        idsCanvas.height = result.height;
        idsContext.imageSmoothingEnabled = false;
        idsContext.drawImage(image, 0, 0);
      }),
    ]);
    canvas.width = result.width;
    canvas.height = result.height;
    context.drawImage(overlayImage, 0, 0);
    $('canvas-message').textContent = '';
    const suggestion = result.suggestionSource ? ` · suggestions ${result.suggestionSource}` : ' · no existing suggestions';
    $('tile-meta').textContent = `${result.regionCount} regions · group ${result.group} · ${result.split} split${suggestion}`;
    $('tile-meta').className = result.split === 'regression' ? 'warning' : '';
    $('annotated-count').textContent = `${Object.keys(result.annotations).length} / ${result.regionCount} regions labeled`;
    setStatus($('save-status'), result.split === 'regression'
      ? 'Frozen evaluation tile: labels score the model but never train it.'
      : 'Drag across regions to label them.');
    renderClasses();
    setView(activeView);
    inspectPoint(Math.floor(result.width / 2), Math.floor(result.height / 2));
  } catch (error) {
    $('canvas-message').textContent = error.message;
    setStatus($('save-status'), error.message, 'error');
  }
}

function pointAt(event) {
  if (!metadata) return -1;
  const rect = $('view-surface').getBoundingClientRect();
  const x = Math.max(0, Math.min(metadata.width - 1, Math.floor((event.clientX - rect.left) * metadata.width / rect.width)));
  const y = Math.max(0, Math.min(metadata.height - 1, Math.floor((event.clientY - rect.top) * metadata.height / rect.height)));
  return { x, y };
}

function segmentAt(event) {
  const point = pointAt(event);
  return point === -1 ? -1 : decodeSegmentId(idsContext.getImageData(point.x, point.y, 1, 1).data);
}

function formatNumber(value, digits = 1) {
  return value == null ? 'n/a' : Number(value).toFixed(digits);
}

function renderProvenance(result) {
  const className = result.assignment || 'no suggestion';
  const color = CLASS_COLORS[result.assignment] || [110, 130, 145];
  const confidence = result.confidence == null ? 'confidence not retained' : `${Math.round(result.confidence * 100)}% confidence`;
  const inputs = result.inputs;
  $('provenance-pixel').textContent = `px ${result.pixel.x}, ${result.pixel.y} · region ${result.segmentId}`;
  $('provenance-content').className = '';
  $('provenance-content').innerHTML = `
    <div class="assignment-line"><span class="swatch" style="background:rgb(${color.join(',')})"></span><span class="assignment-name">${className.replaceAll('_', ' ')}</span><span class="confidence">${confidence}</span></div>
    <div class="source-line">${result.source || 'no stored classifier'} · ${result.schema || 'no schema'}${result.updatedAt ? ` · ${new Date(result.updatedAt).toLocaleString()}` : ''}</div>
    <p class="decision-summary">${result.decision.summary}</p>
    <div class="evidence-values">
      <div><b>RGB at pixel</b><span>${inputs.rgb.join(', ')}</span></div>
      <div><b>Elevation</b><span>${formatNumber(inputs.elevationM)} m</span></div>
      <div><b>Slope</b><span>${formatNumber(inputs.slopeDegrees)}°</span></div>
      <div><b>Local relief</b><span>${formatNumber(inputs.localReliefM)} m</span></div>
      <div><b>Southness</b><span>${formatNumber(inputs.southness, 3)}</span></div>
      <div><b>Eastness</b><span>${formatNumber(inputs.eastness, 3)}</span></div>
      <div><b>Insolation</b><span>${formatNumber(inputs.insolation, 3)}</span></div>
      <div><b>Official water</b><span>${inputs.officialWater ? 'yes — authoritative' : 'no'}</span></div>
    </div>`;
}

async function inspectPoint(x, y) {
  inspectedPoint = { x, y };
  const marker = $('inspection-marker');
  marker.style.display = 'block';
  marker.style.left = `${(x + .5) * 100 / metadata.width}%`;
  marker.style.top = `${(y + .5) * 100 / metadata.height}%`;
  $('provenance-pixel').textContent = `px ${x}, ${y}`;
  $('provenance-content').className = 'provenance-empty';
  $('provenance-content').textContent = 'Loading assignment provenance…';
  try {
    const response = await fetch(`/api/classifier/training/${tileId()}/explain?x=${x}&y=${y}`, { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    if (inspectedPoint?.x === x && inspectedPoint?.y === y) renderProvenance(result);
  } catch (error) {
    $('provenance-content').textContent = error.message;
  }
}

function collectSegment(event) {
  const segmentId = segmentAt(event);
  if (segmentId >= 0) paintedSegments.add(segmentId);
}

async function savePainted() {
  if (!paintedSegments.size) return;
  const assignments = [...paintedSegments].map(segmentId => ({
    segmentId,
    className: selectedClass === 'ignore' ? null : selectedClass,
  }));
  paintedSegments.clear();
  setStatus($('save-status'), `Saving ${assignments.length} region(s)…`);
  try {
    const response = await fetch(`/api/classifier/training/${tileId()}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignments }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    metadata.annotations = result.annotations;
    overlayImage = await loadImage(metadata.overlayUrl);
    context.drawImage(overlayImage, 0, 0);
    $('annotated-count').textContent = `${result.annotated} / ${metadata.regionCount} regions labeled`;
    setStatus(
      $('save-status'),
      result.pairError
        ? `Saved ${assignments.length} region(s); dataset export deferred: ${result.pairError}`
        : `Saved ${assignments.length} region(s) and updated the dataset pair.`,
      result.pairError ? '' : 'ok',
    );
  } catch (error) {
    setStatus($('save-status'), error.message, 'error');
  }
}

canvas.addEventListener('pointerdown', event => {
  painting = false;
  pointerStart = {
    clientX: event.clientX,
    clientY: event.clientY,
    segmentId: segmentAt(event),
  };
  canvas.setPointerCapture(event.pointerId);
  const point = pointAt(event);
  if (point !== -1) inspectPoint(point.x, point.y);
});
canvas.addEventListener('pointermove', event => {
  if (!pointerStart) return;
  if (!painting && Math.hypot(
    event.clientX - pointerStart.clientX,
    event.clientY - pointerStart.clientY,
  ) >= 4) {
    painting = true;
    if (pointerStart.segmentId >= 0) paintedSegments.add(pointerStart.segmentId);
  }
  if (painting) collectSegment(event);
});
canvas.addEventListener('pointerup', async () => {
  const shouldSave = painting;
  painting = false;
  pointerStart = null;
  if (shouldSave) await savePainted();
});
canvas.addEventListener('pointercancel', () => {
  painting = false;
  pointerStart = null;
  paintedSegments.clear();
});

async function trainModel() {
  $('train-model').disabled = true;
  setStatus($('model-status'), 'Starting reference pretraining and semantic fine-tuning…');
  try {
    const response = await fetch('/api/classifier/training/train', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    setStatus($('model-status'), 'Training started in the background. Status updates here automatically.', 'ok');
    setTimeout(loadModelStatus, 1500);
  } catch (error) {
    setStatus($('model-status'), error.message, 'error');
  } finally { $('train-model').disabled = false; }
}

async function predictTile() {
  $('predict-tile').disabled = true;
  setStatus($('model-status'), `Running trained model on ${tileId()}…`);
  try {
    const response = await fetch(`/api/classifier/training/predict/${tileId()}`, { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    setStatus($('model-status'), `Stored ${result.regions} predicted regions at ${Math.round(result.meanConfidence * 100)}% mean confidence.`, 'ok');
  } catch (error) {
    setStatus($('model-status'), error.message, 'error');
  } finally { $('predict-tile').disabled = false; }
}

async function loadModelStatus() {
  try {
    const response = await fetch('/api/classifier/training/model', { cache: 'no-store' });
    const result = await response.json();
    if (result.trainingJob?.status === 'running') {
      setStatus($('model-status'), 'Training is running: reconstruction pretraining, then trusted-label fine-tuning.');
      setTimeout(loadModelStatus, 3000);
      return;
    }
    if (result.trainingJob?.status === 'failed') {
      setStatus($('model-status'), result.trainingJob.error, 'error');
      return;
    }
    if (result.candidate && result.candidate.createdAt !== result.createdAt) {
      const validation = result.candidate.metrics?.validation;
      const regression = result.candidate.metrics?.regression;
      const percent = metric => metric?.accuracy == null
        ? 'unscored' : `${Math.round(metric.accuracy * 100)}%`;
      setStatus($('model-status'), `Candidate ${result.candidate.format} is ready: validation ${percent(validation)}, regression ${percent(regression)}. Review metrics, then promote from the CLI.`, 'ok');
      return;
    }
    if (!result.trained) {
      setStatus($('model-status'), 'No model artifact yet. Export aligned pairs, label trusted regions, then train.');
      return;
    }
    const validation = result.metrics?.validation;
    setStatus($('model-status'), `Active ${result.format}, trained ${new Date(result.createdAt).toLocaleString()}; validation ${validation?.accuracy == null ? 'n/a' : `${Math.round(validation.accuracy * 100)}%`}.`, 'ok');
  } catch (error) {
    setStatus($('model-status'), error.message, 'error');
  }
}

const ZOOM_MIN = 100;
const ZOOM_MAX = 400;
const ZOOM_STEP = 25;

function setZoom(value) {
  const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number(value)));
  $('zoom').value = String(zoom);
  $('zoom-level').textContent = `${zoom}%`;
  $('view-surface').style.setProperty('--canvas-zoom', `${zoom}%`);
}

$('load').addEventListener('click', () => { const parsed = parseD12($('tile').value); if (parsed) { tile = parsed; loadTile(); } });
$('tile').addEventListener('keydown', event => { if (event.key === 'Enter') $('load').click(); });
$('zoom').addEventListener('input', event => setZoom(event.target.value));
$('zoom-out').addEventListener('click', () => setZoom(Number($('zoom').value) - ZOOM_STEP));
$('zoom-in').addEventListener('click', () => setZoom(Number($('zoom').value) + ZOOM_STEP));
$('train-model').addEventListener('click', trainModel);
$('predict-tile').addEventListener('click', predictTile);
for (const tab of document.querySelectorAll('.view-tab')) tab.addEventListener('click', () => setView(tab.dataset.view));
$('evidence-image').addEventListener('click', event => {
  const point = pointAt(event);
  if (point !== -1) inspectPoint(point.x, point.y);
});

renderClasses();
setZoom(100);
loadModelStatus();
loadTile();
