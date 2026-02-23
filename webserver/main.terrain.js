// UX WIP scene: preserve baseline rendering, layer in map mode + movement + HUD.
import * as THREE from 'three';
import {
  EffectComposer,
  EffectPass,
  NormalPass,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode
} from 'postprocessing';
import {
  AerialPerspectiveEffect,
  DEFAULT_PRECOMPUTED_TEXTURES_URL,
  getSunDirectionECEF,
  PrecomputedTexturesLoader
} from '@takram/three-atmosphere';
import {
  CloudShape,
  CloudShapeDetail,
  CloudsEffect,
  LocalWeather,
  Turbulence
} from '@takram/three-clouds';
import { DitheringEffect } from './three-geospatial/packages/effects/src/index.ts';
import { Ellipsoid, Geodetic, radians } from '@takram/three-geospatial';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const params = new URLSearchParams(window.location.search);
const CLIENT_LOG_ENDPOINT = '/api/client_log';
const CLIENT_LOG_ENABLED = params.get('clientLog') !== '0';
const CLIENT_LOG_BATCH_SIZE = 40;
const CLIENT_LOG_MAX_QUEUE = 600;
const CLIENT_LOG_FLUSH_MS = 800;
const clientLogQueue = [];
let clientLogInFlight = false;
let clientLogFlushTimer = null;

function safeClientLogDetails(details) {
  if (details === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(JSON.stringify(details));
  } catch (_) {
    try {
      return { nonSerializable: true, text: String(details) };
    } catch (__ignored) {
      return { nonSerializable: true };
    }
  }
}

function scheduleClientLogFlush(delayMs = CLIENT_LOG_FLUSH_MS) {
  if (!CLIENT_LOG_ENABLED || clientLogFlushTimer != null) {
    return;
  }
  clientLogFlushTimer = window.setTimeout(() => {
    clientLogFlushTimer = null;
    flushClientLogQueue();
  }, delayMs);
}

function flushClientLogQueue({ useBeacon = false } = {}) {
  if (!CLIENT_LOG_ENABLED || clientLogInFlight || clientLogQueue.length === 0) {
    return;
  }
  const batch = clientLogQueue.splice(0, CLIENT_LOG_BATCH_SIZE);
  const body = JSON.stringify({
    sceneMode: 'clouds-terrain-managed-flask-ux-wip',
    entries: batch
  });
  if (useBeacon && navigator.sendBeacon) {
    const blob = new Blob([body], { type: 'application/json' });
    const ok = navigator.sendBeacon(CLIENT_LOG_ENDPOINT, blob);
    if (!ok) {
      clientLogQueue.unshift(...batch);
    }
    return;
  }
  clientLogInFlight = true;
  fetch(CLIENT_LOG_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true
  })
    .then(response => {
      if (!response.ok) {
        throw new Error(`client log status ${response.status}`);
      }
    })
    .catch(err => {
      console.error('[CLIENT LOG] post failed', {
        endpoint: CLIENT_LOG_ENDPOINT,
        error: err?.message ?? String(err),
      });
      clientLogQueue.unshift(...batch);
      if (clientLogQueue.length > CLIENT_LOG_MAX_QUEUE) {
        clientLogQueue.splice(0, clientLogQueue.length - CLIENT_LOG_MAX_QUEUE);
      }
    })
    .finally(() => {
      clientLogInFlight = false;
      if (clientLogQueue.length > 0) {
        scheduleClientLogFlush(250);
      }
    });
}

function enqueueClientLog(level, phase, details) {
  if (!CLIENT_LOG_ENABLED) {
    return;
  }
  const entry = {
    ts: new Date().toISOString(),
    level,
    phase
  };
  const safeDetails = safeClientLogDetails(details);
  if (safeDetails !== undefined) {
    entry.details = safeDetails;
  }
  clientLogQueue.push(entry);
  if (clientLogQueue.length > CLIENT_LOG_MAX_QUEUE) {
    clientLogQueue.splice(0, clientLogQueue.length - CLIENT_LOG_MAX_QUEUE);
  }
  if (clientLogQueue.length >= CLIENT_LOG_BATCH_SIZE) {
    flushClientLogQueue();
  } else {
    scheduleClientLogFlush();
  }
}

window.addEventListener('beforeunload', () => {
  flushClientLogQueue({ useBeacon: true });
});

const bootStartMs = performance.now();
const bootEvents = [];

function getBootMemorySnapshot() {
  const mem = performance.memory;
  if (!mem) return null;
  return {
    jsHeapMB: Number((mem.usedJSHeapSize / (1024 * 1024)).toFixed(1)),
    jsHeapLimitMB: Number((mem.jsHeapSizeLimit / (1024 * 1024)).toFixed(1))
  };
}

function bootLog(phase, details, level = 'info') {
  const elapsedMs = Number((performance.now() - bootStartMs).toFixed(1));
  const entry = { elapsedMs, phase, level };
  if (details !== undefined) {
    entry.details = details;
  }
  const mem = getBootMemorySnapshot();
  if (mem != null) {
    entry.memory = mem;
  }
  bootEvents.push(entry);
  if (bootEvents.length > 300) {
    bootEvents.shift();
  }
  const compactDetails = { elapsedMs };
  if (details !== undefined) {
    compactDetails.details = details;
  }
  if (mem != null) {
    compactDetails.memory = mem;
  }
  enqueueClientLog(level, phase, compactDetails);
}

window.addEventListener('error', event => {
  bootLog('window.error', {
    message: event.message,
    source: event.filename,
    line: event.lineno,
    column: event.colno,
    stack: event.error?.stack ?? null
  }, 'error');
});

window.addEventListener('unhandledrejection', event => {
  const reason = event.reason;
  bootLog('window.unhandledrejection', {
    message: reason?.message ?? String(reason),
    stack: reason?.stack ?? null
  }, 'error');
});
bootLog('script.start', {
  href: window.location.href,
  userAgent: navigator.userAgent
});

// Use summer daytime in Nuuk so textured ground is clearly visible.
const referenceDate = new Date('2025-07-01T12:00:00Z');

const DEFAULT_CENTER = {
  // Nuuk, Greenland
  lon: -51.7216,
  lat: 64.1835
};
const ATMOSPHERE_CACHE_NAME = 'takram-atmosphere-exr-v1';
const ATMOSPHERE_TEXTURE_FILES = [
  'transmittance.exr',
  'scattering.exr',
  'irradiance.exr',
  'higher_order_scattering.exr'
];

const centerLon = Number(params.get('lon') ?? DEFAULT_CENTER.lon);
const centerLat = Number(params.get('lat') ?? DEFAULT_CENTER.lat);

const scene = new THREE.Scene();
// Black fog — aerial perspective inscatter fills in the natural sky color at distance.
scene.fog = new THREE.FogExp2(0x000000, 0.00009);
const _sceneFog = scene.fog;
const _mapBg = new THREE.Color(0x222222);

// Geospatial scenes use a local ENU frame anchored at the target geodetic point.
const anchorGeodetic = new Geodetic(radians(centerLon), radians(centerLat), 0);
const anchorPosition = anchorGeodetic.toECEF();
const east = new THREE.Vector3();
const north = new THREE.Vector3();
const up = new THREE.Vector3();
Ellipsoid.WGS84.getEastNorthUpVectors(anchorPosition, east, north, up);

// --- View distance constants ---
const MAX_VIEW_DIST = 50000;       // 50km — camera far, fog, map extents
const MAP_CAM_ALT = MAX_VIEW_DIST; // map camera altitude above target

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  1,
  MAX_VIEW_DIST
);
const cameraOffset = new THREE.Vector3()
  .addScaledVector(east, -2600)
  .addScaledVector(north, -3600)
  .addScaledVector(up, 700);
camera.position.copy(anchorPosition).add(cameraOffset);
camera.up.copy(up);
camera.lookAt(anchorPosition);
camera.updateMatrixWorld();

const mapCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, MAP_CAM_ALT + 5000);
mapCam.up.copy(north);
mapCam.layers.enable(0);
const DEFAULT_MAP_ZOOM = 20000;

const controls = {
  yaw: 0,
  pitch: -0.32,
  speed: 0,
  dragging: false,
  dragButton: 0,
  mapMode: false,
  mapZoom: DEFAULT_MAP_ZOOM,
  mapPanEast: 0,
  mapPanNorth: 0,
  keys: {}
};
const ACCEL = 1200;
const BRAKE = 800;
const MAX_SPEED = 5000;
const STRAFE_SPEED = 800;
const TURN_SPEED = 1.5;
const MOUSE_SENS = 0.003;
const MAP_PAN_FACTOR = 1.2;

const defaultCameraPosition = camera.position.clone();
const _lastGoodCamPos = camera.position.clone();
const initialForward = anchorPosition.clone().sub(camera.position).normalize();
const defaultYaw = Math.atan2(-initialForward.dot(east), initialForward.dot(north));
const defaultPitch = Math.asin(Math.max(-1, Math.min(1, initialForward.dot(up))));
controls.yaw = defaultYaw;
controls.pitch = defaultPitch;

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  depth: false,
  logarithmicDepthBuffer: true
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = true;
// Tone mapping is handled in post-processing; avoid applying it twice here.
renderer.toneMapping = THREE.NoToneMapping;
renderer.toneMappingExposure = 10;
bootLog('renderer.ready', {
  width: window.innerWidth,
  height: window.innerHeight,
  pixelRatio: window.devicePixelRatio,
  shadowMap: renderer.shadowMap.type
});
document.body.appendChild(renderer.domElement);
renderer.domElement.addEventListener('contextmenu', event => event.preventDefault());

const hud = document.createElement('div');
hud.style.cssText = [
  'position:absolute',
  'top:12px',
  'left:12px',
  'padding:10px 12px',
  'background:rgba(0,0,0,0.7)',
  'color:#dbe5f1',
  'font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
  'border-radius:8px',
  'pointer-events:none',
  'z-index:5'
].join(';');
document.body.appendChild(hud);

const alt = document.createElement('div');
alt.style.cssText = [
  'position:absolute',
  'right:12px',
  'bottom:12px',
  'padding:8px 10px',
  'background:rgba(0,0,0,0.7)',
  'color:#8fd0ff',
  'font:13px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
  'border-radius:6px',
  'pointer-events:none',
  'z-index:5'
].join(';');
document.body.appendChild(alt);

const tileInfoEl = document.createElement('div');
tileInfoEl.style.cssText = [
  'position:absolute',
  'top:12px',
  'right:12px',
  'color:#fff',
  'font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
  'background:rgba(0,0,0,0.8)',
  'padding:8px 12px',
  'border-radius:6px',
  'pointer-events:none',
  'display:none',
  'z-index:6'
].join(';');
document.body.appendChild(tileInfoEl);

// --- Tile context menu (map mode) ---
const tileMenuEl = document.createElement('div');
tileMenuEl.style.cssText = [
  'position:absolute', 'display:none', 'z-index:20',
  'background:rgba(0,0,0,0.9)', 'border:1px solid #555', 'border-radius:6px',
  'padding:4px 0', 'min-width:180px',
  'font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
  'color:#fff', 'cursor:default'
].join(';');
document.body.appendChild(tileMenuEl);

// --- Enhance prompt dialog ---
let enhanceDialogEl = document.getElementById('enhance-dialog');
if (!enhanceDialogEl) {
  enhanceDialogEl = document.createElement('div');
  enhanceDialogEl.id = 'enhance-dialog';
  enhanceDialogEl.style.cssText = [
    'position:fixed', 'display:none', 'z-index:30',
    'top:50%', 'left:50%', 'transform:translate(-50%,-50%)',
    'background:rgba(0,0,0,0.95)', 'border:1px solid #555', 'border-radius:8px',
    'padding:16px', 'min-width:400px',
    'font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
    'color:#fff'
  ].join(';');
  document.body.appendChild(enhanceDialogEl);
}

const ENHANCE_DEFAULT_POSITIVE = 'sharpen details on this satellite photo of some mountaineous terrain, high resolution aerial orthophoto';
const ENHANCE_DEFAULT_NEGATIVE = 'bad quality, blurry, messy, lowres, artifacts, flat, oversaturated, boring, trees, haze';

// Single delegated click handler — survives innerHTML rebuilds and HMR
enhanceDialogEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action="enhance-submit"]');
  if (!btn) return;
  const tid = btn.dataset.tileId;
  const posTA = enhanceDialogEl.querySelector('[data-role="pos-prompt"]');
  const negTA = enhanceDialogEl.querySelector('[data-role="neg-prompt"]');
  if (!tid || !posTA || !negTA) return;
  enhanceDialogEl.style.display = 'none';
  localStorage.setItem('enhance_positive_prompt', posTA.value);
  localStorage.setItem('enhance_negative_prompt', negTA.value);
  _enhancePending.set(tid, { submitted: performance.now(), nextPollAt: performance.now() + 5000 });
  fetch(`/api/texture/${tid}/enhance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positive_prompt: posTA.value, negative_prompt: negTA.value }),
    })
    .then(r => _handleEnhanceResponse(tid, r))
    .catch(err => {
      console.error(`[ENHANCE] ${tid} fetch failed:`, err);
      _enhancePending.delete(tid);
    });
});

function showEnhanceDialog(tileId) {
  enhanceDialogEl.innerHTML = '';

  const title = document.createElement('div');
  title.style.cssText = 'font-size:14px;font-weight:bold;margin-bottom:12px';
  title.textContent = `Enhance ${tileId}`;
  enhanceDialogEl.appendChild(title);

  const mkLabel = (text) => {
    const lbl = document.createElement('div');
    lbl.style.cssText = 'color:#aaa;font-size:11px;margin-bottom:4px';
    lbl.textContent = text;
    return lbl;
  };
  const mkTextarea = (value) => {
    const ta = document.createElement('textarea');
    ta.style.cssText = 'width:100%;height:60px;background:#1a1a1a;color:#fff;border:1px solid #444;border-radius:4px;padding:6px;font:12px/1.4 inherit;resize:vertical;box-sizing:border-box;margin-bottom:10px';
    ta.value = value;
    return ta;
  };

  enhanceDialogEl.appendChild(mkLabel('Positive prompt'));
  const posTA = mkTextarea(localStorage.getItem('enhance_positive_prompt') ?? ENHANCE_DEFAULT_POSITIVE);
  posTA.dataset.role = 'pos-prompt';
  enhanceDialogEl.appendChild(posTA);

  enhanceDialogEl.appendChild(mkLabel('Negative prompt'));
  const negTA = mkTextarea(localStorage.getItem('enhance_negative_prompt') ?? ENHANCE_DEFAULT_NEGATIVE);
  negTA.dataset.role = 'neg-prompt';
  enhanceDialogEl.appendChild(negTA);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:4px';

  const cancelBtn = document.createElement('button');
  cancelBtn.style.cssText = 'padding:6px 14px;background:#333;color:#ccc;border:1px solid #555;border-radius:4px;cursor:pointer;font:inherit';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => { enhanceDialogEl.style.display = 'none'; });

  const submitBtn = document.createElement('button');
  submitBtn.style.cssText = 'padding:6px 14px;background:#2a6;color:#fff;border:none;border-radius:4px;cursor:pointer;font:inherit;font-weight:bold';
  submitBtn.textContent = 'Enhance';
  submitBtn.dataset.action = 'enhance-submit';
  submitBtn.dataset.tileId = tileId;

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(submitBtn);
  enhanceDialogEl.appendChild(btnRow);

  enhanceDialogEl.style.display = 'block';
  // Clear any stuck keys so camera movement doesn't abort the enhance
  for (const k of Object.keys(controls.keys)) controls.keys[k] = false;
  posTA.focus();
}

function showTileMenu(x, y, tileId, source) {
  tileMenuEl.innerHTML = '';
  const header = document.createElement('div');
  header.style.cssText = 'padding:4px 12px;color:#aaa;font-size:11px;border-bottom:1px solid #444';
  header.textContent = tileId;
  tileMenuEl.appendChild(header);

  const isEnhanced = source && (source.includes('enhanced') || source === 'upscaled');

  if (isEnhanced) {
    // Discard enhanced texture — reverts to the original source
    const regenBtn = document.createElement('div');
    regenBtn.style.cssText = 'padding:6px 12px;cursor:pointer';
    regenBtn.textContent = 'Discard';
    regenBtn.addEventListener('mouseenter', () => regenBtn.style.background = 'rgba(255,255,255,0.15)');
    regenBtn.addEventListener('mouseleave', () => regenBtn.style.background = 'none');
    regenBtn.addEventListener('click', () => {
      hideTileMenu();
      fetch(`/api/texture/${tileId}/discard_enhanced`, { method: 'POST' })
        .then(r => r.json())
        .then(data => {
          if (data.ok) {
            texCache.delete(tileId);
            texSource.delete(tileId);
            waterMaskCache.delete(tileId);
            _lastEnhancedKey = '';
            _texV = Date.now();   // bust browser cache so re-fetch gets the reverted texture
            for (const child of terrainRoot.children) {
              if (child.userData.tileId === tileId) {
                if (child.material.map) {
                  child.material.map.dispose();
                  child.material.map = null;
                }
                child.material.color.set(child.userData.debugColor || 0x888888);
                child.material.needsUpdate = true;
                break;
              }
            }
          } else {
            console.warn(`[DISCARD] ${tileId}:`, data.error);
          }
        })
        .catch(err => console.error(`[DISCARD] ${tileId}:`, err));
    });
    tileMenuEl.appendChild(regenBtn);
  } else if (source && (source === 'sentinel2' || source === 'dataforsyningen')) {
    // Enhance — opt-in upscaling for eligible non-enhanced tiles
    const enhBtn = document.createElement('div');
    enhBtn.style.cssText = 'padding:6px 12px;cursor:pointer';
    enhBtn.textContent = 'Enhance';
    enhBtn.addEventListener('mouseenter', () => enhBtn.style.background = 'rgba(255,255,255,0.15)');
    enhBtn.addEventListener('mouseleave', () => enhBtn.style.background = 'none');
    enhBtn.addEventListener('click', () => {
      hideTileMenu();
      showEnhanceDialog(tileId);
    });
    tileMenuEl.appendChild(enhBtn);
  }

  if (!isEnhanced && !source) {
    const note = document.createElement('div');
    note.style.cssText = 'padding:6px 12px;color:#888;font-style:italic';
    note.textContent = 'no texture';
    tileMenuEl.appendChild(note);
  }

  tileMenuEl.style.left = x + 'px';
  tileMenuEl.style.top = y + 'px';
  tileMenuEl.style.display = 'block';
}

function hideTileMenu() { tileMenuEl.style.display = 'none'; tileInfoEl.style.display = 'none'; }
document.addEventListener('click', e => { if (!tileMenuEl.contains(e.target)) hideTileMenu(); });
document.addEventListener('mousedown', e => { if (enhanceDialogEl.style.display !== 'none' && !enhanceDialogEl.contains(e.target)) enhanceDialogEl.style.display = 'none'; });

// --- Atmosphere / Clouds tuning panel ---
const tuningPanel = document.createElement('div');
tuningPanel.style.cssText = [
  'position:absolute',
  'top:12px',
  'right:12px',
  'width:300px',
  'background:rgba(0,0,0,0.8)',
  'color:#dbe5f1',
  'font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
  'border-radius:8px',
  'z-index:10',
  'user-select:none',
  'backdrop-filter:blur(6px)'
].join(';');
document.body.appendChild(tuningPanel);

const tuningHeader = document.createElement('div');
tuningHeader.style.cssText = 'padding:8px 12px;cursor:pointer;display:flex;justify-content:space-between;align-items:center';
tuningHeader.innerHTML = '<span>Atmosphere</span><span id="tuning-toggle">&#9660;</span>';
tuningPanel.appendChild(tuningHeader);

const tuningBody = document.createElement('div');
tuningBody.style.cssText = 'padding:0 12px 10px;display:none';
tuningPanel.appendChild(tuningBody);

let tuningOpen = false;
tuningHeader.onclick = () => {
  tuningOpen = !tuningOpen;
  tuningBody.style.display = tuningOpen ? 'block' : 'none';
  document.getElementById('tuning-toggle').innerHTML = tuningOpen ? '&#9650;' : '&#9660;';
};

// --- Tuning panel persistence ---
const TUNING_STORAGE_KEY = 'clouds-tuning';
const _tuningState = JSON.parse(localStorage.getItem(TUNING_STORAGE_KEY) || '{}');
function saveTuning() {
  localStorage.setItem(TUNING_STORAGE_KEY, JSON.stringify(_tuningState));
}

// Deferred binding: controls reference aerialPerspective/cloudsEffect which are created later.
// We define the panel structure now and wire it up after effects exist.
const _tuningDefs = [];  // {label, defaultValue, inp, valSpan, fmt, onChange, type}
function tuningSlider(label, opts) {
  const saved = _tuningState[label];
  const initial = saved != null ? saved : opts.value;
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:5px 0';
  const lbl = document.createElement('span');
  lbl.style.cssText = 'flex:0 0 90px;font-size:11px;color:#9ab';
  lbl.textContent = label;
  const inp = document.createElement('input');
  inp.type = 'range';
  inp.min = opts.min;
  inp.max = opts.max;
  inp.step = opts.step;
  inp.value = initial;
  inp.style.cssText = 'flex:1;accent-color:#5af';
  const val = document.createElement('span');
  val.style.cssText = 'flex:0 0 40px;text-align:right;font-size:11px;color:#7cf';
  const fmt = opts.format || (v => v.toFixed(opts.decimals ?? 2));
  val.textContent = fmt(Number(initial));
  // Apply saved value on creation
  if (saved != null) opts.onChange(Number(saved));
  inp.oninput = () => {
    const v = Number(inp.value);
    val.textContent = fmt(v);
    _tuningState[label] = v;
    saveTuning();
    opts.onChange(v);
  };
  row.append(lbl, inp, val);
  tuningBody.appendChild(row);
  _tuningDefs.push({ label, defaultValue: opts.value, inp, valSpan: val, fmt, onChange: opts.onChange, type: 'slider' });
  return inp;
}
function tuningToggle(label, opts) {
  const saved = _tuningState[label];
  const initial = saved != null ? saved : opts.value;
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:5px 0';
  const lbl = document.createElement('span');
  lbl.style.cssText = 'flex:0 0 90px;font-size:11px;color:#9ab';
  lbl.textContent = label;
  const inp = document.createElement('input');
  inp.type = 'checkbox';
  inp.checked = initial;
  inp.style.cssText = 'accent-color:#5af';
  // Apply saved value on creation
  if (saved != null) opts.onChange(initial);
  inp.onchange = () => {
    _tuningState[label] = inp.checked;
    saveTuning();
    opts.onChange(inp.checked);
  };
  row.append(lbl, inp);
  tuningBody.appendChild(row);
  _tuningDefs.push({ label, defaultValue: opts.value, inp, onChange: opts.onChange, type: 'toggle' });
  return inp;
}
function resetTuningUI() {
  for (const def of _tuningDefs) {
    if (def.type === 'slider') {
      def.inp.value = def.defaultValue;
      if (def.valSpan) def.valSpan.textContent = def.fmt(def.defaultValue);
      def.onChange(def.defaultValue);
    } else {
      def.inp.checked = def.defaultValue;
      def.onChange(def.defaultValue);
    }
  }
}
function tuningSectionLabel(text) {
  const d = document.createElement('div');
  d.style.cssText = 'margin:10px 0 4px;font-size:10px;text-transform:uppercase;color:#6889a8;letter-spacing:1px;border-bottom:1px solid #334;padding-bottom:3px';
  d.textContent = text;
  tuningBody.appendChild(d);
}

// We'll call this after aerialPerspective + cloudsEffect are created.
function buildTuningControls(ap, ce) {
  tuningSectionLabel('Date / Time');
  const currentDate = new Date(referenceDate);
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fmtHour = h => {
    const hh = Math.floor(h) % 24;
    const mm = Math.round((h % 1) * 60);
    return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
  };
  tuningSlider('month', {
    min: 1, max: 12, step: 1, value: referenceDate.getUTCMonth() + 1,
    decimals: 0,
    format: v => monthNames[v - 1],
    onChange: v => {
      currentDate.setUTCMonth(v - 1);
      applyDate(currentDate);
    }
  });
  tuningSlider('hour (UTC)', {
    min: 0, max: 24, step: 0.25, value: referenceDate.getUTCHours() + referenceDate.getUTCMinutes() / 60,
    decimals: 1,
    format: fmtHour,
    onChange: v => {
      currentDate.setUTCHours(Math.floor(v), (v % 1) * 60, 0, 0);
      applyDate(currentDate);
    }
  });

  tuningSectionLabel('Aerial Perspective');
  tuningSlider('albedoScale', {
    min: 0, max: 3, step: 0.05, value: ap.albedoScale,
    onChange: v => { ap.albedoScale = v; }
  });
  tuningSlider('shadowRadius', {
    min: 0, max: 5, step: 0.1, value: ap.shadowRadius,
    onChange: v => { ap.shadowRadius = v; }
  });
  tuningToggle('sunIrradiance', {
    value: ap.sunIrradiance,
    onChange: v => { ap.sunIrradiance = v; }
  });
  tuningToggle('skyIrradiance', {
    value: ap.skyIrradiance,
    onChange: v => { ap.skyIrradiance = v; }
  });
  tuningToggle('inscatter', {
    value: ap.inscatter,
    onChange: v => { ap.inscatter = v; }
  });
  tuningToggle('transmittance', {
    value: ap.transmittance,
    onChange: v => { ap.transmittance = v; }
  });

  tuningSectionLabel('Clouds');
  const defaultAltitudes = ce.cloudLayers.map(l => l.altitude);
  tuningSlider('cloud altitude', {
    min: -2000, max: 5000, step: 50, value: 0,
    decimals: 0,
    format: v => `${v > 0 ? '+' : ''}${v}m`,
    onChange: v => {
      for (let i = 0; i < ce.cloudLayers.length; i++) {
        ce.cloudLayers[i].altitude = Math.max(0, defaultAltitudes[i] + v);
      }
    }
  });
  tuningSlider('coverage', {
    min: 0, max: 1, step: 0.01, value: ce.coverage,
    onChange: v => { ce.coverage = v; }
  });
  tuningSlider('cirrus density', {
    min: 0, max: 0.002, step: 0.0001, value: ce.cloudLayers[3].densityScale,
    decimals: 4,
    onChange: v => { ce.cloudLayers[3].densityScale = v; }
  });
  tuningSlider('cirrus coverage', {
    min: 0.1, max: 3, step: 0.05, value: ce.cloudLayers[3].weatherExponent,
    decimals: 2,
    format: v => v <= 0.1 ? 'full' : v >= 3 ? 'sparse' : v.toFixed(2),
    onChange: v => { ce.cloudLayers[3].weatherExponent = v; }
  });
  const _cirrusDefaults = {
    densityScale: 0.004,  // design value (startup is 0 / off)
    coverageFilterWidth: ce.cloudLayers[3].coverageFilterWidth,
    shapeAmount: ce.cloudLayers[3].shapeAmount,
    weatherExponent: ce.cloudLayers[3].weatherExponent,
  };
  controls._cirrusCheckbox = tuningToggle('cirrus', {
    value: false,
    onChange: v => {
      ce.cloudLayers[3].densityScale = v ? _cirrusDefaults.densityScale : 0;
    }
  });
  tuningSlider('cirrus shape', {
    min: 0, max: 1, step: 0.01, value: ce.cloudLayers[3].shapeAmount,
    onChange: v => { ce.cloudLayers[3].shapeAmount = v; }
  });
  let _driftSpeed = 0.00004;
  let _driftAngle = 0; // degrees, 0 = east, 90 = north
  const _updateDrift = () => {
    const rad = _driftAngle * Math.PI / 180;
    ce.localWeatherVelocity.set(
      Math.cos(rad) * _driftSpeed,
      Math.sin(rad) * _driftSpeed
    );
  };
  tuningSlider('drift speed', {
    min: 0, max: 0.002, step: 0.00005, value: _driftSpeed,
    decimals: 6,
    onChange: v => { _driftSpeed = v; _updateDrift(); }
  });
  tuningSlider('drift direction', {
    min: 0, max: 360, step: 5, value: _driftAngle,
    decimals: 0,
    format: v => `${v}°`,
    onChange: v => { _driftAngle = v; _updateDrift(); }
  });
  tuningSectionLabel('Atmosphere');
  tuningSlider('fog strength', {
    min: 1, max: 10, step: 0.5, value: 4.5,
    decimals: 1,
    onChange: v => { controls._fogStrength = v; }
  });
  tuningSlider('cloud distance', {
    min: 5000, max: 50000, step: 1000, value: MAX_VIEW_DIST,
    decimals: 0,
    format: v => `${(v/1000).toFixed(0)}km`,
    // Only update projection matrix on slider change, NOT per-frame.
    // Per-frame updateProjectionMatrix() desyncs cloud shadows from clouds.
    onChange: v => { camera.far = v; camera.updateProjectionMatrix(); }
  });
  tuningSlider('scattering', {
    min: 0, max: 5, step: 0.1, value: ce.scatteringCoefficient ?? 0,
    decimals: 1,
    onChange: v => { ce.scatteringCoefficient = v; }
  });
  tuningSlider('absorption', {
    min: 0, max: 5, step: 0.1, value: ce.absorptionCoefficient ?? 0,
    decimals: 1,
    onChange: v => { ce.absorptionCoefficient = v; }
  });

  // tuningSectionLabel('Shadows');
  // tuningSlider('shadowFarScale', {
  //   min: 0, max: 1, step: 0.05, value: ce.shadow.farScale,
  //   onChange: v => { ce.shadow.farScale = v; }
  // });
  // tuningSlider('optDepthTail', {
  //   min: 0, max: 6, step: 0.1, value: ce.shadow.opticalDepthTailScale,
  //   decimals: 1,
  //   onChange: v => { ce.shadow.opticalDepthTailScale = v; }
  // });
}

const terrainRoot = new THREE.Group();
Ellipsoid.WGS84
  .getEastNorthUpFrame(anchorPosition)
  .decompose(terrainRoot.position, terrainRoot.quaternion, terrainRoot.scale);
scene.add(terrainRoot);

// --- Water plane ---
// Large flat water surface at z=0.5 in terrainRoot local coords.
// Ocean terrain vertices sit at z=0, so water floats just above — no z-fighting.
// Land terrain rises well above 0.5 and naturally occludes the water.
const WATER_EXTENT = 200000; // 200km each direction — covers all visible ocean
const waterNormalTex = new THREE.TextureLoader().load('/waternormals.jpg', tex => {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
});
const waterMat = new THREE.ShaderMaterial({
  uniforms: {
    time: { value: 0 },
    normalSampler: { value: waterNormalTex },
    waterColor: { value: new THREE.Color(0x001e3d) },
    sunDirection: { value: new THREE.Vector3(0.7, 0.7, 0.3) },
    sunColor: { value: new THREE.Color(0xffffff) },
  },
  vertexShader: /* glsl */`
    #include <common>
    #include <logdepthbuf_pars_vertex>
    varying vec2 vLocalPos;
    varying vec3 vWorldNormal;
    varying vec3 vWorldPos;
    void main() {
      vLocalPos = position.xy * 0.002; // scale for tiling (~500m repeat)
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      vWorldNormal = normalize((modelMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      #include <logdepthbuf_vertex>
    }
  `,
  fragmentShader: /* glsl */`
    #include <common>
    #include <logdepthbuf_pars_fragment>
    uniform float time;
    uniform sampler2D normalSampler;
    uniform vec3 waterColor;
    uniform vec3 sunDirection;
    uniform vec3 sunColor;
    varying vec2 vLocalPos;
    varying vec3 vWorldNormal;
    varying vec3 vWorldPos;
    vec4 getNoise(vec2 uv) {
      vec2 uv0 = uv / 1.3 + vec2(time / 17.0, time / 29.0);
      vec2 uv1 = uv / 1.5 - vec2(time / -19.0, time / 31.0);
      vec2 uv2 = uv / 3.7 + vec2(time / 101.0, time / 97.0);
      vec2 uv3 = uv / 2.1 - vec2(time / 109.0, time / -113.0);
      return (texture2D(normalSampler, uv0) + texture2D(normalSampler, uv1) +
              texture2D(normalSampler, uv2) + texture2D(normalSampler, uv3)) * 0.5 - 1.0;
    }
    void main() {
      #include <logdepthbuf_fragment>
      vec4 noise = getNoise(vLocalPos);
      vec3 surfNormal = normalize(mix(vWorldNormal, normalize(noise.xzy), 0.45));
      vec3 toEye = normalize(cameraPosition - vWorldPos);
      // Fresnel — more reflective at grazing angles
      float fresnel = 0.04 + 0.96 * pow(1.0 - max(dot(toEye, surfNormal), 0.0), 4.0);
      // Sun specular
      vec3 refl = reflect(-normalize(sunDirection), surfNormal);
      float spec = pow(max(dot(toEye, refl), 0.0), 64.0) * 3.0;
      // Transparent ripple overlay — satellite texture shows through underneath.
      // Additive specular only, no color tint.
      vec3 col = sunColor * spec * 0.8;
      float alpha = clamp(spec * 0.9 + fresnel * 0.15, 0.0, 0.8);
      gl_FragColor = vec4(col, alpha);
    }
  `,
  transparent: true,
  side: THREE.FrontSide,
  depthWrite: false,
});
const waterGeo = new THREE.PlaneGeometry(WATER_EXTENT * 2, WATER_EXTENT * 2, 1, 1);
const waterMesh = new THREE.Mesh(waterGeo, waterMat);
waterMesh.position.set(0, 0, 0.5); // just above terrain ocean at z=0
waterMesh.frustumCulled = false;
waterMesh.visible = false; // disabled for now
terrainRoot.add(waterMesh);

const camMarkerGeo = new THREE.ConeGeometry(200, 600, 4);
const camMarker = new THREE.Mesh(
  camMarkerGeo,
  new THREE.MeshBasicMaterial({
    color: 0xffff00,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide
  })
);
camMarker.visible = false;
camMarker.layers.set(0);
camMarker.frustumCulled = false;
camMarker.renderOrder = 1000;
terrainRoot.add(camMarker);
const markerCameraRel = new THREE.Vector3();
const mapScreenUp = new THREE.Vector3();
const markerForwardLocal = new THREE.Vector3(0, 1, 0);
const markerHeadingLocal = new THREE.Vector3();
const movementForward = new THREE.Vector3();
const movementRight = new THREE.Vector3();
const raycaster = new THREE.Raycaster();
const mouseNDC = new THREE.Vector2();
const debugIntersectables = [];
let hoverOutline = null;

const enhanceOutlines = new THREE.Group();
enhanceOutlines.visible = false;
enhanceOutlines.renderOrder = 998;
terrainRoot.add(enhanceOutlines);
let _lastEnhanceKey = '';

const enhancedOutlines = new THREE.Group();
enhancedOutlines.visible = false;
enhancedOutlines.renderOrder = 997;
terrainRoot.add(enhancedOutlines);
let _lastEnhancedKey = '';

let _seamPending = new Set();
let _seamRunning = new Set();
let _seamDoneRecent = new Set();
let _seamFailed = new Set();
let _lastSeamPoll = 0;
const SEAM_POLL_MS = 2000;

// --- Terrain streaming state ---
const EXAG = 1.0;
const REFETCH_DIST = 5000;
let originX = 0, originY = 0;        // stereo scene origin from server
let camStereoX = 0, camStereoY = 0;  // current cam position in stereo
let lastFetchX = 0, lastFetchY = 0;
let _lastFetchTriggerMs = 0;
let fetching = false;
let isFirstLoad = true;
let bootFetchLogged = false;
let currentTileIds = new Set();
let lastTiles = null;

function paramNumber(name, fallback) {
  const raw = params.get(name);
  if (raw == null) return fallback;
  const text = raw.trim();
  if (text === '') return fallback;
  const value = Number(text);
  return Number.isFinite(value) ? value : fallback;
}

const HOUSE_MODEL = {
  url: '/models/house_test.glb',
  altOffsetM: paramNumber('houseAltOffset', 0.4),
  hotReloadMs: Math.max(500, paramNumber('houseReloadMs', 2000)),
  enabled: params.get('house') === '1'
};
const HOUSE_SHADOW_MODE_RAW = (params.get('houseShadowMode') || 'shadowmap').toLowerCase();
const HOUSE_SHADOW_MODE = HOUSE_SHADOW_MODE_RAW === 'local' ? 'local' : 'shadowmap';
const HOUSE_USE_LOCAL_SHADOWS = HOUSE_SHADOW_MODE === 'local';
const HOUSE_USE_SHADOW_MAP = HOUSE_SHADOW_MODE === 'shadowmap';
const HOUSE_LOCAL_SHADOW_DEBUG = params.get('houseLocalShadowDebug') !== '0';
const HOUSE_SHADOW_SNAPSHOT_ENABLED = params.get('houseShadowSnapshot') === '1';
const HOUSE_PROBE_CONSOLE = params.get('houseProbeConsole') === '1';
// Candidate sites selected from depth-12 Nuuk tiles in flaskserver/terrain.db
// using dataforsyningen texture features + water-mask exclusion (wm=0 at each point).
const DEFAULT_NUUK_HOUSE_SITES = [
  { id: 'nuuk-01', lat: 64.179102, lon: -51.712988, headingDeg: 22, scale: 1.00, tileId: '12-1375-791' },
  { id: 'nuuk-02', lat: 64.174556, lon: -51.703948, headingDeg: 58, scale: 0.96, tileId: '12-1376-791' },
  { id: 'nuuk-03', lat: 64.185330, lon: -51.703495, headingDeg: 96, scale: 1.08, tileId: '12-1376-792' },
  { id: 'nuuk-04', lat: 64.182984, lon: -51.726468, headingDeg: 144, scale: 1.03, tileId: '12-1374-792' },
  { id: 'nuuk-05', lat: 64.173514, lon: -51.718454, headingDeg: 210, scale: 0.98, tileId: '12-1374-791' },
  { id: 'nuuk-06', lat: 64.178473, lon: -51.724776, headingDeg: 288, scale: 1.04, tileId: '12-1374-791' },
];
const singleHouseLat = paramNumber('houseLat', NaN);
const singleHouseLon = paramNumber('houseLon', NaN);
const houseCountParam = paramNumber('houseCount', DEFAULT_NUUK_HOUSE_SITES.length);
const houseCount = Number.isFinite(houseCountParam)
  ? Math.max(1, Math.min(DEFAULT_NUUK_HOUSE_SITES.length, Math.floor(houseCountParam)))
  : DEFAULT_NUUK_HOUSE_SITES.length;
const houseSites = (Number.isFinite(singleHouseLat) && Number.isFinite(singleHouseLon))
  ? [{
      id: 'nuuk-single',
      lat: singleHouseLat,
      lon: singleHouseLon,
      headingDeg: paramNumber('houseHeadingDeg', 20),
      scale: paramNumber('houseScale', 1.0),
      tileId: 'override',
    }]
  : DEFAULT_NUUK_HOUSE_SITES.slice(0, houseCount);
const houseLayer = new THREE.Group();
houseLayer.name = 'nuuk-houses';
terrainRoot.add(houseLayer);
const houseShadowReceiverLayer = new THREE.Group();
houseShadowReceiverLayer.name = 'nuuk-house-shadow-receivers';
houseShadowReceiverLayer.renderOrder = 26;
houseShadowReceiverLayer.visible = false;
terrainRoot.add(houseShadowReceiverLayer);
const houseMarkerLayer = new THREE.Group();
houseMarkerLayer.name = 'nuuk-house-markers';
houseMarkerLayer.visible = false;
houseMarkerLayer.renderOrder = 1002;
terrainRoot.add(houseMarkerLayer);
const houseLoader = new GLTFLoader();
const houseDownRaycaster = new THREE.Raycaster();
const houseDownDirection = up.clone().negate().normalize();
const houseTargetWorld = new THREE.Vector3();
const houseTargetLocal = new THREE.Vector3();
const houseSnapTargets = [];
const houseShadowCenterLocal = new THREE.Vector3();
const houseShadowLightDirection = new THREE.Vector3();
const houseShadowLightDirectionLocal = new THREE.Vector3();
let houseModelTemplate = null;
let houseLoadSerial = 0;
let houseModelSig = '';
let housePollInFlight = false;
let lastHousePollAt = 0;
let shadowMapReadyLogged = false;
let houseShadowGateReason = 'init';
let lastHouseShadowGateReason = 'init';
const HOUSE_SHADOW_LOG_MS = HOUSE_SHADOW_SNAPSHOT_ENABLED
  ? Math.max(200, paramNumber('houseShadowLogMs', 2000))
  : 0;
let lastHouseShadowLogAt = 0;
const houseLocalShadowDirection = new THREE.Vector2();
const HOUSE_MARKER_HEIGHT = 5000;
const HOUSE_MARKER_BASE_LIFT = 5;
const HOUSE_MARKER_COLORS = [0xff3b30, 0xff9500, 0xffcc00, 0x34c759, 0x0a84ff, 0xbf5af2];
const HOUSE_SHADOW_MAP_SIZE = 2048;
const HOUSE_SHADOW_BASE_RADIUS = 900;
const HOUSE_SHADOW_RADIUS_PADDING = 600;
const HOUSE_SHADOW_MAX_RADIUS = 7000;
const HOUSE_SHADOW_LIGHT_DISTANCE = 10000;
const HOUSE_SHADOW_OPACITY = THREE.MathUtils.clamp(paramNumber('houseShadowOpacity', 0.78), 0, 1);
const HOUSE_LOCAL_SHADOW_WIDTH = paramNumber('houseLocalShadowWidth', 14);
const HOUSE_LOCAL_SHADOW_LENGTH = paramNumber('houseLocalShadowLength', 20);
const HOUSE_LOCAL_SHADOW_Z = paramNumber('houseLocalShadowZ', 0.03);
const HOUSE_LOCAL_SHADOW_OPACITY = paramNumber('houseLocalShadowOpacity', 0.34);
const HOUSE_LOCAL_SHADOW_DEBUG_HOVER_M = paramNumber('houseLocalShadowDebugHoverM', 10);
const HOUSE_LOCAL_SHADOW_ANGLE_OFFSET_RAD = THREE.MathUtils.degToRad(
  paramNumber('houseLocalShadowAngleOffsetDeg', 90)
);
const HOUSE_LOCAL_SHADOW_MAX_STRETCH = 3.2;
const HOUSE_LOCAL_SHADOW_MIN_SUN = 0.02;
const houseShadowReceiverMaterial = new THREE.ShadowMaterial({
  color: 0x000000,
  transparent: true,
  opacity: HOUSE_SHADOW_OPACITY,
  depthTest: true,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -2,
});
houseShadowReceiverMaterial.toneMapped = false;
const houseShadowReceivers = new Map();
const houseShadowCasterLight = new THREE.DirectionalLight(0xffffff, 1.0);
houseShadowCasterLight.name = 'nuuk-house-shadow-light';
houseShadowCasterLight.castShadow = true;
houseShadowCasterLight.visible = HOUSE_USE_SHADOW_MAP;
houseShadowCasterLight.shadow.mapSize.set(HOUSE_SHADOW_MAP_SIZE, HOUSE_SHADOW_MAP_SIZE);
houseShadowCasterLight.shadow.bias = -0.00008;
houseShadowCasterLight.shadow.normalBias = 0.05;
houseShadowCasterLight.shadow.camera.near = 50;
houseShadowCasterLight.shadow.camera.far = 80000;
terrainRoot.add(houseShadowCasterLight);
terrainRoot.add(houseShadowCasterLight.target);
const houseMarkerDotGeo = new THREE.SphereGeometry(240, 14, 12);
const houseMarkerHaloGeo = new THREE.RingGeometry(330, 470, 24);
const houseMarkerTextCache = new Map();

function createLocalShadowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx == null) {
    return null;
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const gradient = ctx.createRadialGradient(128, 128, 18, 128, 128, 120);
  gradient.addColorStop(0.0, 'rgba(0,0,0,0.86)');
  gradient.addColorStop(0.45, 'rgba(0,0,0,0.44)');
  gradient.addColorStop(1.0, 'rgba(0,0,0,0.0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.premultiplyAlpha = true;
  return texture;
}

const houseLocalShadowTexture = createLocalShadowTexture();

function createHouseLocalShadowMesh() {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      map: houseLocalShadowTexture,
      transparent: true,
      opacity: HOUSE_LOCAL_SHADOW_OPACITY,
      depthTest: false,
      depthWrite: false,
      blending: THREE.MultiplyBlending,
      premultipliedAlpha: true,
      toneMapped: true,
      side: THREE.DoubleSide,
    })
  );
  mesh.frustumCulled = false;
  mesh.renderOrder = 30;
  mesh.userData.houseShadowProbeIgnore = true;
  return mesh;
}

function createHouseLocalShadowDebugMesh() {
  const group = new THREE.Group();
  group.visible = false;

  const fill = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      color: 0xff2d7a,
      transparent: true,
      opacity: 0.22,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    })
  );
  fill.renderOrder = 31;

  const outline = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)),
    new THREE.LineBasicMaterial({
      color: 0x00e5ff,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
  );
  outline.renderOrder = 32;

  const beacon = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, HOUSE_LOCAL_SHADOW_DEBUG_HOVER_M),
    ]),
    new THREE.LineBasicMaterial({
      color: 0x00e5ff,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
  );
  beacon.renderOrder = 33;

  group.add(fill, outline, beacon);
  group.traverse(object => {
    object.userData.houseShadowProbeIgnore = true;
  });
  group.frustumCulled = false;
  return group;
}

function computeHouseShadowCoverage(loadedHouses) {
  if (loadedHouses.length === 0) {
    return null;
  }
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const house of loadedHouses) {
    const { x, y, z } = house.group.position;
    sumX += x;
    sumY += y;
    sumZ += z;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const span = Math.max(maxX - minX, maxY - minY);
  const shadowRadius = THREE.MathUtils.clamp(
    HOUSE_SHADOW_BASE_RADIUS + span * 0.6 + HOUSE_SHADOW_RADIUS_PADDING,
    HOUSE_SHADOW_BASE_RADIUS,
    HOUSE_SHADOW_MAX_RADIUS
  );
  return {
    centerX: sumX / loadedHouses.length,
    centerY: sumY / loadedHouses.length,
    centerZ: sumZ / loadedHouses.length,
    minX,
    minY,
    maxX,
    maxY,
    shadowRadius,
  };
}

function createHouseLabelSprite(labelText, colorHex) {
  const cacheKey = `${labelText}:${colorHex}`;
  const cached = houseMarkerTextCache.get(cacheKey);
  if (cached) return cached.clone();
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx == null) {
    const fallback = new THREE.Sprite(new THREE.SpriteMaterial({ color: colorHex, depthTest: false, depthWrite: false }));
    fallback.scale.set(1200, 600, 1);
    houseMarkerTextCache.set(cacheKey, fallback);
    return fallback.clone();
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(12, 20, canvas.width - 24, 88);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3;
  ctx.strokeRect(12, 20, canvas.width - 24, 88);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 54px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(labelText, canvas.width / 2, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      color: colorHex,
    })
  );
  sprite.scale.set(1500, 750, 1);
  houseMarkerTextCache.set(cacheKey, sprite);
  return sprite.clone();
}

function createHouseMarker(index, houseId) {
  const color = HOUSE_MARKER_COLORS[index % HOUSE_MARKER_COLORS.length];
  const marker = new THREE.Group();
  marker.name = `house-marker-${houseId}`;
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, HOUSE_MARKER_HEIGHT),
    ]),
    new THREE.LineBasicMaterial({
      color,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.95,
    })
  );
  line.renderOrder = 1002;
  const halo = new THREE.Mesh(
    houseMarkerHaloGeo,
    new THREE.MeshBasicMaterial({
      color,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
    })
  );
  halo.position.z = HOUSE_MARKER_HEIGHT;
  halo.renderOrder = 1003;
  const dot = new THREE.Mesh(
    houseMarkerDotGeo,
    new THREE.MeshBasicMaterial({
      color,
      depthTest: false,
      depthWrite: false,
    })
  );
  dot.position.z = HOUSE_MARKER_HEIGHT;
  dot.renderOrder = 1004;
  const label = createHouseLabelSprite(houseId.replace('nuuk-', ''), color);
  label.position.set(0, 0, HOUSE_MARKER_HEIGHT + 900);
  label.renderOrder = 1005;
  marker.add(line, halo, dot, label);
  return marker;
}
const houseInstances = houseSites.map((site, index) => {
  const group = new THREE.Group();
  group.name = `house-${site.id}`;
  group.userData = {
    houseId: site.id,
    tileId: site.tileId,
  };
  houseLayer.add(group);
  const marker = createHouseMarker(index, site.id);
  marker.userData = {
    houseId: site.id,
  };
  houseMarkerLayer.add(marker);
  return {
    site,
    group,
    marker,
    localShadowMesh: null,
    localShadowDebugMesh: null,
    hasModel: false,
    snapPending: true,
  };
});
const houseById = new Map(houseInstances.map(house => [house.site.id, house]));
let housesRuntimeVisible = HOUSE_MODEL.enabled;
houseLayer.visible = housesRuntimeVisible;

function setHousesRuntimeVisible(nextVisible, reason = 'manual') {
  housesRuntimeVisible = Boolean(nextVisible);
  houseLayer.visible = housesRuntimeVisible;
  if (!housesRuntimeVisible) {
    houseMarkerLayer.visible = false;
    houseShadowReceiverLayer.visible = false;
    houseShadowCasterLight.visible = false;
    bootLog('house.visibility', { visible: false, reason });
    return;
  }
  bootLog('house.visibility', { visible: true, reason });
  if (!houseInstances.some(house => house.hasModel)) {
    markHousesNeedSnap();
    loadHouseModel('toggle-on');
  }
}

function findHouseForObject(object) {
  let cursor = object;
  while (cursor != null) {
    const houseId = cursor.userData?.houseId;
    if (houseId != null) {
      return houseById.get(houseId) ?? null;
    }
    cursor = cursor.parent;
  }
  return null;
}

function collectHouseModelMeshes() {
  const meshes = [];
  for (const house of houseInstances) {
    if (!house.hasModel) continue;
    house.group.traverse(object => {
      if (!object.isMesh) return;
      if (object.userData?.houseShadowProbeIgnore) return;
      meshes.push(object);
    });
  }
  return meshes;
}

function collectHouseLocalShadowMeshes() {
  const meshes = [];
  for (const house of houseInstances) {
    if (!house.localShadowMesh) continue;
    meshes.push(house.localShadowMesh);
  }
  return meshes;
}

function _roundPoint(point) {
  return {
    x: Number(point.x.toFixed(3)),
    y: Number(point.y.toFixed(3)),
    z: Number(point.z.toFixed(3)),
  };
}

function probeHouseShadowIntersections(event) {
  if (HOUSE_PROBE_CONSOLE) {
    console.log('[HOUSE PROBE] click', {
      x: event.clientX,
      y: event.clientY,
      mapMode: controls.mapMode,
      shadowMode: HOUSE_SHADOW_MODE,
      houseEnabled: HOUSE_MODEL.enabled,
      housesVisible: housesRuntimeVisible,
    });
  }
  if (!HOUSE_MODEL.enabled || !housesRuntimeVisible) return;
  const houseMeshes = collectHouseModelMeshes();
  const localShadowMeshes = collectHouseLocalShadowMeshes();
  const receiverTargets = houseShadowReceiverLayer.visible ? [...houseShadowReceivers.values()] : [];
  if (houseMeshes.length === 0 && localShadowMeshes.length === 0 && receiverTargets.length === 0) return;

  mouseNDC.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouseNDC.y = -(event.clientY / window.innerHeight) * 2 + 1;
  const activeCamera = controls.mapMode ? mapCam : camera;
  raycaster.setFromCamera(mouseNDC, activeCamera);

  const houseHits = raycaster.intersectObjects(houseMeshes, false);
  const localShadowHits = raycaster.intersectObjects(localShadowMeshes, false);
  const receiverHits = receiverTargets.length > 0
    ? raycaster.intersectObjects(receiverTargets, false)
    : [];
  if (houseHits.length === 0 && localShadowHits.length === 0 && receiverHits.length === 0) return;

  const houseHit = houseHits[0] ?? null;
  let house = houseHit ? findHouseForObject(houseHit.object) : null;
  const localShadowHit = localShadowHits[0] ?? null;
  if (house == null && localShadowHit?.object?.userData?.houseId) {
    house = houseById.get(localShadowHit.object.userData.houseId) ?? null;
  }
  const receiverHit = receiverHits[0] ?? null;

  const payload = {
    houseId: house?.site?.id ?? null,
    tileId: house?.site?.tileId ?? null,
    shadowMode: HOUSE_SHADOW_MODE,
    gateReason: houseShadowGateReason,
    mapMode: controls.mapMode,
    click: { x: event.clientX, y: event.clientY },
    rayOrigin: _roundPoint(raycaster.ray.origin),
    rayDirection: _roundPoint(raycaster.ray.direction),
    houseHit: houseHit
      ? {
          count: houseHits.length,
          distance: Number(houseHit.distance.toFixed(3)),
          point: _roundPoint(houseHit.point),
          objectName: houseHit.object.name || houseHit.object.type,
          castShadow: Boolean(houseHit.object.castShadow),
          receiveShadow: Boolean(houseHit.object.receiveShadow),
        }
      : {
          count: 0,
          distance: null,
          point: null,
          objectName: null,
          castShadow: null,
          receiveShadow: null,
        },
    localShadow: {
      enabled: HOUSE_USE_LOCAL_SHADOWS,
      meshVisible: house ? Boolean(house.localShadowMesh?.visible) : null,
      hitCount: localShadowHits.length,
      hitDistance: localShadowHit ? Number(localShadowHit.distance.toFixed(3)) : null,
      hitPoint: localShadowHit ? _roundPoint(localShadowHit.point) : null,
      hitHouseId: localShadowHit?.object?.userData?.houseId ?? null,
    },
    shadowMap: {
      enabled: HOUSE_USE_SHADOW_MAP,
      receiverLayerVisible: houseShadowReceiverLayer.visible,
      receiverCount: houseShadowReceivers.size,
      hitCount: receiverHits.length,
      hitDistance: receiverHit ? Number(receiverHit.distance.toFixed(3)) : null,
      hitPoint: receiverHit ? _roundPoint(receiverHit.point) : null,
      hitReceiverTileId: receiverHit?.object?.userData?.houseShadowTileId ?? null,
    },
  };

  bootLog('house.shadow.click_probe', payload);
  if (HOUSE_PROBE_CONSOLE) {
    console.log('[HOUSE PROBE] hit', {
      houseId: house?.site?.id ?? null,
      houseHits: houseHits.length,
      localShadowHits: localShadowHits.length,
      receiverHits: receiverHits.length,
    });
  }
  flushClientLogQueue();
}

function updateHouseMarkerPosition(house) {
  if (house.marker == null) return;
  house.marker.position.set(
    house.group.position.x,
    house.group.position.y,
    house.group.position.z + HOUSE_MARKER_BASE_LIFT
  );
}

function houseLocalFromLatLon(lat, lon) {
  const eastM = (lon - centerLon) * 111320 * Math.cos(centerLat * Math.PI / 180);
  const northM = (lat - centerLat) * 111320;
  return { x: eastM, y: northM };
}

function houseTerrainMeshes() {
  const meshes = [];
  for (const child of terrainRoot.children) {
    if (!child.isMesh) continue;
    if (!child.userData?.tileId) continue;
    meshes.push(child);
  }
  return meshes;
}

function createHouseShadowReceiverFromTerrainMesh(terrainMesh) {
  const receiver = new THREE.Mesh(terrainMesh.geometry, houseShadowReceiverMaterial);
  receiver.position.copy(terrainMesh.position);
  receiver.quaternion.copy(terrainMesh.quaternion);
  receiver.scale.copy(terrainMesh.scale);
  receiver.receiveShadow = true;
  receiver.castShadow = false;
  receiver.frustumCulled = false;
  receiver.renderOrder = 26;
  receiver.userData.houseShadowTileId = terrainMesh.userData.tileId;
  receiver.userData.sourceGeometry = terrainMesh.geometry;
  return receiver;
}

function clearHouseShadowReceivers() {
  for (const receiver of houseShadowReceivers.values()) {
    houseShadowReceiverLayer.remove(receiver);
  }
  houseShadowReceivers.clear();
}

function syncHouseShadowReceivers() {
  if (!HOUSE_MODEL.enabled) {
    clearHouseShadowReceivers();
    return;
  }
  const activeTileIds = new Set();
  const terrainMeshes = houseTerrainMeshes();
  for (const terrainMesh of terrainMeshes) {
    const tileId = terrainMesh.userData?.tileId;
    if (!tileId) continue;
    activeTileIds.add(tileId);
    const existing = houseShadowReceivers.get(tileId);
    if (existing) {
      if (existing.userData.sourceGeometry !== terrainMesh.geometry) {
        houseShadowReceiverLayer.remove(existing);
        houseShadowReceivers.delete(tileId);
      } else {
        continue;
      }
    }
    if (houseShadowReceivers.has(tileId)) {
      continue;
    }
    const receiver = createHouseShadowReceiverFromTerrainMesh(terrainMesh);
    houseShadowReceivers.set(tileId, receiver);
    houseShadowReceiverLayer.add(receiver);
  }
  for (const [tileId, receiver] of houseShadowReceivers) {
    if (activeTileIds.has(tileId)) continue;
    houseShadowReceiverLayer.remove(receiver);
    houseShadowReceivers.delete(tileId);
  }
}

function updateHouseShadowSystem() {
  const setGate = reason => {
    houseShadowGateReason = reason;
    if (lastHouseShadowGateReason !== reason) {
      lastHouseShadowGateReason = reason;
      houseShadowReceiverMaterial.needsUpdate = true;
      bootLog('house.shadow.gate', { reason });
    }
  };

  if (!HOUSE_USE_SHADOW_MAP) {
    setGate('shadowmap-disabled');
    houseShadowCasterLight.visible = false;
    houseShadowReceiverLayer.visible = false;
    return;
  }
  if (!HOUSE_MODEL.enabled) {
    setGate('disabled');
    houseShadowReceiverLayer.visible = false;
    return;
  }
  if (controls.mapMode) {
    setGate('map-mode');
    houseShadowReceiverLayer.visible = false;
    return;
  }

  const loadedHouses = houseInstances.filter(
    house => house.hasModel && house.group.children.length > 0
  );
  const sunUp = sunDirection.dot(up);
  const coverage = computeHouseShadowCoverage(loadedHouses);
  if (coverage == null) {
    setGate('no-house-coverage');
    houseShadowReceiverLayer.visible = false;
    return;
  }
  if (sunUp <= 0.01) {
    setGate('sun-below-horizon');
    houseShadowReceiverLayer.visible = false;
    return;
  }
  if (houseShadowReceivers.size === 0) {
    setGate('no-shadow-receivers');
    houseShadowReceiverLayer.visible = false;
    return;
  }

  setGate('active');
  houseShadowCenterLocal.set(coverage.centerX, coverage.centerY, coverage.centerZ);
  const shadowRadius = coverage.shadowRadius;
  houseShadowLightDirection.copy(sunDirection).normalize();
  houseShadowLightDirectionLocal.set(
    houseShadowLightDirection.dot(east),
    houseShadowLightDirection.dot(north),
    houseShadowLightDirection.dot(up)
  ).normalize();
  houseShadowCasterLight.position
    .copy(houseShadowCenterLocal)
    .addScaledVector(houseShadowLightDirectionLocal, HOUSE_SHADOW_LIGHT_DISTANCE + shadowRadius);
  houseShadowCasterLight.target.position.copy(houseShadowCenterLocal);
  houseShadowCasterLight.target.updateMatrixWorld();
  houseShadowCasterLight.updateMatrixWorld();

  const shadowCamera = houseShadowCasterLight.shadow.camera;
  shadowCamera.left = -shadowRadius;
  shadowCamera.right = shadowRadius;
  shadowCamera.top = shadowRadius;
  shadowCamera.bottom = -shadowRadius;
  shadowCamera.near = 100;
  shadowCamera.far = HOUSE_SHADOW_LIGHT_DISTANCE + shadowRadius * 4;
  shadowCamera.updateProjectionMatrix();

  houseShadowReceiverMaterial.opacity = HOUSE_SHADOW_OPACITY;
  houseShadowCasterLight.shadow.needsUpdate = true;
  houseShadowReceiverLayer.visible = true;
}

function updateHouseLocalShadows() {
  if (!HOUSE_MODEL.enabled || !HOUSE_USE_LOCAL_SHADOWS || controls.mapMode) {
    houseShadowGateReason = controls.mapMode ? 'local-map-mode' : 'local-disabled';
    for (const house of houseInstances) {
      if (house.localShadowMesh) house.localShadowMesh.visible = false;
      if (house.localShadowDebugMesh) house.localShadowDebugMesh.visible = false;
    }
    return;
  }
  const sunUp = sunDirection.dot(up);
  if (sunUp <= HOUSE_LOCAL_SHADOW_MIN_SUN) {
    houseShadowGateReason = 'local-sun-below';
    for (const house of houseInstances) {
      if (house.localShadowMesh) house.localShadowMesh.visible = false;
      if (house.localShadowDebugMesh) house.localShadowDebugMesh.visible = false;
    }
    return;
  }
  houseLocalShadowDirection.set(
    -sunDirection.dot(east),
    -sunDirection.dot(north)
  );
  const horiz = houseLocalShadowDirection.length();
  if (horiz <= 1e-6) {
    houseShadowGateReason = 'local-no-horizontal';
    for (const house of houseInstances) {
      if (house.localShadowMesh) house.localShadowMesh.visible = false;
      if (house.localShadowDebugMesh) house.localShadowDebugMesh.visible = false;
    }
    return;
  }
  houseShadowGateReason = 'local-active';
  houseLocalShadowDirection.multiplyScalar(1 / horiz);

  const stretch = THREE.MathUtils.clamp(
    1 / Math.max(sunUp, 0.2),
    1,
    HOUSE_LOCAL_SHADOW_MAX_STRETCH
  );
  const worldAngle = Math.atan2(houseLocalShadowDirection.y, houseLocalShadowDirection.x);
  const baseOpacity = THREE.MathUtils.clamp(
    HOUSE_LOCAL_SHADOW_OPACITY * (0.72 + 0.35 * sunUp),
    0.2,
    0.45
  );

  for (const house of houseInstances) {
    const shadowMesh = house.localShadowMesh;
    const debugMesh = house.localShadowDebugMesh;
    if (!shadowMesh || !house.hasModel) {
      if (shadowMesh) shadowMesh.visible = false;
      if (debugMesh) debugMesh.visible = false;
      continue;
    }
    const localAngle = worldAngle - house.group.rotation.z + HOUSE_LOCAL_SHADOW_ANGLE_OFFSET_RAD;
    const scale = house.site.scale;
    const width = HOUSE_LOCAL_SHADOW_WIDTH * scale;
    const length = HOUSE_LOCAL_SHADOW_LENGTH * scale * stretch;
    const offset = (length - width) * 0.32;
    shadowMesh.rotation.z = localAngle;
    shadowMesh.scale.set(length, width, 1);
    shadowMesh.position.set(
      Math.cos(localAngle) * offset,
      Math.sin(localAngle) * offset,
      -HOUSE_MODEL.altOffsetM + HOUSE_LOCAL_SHADOW_Z
    );
    if (shadowMesh.material) {
      shadowMesh.material.opacity = baseOpacity;
    }
    shadowMesh.visible = true;
    if (debugMesh) {
      debugMesh.rotation.z = localAngle;
      debugMesh.scale.set(length, width, 1);
      debugMesh.position.set(
        Math.cos(localAngle) * offset,
        Math.sin(localAngle) * offset,
        -HOUSE_MODEL.altOffsetM + HOUSE_LOCAL_SHADOW_Z + 0.02
      );
      debugMesh.visible = true;
    }
  }
}

function makeTakramHouseMaterial(sourceMaterial) {
  const material = new THREE.MeshBasicMaterial({
    color:
      sourceMaterial?.color != null ? sourceMaterial.color.clone() : new THREE.Color(0xffffff),
    map: sourceMaterial?.map ?? null,
    transparent: Boolean(sourceMaterial?.transparent),
    opacity: sourceMaterial?.opacity ?? 1,
    side: sourceMaterial?.side ?? THREE.FrontSide,
    alphaTest: sourceMaterial?.alphaTest ?? 0,
  });
  material.toneMapped = true;
  return material;
}

function applyHouseTakramMaterials(root) {
  root.traverse(object => {
    if (!object.isMesh) return;
    if (Array.isArray(object.material)) {
      object.material = object.material.map(makeTakramHouseMaterial);
    } else {
      object.material = makeTakramHouseMaterial(object.material);
    }
  });
}

function applyHousePlanarPlacement(house) {
  const local = houseLocalFromLatLon(house.site.lat, house.site.lon);
  house.group.position.set(local.x, local.y, house.group.position.z);
  house.group.rotation.set(0, 0, THREE.MathUtils.degToRad(house.site.headingDeg));
  house.group.scale.setScalar(house.site.scale);
  updateHouseMarkerPosition(house);
}

function snapHouseToTerrain(house, terrainTargets) {
  if (!HOUSE_MODEL.enabled || terrainTargets.length === 0) {
    return false;
  }
  houseTargetLocal.copy(house.group.position);
  houseTargetLocal.z = 20000;
  houseTargetWorld.copy(houseTargetLocal);
  terrainRoot.localToWorld(houseTargetWorld);
  houseDownRaycaster.set(houseTargetWorld, houseDownDirection);
  const hits = houseDownRaycaster.intersectObjects(terrainTargets);
  if (hits.length === 0) {
    return false;
  }
  houseTargetLocal.copy(hits[0].point);
  terrainRoot.worldToLocal(houseTargetLocal);
  house.group.position.z = houseTargetLocal.z + HOUSE_MODEL.altOffsetM;
  updateHouseMarkerPosition(house);
  return true;
}

function disposeHouseTree(root, seenGeometries, seenMaterials) {
  root.traverse(object => {
    if (!object.isMesh) return;
    if (object.customDepthMaterial && !seenMaterials.has(object.customDepthMaterial)) {
      seenMaterials.add(object.customDepthMaterial);
      object.customDepthMaterial.dispose?.();
      object.customDepthMaterial = null;
    }
    if (object.customDistanceMaterial && !seenMaterials.has(object.customDistanceMaterial)) {
      seenMaterials.add(object.customDistanceMaterial);
      object.customDistanceMaterial.dispose?.();
      object.customDistanceMaterial = null;
    }
    if (object.geometry && !seenGeometries.has(object.geometry)) {
      seenGeometries.add(object.geometry);
      object.geometry.dispose();
    }
    if (Array.isArray(object.material)) {
      for (const mat of object.material) {
        if (mat && !seenMaterials.has(mat)) {
          seenMaterials.add(mat);
          mat.dispose();
        }
      }
    } else if (object.material && !seenMaterials.has(object.material)) {
      seenMaterials.add(object.material);
      object.material.dispose();
    }
  });
}

function clearHouseVisuals() {
  const seenGeometries = new Set();
  const seenMaterials = new Set();
  for (const house of houseInstances) {
    while (house.group.children.length > 0) {
      const child = house.group.children[house.group.children.length - 1];
      house.group.remove(child);
      disposeHouseTree(child, seenGeometries, seenMaterials);
    }
    house.localShadowMesh = null;
    house.localShadowDebugMesh = null;
    house.hasModel = false;
  }
}

function instantiateHousesFromTemplate() {
  clearHouseVisuals();
  if (houseModelTemplate == null) {
    return;
  }
  for (const house of houseInstances) {
    const localShadow = createHouseLocalShadowMesh();
    localShadow.userData.houseId = house.site.id;
    house.group.add(localShadow);
    house.localShadowMesh = localShadow;
    if (HOUSE_LOCAL_SHADOW_DEBUG) {
      const localShadowDebugMesh = createHouseLocalShadowDebugMesh();
      localShadowDebugMesh.userData.houseId = house.site.id;
      house.group.add(localShadowDebugMesh);
      house.localShadowDebugMesh = localShadowDebugMesh;
    }
    const model = houseModelTemplate.clone(true);
    // glTF assets are y-up; terrainRoot local space is z-up.
    model.rotation.x = Math.PI * 0.5;
    applyHouseTakramMaterials(model);
    model.traverse(object => {
      if (!object.isMesh) return;
      object.frustumCulled = false;
      object.castShadow = HOUSE_USE_SHADOW_MAP;
      object.receiveShadow = false;
      if (HOUSE_USE_SHADOW_MAP) {
        const shadowDepthMaterial = new THREE.MeshDepthMaterial({
          depthPacking: THREE.RGBADepthPacking,
          side: THREE.DoubleSide,
        });
        shadowDepthMaterial.map = object.material?.map ?? null;
        shadowDepthMaterial.alphaTest = object.material?.alphaTest ?? 0;
        shadowDepthMaterial.depthTest = true;
        shadowDepthMaterial.depthWrite = true;
        object.customDepthMaterial = shadowDepthMaterial;
      }
    });
    house.group.add(model);
    house.hasModel = true;
    applyHousePlanarPlacement(house);
    house.snapPending = true;
  }
}

function markHousesNeedSnap() {
  for (const house of houseInstances) {
    house.snapPending = true;
  }
}

function snapPendingHouses() {
  if (!HOUSE_MODEL.enabled || houseInstances.length === 0) {
    return;
  }
  houseSnapTargets.length = 0;
  houseSnapTargets.push(...houseTerrainMeshes());
  if (houseSnapTargets.length === 0) {
    return;
  }
  for (const house of houseInstances) {
    if (!house.snapPending) continue;
    house.snapPending = !snapHouseToTerrain(house, houseSnapTargets);
  }
}

function houseZSummary() {
  return houseInstances.map(house => ({
    id: house.site.id,
    lat: house.site.lat,
    lon: house.site.lon,
    tileId: house.site.tileId,
    z: Number(house.group.position.z.toFixed(3)),
    snapped: !house.snapPending,
  }));
}

function houseShadowDebugSummary() {
  const loadedHouses = houseInstances.filter(
    house => house.hasModel && house.group.children.length > 0
  );
  let casterMeshCount = 0;
  let customDepthCount = 0;
  let localShadowMeshCount = 0;
  let localShadowVisibleCount = 0;
  let localShadowDebugMeshCount = 0;
  let localShadowDebugVisibleCount = 0;
  for (const house of loadedHouses) {
    if (house.localShadowMesh) {
      localShadowMeshCount += 1;
      if (house.localShadowMesh.visible) {
        localShadowVisibleCount += 1;
      }
    }
    if (house.localShadowDebugMesh) {
      localShadowDebugMeshCount += 1;
      if (house.localShadowDebugMesh.visible) {
        localShadowDebugVisibleCount += 1;
      }
    }
    house.group.traverse(object => {
      if (!object.isMesh) return;
      if (object.castShadow) casterMeshCount += 1;
      if (object.customDepthMaterial) customDepthCount += 1;
    });
  }
  const loadedHouseCount = loadedHouses.length;
  const coverage = computeHouseShadowCoverage(loadedHouses);
  const shadowCamera = houseShadowCasterLight.shadow.camera;
  const span = shadowCamera.right - shadowCamera.left;
  const map = houseShadowCasterLight.shadow.map;
  const mapSize = houseShadowCasterLight.shadow.mapSize;
  const sunUp = sunDirection.dot(up);
  return {
    shadowMode: HOUSE_SHADOW_MODE,
    localShadowEnabled: HOUSE_USE_LOCAL_SHADOWS,
    localShadowDebugEnabled: HOUSE_LOCAL_SHADOW_DEBUG,
    shadowMapEnabled: HOUSE_USE_SHADOW_MAP,
    enabled: HOUSE_MODEL.enabled,
    mapMode: controls.mapMode,
    gateReason: houseShadowGateReason,
    gateMapMode: controls.mapMode,
    gateCoverageMissing: coverage == null,
    gateSunBelow: sunUp <= 0.01,
    gateNoReceivers: houseShadowReceivers.size === 0,
    rendererShadowEnabled: renderer.shadowMap.enabled,
    rendererShadowAutoUpdate: renderer.shadowMap.autoUpdate,
    lightVisible: houseShadowCasterLight.visible,
    lightCastShadow: houseShadowCasterLight.castShadow,
    receiverVisible: houseShadowReceiverLayer.visible,
    receiverCount: houseShadowReceivers.size,
    loadedHouseCount,
    localShadowMeshCount,
    localShadowVisibleCount,
    localShadowDebugMeshCount,
    localShadowDebugVisibleCount,
    casterMeshCount,
    customDepthCount,
    shadowMapSize: mapSize.x,
    shadowMapActual: map ? { width: map.width, height: map.height } : null,
    shadowCameraNear: Number(shadowCamera.near.toFixed(2)),
    shadowCameraFar: Number(shadowCamera.far.toFixed(2)),
    shadowSpanM: Number(span.toFixed(1)),
    approxTexelM: Number((span / mapSize.x).toFixed(3)),
    lightPos: {
      x: Number(houseShadowCasterLight.position.x.toFixed(1)),
      y: Number(houseShadowCasterLight.position.y.toFixed(1)),
      z: Number(houseShadowCasterLight.position.z.toFixed(1)),
    },
    lightTarget: {
      x: Number(houseShadowCasterLight.target.position.x.toFixed(1)),
      y: Number(houseShadowCasterLight.target.position.y.toFixed(1)),
      z: Number(houseShadowCasterLight.target.position.z.toFixed(1)),
    },
    sunUp: Number(sunUp.toFixed(4)),
  };
}

function maybeLogHouseShadowSnapshot(nowMs) {
  if (!HOUSE_MODEL.enabled || HOUSE_SHADOW_LOG_MS <= 0) {
    return;
  }
  if (nowMs - lastHouseShadowLogAt < HOUSE_SHADOW_LOG_MS) {
    return;
  }
  lastHouseShadowLogAt = nowMs;
  bootLog('house.shadow.snapshot', houseShadowDebugSummary());
}

function parseSigHeaders(response) {
  const etag = response.headers.get('etag') || '';
  const modified = response.headers.get('last-modified') || '';
  const length = response.headers.get('content-length') || '';
  return `${etag}|${modified}|${length}`;
}

async function pollHouseModelSignature() {
  try {
    const response = await fetch(HOUSE_MODEL.url, { method: 'HEAD', cache: 'no-store' });
    if (!response.ok) return '';
    return parseSigHeaders(response);
  } catch (_) {
    return '';
  }
}

function loadHouseModel(reason = 'manual') {
  if (!HOUSE_MODEL.enabled) {
    return;
  }
  const loadToken = ++houseLoadSerial;
  const cacheBustedUrl = `${HOUSE_MODEL.url}?cb=${Date.now()}`;
  bootLog('house.model.load.start', {
    reason,
    url: HOUSE_MODEL.url
  });
  houseLoader.load(
    cacheBustedUrl,
    gltf => {
      if (loadToken !== houseLoadSerial) {
        return;
      }
      houseModelTemplate = gltf.scene;
      instantiateHousesFromTemplate();
      snapPendingHouses();
      bootLog('house.model.load.success', {
        reason,
        instances: houseInstances.length
      });
    },
    undefined,
    error => {
      bootLog('house.model.load.error', {
        reason,
        message: error?.message ?? String(error),
        stack: error?.stack ?? null
      });
      console.warn(`[HOUSE] load failed (${reason}):`, error);
    }
  );
}

async function updateHouseHotReload(nowMs) {
  if (!HOUSE_MODEL.enabled) return;
  if (housePollInFlight) return;
  if (nowMs - lastHousePollAt < HOUSE_MODEL.hotReloadMs) return;
  lastHousePollAt = nowMs;
  housePollInFlight = true;
  try {
    const nextSig = await pollHouseModelSignature();
    if (!nextSig) return;
    if (!houseModelSig) {
      houseModelSig = nextSig;
      return;
    }
    if (nextSig !== houseModelSig) {
      houseModelSig = nextSig;
      loadHouseModel('asset-change');
    }
  } finally {
    housePollInFlight = false;
  }
}

const normalPass = new NormalPass(scene, camera);

const cloudsEffect = new CloudsEffect(camera, { resolutionScale: 1 });
cloudsEffect.qualityPreset = 'high';
cloudsEffect.coverage = 0.28;
// Raise main cloud layers to ~800m above Takram defaults
cloudsEffect.cloudLayers[0].altitude = 1550;  // default 750 + 800
cloudsEffect.cloudLayers[1].altitude = 1800;  // default 1000 + 800
cloudsEffect.cloudLayers[2].altitude = 8300;  // default 7500 + 800
// Cirrus layer — configured but OFF at startup (toggle in tuning panel)
cloudsEffect.cloudLayers[3].altitude = 9100;
cloudsEffect.cloudLayers[3].height = 400;
cloudsEffect.cloudLayers[3].densityScale = 0;
cloudsEffect.cloudLayers[3].shapeAmount = 0.3;
cloudsEffect.cloudLayers[3].shapeDetailAmount = 0;
cloudsEffect.cloudLayers[3].weatherExponent = 1;
cloudsEffect.cloudLayers[3].shapeAlteringBias = 0.35;
cloudsEffect.cloudLayers[3].coverageFilterWidth = 0.5;
cloudsEffect.localWeatherVelocity.set(0.00004, 0);
cloudsEffect.shapeVelocity.set(0, 0, 0);
cloudsEffect.shapeDetailVelocity.set(0, 0, 0);
cloudsEffect.shadow.maxFar = 1e5;
cloudsEffect.shadow.farScale = 0.25;
cloudsEffect.shadow.minTransmittance = 1e-5;
cloudsEffect.shadow.opticalDepthTailScale = 3;
cloudsEffect.localWeatherTexture = new LocalWeather();
cloudsEffect.shapeTexture = new CloudShape();
cloudsEffect.shapeDetailTexture = new CloudShapeDetail();
cloudsEffect.turbulenceTexture = new Turbulence();
const cloudsDefaults = {
  scattering: cloudsEffect.scatteringCoefficient,
  absorption: cloudsEffect.absorptionCoefficient,
};

const aerialPerspective = new AerialPerspectiveEffect(camera);
aerialPerspective.sky = true;
aerialPerspective.sun = true;
aerialPerspective.sunIrradiance = true; // shadows a bit strong but needed
aerialPerspective.skyIrradiance = true;
aerialPerspective.normalBuffer = normalPass.texture;
aerialPerspective.albedoScale = 1.0;
aerialPerspective.shadowRadius = 1.8;
aerialPerspective.shadowSampleCount = 12;

// Wire up tuning panel now that effects exist
const sunDirection = new THREE.Vector3();

function applyDate(date) {
  getSunDirectionECEF(date, sunDirection);
  aerialPerspective.sunDirection.copy(sunDirection);
  cloudsEffect.sunDirection.copy(sunDirection);
}
buildTuningControls(aerialPerspective, cloudsEffect);
applyDate(referenceDate);

function syncCloudComposition() {
  aerialPerspective.overlay = cloudsEffect.atmosphereOverlay;
  aerialPerspective.shadow = cloudsEffect.atmosphereShadow;
  aerialPerspective.shadowLength = cloudsEffect.atmosphereShadowLength;
}

cloudsEffect.events.addEventListener('change', event => {
  switch (event.property) {
    case 'atmosphereOverlay':
      aerialPerspective.overlay = cloudsEffect.atmosphereOverlay;
      break;
    case 'atmosphereShadow':
      aerialPerspective.shadow = cloudsEffect.atmosphereShadow;
      break;
    case 'atmosphereShadowLength':
      aerialPerspective.shadowLength = cloudsEffect.atmosphereShadowLength;
      break;
    default:
  }
});

syncCloudComposition();

function revokeObjectUrls(urlMap) {
  for (const objectUrl of urlMap.values()) {
    URL.revokeObjectURL(objectUrl);
  }
}

function applyAtmosphereTextures(textures) {
  bootLog('atmosphere.textures.apply', {
    keys: Object.keys(textures || {})
  });
  Object.assign(aerialPerspective, textures);
  Object.assign(cloudsEffect, textures);
}

function loadAtmosphereTextures(url, manager) {
  bootLog('atmosphere.loader.start', {
    url,
    viaManager: Boolean(manager)
  });
  new PrecomputedTexturesLoader({}, manager).load(
    url,
    textures => {
      bootLog('atmosphere.loader.success', { url });
      applyAtmosphereTextures(textures);
    },
    undefined,
    error => {
      bootLog('atmosphere.loader.error', {
        url,
        message: error?.message ?? String(error),
        stack: error?.stack ?? null
      });
    }
  );
}

async function prepareAtmosphereTextureUrlMap(baseUrl) {
  bootLog('atmosphere.cache.prepare.start', {
    baseUrl,
    fileCount: ATMOSPHERE_TEXTURE_FILES.length
  });
  if (!('caches' in window)) {
    bootLog('atmosphere.cache.prepare.no-cache-api');
    return null;
  }
  const cache = await caches.open(ATMOSPHERE_CACHE_NAME);
  const urlMap = new Map();
  let cacheHits = 0;
  let networkHits = 0;

  for (const fileName of ATMOSPHERE_TEXTURE_FILES) {
    const sourceUrl = `${baseUrl}/${fileName}`;
    let response = await cache.match(sourceUrl);
    let source = 'cache';
    if (response != null) {
      cacheHits += 1;
    } else {
      source = 'network';
      response = await fetch(sourceUrl);
      if (!response.ok) {
        throw new Error(`atmosphere texture fetch failed: ${response.status} ${sourceUrl}`);
      }
      await cache.put(sourceUrl, response.clone());
      networkHits += 1;
    }
    const blob = await response.blob();
    bootLog('atmosphere.cache.file.ready', {
      fileName,
      source,
      bytes: blob.size
    });
    urlMap.set(sourceUrl, URL.createObjectURL(blob));
  }

  bootLog('atmosphere.cache.prepare.done', { cacheHits, networkHits });
  return { urlMap, cacheHits, networkHits };
}

function loadAtmosphereTexturesWithLocalCache() {
  bootLog('atmosphere.cache.load-sequence.start');
  prepareAtmosphereTextureUrlMap(DEFAULT_PRECOMPUTED_TEXTURES_URL)
    .then(result => {
      if (result == null) {
        bootLog('atmosphere.cache.load-sequence.fallback-direct');
        loadAtmosphereTextures(DEFAULT_PRECOMPUTED_TEXTURES_URL);
        return;
      }

      const manager = new THREE.LoadingManager();
      // Loader requests still use source URLs; URLModifier swaps them for cached blobs.
      manager.setURLModifier(url => result.urlMap.get(url) ?? url);
      console.info(
        '[clouds-terrain-managed-flask-ux-wip] Atmosphere LUT cache prepared. ' +
          `cacheHits=${result.cacheHits} network=${result.networkHits}`
      );
      bootLog('atmosphere.cache.manager.ready', {
        cacheHits: result.cacheHits,
        networkHits: result.networkHits
      });

      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          revokeObjectUrls(result.urlMap);
          bootLog('atmosphere.cache.object-urls.revoked');
        }
      };

      bootLog('atmosphere.cache.loader.start');
      new PrecomputedTexturesLoader({}, manager).load(
        DEFAULT_PRECOMPUTED_TEXTURES_URL,
        textures => {
          bootLog('atmosphere.cache.loader.success');
          applyAtmosphereTextures(textures);
          release();
        },
        undefined,
        error => {
          bootLog('atmosphere.cache.loader.error', {
            message: error?.message ?? String(error),
            stack: error?.stack ?? null
          });
          release();
          loadAtmosphereTextures(DEFAULT_PRECOMPUTED_TEXTURES_URL);
        }
      );
    })
    .catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      bootLog('atmosphere.cache.load-sequence.error', {
        message,
        stack: error?.stack ?? null
      });
      console.warn(
        `[clouds-terrain-managed-flask-ux-wip] Atmosphere cache setup failed: ${message}`
      );
      loadAtmosphereTextures(DEFAULT_PRECOMPUTED_TEXTURES_URL);
    });
}

bootLog('atmosphere.cache.load-sequence.invoke');
loadAtmosphereTexturesWithLocalCache();

const composer = new EffectComposer(renderer, {
  frameBufferType: THREE.HalfFloatType,
  multisampling: 0
});
composer.addPass(new RenderPass(scene, camera));
composer.addPass(normalPass);
// Keep clouds + atmosphere in one effect pass to avoid render-target feedback issues.
composer.addPass(new EffectPass(camera, cloudsEffect, aerialPerspective));
composer.addPass(
  new EffectPass(
    camera,
    new ToneMappingEffect({ mode: ToneMappingMode.AGX }),
    new DitheringEffect()
  )
);
bootLog('composer.ready', {
  passCount: composer.passes.length
});

// --- Heightmap decode + mesh building (adapted for ENU frame) ---

function decodeHM(b64) {
  const r = atob(b64);
  const b = new Uint8Array(r.length);
  for (let i = 0; i < r.length; i++) b[i] = r.charCodeAt(i);
  return new Float32Array(b.buffer);
}

function eColor(e) {
  const s = [
    { e: -50, r: 0.04, g: 0.15, b: 0.35 }, { e: 5, r: 0.06, g: 0.18, b: 0.38 },
    { e: 15, r: 0.10, g: 0.35, b: 0.18 },
    { e: 200, r: 0.35, g: 0.55, b: 0.22 }, { e: 500, r: 0.52, g: 0.48, b: 0.20 },
    { e: 800, r: 0.55, g: 0.40, b: 0.25 }, { e: 1200, r: 0.58, g: 0.55, b: 0.50 },
    { e: 2000, r: 0.80, g: 0.78, b: 0.75 }, { e: 3000, r: 0.97, g: 0.97, b: 0.98 }
  ];
  if (e <= s[0].e) return s[0];
  if (e >= s[s.length - 1].e) return s[s.length - 1];
  for (let i = 0; i < s.length - 1; i++) {
    if (e >= s[i].e && e <= s[i + 1].e) {
      const t = (e - s[i].e) / (s[i + 1].e - s[i].e);
      return {
        r: s[i].r + t * (s[i + 1].r - s[i].r),
        g: s[i].g + t * (s[i + 1].g - s[i].g),
        b: s[i].b + t * (s[i + 1].b - s[i].b)
      };
    }
  }
  return s[s.length - 1];
}

function buildMesh(tile) {
  const res = tile.resolution, hm = decodeHM(tile.heightmap);
  const [xMin, yMin, xMax, yMax] = tile.bbox;
  const pos = new Float32Array(res * res * 3);
  const col = new Float32Array(res * res * 3);
  const uv = new Float32Array(res * res * 2);

  for (let r = 0; r < res; r++) for (let c = 0; c < res; c++) {
    const i = r * res + c, e = hm[i];
    const isOcean = e <= 1;
    pos[i * 3]     = xMin + (c / (res - 1)) * (xMax - xMin);
    pos[i * 3 + 1] = yMin + (r / (res - 1)) * (yMax - yMin);
    pos[i * 3 + 2] = isOcean ? 0 : e * EXAG;
    uv[i * 2] = c / (res - 1);
    uv[i * 2 + 1] = r / (res - 1);
    if (isOcean) { col[i * 3] = 0.04; col[i * 3 + 1] = 0.15; col[i * 3 + 2] = 0.30; }
    else { const cl = eColor(e); col[i * 3] = cl.r; col[i * 3 + 1] = cl.g; col[i * 3 + 2] = cl.b; }
  }
  const idx = [];
  for (let r = 0; r < res - 1; r++) for (let c = 0; c < res - 1; c++) {
    const a = r * res + c, b = a + 1, d = a + res, f = d + 1;
    idx.push(a, b, d); idx.push(b, f, d); // CW→CCW so normals point up
  }
  if (!idx.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const mat = new THREE.MeshBasicMaterial({
    color: 0x0a2650, side: THREE.FrontSide
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.userData.tileId = tile.id;
  mesh.userData.bbox = tile.bbox;
  mesh.userData.isWater = false;
  mesh.userData.waterMaskUrl = `/api/watermask/${tile.id}.png`;
  mesh.userData.waterMask = null;
  return mesh;
}

// --- Status colors for untextured tiles ---

function priorityColor(priority, minP, maxP) {
  if (maxP <= minP) return new THREE.Color(1, 0, 0);
  const t = Math.min(1, Math.max(0, (priority - minP) / (maxP - minP)));
  if (t < 0.33) return new THREE.Color(1, t / 0.33, 0);
  if (t < 0.66) return new THREE.Color(1 - (t - 0.33) / 0.33, 1, 0);
  return new THREE.Color(0, 1 - (t - 0.66) / 0.34, (t - 0.66) / 0.34);
}

const COLOR_DOWNLOADING = new THREE.Color(0xff2200);
const COLOR_MISSING = new THREE.Color(0x666666);

function markMissing(missing, downloading) {
  const dlSet = new Set(downloading || []);
  const missingSet = new Set((missing || []).map(t => t.id));
  for (const child of terrainRoot.children) {
    if (!child.isMesh) continue;
    const tid = child.userData.tileId;
    if (!tid) continue;
    if (child.material && child.material.map) continue;
    if (dlSet.has(tid)) {
      child.material.color.copy(COLOR_DOWNLOADING);
      child.material.vertexColors = false;
      child.material.needsUpdate = true;
    } else if (missingSet.has(tid)) {
      child.material.color.copy(COLOR_MISSING);
      child.material.vertexColors = false;
      child.material.needsUpdate = true;
    }
  }
}

// --- Deferred tile system ---
const deferredTiles = new Map();
const tileHistory = new Map();
function tileLog(tileId, msg) {
  if (!tileHistory.has(tileId)) tileHistory.set(tileId, []);
  tileHistory.get(tileId).push(`${(performance.now() / 1000).toFixed(1)}s ${msg}`);
}

function materializeTile(tileId, tex) {
  const tileData = deferredTiles.get(tileId);
  if (!tileData) return;
  deferredTiles.delete(tileId);
  tileLog(tileId, `materialize tex=${tex.image.width}x${tex.image.height}`);
  const mesh = buildMesh(tileData);
  if (!mesh) return;
  mesh.material.map = tex;
  mesh.material.color.set(0xffffff);
  mesh.userData.waterMask = waterMaskCache.get(tileId) || null;
  const depth = parseInt(tileId.split('-')[0]);
  mesh.material.polygonOffset = true;
  mesh.material.polygonOffsetFactor = -depth;
  mesh.material.polygonOffsetUnits = -depth;
  mesh.material.needsUpdate = true;
  const nb = mesh.userData.bbox;
  const toRemove = [];
  for (const child of terrainRoot.children) {
    if (!child.isMesh) continue;
    if (child.userData.tileId === tileId) {
      toRemove.push(child);
      continue;
    }
    const sb = child.userData.bbox;
    if (!sb) continue;
    if (!currentTileIds.has(child.userData.tileId) &&
        nb[0] <= sb[0] && nb[2] >= sb[2] && nb[1] <= sb[1] && nb[3] >= sb[3]) {
      toRemove.push(child);
    }
  }
  for (const c of toRemove) {
    const eid = c.userData.tileId || '?';
    const reason = eid === tileId ? 'replaced by textured self' : `contained by ${tileId}`;
    tileLog(eid, `evicted — ${reason}`);
    terrainRoot.remove(c);
    if (c.geometry) c.geometry.dispose();
    if (c.material) c.material.dispose();
  }
  terrainRoot.add(mesh);
}

// --- Texture streaming ---

const texCache = new Map();
const texSource = new Map();
const texInflight = new Map();
const texFetching = new Set();
const waterMaskCache = new Map();
const waterMaskInflight = new Map();
const ENABLE_WATER_MASKS = false;
const TEX_MAX = 50;
const _ancestorLogged = new Set();
let _texV = Date.now();

function requestWaterMask(tileId) {
  if (!ENABLE_WATER_MASKS) return;
  if (!tileId) return;
  if (waterMaskCache.has(tileId) || waterMaskInflight.has(tileId)) return;
  const ac = new AbortController();
  waterMaskInflight.set(tileId, ac);
  fetch(`/api/watermask/${tileId}.png?v=${_texV}`, { signal: ac.signal })
    .then(r => {
      waterMaskInflight.delete(tileId);
      if (r.status === 202 || !r.ok) return null;
      return r.blob();
    })
    .then(blob => {
      if (!blob) return;
      return createImageBitmap(blob, { imageOrientation: 'flipY' })
        .then(bmp => {
          const tex = new THREE.Texture(bmp);
          tex.flipY = false;
          tex.colorSpace = THREE.NoColorSpace;
          tex.needsUpdate = true;
          waterMaskCache.set(tileId, tex);
        });
    })
    .catch(err => {
      waterMaskInflight.delete(tileId);
      if (err.name !== 'AbortError') console.warn(`[WATER MASK] ${tileId}:`, err.message);
    });
}

// Visibility distance from camera altitude.
// Geometric horizon: sqrt(2 * R_earth * h), clamped to practical atmosphere limits.
// Low alt → ~15km (haze-limited), high alt → scales toward horizon.
function getTileLoadDistance() {
  const alt = Math.max(25, getCameraLatLon().alt);
  const R = 6371000;
  const horizon = Math.sqrt(2 * R * alt);
  return Math.min(horizon, 30000 + alt * 12);
}

function getFogDistance() {
  const alt = Math.max(25, getCameraLatLon().alt);
  const R = 6371000;
  const horizon = Math.sqrt(2 * R * alt);
  return Math.min(horizon, 15000 + alt * 8);
}

// Cosine of the horizontal half-FOV — tiles inside this cone get full priority.
function getFrustumDotMin() {
  const vFovRad = camera.fov * Math.PI / 360; // half vertical FOV
  const hHalf = Math.atan(Math.tan(vFovRad) * camera.aspect);
  return Math.cos(hHalf) * 0.8; // 20% margin beyond screen edge
}

function tilePriority(tile) {
  const cp = Math.cos(controls.pitch);
  const fwdX = -Math.sin(controls.yaw) * cp;
  const fwdY = Math.cos(controls.yaw) * cp;
  const rel = camera.position.clone().sub(anchorPosition);
  const camLocalX = rel.dot(east);
  const camLocalY = rel.dot(north);
  const tcx = (tile.bbox[0] + tile.bbox[2]) / 2;
  const tcy = (tile.bbox[1] + tile.bbox[3]) / 2;
  const dx = tcx - camLocalX;
  const dy = tcy - camLocalY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist <= 0) return 0;
  // Tiles within 2km always get top priority regardless of look direction
  if (dist < 2000) return Math.log(Math.max(dist, 1));
  const dot = (dx * fwdX + dy * fwdY) / dist;
  const dotMin = getFrustumDotMin();
  return Math.log(Math.max(dist / Math.max(dot, dotMin), 1));
}

function updateTextures(tiles) {
  texFetching.clear();
  const meshMap = new Map();
  for (const child of terrainRoot.children) {
    if (child.userData.tileId) meshMap.set(child.userData.tileId, child);
  }
  const visDist = getTileLoadDistance();
  const TEX_PRIO_MAX = Math.log(visDist); // dynamic visibility cutoff
  const tileSet = new Set();
  const scored = [];
  for (const t of tiles) {
    if (!t.id || !t.bbox) continue;
    tileSet.add(t.id);
    const prio = tilePriority(t);
    if (prio <= TEX_PRIO_MAX) scored.push({ tile: t, prio });
  }
  scored.sort((a, b) => a.prio - b.prio);

  // Materialize deferred tiles that now have cached textures
  for (const id of [...deferredTiles.keys()]) {
    const tex = texCache.get(id);
    if (tex) {
      materializeTile(id, tex);
    }
  }

  // Apply cached textures to existing meshes — always ensure white color
  // (priority tinting may have changed color since texture was last applied)
  for (const t of tiles) {
    if (!t.id) continue;
    const tex = texCache.get(t.id);
    if (!tex) continue;
    requestWaterMask(t.id);
    const mesh = meshMap.get(t.id);
    if (!mesh) continue;
    if (mesh.material.map !== tex) {
      tileLog(t.id, `apply cached tex (src=${texSource.get(t.id) || '?'})`);
      mesh.material.map = tex;
    }
    mesh.userData.waterMask = waterMaskCache.get(t.id) || null;
    if (mesh.material.color.r !== 1 || mesh.material.color.g !== 1 || mesh.material.color.b !== 1) {
      mesh.material.color.set(0xffffff);
    }
    mesh.material.vertexColors = false;
    mesh.material.needsUpdate = true;
  }



  // Fire fetches for hottest uncached tiles
  for (const { tile } of scored) {
    if (texFetching.size >= TEX_MAX) break;
    if (texCache.has(tile.id) || texInflight.has(tile.id) || texFetching.has(tile.id)) continue;
    if (_coveredByEnhancedParent(tile)) continue;

    const ac = new AbortController();
    texInflight.set(tile.id, ac);
    const tid = tile.id;
    fetch(`/api/texture/${tid}.jpg?v=${_texV}`, { signal: ac.signal })
      .then(r => {
        texInflight.delete(tid);
        if (r.status === 202) { tileLog(tid, 'fetch -> 202 (server fetching)'); texFetching.add(tid); return; }
        if (!r.ok) throw new Error(r.status);
        const ancestorHeader = r.headers.get('X-Tex-Ancestor');
        return r.blob()
          .then(blob => createImageBitmap(blob, { imageOrientation: 'flipY' }))
          .then(bmp => {
            texFetching.delete(tid);
            const isAncestorCrop = !!ancestorHeader;
            const texSrc = r.headers.get('X-Tex-Source') || '';
            tileLog(tid, `fetch -> ${bmp.width}x${bmp.height}${isAncestorCrop ? ' ANCESTOR=' + ancestorHeader : ''} src=${texSrc}`);
            const tex = new THREE.Texture(bmp);
            tex.flipY = false;
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.needsUpdate = true;
            if (isAncestorCrop) {
              tileLog(tid, `ancestor crop from ${ancestorHeader} — not caching, will retry`);
              _ancestorLogged.add(tid);
              // Apply ancestor texture as placeholder (don't cache — will re-fetch for sharp version)
              let mesh = null;
              for (const child of terrainRoot.children) {
                if (child.userData.tileId === tid) { mesh = child; break; }
              }
              if (mesh) {
                mesh.material.map = tex;
                mesh.material.color.set(0xffffff);
                mesh.material.needsUpdate = true;
              }
            } else {
              _ancestorLogged.delete(tid);
              texCache.set(tid, tex);
              texSource.set(tid, texSrc);
              requestWaterMask(tid);
              if (deferredTiles.has(tid)) {
                tileLog(tid, `cached + materialize (was deferred)`);
                materializeTile(tid, tex);
              } else {
                let mesh = null;
                for (const child of terrainRoot.children) {
                  if (child.userData.tileId === tid) { mesh = child; break; }
                }
                if (mesh) {
                  tileLog(tid, `cached + applied to existing mesh`);
                  mesh.material.map = tex;
                  mesh.material.color.set(0xffffff);
                  mesh.userData.waterMask = waterMaskCache.get(tid) || null;
                  mesh.material.needsUpdate = true;
                } else {
                  tileLog(tid, `cached but NO mesh in scene`);
                }
              }
            }
          });
      })
      .catch(err => {
        texInflight.delete(tid);
        if (err.name !== 'AbortError') console.warn(`[TEX] ${tid}:`, err.message);
      });
  }

  // Sweep stale parents: evict textured parents whose overlapping children
  // now all have cached textures. This catches parents that survived the
  // fetchTiles() eviction because children weren't textured yet.
  const tileBboxMap = new Map();
  for (const t of tiles) {
    if (t.id && t.bbox) tileBboxMap.set(t.id, t.bbox);
  }
  const staleParents = [];
  for (const child of terrainRoot.children) {
    if (!child.isMesh) continue;
    const tid = child.userData.tileId;
    if (!tid || !child.material || !child.material.map) continue;
    if (tileSet.has(tid)) continue; // not stale
    const sb = child.userData.bbox;
    if (!sb) continue;
    let covered = true;
    let foundOverlap = false;
    for (const cid of tileSet) {
      const cdepth = parseInt(cid.split('-')[0]);
      const pdepth = parseInt(tid.split('-')[0]);
      if (cdepth <= pdepth) continue;
      const cmesh = meshMap.get(cid);
      const cb = cmesh ? cmesh.userData.bbox : tileBboxMap.get(cid);
      if (!cb) continue;
      if (sb[0] <= cb[0] && sb[2] >= cb[2] && sb[1] <= cb[1] && sb[3] >= cb[3]) {
        foundOverlap = true;
        if (!texCache.has(cid)) { covered = false; break; }
      }
    }
    if (!foundOverlap) covered = false;
    if (covered) staleParents.push(child);
  }
  for (const c of staleParents) {
    tileLog(c.userData.tileId || '?', 'evicted — stale parent (children now textured)');
    terrainRoot.remove(c);
    if (c.geometry) c.geometry.dispose();
    if (c.material) c.material.dispose();
  }
}

// --- Deferred enhancement (idle-time upgrade) ---

const ENHANCE_MAX = 4;
const ENHANCE_IDLE_MS = 2000;
const ENHANCE_POLL_MS = 5000;
const ENHANCE_STATUS_POLL_MS = 3000;
const ENHANCE_BACKOFF_MS = 10000;
const ENHANCE_POLL_BATCH = 1;
const ENHANCE_SUBMIT_BATCH = 2;
const _enhanceInflight = new Map();
const _enhancePending = new Map();  // tid -> {submitted: ts, nextPollAt: ts} — server is working on it
const _enhanceRetryAfter = new Map(); // tid -> ts
const _enhanceFailed = new Set();
let _lastCamMoveTime = performance.now();
let _enhanceStatus = { total: 0, eligible: 0, done: 0, in_progress: 0 };
let _lastStatusPoll = 0;
let _enhanceBackoffUntil = 0;

// Check if a tile is fully contained by a parent mesh that has an enhanced texture.
function _coveredByEnhancedParent(tile) {
  const tb = tile.bbox;
  if (!tb) return false;
  const tileDepth = parseInt(tile.id.split('-')[0]);
  for (const child of terrainRoot.children) {
    if (!child.isMesh) continue;
    const cid = child.userData.tileId;
    if (!cid) continue;
    const parentDepth = parseInt(cid.split('-')[0]);
    if (parentDepth >= tileDepth) continue;
    const src = texSource.get(cid);
    if (!src || !src.includes('enhanced')) continue;
    const sb = child.userData.bbox;
    if (!sb) continue;
    if (sb[0] <= tb[0] && sb[2] >= tb[2] && sb[1] <= tb[1] && sb[3] >= tb[3]) {
      return true;
    }
  }
  return false;
}

function abortAllEnhancements() {
  if (_enhanceInflight.size === 0) return;
  for (const [tid, ac] of _enhanceInflight) {
    tileLog(tid, 'enhance aborted — camera moved');
    ac.abort();
  }
  _enhanceInflight.clear();
}

function _enhanceBusyCount() {
  return _enhanceInflight.size + _enhancePending.size;
}

function _handleEnhanceResponse(tid, r, fromPending = false) {
  _enhanceInflight.delete(tid);
  const now = performance.now();
  if (r.status === 202) {
    const pending = _enhancePending.get(tid);
    if (!pending) {
      tileLog(tid, 'enhance queued on server');
    }
    _enhancePending.set(tid, { submitted: now, nextPollAt: now + ENHANCE_POLL_MS });
    _enhanceRetryAfter.delete(tid);
    return;
  }
  if (r.status === 429) {
    _enhanceBackoffUntil = now + ENHANCE_BACKOFF_MS;
    _enhanceRetryAfter.set(tid, _enhanceBackoffUntil);
    if (fromPending || _enhancePending.has(tid)) {
      const pending = _enhancePending.get(tid);
      _enhancePending.set(tid, {
        submitted: pending?.submitted ?? now,
        nextPollAt: _enhanceBackoffUntil
      });
    }
    tileLog(tid, 'enhance throttled (429)');
    return;
  }
  _enhancePending.delete(tid);
  _enhanceRetryAfter.delete(tid);
  if (!r.ok || r.status === 204) {
    const reason = r.headers.get('X-Tex-Status') || `status ${r.status}`;
    console.warn(`[ENHANCE] ${tid} rejected: ${reason}`);
    tileLog(tid, `enhance rejected: ${reason}`);
    _enhanceFailed.add(tid);
    _enhancePending.delete(tid);
    return;
  }
  const newSrc = r.headers.get('X-Tex-Source') || 'sentinel2_enhanced';
  return r.blob()
    .then(blob => createImageBitmap(blob, { imageOrientation: 'flipY' }))
    .then(bmp => {
      const tex = new THREE.Texture(bmp);
      tex.flipY = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      texCache.set(tid, tex);
      texSource.set(tid, newSrc);
      requestWaterMask(tid);
      tileLog(tid, `enhanced: sentinel2 -> ${newSrc}`);
      // Apply enhanced texture to existing mesh
      for (const child of terrainRoot.children) {
        if (!child.isMesh) continue;
        if (child.userData.tileId === tid) {
          child.material.map = tex;
          child.userData.waterMask = waterMaskCache.get(tid) || null;
          child.material.needsUpdate = true;
          break;
        }
      }
      // Don't evict deeper children here — let the LOD system handle it
      // naturally. Immediate eviction causes visible flashing.
    });
}

function updateEnhancement() {
  const now = performance.now();
  // Poll server-side enhance status periodically
  if (now - _lastStatusPoll > ENHANCE_STATUS_POLL_MS) {
    _lastStatusPoll = now;
    fetch('/api/enhance/status').then(r => r.json()).then(s => { _enhanceStatus = s; }).catch(() => {});
  }

  if (texInflight.size > 0 || texFetching.size > 0) return;
  if (now - _lastCamMoveTime < ENHANCE_IDLE_MS) return;
  if (!lastTiles) return;
  if (now < _enhanceBackoffUntil) return;

  // Poll pending tiles that the server is working on
  let pollBudget = Math.min(ENHANCE_POLL_BATCH, Math.max(0, ENHANCE_MAX - _enhanceInflight.size));
  for (const [tid, info] of _enhancePending) {
    if (pollBudget <= 0) break;
    if (_enhanceInflight.has(tid)) continue;
    const retryAt = _enhanceRetryAfter.get(tid) ?? 0;
    if (now < retryAt) continue;
    const nextPollAt = info.nextPollAt ?? (info.submitted + ENHANCE_POLL_MS);
    if (now < nextPollAt) continue;
    info.submitted = now;
    info.nextPollAt = now + ENHANCE_POLL_MS;
    const ac = new AbortController();
    _enhanceInflight.set(tid, ac);
    pollBudget--;
    fetch(`/api/texture/${tid}/enhance`, { method: 'POST', signal: ac.signal })
      .then(r => _handleEnhanceResponse(tid, r, true))
      .catch(err => {
        _enhanceInflight.delete(tid);
        if (err.name !== 'AbortError') tileLog(tid, `enhance poll error: ${err.message}`);
      });
  }

}

// --- Camera position → lat/lon conversion ---

function getCameraLatLon() {
  const rel = camera.position.clone().sub(anchorPosition);
  const eastM = rel.dot(east);
  const northM = rel.dot(north);
  const altM = rel.dot(up);
  const lat = centerLat + northM / 111320;
  const lon = centerLon + eastM / (111320 * Math.cos(centerLat * Math.PI / 180));
  return { lat, lon, alt: altM };
}

// --- Tile fetching ---

let pollTimer = null;

const PREVIEW_MAX_DEPTH = 8;

async function fetchTiles(lat, lon) {
  if (fetching) return;
  fetching = true;
  try {
    const t0 = performance.now();
    const heading = controls.yaw;
    const camLL = getCameraLatLon();
    const fetchLat = lat ?? camLL.lat;
    const fetchLon = lon ?? camLL.lon;
    const fetchAlt = camLL.alt;
    let url;
    if (isFirstLoad) {
      url = `/api/tiles?lat=${fetchLat}&lon=${fetchLon}&alt=${fetchAlt}&heading=${heading}&maxDepth=${PREVIEW_MAX_DEPTH}`;
    } else {
      url = `/api/tiles?lat=${fetchLat}&lon=${fetchLon}&ox=${originX}&oy=${originY}&alt=${fetchAlt}&heading=${heading}`;
    }
    const resp = await fetch(url);
    const data = await resp.json();
    if (!bootFetchLogged) {
      bootFetchLogged = true;
      bootLog('tiles.initial-fetch.response', {
        status: resp.status,
        tileCount: Array.isArray(data.tiles) ? data.tiles.length : -1
      });
    }

    const wasFirstLoad = isFirstLoad;
    if (isFirstLoad) {
      originX = data.ox;
      originY = data.oy;
      camStereoX = data.qx;
      camStereoY = data.qy;
      lastFetchX = data.qx;
      lastFetchY = data.qy;
      isFirstLoad = false;
    }

    const newIds = new Set(data.tiles.map(t => t.id));
    const added = [...newIds].filter(id => !currentTileIds.has(id));
    const removed = [...currentTileIds].filter(id => !newIds.has(id));
    currentTileIds = newIds;

    // Purge stale deferred tiles
    let purged = 0;
    for (const id of deferredTiles.keys()) {
      if (!newIds.has(id)) { deferredTiles.delete(id); purged++; }
    }

    // Index current meshes by tile ID for overlap/coverage checks below.
    const meshMap = new Map();
    for (const child of terrainRoot.children) {
      if (child.userData.tileId) meshMap.set(child.userData.tileId, child);
    }

    // Bbox lookup from API response — lets us see children that don't
    // have meshes yet (deferred / newly added).
    const tileBboxMap = new Map();
    for (const t of data.tiles) {
      if (t.id && t.bbox) tileBboxMap.set(t.id, t.bbox);
    }

    // Evict stale meshes: always remove untextured; remove textured parents
    // ONLY when every overlapping child in the new LOD set has a cached texture.
    // Keep the stale parent visible until all children are ready to replace it.
    const staleToRemove = [];
    for (const child of terrainRoot.children) {
      if (!child.isMesh) continue;
      const tid = child.userData.tileId;
      if (!tid) continue;
      if (!newIds.has(tid)) {
        if (!child.material || !child.material.map) {
          staleToRemove.push(child);
        } else {
          // Textured stale tile — only evict when ALL overlapping children
          // have cached textures so there's no visible gap.
          const sb = child.userData.bbox;
          if (sb) {
            let coveredByChildren = true;
            let foundOverlap = false;
            for (const cid of newIds) {
              const cdepth = parseInt(cid.split('-')[0]);
              const pdepth = parseInt(tid.split('-')[0]);
              if (cdepth <= pdepth) continue;
              // Check mesh bbox first, fall back to API tile data for
              // children that don't have meshes yet (deferred/new).
              const cmesh = meshMap.get(cid);
              const cb = cmesh ? cmesh.userData.bbox : tileBboxMap.get(cid);
              if (!cb) continue;
              // Is this child tile within the stale parent's area?
              if (sb[0] <= cb[0] && sb[2] >= cb[2] && sb[1] <= cb[1] && sb[3] >= cb[3]) {
                foundOverlap = true;
                if (!texCache.has(cid)) { coveredByChildren = false; break; }
              }
            }
            // No overlapping children found → keep parent (don't evict into void)
            if (!foundOverlap) coveredByChildren = false;
            if (coveredByChildren) {
              staleToRemove.push(child);
            } else {
              // Keep for now but disable polygonOffset
              if (child.material.polygonOffset) {
                child.material.polygonOffset = false;
                child.material.needsUpdate = true;
              }
            }
          } else {
            staleToRemove.push(child);
          }
        }
      } else if (child.material && child.material.map && !child.material.polygonOffset) {
        const depth = parseInt(tid.split('-')[0]);
        child.material.polygonOffset = true;
        child.material.polygonOffsetFactor = -depth;
        child.material.polygonOffsetUnits = -depth;
        child.material.needsUpdate = true;
      }
    }
    for (const c of staleToRemove) {
      const reason = c.material?.map ? 'evicted — stale parent (children textured)' : 'evicted — stale untextured';
      tileLog(c.userData.tileId || '?', reason);
      terrainRoot.remove(c);
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    }

    if (added.length > 0) {
      const existingIds = new Set();
      for (const c of terrainRoot.children) {
        if (c.userData.tileId) existingIds.add(c.userData.tileId);
      }
      const addedSet = new Set(added);
      let built = 0, deferred = 0;
      const MESH_BUILD_BUDGET = 30; // max meshes to build per fetch (spread the rest across frames)
      for (const tile of data.tiles) {
        if (!addedSet.has(tile.id) || !tile.heightmap) continue;
        if (existingIds.has(tile.id)) continue;
        // Skip children whose parent is already enhanced — the parent covers this area
        if (_coveredByEnhancedParent(tile)) {
          tileLog(tile.id, 'skipped — covered by enhanced parent');
          continue;
        }
        const cachedTex = texCache.get(tile.id);
        if (cachedTex) {
          if (built < MESH_BUILD_BUDGET) {
            tileLog(tile.id, 'added — immediate build (cached tex)');
            deferredTiles.set(tile.id, tile);
            materializeTile(tile.id, cachedTex);
            built++;
          } else {
            // Over budget — defer to next frame cycle
            deferredTiles.set(tile.id, tile);
            deferred++;
          }
        } else {
          // No texture yet — defer until texture arrives.
          deferredTiles.set(tile.id, tile);
          // If a stale textured mesh covers this area, skip the untextured
          // fallback — the stale texture looks better than a blank mesh.
          // materializeTile() will swap in the real textured mesh when ready.
          const tb = tile.bbox;
          let hasCoverage = false;
          for (const child of terrainRoot.children) {
            if (!child.isMesh || !child.material || !child.material.map) continue;
            const sb = child.userData.bbox;
            if (!sb) continue;
            if (sb[0] < tb[2] && sb[2] > tb[0] && sb[1] < tb[3] && sb[3] > tb[1]) {
              hasCoverage = true;
              break;
            }
          }
          if (hasCoverage) {
            tileLog(tile.id, 'added — deferred (stale coverage exists)');
            deferred++;
          } else if (built < MESH_BUILD_BUDGET) {
            tileLog(tile.id, 'added — untextured fallback (no stale coverage)');
            const mesh = buildMesh(tile);
            if (mesh) {
              const depth = parseInt(tile.id.split('-')[0]);
              mesh.material.polygonOffset = true;
              mesh.material.polygonOffsetFactor = -depth;
              mesh.material.polygonOffsetUnits = -depth;
              terrainRoot.add(mesh);
            }
            built++;
          } else {
            deferredTiles.set(tile.id, tile);
            deferred++;
          }
        }
      }
    }

    updateTextures(data.tiles);
    markMissing(data.missing || [], data.downloading || []);
    lastTiles = data.tiles;

    // Update stereo position from camera
    const camLLNow = getCameraLatLon();
    camStereoX = originX + (camLLNow.lon - centerLon) * 111320 * Math.cos(centerLat * Math.PI / 180);
    camStereoY = originY + (camLLNow.lat - centerLat) * 111320;
    lastFetchX = camStereoX;
    lastFetchY = camStereoY;

    const nm = (data.missing || []).length;
    const nd = (data.downloading || []).length;
    const texInFlight = (data.texFetching || 0);

    if (pollTimer) clearTimeout(pollTimer);
    if (wasFirstLoad) {
      // Preview pass done — immediately fetch full-depth tiles.
      // The normal eviction/replacement logic will upgrade the low-LOD
      // preview tiles as higher-detail children arrive with textures.
      bootLog('tiles.preview-done', {
        previewTiles: data.tiles.length,
        elapsedMs: Number((performance.now() - t0).toFixed(1))
      });
      fetching = false;
      fetchTiles();
      return;
    } else if (nd > 0 || nm > 0 || texInFlight > 0) {
      pollTimer = setTimeout(() => fetchTiles(), 3000);
    }

  } catch (err) {
    if (!bootFetchLogged) {
      bootLog('tiles.initial-fetch.error', {
        message: err?.message ?? String(err),
        stack: err?.stack ?? null
      });
      bootFetchLogged = true;
    }
    console.error('Fetch error:', err);
  }
  fetching = false;
  // Drain accumulated dt so the next render frame doesn't lurch the camera
  clock.getDelta();
}

// --- Save/restore camera position ---

function savePosition() {
  if (isFirstLoad) return;
  const camLL = getCameraLatLon();
  localStorage.setItem('clouds-cam', JSON.stringify({
    lat: camLL.lat, lon: camLL.lon, alt: camLL.alt,
    yaw: controls.yaw, pitch: controls.pitch, speed: controls.speed,
    mapZoom: controls.mapZoom
  }));
}
setInterval(savePosition, 2000);
window.addEventListener('beforeunload', savePosition);

// Restore saved camera position (lat/lon/alt are origin-independent)
try {
  const saved = JSON.parse(localStorage.getItem('clouds-cam'));
  if (saved && saved.lat != null && saved.lon != null) {
    const dLat = saved.lat - centerLat;
    const dLon = saved.lon - centerLon;
    const eM = dLon * 111320 * Math.cos(centerLat * Math.PI / 180);
    const nM = dLat * 111320;
    const alt = saved.alt ?? 700;
    camera.position.copy(anchorPosition)
      .addScaledVector(east, eM)
      .addScaledVector(north, nM)
      .addScaledVector(up, alt);
    if (saved.yaw != null) controls.yaw = saved.yaw;
    if (saved.pitch != null) controls.pitch = saved.pitch;
    if (saved.speed != null) controls.speed = saved.speed;
    if (saved.mapZoom != null) controls.mapZoom = saved.mapZoom;
    applyCameraOrientation();
  }
} catch (_) {}
// Always fetch at center first so origin = stereo(center) matches the ECEF anchor.
// The render loop will immediately refetch around the restored camera position.
bootLog('tiles.initial-fetch.start', {
  centerLat,
  centerLon
});
fetchTiles(centerLat, centerLon);
if (HOUSE_MODEL.enabled && housesRuntimeVisible) {
  bootLog('house.initial-load.start', {
    instanceCount: houseInstances.length
  });
  markHousesNeedSnap();
  loadHouseModel('initial');
  pollHouseModelSignature().then(sig => {
    houseModelSig = sig;
  });
}

window.takramDebug = {
  sceneMode: 'clouds-terrain-managed-flask-ux-wip',
  cloudsEffect,
  aerialPerspective,
  referenceDate,
  centerLat,
  centerLon,
  controls,
  applyDate,
  bootEvents,
  getBootEvents: () => bootEvents.slice(),
  flushClientLogQueue: () => flushClientLogQueue(),
  fetchTiles,
  loadHouseModel,
  setHousesVisible: visible => setHousesRuntimeVisible(Boolean(visible), 'debug-api'),
  getHousesVisible: () => housesRuntimeVisible,
  houseInstances,
  houseZSummary,
  houseShadowDebugSummary,
  terrainRoot,
  texCache,
  waterMaskCache,
  deferredTiles,
  tileHistory,
  currentTileIds,
  getSunDirection: () => sunDirection.clone()
};

function applyCameraOrientation() {
  const cp = Math.cos(controls.pitch);
  const direction = new THREE.Vector3()
    .addScaledVector(east, -Math.sin(controls.yaw) * cp)
    .addScaledVector(north, Math.cos(controls.yaw) * cp)
    .addScaledVector(up, Math.sin(controls.pitch))
    .normalize();
  camera.up.copy(up);
  camera.lookAt(camera.position.clone().add(direction));
}

function updateMapCamera() {
  const aspect = window.innerWidth / window.innerHeight;
  mapCam.left = -controls.mapZoom * aspect;
  mapCam.right = controls.mapZoom * aspect;
  mapCam.top = controls.mapZoom;
  mapCam.bottom = -controls.mapZoom;
  mapCam.updateProjectionMatrix();

  const cosY = Math.cos(controls.yaw);
  const sinY = Math.sin(controls.yaw);
  const rpe = controls.mapPanEast * cosY - controls.mapPanNorth * sinY;
  const rpn = controls.mapPanEast * sinY + controls.mapPanNorth * cosY;
  const target = camera.position
    .clone()
    .addScaledVector(east, rpe)
    .addScaledVector(north, rpn);
  mapCam.position.copy(target).addScaledVector(up, MAP_CAM_ALT);
  mapCam.up.copy(north);
  mapCam.lookAt(target);
  mapCam.rotation.z = controls.yaw;
}

function disposeObjectMaterial(material) {
  if (material == null) {
    return;
  }
  if (Array.isArray(material)) {
    for (const value of material) {
      value.dispose?.();
    }
    return;
  }
  material.dispose?.();
}

function showTileBorder(mesh) {
  if (hoverOutline != null) {
    terrainRoot.remove(hoverOutline);
    hoverOutline.geometry?.dispose?.();
    disposeObjectMaterial(hoverOutline.material);
    hoverOutline = null;
  }
  if (mesh == null) {
    return;
  }
  let xMin = 0;
  let yMin = 0;
  let xMax = 0;
  let yMax = 0;

  const bbox = mesh.userData?.bbox;
  if (Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite)) {
    xMin = Number(bbox[0]);
    yMin = Number(bbox[1]);
    xMax = Number(bbox[2]);
    yMax = Number(bbox[3]);
  } else {
    const box = new THREE.Box3().setFromObject(mesh);
    if (box.isEmpty()) {
      return;
    }
    xMin = box.min.x;
    yMin = box.min.y;
    xMax = box.max.x;
    yMax = box.max.y;
  }

  const z = 50;
  const points = [
    new THREE.Vector3(xMin, yMin, z),
    new THREE.Vector3(xMax, yMin, z),
    new THREE.Vector3(xMax, yMax, z),
    new THREE.Vector3(xMin, yMax, z),
    new THREE.Vector3(xMin, yMin, z)
  ];
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  hoverOutline = new THREE.Line(
    geometry,
    new THREE.LineBasicMaterial({ color: 0xff0000, depthTest: false })
  );
  hoverOutline.renderOrder = 999;
  terrainRoot.add(hoverOutline);
}

function updateEnhanceOutlines() {
  const pendingIds = new Set([..._enhancePending.keys(), ..._enhanceInflight.keys()]);
  const key = [...pendingIds].sort().join(',');
  if (key === _lastEnhanceKey) return;
  _lastEnhanceKey = key;

  // Clear old outlines
  while (enhanceOutlines.children.length) {
    const c = enhanceOutlines.children[0];
    enhanceOutlines.remove(c);
    c.geometry?.dispose?.();
    c.material?.dispose?.();
  }

  for (const tid of pendingIds) {
    const mesh = terrainRoot.children.find(c => c.userData?.tileId === tid);
    if (!mesh) continue;
    const bbox = mesh.userData?.bbox;
    if (!Array.isArray(bbox) || bbox.length !== 4) continue;
    const [xMin, yMin, xMax, yMax] = bbox;
    const z = 50;
    const points = [
      new THREE.Vector3(xMin, yMin, z),
      new THREE.Vector3(xMax, yMin, z),
      new THREE.Vector3(xMax, yMax, z),
      new THREE.Vector3(xMin, yMax, z),
      new THREE.Vector3(xMin, yMin, z)
    ];
    const geom = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(geom,
      new THREE.LineBasicMaterial({ color: 0xff88cc, depthTest: false })
    );
    line.renderOrder = 998;
    enhanceOutlines.add(line);
  }
}

function updateEnhancedOutlines() {
  const enhancedIds = [];
  for (const [tid, src] of texSource) {
    if (src.includes('enhanced') || src === 'upscaled') enhancedIds.push(tid);
  }
  const key = enhancedIds.sort().join(',');
  if (key === _lastEnhancedKey) return;
  _lastEnhancedKey = key;

  while (enhancedOutlines.children.length) {
    const c = enhancedOutlines.children[0];
    enhancedOutlines.remove(c);
    c.geometry?.dispose?.();
    c.material?.dispose?.();
  }

  for (const tid of enhancedIds) {
    const mesh = terrainRoot.children.find(c => c.userData?.tileId === tid);
    if (!mesh) continue;
    const bbox = mesh.userData?.bbox;
    if (!Array.isArray(bbox) || bbox.length !== 4) continue;
    const [xMin, yMin, xMax, yMax] = bbox;
    const z = 50;
    const points = [
      new THREE.Vector3(xMin, yMin, z),
      new THREE.Vector3(xMax, yMin, z),
      new THREE.Vector3(xMax, yMax, z),
      new THREE.Vector3(xMin, yMax, z),
      new THREE.Vector3(xMin, yMin, z)
    ];
    const geom = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(geom,
      new THREE.LineBasicMaterial({ color: 0x44aaff, depthTest: false })
    );
    line.renderOrder = 997;
    enhancedOutlines.add(line);
  }
}

function pollSeamStatus() {
  const now = performance.now();
  if (now - _lastSeamPoll < SEAM_POLL_MS) return;
  _lastSeamPoll = now;
  fetch('/api/seam_status')
    .then(r => r.json())
    .then(s => {
      _seamPending = new Set(s.pending || []);
      _seamRunning = new Set(s.running || []);
      _seamDoneRecent = new Set(s.done_recent || []);
      _seamFailed = new Set(s.failed || []);
    })
    .catch(() => {});
}

function getSeamStatus(tileId) {
  if (_seamRunning.has(tileId)) return '<span style="color:#0f8">RUNNING</span>';
  if (_seamFailed.has(tileId)) return '<span style="color:#f33">FAILED</span>';
  if (_seamPending.has(tileId)) return '<span style="color:#fc0">PENDING</span>';
  if (_seamDoneRecent.has(tileId)) return '<span style="color:#8f8">DONE</span>';
  return null;
}

function hideTileInfo() {
  tileInfoEl.style.display = 'none';
  showTileBorder(null);
}

function collectDebugMeshes(root) {
  debugIntersectables.length = 0;
  root.traverse(object => {
    if (object.isMesh && object.userData?.tileId) {
      debugIntersectables.push(object);
    }
  });
  return debugIntersectables;
}

function meshDebugSummary(mesh) {
  const tileId = mesh.userData?.tileId ?? '?';
  const hasTexture = !!mesh.material?.map;
  const textureImage = mesh.material?.map?.image;
  const textureSize = textureImage != null ? `${textureImage.width}x${textureImage.height}` : '-';
  const color = mesh.material?.color != null ? `#${mesh.material.color.getHexString()}` : '-';
  const bbox = mesh.userData?.bbox;
  return {
    tileId,
    hasTexture,
    textureSize,
    color,
    bbox
  };
}

function clampAltitude() {
  const rel = camera.position.clone().sub(anchorPosition);
  const altitude = rel.dot(up);
  const clamped = Math.max(25, Math.min(6000, altitude));
  const delta = clamped - altitude;
  if (Math.abs(delta) > 1e-6) {
    camera.position.addScaledVector(up, delta);
  }
}

function isPressed(primary, secondary) {
  return controls.keys[primary] || controls.keys[secondary];
}

function updateMovement(dt) {
  const forwardPressed = isPressed('KeyW', 'ArrowUp');
  const backPressed = isPressed('KeyS', 'ArrowDown');
  const leftPressed = isPressed('KeyA', 'ArrowLeft');
  const rightPressed = isPressed('KeyD', 'ArrowRight');

  if (forwardPressed) {
    controls.speed = Math.min(controls.speed + ACCEL * dt, MAX_SPEED);
  } else if (backPressed) {
    controls.speed = Math.max(controls.speed - ACCEL * dt, -MAX_SPEED);
  } else {
    if (controls.speed > 0) {
      controls.speed = Math.max(controls.speed - BRAKE * dt, 0);
    } else if (controls.speed < 0) {
      controls.speed = Math.min(controls.speed + BRAKE * dt, 0);
    }
  }

  if (controls.mapMode) {
    updateMapCamera();
    mapScreenUp.set(0, 1, 0).applyQuaternion(mapCam.quaternion);
    mapScreenUp.addScaledVector(up, -mapScreenUp.dot(up));
    if (mapScreenUp.lengthSq() < 1e-9) {
      movementForward.copy(north);
    } else {
      movementForward.copy(mapScreenUp).normalize();
    }
  } else {
    applyCameraOrientation();
    camera.getWorldDirection(movementForward);
    movementForward.addScaledVector(up, -movementForward.dot(up));
    if (movementForward.lengthSq() < 1e-9) {
      movementForward.copy(north);
    } else {
      movementForward.normalize();
    }
  }
  movementRight.crossVectors(movementForward, up).normalize();

  const move = new THREE.Vector3();
  if (controls.speed !== 0) {
    move.addScaledVector(movementForward, controls.speed * dt);
  }
  if (controls.mapMode) {
    if (leftPressed) {
      controls.yaw += TURN_SPEED * dt;
    }
    if (rightPressed) {
      controls.yaw -= TURN_SPEED * dt;
    }
  } else {
    if (leftPressed) {
      move.addScaledVector(movementRight, -STRAFE_SPEED * dt);
    }
    if (rightPressed) {
      move.addScaledVector(movementRight, STRAFE_SPEED * dt);
    }
  }
  if (controls.keys.KeyQ) {
    move.addScaledVector(up, STRAFE_SPEED * dt * 0.5);
  }
  if (controls.keys.KeyZ) {
    move.addScaledVector(up, -STRAFE_SPEED * dt * 0.5);
  }
  if (move.lengthSq() > 0) {
    _lastCamMoveTime = performance.now();
    abortAllEnhancements();
  }
  camera.position.add(move);
  // NaN guard — if camera position gets corrupted (e.g. bad terrain data
  // or degenerate lookAt), snap back to last known good position.
  if (isNaN(camera.position.x) || isNaN(camera.position.y) || isNaN(camera.position.z)) {
    console.warn('[CAM] NaN detected — restoring last good position');
    camera.position.copy(_lastGoodCamPos);
    controls.speed = 0;
  } else {
    _lastGoodCamPos.copy(camera.position);
  }
  clampAltitude();
}

function updateHud() {
  const rel = camera.position.clone().sub(anchorPosition);
  const eastM = rel.dot(east);
  const northM = rel.dot(north);
  const altM = rel.dot(up);
  const speedKmh = Math.abs(controls.speed) * 3.6;
  const deg = (((-controls.yaw * 180) / Math.PI) % 360 + 360) % 360;
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const compass = dirs[Math.round(deg / 45) % 8];
  let texLine = `tiles: ${currentTileIds.size}  tex: ${texCache.size}`;
  const es = _enhanceStatus;
  const enhDone = es.done || 0;
  const enhTotal = es.total || 0;
  const enhInProg = es.in_progress || 0;
  const enhEligible = es.eligible || 0;
  if (enhTotal > 0) {
    const pct = enhTotal > 0 ? Math.round(enhDone / enhTotal * 100) : 0;
    let enhParts = [];
    if (enhInProg > 0) enhParts.push(`<span style="color:#f8c">${enhInProg} upscaling</span>`);
    enhParts.push(`<span style="color:#8f8">${enhDone}/${enhTotal} enhanced (${pct}%)</span>`);
    if (enhEligible > 0) enhParts.push(`<span style="color:#fc8">${enhEligible} eligible</span>`);
    texLine += '  ' + enhParts.join('  ');
  }
  hud.innerHTML = [
    '<b>Clouds Terrain Managed Flask UX WIP</b>',
    `mode: <b>${controls.mapMode ? 'MAP' : 'FLIGHT'}</b>`,
    `enu: E ${eastM.toFixed(0)}m  N ${northM.toFixed(0)}m  U ${altM.toFixed(0)}m`,
    `speed: ${speedKmh.toFixed(0)} km/h  heading: ${deg.toFixed(0)}° ${compass}`,
    texLine,
    'WASD or Arrows move, Q/Z altitude, drag look',
    'map: left-drag rotate, right-drag pan, wheel zoom',
    'M map mode, R reset'
  ].join('<br>');
  alt.textContent =
    `${altM.toFixed(0)}m / ${(altM * 3.28084).toFixed(0)}ft  ${deg.toFixed(0)}° ${compass}` +
    `  FOV ${camera.fov.toFixed(0)}°` +
    (controls.mapMode ? '  [MAP]' : '');
}

function resetView() {
  localStorage.removeItem('clouds-cam');
  localStorage.removeItem(TUNING_STORAGE_KEY);
  for (const k of Object.keys(_tuningState)) delete _tuningState[k];
  controls.yaw = defaultYaw;
  controls.pitch = defaultPitch;
  controls.speed = 0;
  controls.dragging = false;
  controls.dragButton = 0;
  controls.mapMode = false;
  controls.mapPanEast = 0;
  controls.mapPanNorth = 0;
  controls.mapZoom = DEFAULT_MAP_ZOOM;
  camera.position.copy(defaultCameraPosition);
  camera.fov = 60;
  camera.updateProjectionMatrix();
  camMarker.visible = false;
  hideTileInfo();
  applyCameraOrientation();
  updateMapCamera();
  // Reset all tuning sliders/toggles to defaults (clouds, cirrus, fog, etc.)
  resetTuningUI();
  camera.far = MAX_VIEW_DIST;
  camera.updateProjectionMatrix();
  // Close atmosphere panel
  tuningOpen = false;
  tuningBody.style.display = 'none';
  document.getElementById('tuning-toggle').innerHTML = '&#9660;';
  updateHud();
  // Re-fetch tiles at Nuuk anchor
  isFirstLoad = true;
  originX = 0; originY = 0;
  camStereoX = 0; camStereoY = 0;
  lastFetchX = 0; lastFetchY = 0;
  markHousesNeedSnap();
  fetchTiles(centerLat, centerLon);
}

window.addEventListener('keydown', event => {
  if (event.target.tagName === 'TEXTAREA' || event.target.tagName === 'INPUT') return;
  controls.keys[event.code] = true;
  if (event.code === 'KeyM' && !event.repeat) {
    controls.mapMode = !controls.mapMode;
    camMarker.visible = controls.mapMode;
    tuningPanel.style.display = controls.mapMode ? 'none' : '';
    controls.mapPanEast = 0;
    controls.mapPanNorth = 0;
    if (controls.mapMode) {
      updateMapCamera();
    } else {
      hideTileInfo();
      hideTileMenu();
    }
  }
  if (event.code === 'KeyR' && !event.repeat) {
    resetView();
  }
  if (event.code === 'KeyH' && !event.repeat) {
    if (event.shiftKey) {
      loadHouseModel('keyboard');
    } else {
      setHousesRuntimeVisible(!housesRuntimeVisible, 'keyboard');
    }
  }
});

window.addEventListener('keyup', event => {
  controls.keys[event.code] = false;
});

renderer.domElement.addEventListener('mousedown', event => {
  controls.dragging = true;
  controls.dragButton = event.button;
});

window.addEventListener('mouseup', () => {
  controls.dragging = false;
  controls.dragButton = 0;
});

window.addEventListener('mousemove', event => {
  if (!controls.dragging) {
    return;
  }
  if (controls.mapMode) {
    if (controls.dragButton === 2) {
      const panStep = controls.mapZoom * MOUSE_SENS * MAP_PAN_FACTOR;
      controls.mapPanEast -= event.movementX * panStep;
      controls.mapPanNorth += event.movementY * panStep;
      updateMapCamera();
      return;
    }
    controls.yaw += event.movementX * MOUSE_SENS;
    return;
  }
  controls.yaw += event.movementX * MOUSE_SENS;
  controls.pitch += event.movementY * MOUSE_SENS;
  controls.pitch = Math.max(-1.4, Math.min(1.2, controls.pitch));
});

renderer.domElement.addEventListener('pointerdown', event => {
  console.warn('[CLICK TEST] pointerdown', {
    x: event.clientX,
    y: event.clientY,
    button: event.button,
  });
});

renderer.domElement.addEventListener('click', event => {
  console.warn('[CLICK TEST] click', {
    x: event.clientX,
    y: event.clientY,
    mapMode: controls.mapMode,
    housesVisible: housesRuntimeVisible,
  });
  enqueueClientLog('info', 'click.test', {
    x: event.clientX,
    y: event.clientY,
    mapMode: controls.mapMode,
    shadowMode: HOUSE_SHADOW_MODE,
    housesVisible: housesRuntimeVisible,
  });
  flushClientLogQueue();
  try {
    probeHouseShadowIntersections(event);
  } catch (err) {
    console.error('[CLICK TEST] probe exception', err);
    bootLog('house.shadow.click_probe.error', {
      message: err?.message ?? String(err),
      stack: err?.stack ?? null
    }, 'error');
  }
  if (!controls.mapMode) {
    return;
  }
  const targets = collectDebugMeshes(terrainRoot);
  if (targets.length === 0) {
    return;
  }
  mouseNDC.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouseNDC.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouseNDC, mapCam);
  const hits = raycaster.intersectObjects(targets);
  if (hits.length === 0) {
    return;
  }
  // Show context menu for the top-most hit
  const topInfo = meshDebugSummary(hits[0].object);
  const topSrc = texSource.get(topInfo.tileId) || '';
  showTileMenu(event.clientX, event.clientY, topInfo.tileId, topSrc);

  hits.forEach((hit, index) => {
    const info = meshDebugSummary(hit.object);
    const vertexColors = !!hit.object.material?.vertexColors;
    const polygonOffset = !!hit.object.material?.polygonOffset;
    const polygonOffsetFactor = hit.object.material?.polygonOffsetFactor ?? null;
    fetch('/api/tile_inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tileId: info.tileId,
        tex: info.hasTexture,
        texDim: info.textureSize,
        color: info.color,
        vc: vertexColors,
        po: polygonOffset,
        poFactor: polygonOffsetFactor,
        bbox: info.bbox ?? null
      })
    }).catch(() => {});
  });
});

renderer.domElement.addEventListener('mousemove', event => {
  if (!controls.mapMode || controls.dragging) {
    hideTileInfo();
    return;
  }
  const targets = collectDebugMeshes(terrainRoot);
  if (targets.length === 0) {
    hideTileInfo();
    return;
  }
  mouseNDC.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouseNDC.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouseNDC, mapCam);
  const hits = raycaster.intersectObjects(targets);
  if (hits.length === 0) {
    hideTileInfo();
    return;
  }

  const mesh = hits[0].object;
  showTileBorder(mesh);
  const info = meshDebugSummary(mesh);
  const overlapLines = hits.slice(0, 12)
    .filter(hit => hit.object.userData?.tileId)
    .map(hit => {
      const row = meshDebugSummary(hit.object);
      const rsrc = texSource.get(row.tileId) || '';
      return `${row.tileId} ${rsrc || (row.hasTexture ? 'tex' : 'noTex')}`;
    });

  const src = texSource.get(info.tileId) || 'none';
  const isEnhanced = src.includes('enhanced');
  const srcLabel = isEnhanced
    ? `<span style="color:#0f0;font-weight:bold">ENHANCED</span>`
    : `<span style="color:#f80">${src || 'no texture'}</span>`;
  const matHex = info.color !== '-' ? info.color : '#ffffff';
  const seamLabel = getSeamStatus(info.tileId);
  tileInfoEl.innerHTML = [
    `<b style="color:${matHex}">${info.tileId}</b>`,
    `tex: ${info.hasTexture ? 'YES' : 'NO'} ${info.textureSize}  source: ${srcLabel}`,
    seamLabel ? `seam: ${seamLabel}` : null,
    `<b>overlaps (${hits.length}):</b>`,
    overlapLines.join('<br>')
  ].filter(Boolean).join('<br>');
  tileInfoEl.style.display = 'block';
});

renderer.domElement.addEventListener('contextmenu', event => {
  if (!controls.mapMode) return;
  event.preventDefault();
  const targets = collectDebugMeshes(terrainRoot);
  if (targets.length === 0) return;
  mouseNDC.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouseNDC.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouseNDC, mapCam);
  const hits = raycaster.intersectObjects(targets);
  if (hits.length === 0) return;
  const info = meshDebugSummary(hits[0].object);
  const src = texSource.get(info.tileId) || '';
  showTileMenu(event.clientX, event.clientY, info.tileId, src);
});

renderer.domElement.addEventListener(
  'wheel',
  event => {
    event.preventDefault();
    const zoomIn = event.deltaY < 0;
    if (controls.mapMode) {
      controls.mapZoom *= zoomIn ? 0.85 : 1.18;
      controls.mapZoom = Math.max(500, Math.min(40000, controls.mapZoom));
      savePosition();
      updateMapCamera();
    } else {
      camera.fov *= zoomIn ? 0.95 : 1.05;
      camera.fov = Math.max(20, Math.min(100, camera.fov));
      camera.updateProjectionMatrix();
    }
  },
  { passive: false }
);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  updateMapCamera();
});

applyCameraOrientation();
camera.updateProjectionMatrix();
camera.updateMatrixWorld(true);
updateMapCamera();
updateHud();

const clock = new THREE.Clock();
let lastTexRefresh = 0;
function render() {
  const dt = Math.min(0.05, clock.getDelta());
  const nowMs = performance.now();
  updateMovement(dt);
  applyCameraOrientation();
  updateHud();

  // Update fog density from slider
  const fogStrength = controls._fogStrength ?? 4.5;
  _sceneFog.density = fogStrength / getFogDistance();

  // Animate water
  waterMat.uniforms.time.value = clock.elapsedTime * 0.4;
  waterMat.uniforms.sunDirection.value.copy(sunDirection);
  // Hide water in map mode so it doesn't cover terrain overview
  waterMesh.visible = !controls.mapMode;

  // Terrain streaming: check if camera moved far enough to re-fetch
  if (!isFirstLoad) {
    const camLL = getCameraLatLon();
    const approxStereoX = originX + (camLL.lon - centerLon) * 111320 * Math.cos(centerLat * Math.PI / 180);
    const approxStereoY = originY + (camLL.lat - centerLat) * 111320;
    camStereoX = approxStereoX;
    camStereoY = approxStereoY;
    const fdx = camStereoX - lastFetchX;
    const fdy = camStereoY - lastFetchY;
    const fetchDist = Math.sqrt(fdx * fdx + fdy * fdy);
    if (fetchDist > REFETCH_DIST && nowMs - _lastFetchTriggerMs > 500) {
      _lastFetchTriggerMs = nowMs;
      fetchTiles();
    }
  }
  // Periodic texture refresh (~1 Hz)
  if (lastTiles && clock.elapsedTime - lastTexRefresh > 1.0) {
    lastTexRefresh = clock.elapsedTime;
    updateTextures(lastTiles);
    updateEnhancement();
  }
  if (housesRuntimeVisible) {
    houseLayer.visible = true;
    updateHouseHotReload(nowMs);
    snapPendingHouses();
    if (HOUSE_USE_SHADOW_MAP) {
      syncHouseShadowReceivers();
      updateHouseShadowSystem();
      renderer.shadowMap.autoUpdate = true;
      if (
        !shadowMapReadyLogged &&
        houseShadowCasterLight.visible &&
        houseShadowCasterLight.shadow.map != null
      ) {
        shadowMapReadyLogged = true;
        bootLog('house.shadow.map.ready', {
          width: houseShadowCasterLight.shadow.map.width,
          height: houseShadowCasterLight.shadow.map.height,
          receiverCount: houseShadowReceivers.size
        });
      }
    } else {
      updateHouseLocalShadows();
      houseShadowReceiverLayer.visible = false;
      houseShadowCasterLight.visible = false;
    }
    maybeLogHouseShadowSnapshot(nowMs);
  } else {
    houseLayer.visible = false;
    houseMarkerLayer.visible = false;
    houseShadowReceiverLayer.visible = false;
    houseShadowCasterLight.visible = false;
  }
  houseMarkerLayer.visible = controls.mapMode && housesRuntimeVisible;
  enhanceOutlines.visible = controls.mapMode;
  enhancedOutlines.visible = controls.mapMode;
  if (controls.mapMode) {
    pollSeamStatus();
    updateEnhanceOutlines();
    updateEnhancedOutlines();
    updateMapCamera();
    markerCameraRel.copy(camera.position).sub(anchorPosition);
    camMarker.position.set(
      markerCameraRel.dot(east),
      markerCameraRel.dot(north),
      5000
    );
    markerHeadingLocal.set(
      movementForward.dot(east),
      movementForward.dot(north),
      0
    );
    if (markerHeadingLocal.lengthSq() < 1e-9) {
      markerHeadingLocal.set(0, 1, 0);
    } else {
      markerHeadingLocal.normalize();
    }
    camMarker.quaternion.setFromUnitVectors(markerForwardLocal, markerHeadingLocal);
    const markerScale = controls.mapZoom / DEFAULT_MAP_ZOOM;
    camMarker.scale.setScalar(markerScale);
    for (const house of houseInstances) {
      house.marker.scale.setScalar(markerScale);
    }
    scene.fog = null;
    scene.background = _mapBg;
    renderer.render(scene, mapCam);
    scene.background = null;
    scene.fog = _sceneFog;
    return;
  }
  composer.render();
}

renderer.setAnimationLoop(render);
