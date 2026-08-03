export const CLASS_COLORS = {
  bare_rock: [150, 105, 210], vegetation: [150, 225, 60],
  soil_scree: [255, 140, 0], snow_ice: [255, 255, 255],
  water: [255, 42, 161], unknown_shadow: [60, 120, 255],
  lake: [0, 200, 220], sand: [255, 230, 90],
  shore_rock: [105, 92, 125], ignore: [30, 38, 46],
};

export function parseD12(value) {
  const match = /^12-(\d+)-(\d+)$/.exec(String(value ?? '').trim());
  return match ? { depth: 12, col: Number(match[1]), row: Number(match[2]) } : null;
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
let paintedSegments = new Set();
let overlayImage = null;
const canvas = $('annotation-canvas');
const context = canvas.getContext('2d');
const idsCanvas = document.createElement('canvas');
const idsContext = idsCanvas.getContext('2d', { willReadFrequently: true });

function tileId() { return `12-${tile.col}-${tile.row}`; }

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

async function loadTile() {
  $('tile').value = tileId();
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
    $('tile-meta').textContent = `${result.regionCount} regions · group ${result.group} · ${result.split} split`;
    $('tile-meta').className = result.split === 'regression' ? 'warning' : '';
    $('annotated-count').textContent = `${Object.keys(result.annotations).length} / ${result.regionCount} regions labeled`;
    setStatus($('save-status'), result.split === 'regression'
      ? 'Frozen evaluation tile: labels score the model but never train it.'
      : 'Drag across regions to label them.');
    renderClasses();
  } catch (error) {
    $('canvas-message').textContent = error.message;
    setStatus($('save-status'), error.message, 'error');
  }
}

function segmentAt(event) {
  if (!metadata) return -1;
  const rect = canvas.getBoundingClientRect();
  const x = Math.max(0, Math.min(metadata.width - 1, Math.floor((event.clientX - rect.left) * metadata.width / rect.width)));
  const y = Math.max(0, Math.min(metadata.height - 1, Math.floor((event.clientY - rect.top) * metadata.height / rect.height)));
  return decodeSegmentId(idsContext.getImageData(x, y, 1, 1).data);
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
    setStatus($('save-status'), `Saved ${assignments.length} region(s).`, 'ok');
  } catch (error) {
    setStatus($('save-status'), error.message, 'error');
  }
}

canvas.addEventListener('pointerdown', event => {
  painting = true;
  canvas.setPointerCapture(event.pointerId);
  collectSegment(event);
});
canvas.addEventListener('pointermove', event => { if (painting) collectSegment(event); });
canvas.addEventListener('pointerup', async () => { painting = false; await savePainted(); });
canvas.addEventListener('pointercancel', () => { painting = false; paintedSegments.clear(); });

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

function move(dx, dy) { tile.col += dx; tile.row += dy; loadTile(); }
$('load').addEventListener('click', () => { const parsed = parseD12($('tile').value); if (parsed) { tile = parsed; loadTile(); } });
$('tile').addEventListener('keydown', event => { if (event.key === 'Enter') $('load').click(); });
$('west').addEventListener('click', () => move(-1, 0));
$('east').addEventListener('click', () => move(1, 0));
$('north').addEventListener('click', () => move(0, 1));
$('south').addEventListener('click', () => move(0, -1));
$('train-model').addEventListener('click', trainModel);
$('predict-tile').addEventListener('click', predictTile);

renderClasses();
loadModelStatus();
loadTile();
