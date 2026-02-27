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
const DEFAULT_ASSET_SERVER_BASE = 'http://127.0.0.1:8787';
const ASSET_SERVER_BASE = (() => {
  const raw = params.get('assetServer');
  const text = typeof raw === 'string' ? raw.trim() : '';
  const base = text || DEFAULT_ASSET_SERVER_BASE;
  return base.replace(/\/+$/, '');
})();
const VEHICLE_STATE_ENDPOINT = `${ASSET_SERVER_BASE}/api/vehicle_state`;
const ASSETS_ENDPOINT = `${ASSET_SERVER_BASE}/api/assets`;
const ASSETS_FETCH_TIMEOUT_MS = 1500;
const VEHICLE_SAVE_FETCH_TIMEOUT_MS = 1500;
const VEHICLE_SAVE_FAILURE_COOLDOWN_MS = 15000;
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
// Force immediate flush so we know the log pipeline is alive.
flushClientLogQueue();

// Use summer daytime in Nuuk so textured ground is clearly visible.
const referenceDate = new Date('2025-07-01T12:00:00Z');
const GAME_HOURS_PER_REAL_HOUR = 24;
const GAME_TIME_SCALE = GAME_HOURS_PER_REAL_HOUR;
const GAME_CLOCK_STORAGE_KEY = 'game-clock-ms';
const _savedGameClockMs = Number(localStorage.getItem(GAME_CLOCK_STORAGE_KEY));
let gameClockStartMs = _savedGameClockMs || referenceDate.getTime();
let browserTimeStartMs = Date.now();
const currentDate = new Date(gameClockStartMs);
let _lastGameClockSave = 0;

const DEFAULT_LOCATION = {
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

const anchorLon = Number(params.get('lon') ?? DEFAULT_LOCATION.lon);
const anchorLat = Number(params.get('lat') ?? DEFAULT_LOCATION.lat);

function defaultStartupAssets() {
  return {
    vehicle_definition: {},
    structure_definition: {},
    vehicle_instances: [],
    structure_instances: [],
  };
}

function normalizeStartupAssetsPayload(payload) {
  const fallback = defaultStartupAssets();
  if (payload == null || typeof payload !== 'object') {
    return fallback;
  }

  const rawVehicleDef = payload.vehicle_definition;
  if (rawVehicleDef != null && typeof rawVehicleDef === 'object') {
    fallback.vehicle_definition = { ...rawVehicleDef };
  }

  const rawStructureDef = payload.structure_definition;
  if (rawStructureDef != null && typeof rawStructureDef === 'object') {
    fallback.structure_definition = { ...rawStructureDef };
  }

  if (Array.isArray(payload.vehicle_instances)) {
    fallback.vehicle_instances = payload.vehicle_instances
      .filter(v => v != null && typeof v === 'object')
      .map(v => ({ ...v }));
  }

  if (Array.isArray(payload.structure_instances)) {
    fallback.structure_instances = payload.structure_instances
      .filter(s => s != null && typeof s === 'object')
      .map(s => ({ ...s }));
  }

  return fallback;
}

async function loadStartupAssets() {
  const fallback = {
    source: 'defaults',
    schemaVersion: 4,
    seeded: null,
    ...defaultStartupAssets(),
  };
  try {
    const controller = typeof AbortController !== 'undefined'
      ? new AbortController()
      : null;
    const timeoutHandle = controller != null
      ? window.setTimeout(() => controller.abort(), ASSETS_FETCH_TIMEOUT_MS)
      : null;
    const response = await fetch(ASSETS_ENDPOINT, {
      cache: 'no-store',
      signal: controller?.signal,
    }).finally(() => {
      if (timeoutHandle != null) {
        window.clearTimeout(timeoutHandle);
      }
    });
    if (!response.ok) {
      throw new Error(`assets endpoint status ${response.status}`);
    }
    const payload = await response.json();
    const normalized = normalizeStartupAssetsPayload(payload);
    const source = typeof payload?.source === 'string' ? payload.source : 'metadata';
    const schemaVersion = Number.isFinite(payload?.schemaVersion) ? payload.schemaVersion : 4;
    bootLog('assets.fetch.ok', {
      endpoint: ASSETS_ENDPOINT,
      status: response.status,
      source,
      schemaVersion,
      structureCount: normalized.structure_instances.length,
      vehicleCount: normalized.vehicle_instances.length,
    });
    return {
      source,
      schemaVersion,
      seeded: payload?.seeded ?? null,
      ...normalized,
    };
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    bootLog('assets.fetch.fallback', {
      endpoint: ASSETS_ENDPOINT,
      timeoutMs: ASSETS_FETCH_TIMEOUT_MS,
      timedOut,
      error: error?.message ?? String(error),
    }, 'warn');
    console.warn('[ASSETS] startup fallback', {
      endpoint: ASSETS_ENDPOINT,
      timeoutMs: ASSETS_FETCH_TIMEOUT_MS,
      timedOut,
      error: error?.message ?? String(error),
    });
    return fallback;
  }
}

const startupAssetsResponse = await loadStartupAssets();
const VEHICLE_DEFINITION = startupAssetsResponse.vehicle_definition;
const STRUCTURE_DEFINITION = startupAssetsResponse.structure_definition;
const VEHICLE_HEADLIGHTS = (
  VEHICLE_DEFINITION.headlights != null &&
  typeof VEHICLE_DEFINITION.headlights === 'object'
)
  ? VEHICLE_DEFINITION.headlights
  : null;

const scene = new THREE.Scene();
// Black fog — aerial perspective inscatter fills in the natural sky color at distance.
scene.fog = new THREE.FogExp2(0x000000, 0.00009);
const _sceneFog = scene.fog;
const _mapBg = new THREE.Color(0x222222);

// Geospatial scenes use a local ENU frame anchored at the target geodetic point.
const anchorGeodetic = new Geodetic(radians(anchorLon), radians(anchorLat), 0);
const anchorPosition = anchorGeodetic.toECEF();
const east = new THREE.Vector3();
const north = new THREE.Vector3();
const up = new THREE.Vector3();
Ellipsoid.WGS84.getEastNorthUpVectors(anchorPosition, east, north, up);

// --- View distance constants ---
const MAX_VIEW_DIST = 50000;       // 50km — camera far, fog, map extents
let _terrainRange = 20000;         // terrain tile fetch range (meters), slider-controlled
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
const BASE_ACCEL = 1200;
const BASE_BRAKE = 800;
const BASE_MAX_SPEED = 5000;
const BASE_STRAFE_SPEED = 800;
const TURN_SPEED = 1.5;
const MIN_FLIGHT_ALT = paramNumber('minFlightAlt', 2);
// AGL-based speed scaling: full speed at AGL_FULL_SPEED_M, minimum factor at ground level
const AGL_FULL_SPEED_M = 500;
const AGL_MIN_FACTOR = 0.05;
let cameraAGL = AGL_FULL_SPEED_M; // assume high until first raycast
const aglRaycaster = new THREE.Raycaster();
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
hud.addEventListener('mousedown', e => {
  if (e.target.id === 'debugLogLink') {
    e.stopPropagation();
    e.preventDefault();
    console.log('[HUD] debug log link clicked');
    window.open('/client_log.html', '_blank');
  }
});
hud.addEventListener('click', e => {
  if (e.target.id === 'debugLogLink') {
    e.stopPropagation();
    e.preventDefault();
  }
});

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

const gameClockEl = document.createElement('div');
gameClockEl.style.cssText = [
  'position:absolute',
  'left:12px',
  'bottom:12px',
  'padding:8px 10px',
  'background:rgba(0,0,0,0.7)',
  'color:#5af',
  'font:13px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
  'border-radius:6px',
  'pointer-events:auto',
  'z-index:5',
  'user-select:none'
].join(';');
document.body.appendChild(gameClockEl);

// Transport control handlers for game clock HUD
function _gcRewind() {
  if (useRealtimeGameClock) {
    currentDate.setTime(getGameDateFromBrowserTime().getTime());
  }
  useRealtimeGameClock = false;
  currentDate.setTime(currentDate.getTime() - 15 * 60 * 1000);
  applyDate(currentDate);
}
function _gcStop() {
  if (useRealtimeGameClock) {
    currentDate.setTime(getGameDateFromBrowserTime().getTime());
  }
  useRealtimeGameClock = false;
}
function _gcPlay() {
  if (!useRealtimeGameClock) {
    gameClockStartMs = currentDate.getTime();
    browserTimeStartMs = Date.now();
    useRealtimeGameClock = true;
  }
}
function _gcFfwd() {
  if (useRealtimeGameClock) {
    currentDate.setTime(getGameDateFromBrowserTime().getTime());
  }
  useRealtimeGameClock = false;
  currentDate.setTime(currentDate.getTime() + 15 * 60 * 1000);
  applyDate(currentDate);
}
gameClockEl.addEventListener('mousedown', e => {
  const btn = e.target.closest('button[data-gc]');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const action = btn.dataset.gc;
  if (action === 'rw') _gcRewind();
  else if (action === 'stop') _gcStop();
  else if (action === 'play') _gcPlay();
  else if (action === 'ff') _gcFfwd();
});

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

  if (controls.mapMode) {
    const oceanToggleBtn = document.createElement('div');
    oceanToggleBtn.style.cssText = 'padding:6px 12px;cursor:pointer';
    oceanToggleBtn.textContent = `Ocean Overlay: ${oceanMapDebugEnabled ? 'ON' : 'OFF'}`;
    oceanToggleBtn.addEventListener('mouseenter', () => oceanToggleBtn.style.background = 'rgba(255,255,255,0.15)');
    oceanToggleBtn.addEventListener('mouseleave', () => oceanToggleBtn.style.background = 'none');
    oceanToggleBtn.addEventListener('click', () => {
      oceanMapDebugEnabled = !oceanMapDebugEnabled;
      hideTileMenu();
      if (lastTiles) {
        updateTextures(lastTiles);
      }
    });
    tileMenuEl.appendChild(oceanToggleBtn);
  }

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
const hasSavedMonth = Object.prototype.hasOwnProperty.call(_tuningState, 'month');
const hasSavedHour = Object.prototype.hasOwnProperty.call(_tuningState, 'hour (UTC)');
let useRealtimeGameClock = !(hasSavedMonth || hasSavedHour);

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
function tuningSliderSetValue(label, v) {
  const def = _tuningDefs.find(d => d.label === label && d.type === 'slider');
  if (!def) return;
  def.inp.value = v;
  if (def.valSpan) def.valSpan.textContent = def.fmt(v);
}
// ── Google Maps Panel (toggle with G) ─────────────────────────────────────────
let gmapsPanelOpen = false;
let gmapsPanelMinimized = false;
let _gmapsLastLat = null;
let _gmapsLastLon = null;
const GMAPS_UPDATE_INTERVAL = 1500; // ms between iframe updates while moving
let _gmapsLastUpdate = 0;
let _gmapsActiveTab = 0;

const gmapsPanel = document.createElement('div');
gmapsPanel.style.cssText = [
  'position:absolute',
  'bottom:50px',
  'left:12px',
  'width:420px',
  'background:rgba(10,16,24,0.95)',
  'border:1px solid #2a3a4a',
  'border-radius:8px',
  'overflow:hidden',
  'resize:both',
  'min-width:300px',
  'min-height:200px',
  'z-index:20',
  'display:none',
  'flex-direction:column',
  'height:460px',
  'font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
  'color:#dbe5f1',
  'box-shadow:0 4px 24px rgba(0,0,0,0.7)'
].join(';');

// Make panel draggable via header
(function makeDraggable(panel) {
  let dragging = false, ox = 0, oy = 0;
  panel.querySelector && panel.addEventListener('mousedown', e => {
    if (e.target.closest('#gmap-drag-handle')) {
      dragging = true;
      const r = panel.getBoundingClientRect();
      ox = e.clientX - r.left;
      oy = e.clientY - r.top;
      e.preventDefault();
    }
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    panel.style.left = (e.clientX - ox) + 'px';
    panel.style.top  = (e.clientY - oy) + 'px';
    panel.style.bottom = 'auto';
    panel.style.right  = 'auto';
  });
  document.addEventListener('mouseup', () => { dragging = false; });
})(gmapsPanel);

// Header (draggable handle)
const gmapsHeader = document.createElement('div');
gmapsHeader.id = 'gmap-drag-handle';
gmapsHeader.style.cssText = 'display:flex;align-items:center;gap:6px;padding:7px 10px;background:rgba(255,255,255,0.06);cursor:grab;user-select:none';
gmapsHeader.innerHTML = `
  <span style="flex:1;font-weight:bold;color:#5af">&#x1F5FA; Maps  <span style="font-size:10px;color:#6889a8;font-weight:normal">(drag to move)</span></span>
  <button id="gmap-min" title="Minimize" style="background:none;border:none;color:#8aa;cursor:pointer;font-size:14px;padding:0 4px">&#x2212;</button>
  <button id="gmap-close" title="Close (G)" style="background:none;border:none;color:#8aa;cursor:pointer;font-size:14px;padding:0 4px">&#x2715;</button>
`;
gmapsPanel.appendChild(gmapsHeader);

// Nav input row
const gmapsNavRow = document.createElement('div');
gmapsNavRow.id = 'gmap-nav-row';
gmapsNavRow.style.cssText = 'display:flex;gap:6px;padding:7px 10px;border-bottom:1px solid #1e2d3a';
gmapsNavRow.innerHTML = `
  <input id="gmap-input" type="text" placeholder="Paste lat, lon  e.g. 64.18, -51.70"
    style="flex:1;background:rgba(255,255,255,0.07);border:1px solid #2a3a4a;border-radius:4px;
           color:#dbe5f1;padding:4px 8px;font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;outline:none" />
  <button id="gmap-go"
    style="background:#1a3a5a;border:1px solid #2a5a8a;border-radius:4px;color:#5af;
           padding:4px 12px;cursor:pointer;font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">Go</button>
`;
gmapsPanel.appendChild(gmapsNavRow);

// Tab bar
const gmapsTabBar = document.createElement('div');
gmapsTabBar.id = 'gmap-tab-row';
gmapsTabBar.style.cssText = 'display:flex;border-bottom:1px solid #1e2d3a;user-select:none';
['Satellite', 'Map', 'Navigate'].forEach((label, i) => {
  const tab = document.createElement('div');
  tab.dataset.gmtab = String(i);
  tab.textContent = label;
  tab.style.cssText = `flex:1;text-align:center;padding:5px 0;cursor:pointer;font-size:11px;color:${i === 0 ? '#5af' : '#6889a8'};border-bottom:${i === 0 ? '2px solid #5af' : '2px solid transparent'}`;
  tab.addEventListener('click', () => {
    document.querySelectorAll('[data-gmtab]').forEach(t => {
      t.style.color = '#6889a8'; t.style.borderBottom = '2px solid transparent';
    });
    tab.style.color = '#5af'; tab.style.borderBottom = '2px solid #5af';
    _gmapsActiveTab = i;
    _gmapsLastLat = null; // force refresh
    _gmapsForceUpdate();
  });
  gmapsTabBar.appendChild(tab);
});
gmapsPanel.appendChild(gmapsTabBar);

// iframe container — fills remaining panel height
const gmapsIframeWrap = document.createElement('div');
gmapsIframeWrap.style.cssText = 'flex:1;min-height:0';
const gmapsIframe = document.createElement('iframe');
gmapsIframe.style.cssText = 'width:100%;height:100%;border:none;display:block';
gmapsIframe.setAttribute('loading', 'eager');
gmapsIframeWrap.appendChild(gmapsIframe);
gmapsPanel.appendChild(gmapsIframeWrap);

// Disable iframe pointer-events during resize so the drag handle works
new ResizeObserver(() => {
  gmapsIframe.style.pointerEvents = 'none';
  clearTimeout(gmapsPanel._resizeTimer);
  gmapsPanel._resizeTimer = setTimeout(() => { gmapsIframe.style.pointerEvents = ''; }, 150);
}).observe(gmapsPanel);

document.body.appendChild(gmapsPanel);

function _gmapsBuildUrl(lat, lon) {
  if (_gmapsActiveTab === 0) {
    return `https://maps.google.com/maps?q=${lat},${lon}&t=k&z=16&output=embed`;
  } else if (_gmapsActiveTab === 1) {
    return `https://maps.google.com/maps?q=${lat},${lon}&t=m&z=16&output=embed`;
  } else {
    return `/mapview.html?lat=${lat}&lon=${lon}&t=k`;
  }
}

function _gmapsForceUpdate() {
  const camLL = getCameraLatLon();
  const lat = camLL.lat.toFixed(6);
  const lon = camLL.lon.toFixed(6);
  gmapsIframe.src = _gmapsBuildUrl(lat, lon);
  _gmapsLastLat = lat;
  _gmapsLastLon = lon;
  _gmapsLastUpdate = performance.now();
}

function _gmapsNavigateTo(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  const dLat = lat - anchorLat;
  const dLon = lon - anchorLon;
  const eM = dLon * 111320 * Math.cos(anchorLat * Math.PI / 180);
  const nM = dLat * 111320;
  const alt = getCameraLatLon().alt;
  camera.position.copy(anchorPosition)
    .addScaledVector(east, eM)
    .addScaledVector(north, nM)
    .addScaledVector(up, Math.max(50, alt));
  applyCameraOrientation();
  fetchTiles(lat, lon);
  _gmapsLastLat = null;
  _gmapsLastUpdate = 0; // force immediate re-center on next render cycle
}

function toggleGmapsPanel(forceState) {
  gmapsPanelOpen = forceState !== undefined ? forceState : !gmapsPanelOpen;
  gmapsPanel.style.display = gmapsPanelOpen ? 'flex' : 'none';
  if (gmapsPanelOpen) {
    // Always force-reload when opening so tiles request after container is visible
    _gmapsLastLat = null;
    _gmapsForceUpdate();
  }
}

// Wire up header buttons
document.getElementById('gmap-min').addEventListener('click', e => {
  e.stopPropagation();
  gmapsPanelMinimized = !gmapsPanelMinimized;
  gmapsNavRow.style.display = gmapsPanelMinimized ? 'none' : '';
  gmapsTabBar.style.display = gmapsPanelMinimized ? 'none' : '';
  gmapsIframeWrap.style.display = gmapsPanelMinimized ? 'none' : '';
  document.getElementById('gmap-min').innerHTML = gmapsPanelMinimized ? '&#x25A1;' : '&#x2212;';
});
document.getElementById('gmap-close').addEventListener('click', e => {
  e.stopPropagation();
  toggleGmapsPanel(false);
});

// Wire up Go button + Enter key
document.getElementById('gmap-go').addEventListener('click', () => {
  const val = document.getElementById('gmap-input').value.trim();
  // Match each coordinate token: optional minus, digits, optional decimal, optional N/S/E/W
  const tokens = [...val.matchAll(/([-]?\d+(?:\.\d+)?)\s*°?\s*([NSEWnsew])?/g)];
  if (tokens.length >= 2) {
    let lat = parseFloat(tokens[0][1]);
    let lon = parseFloat(tokens[1][1]);
    const latDir = (tokens[0][2] || '').toUpperCase();
    const lonDir = (tokens[1][2] || '').toUpperCase();
    if (latDir === 'S') lat = -Math.abs(lat);
    if (lonDir === 'W') lon = -Math.abs(lon);
    _gmapsNavigateTo(lat, lon);
  }
});
document.getElementById('gmap-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('gmap-go').click();
  e.stopPropagation(); // prevent WASD etc from firing while typing
});

// Navigate tab: receive click coords and ready signal from mapview.html iframe
window.addEventListener('message', e => {
  if (e.data && e.data.ready) {
    // Leaflet just finished loading — push current camera position immediately
    if (_gmapsActiveTab === 2 && gmapsPanelOpen) {
      const camLL = getCameraLatLon();
      gmapsIframe.contentWindow?.postMessage({ lat: camLL.lat, lon: camLL.lon }, '*');
      _gmapsLastLat = camLL.lat.toFixed(4);
      _gmapsLastLon = camLL.lon.toFixed(4);
      _gmapsLastUpdate = performance.now();
    }
    return;
  }
  if (e.data && e.data.nav && e.data.lat != null) {
    _gmapsNavigateTo(e.data.lat, e.data.lon);
  }
});
// ── end Google Maps Panel ───────────────────────────────────────────────────────

function tuningSectionLabel(text) {
  const d = document.createElement('div');
  d.style.cssText = 'margin:10px 0 4px;font-size:10px;text-transform:uppercase;color:#6889a8;letter-spacing:1px;border-bottom:1px solid #334;padding-bottom:3px';
  d.textContent = text;
  tuningBody.appendChild(d);
}

// We'll call this after aerialPerspective + cloudsEffect are created.
function buildTuningControls(ap, ce) {
  tuningSectionLabel('Date / Time');
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  tuningSlider('month', {
    min: 1, max: 12, step: 1, value: referenceDate.getUTCMonth() + 1,
    decimals: 0,
    format: v => monthNames[v - 1],
    onChange: v => {
      useRealtimeGameClock = false;
      currentDate.setUTCMonth(v - 1);
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
  tuningSectionLabel('Terrain');
  tuningSlider('terrain range', {
    min: 10000, max: 50000, step: 1000, value: _terrainRange,
    decimals: 0,
    format: v => `${(v/1000).toFixed(0)}km`,
    onChange: v => { _terrainRange = v; fetchTiles(); }
  });
  tuningSectionLabel('Atmosphere');
  tuningSlider('fog strength', {
    min: 1, max: 10, step: 0.5, value: 4.5,
    decimals: 1,
    onChange: v => { controls._fogStrength = v; }
  });
  tuningSlider('cloud distance', {
    min: 5000, max: 200000, step: 5000, value: ce.clouds.maxRayDistance,
    decimals: 0,
    format: v => `${(v/1000).toFixed(0)}km`,
    onChange: v => { ce.clouds.maxRayDistance = v; }
  });
  tuningSlider('turbulence', {
    min: 0, max: 2000, step: 50, value: ce.turbulenceDisplacement,
    decimals: 0,
    onChange: v => { ce.turbulenceDisplacement = v; }
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
// Ocean terrain is shaped below sea level, so water floats above the seabed.
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
      vLocalPos = position.xy * 0.002;
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
      vec3 sunDir = normalize(sunDirection);
      // Fresnel — more reflective at grazing angles
      float fresnel = 0.04 + 0.96 * pow(1.0 - max(dot(toEye, surfNormal), 0.0), 4.0);
      // Diffuse ripple shading — waves facing the sun lighten, facing away darken
      float diffuse = max(dot(surfNormal, sunDir), 0.0);
      vec3 rippleColor = waterColor * (0.6 + 0.4 * diffuse);
      // Sun specular
      vec3 refl = reflect(-sunDir, surfNormal);
      float spec = pow(max(dot(toEye, refl), 0.0), 80.0) * 2.0;
      // Blend ripple shading + specular highlight
      vec3 col = rippleColor + sunColor * spec * 0.6;
      float alpha = clamp(fresnel * 0.35 + spec * 0.7 + 0.12, 0.0, 0.55);
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
let tileFrameOffsetX = 0;            // shift server stereo-local bboxes into camera ENU-local frame
let tileFrameOffsetY = 0;
let tileFrameOffsetReady = false;
let _lastFetchTriggerMs = 0;
let fetching = false;
let isFirstLoad = true;
let _loadPass = 1;  // 1 = preview (low-LOD), 2 = full-depth
let bootFetchLogged = false;
let currentTileIds = new Set();
let lastTiles = null;
let _hmMissing = 0;   // heightmaps the server hasn't started
let _hmDownloading = 0; // heightmaps the server is fetching
let _srvTexFetching = 0;   // server-side: textures being fetched from dataforsyningen
let _srvTexRetry = 0;      // server-side: textures in retry queue (rate-limited)
let _srvTexStatus = {};    // server-side: {ready, ancestor_fallback, fetching, missing}

function paramNumber(name, fallback) {
  const raw = params.get(name);
  if (raw == null) return fallback;
  const text = raw.trim();
  if (text === '') return fallback;
  const value = Number(text);
  return Number.isFinite(value) ? value : fallback;
}

const ASSET_STRUCTURE_INSTANCES = Array.isArray(startupAssetsResponse.structure_instances)
  ? startupAssetsResponse.structure_instances
  : [];
const ASSET_VEHICLE_INSTANCES = Array.isArray(startupAssetsResponse.vehicle_instances)
  ? startupAssetsResponse.vehicle_instances
  : [];
const houseEnabledParam = params.get('house');
const HOUSE_MODEL = {
  url: (typeof STRUCTURE_DEFINITION.url === 'string' && STRUCTURE_DEFINITION.url.trim() !== '')
    ? STRUCTURE_DEFINITION.url
    : '',
  altOffsetM: paramNumber(
    'houseAltOffset',
    Number.isFinite(STRUCTURE_DEFINITION.altOffsetM) ? STRUCTURE_DEFINITION.altOffsetM : 0.4
  ),
  hotReloadMs: Math.max(
    500,
    paramNumber(
      'houseReloadMs',
      Number.isFinite(STRUCTURE_DEFINITION.hotReloadMs) ? STRUCTURE_DEFINITION.hotReloadMs : 2000
    )
  ),
  enabled: houseEnabledParam == null
    ? Boolean(STRUCTURE_DEFINITION.enabled)
    : houseEnabledParam === '1'
};
if (!HOUSE_MODEL.url) {
  HOUSE_MODEL.enabled = false;
  bootLog('house.config.missing_model_url', {
    source: startupAssetsResponse.source,
  }, 'warn');
}
const HOUSE_SHADOW_MODE_RAW = (params.get('houseShadowMode') || 'shadowmap').toLowerCase();
const HOUSE_SHADOW_MODE = HOUSE_SHADOW_MODE_RAW === 'local' ? 'local' : 'shadowmap';
const HOUSE_USE_LOCAL_SHADOWS = HOUSE_SHADOW_MODE === 'local';
const HOUSE_USE_SHADOW_MAP = HOUSE_SHADOW_MODE === 'shadowmap';
const HOUSE_LOCAL_SHADOW_DEBUG = params.get('houseLocalShadowDebug') !== '0';
const HOUSE_SHADOW_SNAPSHOT_ENABLED = params.get('houseShadowSnapshot') === '1';
const HOUSE_PROBE_CONSOLE = params.get('houseProbeConsole') === '1';
const DEFAULT_NUUK_HOUSE_SITES = ASSET_STRUCTURE_INSTANCES;
const singleHouseLat = paramNumber('houseLat', NaN);
const singleHouseLon = paramNumber('houseLon', NaN);
const houseCountParam = paramNumber('houseCount', DEFAULT_NUUK_HOUSE_SITES.length);
const houseCount = DEFAULT_NUUK_HOUSE_SITES.length === 0
  ? 0
  : Number.isFinite(houseCountParam)
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
const _lastHouseShadowPos = new THREE.Vector3();
const _lastHouseShadowDir = new THREE.Vector3();
let _lastHouseShadowRadius = 0;
const HOUSE_SHADOW_MOVE_THRESHOLD = 0.5; // meters — ignore sub-pixel jitter
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

// ── Patria AMV vehicle ──────────────────────────────────────────────────
const _vehicleSeedInstance = ASSET_VEHICLE_INSTANCES.length > 0 ? ASSET_VEHICLE_INSTANCES[0] : {};
const VEHICLE_MODEL = {
  url: (typeof VEHICLE_DEFINITION.url === 'string' && VEHICLE_DEFINITION.url.trim() !== '')
    ? VEHICLE_DEFINITION.url
    : '/models/patria_amv.glb',
  lat: Number.isFinite(_vehicleSeedInstance.lat) ? _vehicleSeedInstance.lat : anchorLat,
  lon: Number.isFinite(_vehicleSeedInstance.lon) ? _vehicleSeedInstance.lon : anchorLon,
  headingDeg: Number.isFinite(_vehicleSeedInstance.headingDeg) ? _vehicleSeedInstance.headingDeg : 0,
  z: Number.isFinite(_vehicleSeedInstance.z) ? _vehicleSeedInstance.z : 0,
  realLengthM: Number.isFinite(VEHICLE_DEFINITION.realLengthM) ? VEHICLE_DEFINITION.realLengthM : 7.7,
  tireDiameterM: paramNumber(
    'vehicleTireDiameterM',
    Number.isFinite(VEHICLE_DEFINITION.tireDiameterM)
      ? VEHICLE_DEFINITION.tireDiameterM
      : 1.27
  ),
  altOffsetM: Number.isFinite(VEHICLE_DEFINITION.altOffsetM) ? VEHICLE_DEFINITION.altOffsetM : 0.05,
};
bootLog('assets.loaded', {
  source: startupAssetsResponse.source,
  schemaVersion: startupAssetsResponse.schemaVersion,
  seeded: startupAssetsResponse.seeded,
  headlightsOn: _vehicleSeedInstance.headlightsOn === true,
  headlightsParams: VEHICLE_HEADLIGHTS != null,
  structureCount: ASSET_STRUCTURE_INSTANCES.length,
  vehicleCount: ASSET_VEHICLE_INSTANCES.length,
});
const VEHICLE_TIRE_RADIUS_M = Math.max(
  0,
  paramNumber('vehicleTireRadiusM', VEHICLE_MODEL.tireDiameterM * 0.5)
);
const VEHICLE_TERRAIN_LIFT_M = VEHICLE_MODEL.altOffsetM + VEHICLE_TIRE_RADIUS_M;
const vehicleGroup = new THREE.Group();
vehicleGroup.name = 'patria-amv';
terrainRoot.add(vehicleGroup);
const vehicleMarkerLayer = new THREE.Group();
vehicleMarkerLayer.name = 'vehicle-markers';
vehicleMarkerLayer.visible = false;
vehicleMarkerLayer.renderOrder = 1002;
terrainRoot.add(vehicleMarkerLayer);
const VEHICLE_MARKER_MAP_SCALE = THREE.MathUtils.clamp(
  paramNumber('vehicleMarkerMapScale', 1.0),
  0.02,
  2
);
const vehicleMarkerColor = 0xff2d55;
const vehicleMarker = (function createVehicleMarker() {
  const marker = new THREE.Group();
  marker.name = 'vehicle-marker-amv';
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, HOUSE_MARKER_HEIGHT),
    ]),
    new THREE.LineBasicMaterial({
      color: vehicleMarkerColor,
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
      color: vehicleMarkerColor,
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
      color: vehicleMarkerColor,
      depthTest: false,
      depthWrite: false,
    })
  );
  dot.position.z = HOUSE_MARKER_HEIGHT;
  dot.renderOrder = 1004;
  const label = createHouseLabelSprite('AMV', vehicleMarkerColor);
  label.position.set(0, 0, HOUSE_MARKER_HEIGHT + 900);
  label.renderOrder = 1005;
  marker.add(line, halo, dot, label);
  return marker;
})();
vehicleMarkerLayer.add(vehicleMarker);
// Vehicle lighting — directional + ambient, synced to Takram sunDirection
const vehicleSunLight = new THREE.DirectionalLight(0xffffff, 3.0);
vehicleSunLight.name = 'vehicle-sun-light';
vehicleSunLight.castShadow = false;
vehicleGroup.add(vehicleSunLight);
vehicleGroup.add(vehicleSunLight.target);
const vehicleAmbientLight = new THREE.AmbientLight(0x8090b0, 1.0);
vehicleGroup.add(vehicleAmbientLight);
const VEHICLE_SHADOW_MAP_SIZE = 1024;
const VEHICLE_SHADOW_LIGHT_DISTANCE = 250;
const VEHICLE_SHADOW_MIN_RADIUS = 60;
const VEHICLE_SHADOW_MAX_RADIUS = 180;
const VEHICLE_SHADOW_TEXEL_SNAP = params.get('vehicleShadowTexelSnap') !== '0';
const VEHICLE_SHADOW_GROUND_ANCHOR = THREE.MathUtils.clamp(
  paramNumber('vehicleShadowGroundAnchor', 1.0),
  0,
  1
);
// Aggressive default so the vehicle shadow is clearly legible on bright ortho textures.
const VEHICLE_SHADOW_OPACITY = THREE.MathUtils.clamp(paramNumber('vehicleShadowOpacity', 0.95), 0, 1);
let vehicleShadowRadius = 100;
const vehicleShadowReceiverMaterial = new THREE.ShadowMaterial({
  color: 0x000000,
  transparent: true,
  opacity: VEHICLE_SHADOW_OPACITY,
  depthTest: true,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -2,
});
vehicleShadowReceiverMaterial.toneMapped = false;
const vehicleShadowReceiverLayer = new THREE.Group();
vehicleShadowReceiverLayer.name = 'vehicle-shadow-receivers';
vehicleShadowReceiverLayer.renderOrder = 25;
vehicleShadowReceiverLayer.visible = false;
terrainRoot.add(vehicleShadowReceiverLayer);
const vehicleShadowReceivers = new Map();
const vehicleShadowCasterLight = new THREE.DirectionalLight(0xffffff, 1.0);
vehicleShadowCasterLight.name = 'vehicle-shadow-light';
vehicleShadowCasterLight.castShadow = true;
vehicleShadowCasterLight.visible = false;
vehicleShadowCasterLight.shadow.mapSize.set(VEHICLE_SHADOW_MAP_SIZE, VEHICLE_SHADOW_MAP_SIZE);
vehicleShadowCasterLight.shadow.bias = -0.00008;
vehicleShadowCasterLight.shadow.normalBias = 0.04;
vehicleShadowCasterLight.shadow.camera.near = 20;
vehicleShadowCasterLight.shadow.camera.far = 700;
terrainRoot.add(vehicleShadowCasterLight);
terrainRoot.add(vehicleShadowCasterLight.target);
const vehicleShadowCenterLocal = new THREE.Vector3();
const vehicleShadowCenterWorld = new THREE.Vector3();
const vehicleShadowCenterLight = new THREE.Vector3();
const vehicleShadowSnappedLight = new THREE.Vector3();
const vehicleShadowSnappedWorld = new THREE.Vector3();
const vehicleShadowSnapOffsetWorld = new THREE.Vector3();
const vehicleShadowSnapOffsetLocal = new THREE.Vector3();
const vehicleLoader = new GLTFLoader();
const vehicleDownRaycaster = new THREE.Raycaster();
const vehicleDownDirection = up.clone().negate().normalize();
const vehicleTargetWorld = new THREE.Vector3();
const vehicleTargetLocal = new THREE.Vector3();
let vehicleSnapPending = true;
let vehicleLoaded = false;
let vehicleControlActive = false;
let vehicleSavedStatePending = null;
let lastVehicleSnapAttemptAt = 0;
let vehicleAwaitingInitialSnap = false;
let vehicleRestoreRequiresDepth = false;
let vehicleRestoreDepthTarget = -1;
let vehicleGroundZTarget = null;
let vehicleVerticalVelocity = 0;
let vehicleHeadingRad = THREE.MathUtils.degToRad(VEHICLE_MODEL.headingDeg);
let vehicleBodyLengthM = VEHICLE_MODEL.realLengthM;
let vehicleBodyWidthM = Math.max(2, VEHICLE_MODEL.realLengthM * 0.35);
let vehicleLastContactDepth = -1;
let vehicleLastContactTileId = null;
const vehicleUpRaycaster = new THREE.Raycaster();
const vehicleUpDirection = up.clone().normalize();
let vehicleMeshes = [];
let vehicleHeadlightSpots = [];
const VEHICLE_DRIVE_SPEED = paramNumber('vehicleDriveSpeed', 24);
const VEHICLE_ACCEL = paramNumber('vehicleAccel', 24);      // m/s² throttle
const VEHICLE_BRAKE = paramNumber('vehicleBrake', 3);       // m/s² engine brake (coast-down)
const VEHICLE_STEER_SPEED = paramNumber('vehicleSteerSpeed', 1.5);
let vehicleSpeed = 0; // current vehicle speed in m/s
let VEHICLE_CAMERA_FOLLOW_DISTANCE = paramNumber('vehicleCamDistance', 38);
let VEHICLE_CAMERA_FOLLOW_HEIGHT = paramNumber('vehicleCamHeight', 12);
const VEHICLE_CAMERA_LOOK_HEIGHT = paramNumber('vehicleCamLookHeight', 2.2);
const VEHICLE_CAMERA_ORBIT_SENS = paramNumber('vehicleCamOrbitSens', MOUSE_SENS);
const VEHICLE_CAMERA_ORBIT_PITCH_MIN = THREE.MathUtils.degToRad(
  paramNumber('vehicleCamPitchMinDeg', -20)
);
const VEHICLE_CAMERA_ORBIT_PITCH_MAX = THREE.MathUtils.degToRad(
  paramNumber('vehicleCamPitchMaxDeg', 70)
);
const VEHICLE_SNAP_IDLE_MS = Math.max(250, paramNumber('vehicleSnapIdleMs', 1000));
const VEHICLE_SNAP_PENDING_MS = Math.max(50, paramNumber('vehicleSnapPendingMs', 120));
const VEHICLE_RESTORE_MIN_DEPTH = Math.max(0, Math.floor(paramNumber('vehicleRestoreMinDepth', 12)));
const VEHICLE_SUSPENSION_HZ = Math.max(0.1, paramNumber('vehicleSuspensionHz', 1.8));
const VEHICLE_SUSPENSION_DAMPING_RATIO = Math.max(0.1, paramNumber('vehicleSuspensionDampingRatio', 0.72));
const VEHICLE_SUSPENSION_MAX_VEL = Math.max(1, paramNumber('vehicleSuspensionMaxVel', 12));
const VEHICLE_REFINEMENT_BOUNCE = THREE.MathUtils.clamp(
  paramNumber('vehicleRefinementBounce', 0.35),
  0,
  2
);
const VEHICLE_RESNAP_MARGIN_M = Math.max(3, paramNumber('vehicleResnapMarginM', 14));
const VEHICLE_ORIENTATION_RESPONSE = Math.max(1, paramNumber('vehicleOrientationResponse', 10));
const VEHICLE_SLOPE_PROBE_LENGTH_SCALE = THREE.MathUtils.clamp(
  paramNumber('vehicleSlopeProbeLengthScale', 0.34),
  0.1,
  0.55
);
const VEHICLE_SLOPE_PROBE_WIDTH_SCALE = THREE.MathUtils.clamp(
  paramNumber('vehicleSlopeProbeWidthScale', 0.45),
  0.2,
  0.7
);
const vehicleFollowLocal = new THREE.Vector3();
const vehicleFollowWorld = new THREE.Vector3();
const VEHICLE_LOG_STYLE = 'color:#ffbf00;font-weight:600;';
const vehicleGroundNormal = new THREE.Vector3(0, 0, 1);
const vehicleDesiredForward = new THREE.Vector3();
const vehicleDesiredRight = new THREE.Vector3();
const vehicleOrientationMatrix = new THREE.Matrix4();
const vehicleOrientationTargetQuat = new THREE.Quaternion();
const vehicleSnapPrevQuat = new THREE.Quaternion();
const vehicleInvQuat = new THREE.Quaternion();
const vehicleNormalMatrix = new THREE.Matrix3();
const vehicleTerrainInverse = new THREE.Matrix4();
const vehicleProbeLongitudinal = new THREE.Vector3();
const vehicleProbeLateral = new THREE.Vector3();
const vehicleProbeNormalWorld = new THREE.Vector3();
const vehicleProbeNormalLocal = new THREE.Vector3();
const vehicleLookTargetLocal = new THREE.Vector3();
const vehicleLookTargetWorld = new THREE.Vector3();
const vehicleLookDirLocal = new THREE.Vector3();
const VEHICLE_TEXTURE_ANISOTROPY = Math.max(
  1,
  Math.floor(paramNumber('vehicleTextureAnisotropy', 8))
);
let vehicleCameraOrbitYaw = 0;
let vehicleCameraOrbitPitch = Math.atan2(
  VEHICLE_CAMERA_FOLLOW_HEIGHT,
  VEHICLE_CAMERA_FOLLOW_DISTANCE
);

function vehicleConsoleLog(message, ...args) {
  console.log(`%c[VEHICLE] ${message}`, VEHICLE_LOG_STYLE, ...args);
}

function vehicleConsoleWarn(message, ...args) {
  console.warn(`%c[VEHICLE] ${message}`, VEHICLE_LOG_STYLE, ...args);
}

function applyVehicleTextureSampling(texture) {
  if (!texture || !texture.isTexture) return;
  const maxAniso = renderer.capabilities.getMaxAnisotropy?.() ?? 1;
  texture.anisotropy = Math.max(1, Math.min(maxAniso, VEHICLE_TEXTURE_ANISOTROPY));
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
}

function applyVehicleMaterialSampling(material) {
  if (!material) return;
  applyVehicleTextureSampling(material.map);
  applyVehicleTextureSampling(material.normalMap);
  applyVehicleTextureSampling(material.roughnessMap);
  applyVehicleTextureSampling(material.metalnessMap);
  applyVehicleTextureSampling(material.aoMap);
  applyVehicleTextureSampling(material.emissiveMap);
  applyVehicleTextureSampling(material.alphaMap);
}

function vehicleLocalToLatLon(x, y) {
  const lat = anchorLat + y / 111320;
  const lon = anchorLon + x / (111320 * Math.cos(anchorLat * Math.PI / 180));
  return { lat, lon };
}

function getVehicleStateSnapshot() {
  if (!vehicleLoaded) return null;
  const local = vehicleGroup.position;
  const latLon = vehicleLocalToLatLon(local.x, local.y);
  const headingDeg = (
    (THREE.MathUtils.radToDeg(vehicleHeadingRad) % 360) + 360
  ) % 360;
  return {
    lat: Number(latLon.lat.toFixed(8)),
    lon: Number(latLon.lon.toFixed(8)),
    headingDeg: Number(headingDeg.toFixed(3)),
    z: Number(local.z.toFixed(3)),
  };
}

function tileDepthFromId(tileId) {
  if (typeof tileId !== 'string') return -1;
  const depth = Number.parseInt(tileId.split('-')[0], 10);
  return Number.isFinite(depth) ? depth : -1;
}

function sampleBestVehicleTerrainHit(localX = vehicleGroup.position.x, localY = vehicleGroup.position.y, terrainMeshes = null) {
  if (!vehicleLoaded) {
    return { hit: null, depth: -1, tileId: null };
  }
  const targets = terrainMeshes ?? houseTerrainMeshes();
  if (targets.length === 0) {
    return { hit: null, depth: -1, tileId: null };
  }
  vehicleTargetLocal.set(localX, localY, 20000);
  vehicleTargetWorld.copy(vehicleTargetLocal);
  terrainRoot.localToWorld(vehicleTargetWorld);
  vehicleDownRaycaster.set(vehicleTargetWorld, vehicleDownDirection);
  const terrainHits = vehicleDownRaycaster.intersectObjects(targets);
  if (terrainHits.length === 0) {
    return { hit: null, depth: -1, tileId: null };
  }
  let bestHit = null;
  let bestDepth = -1;
  for (const hit of terrainHits) {
    const depth = tileDepthFromId(hit.object?.userData?.tileId);
    if (depth > bestDepth) {
      bestDepth = depth;
      bestHit = hit;
    }
  }
  return {
    hit: bestHit,
    depth: bestDepth,
    tileId: bestHit?.object?.userData?.tileId ?? null,
  };
}

function terrainDirectionFromWorld(worldDir, out) {
  vehicleTerrainInverse.copy(terrainRoot.matrixWorld).invert();
  out.copy(worldDir).transformDirection(vehicleTerrainInverse).normalize();
}

function updateVehicleOrientationTargetFromGround() {
  vehicleDesiredForward.set(-Math.sin(vehicleHeadingRad), Math.cos(vehicleHeadingRad), 0);
  vehicleDesiredForward.addScaledVector(
    vehicleGroundNormal,
    -vehicleDesiredForward.dot(vehicleGroundNormal)
  );
  if (vehicleDesiredForward.lengthSq() < 1e-8) {
    vehicleDesiredForward.set(0, 1, 0);
  } else {
    vehicleDesiredForward.normalize();
  }
  vehicleDesiredRight.crossVectors(vehicleDesiredForward, vehicleGroundNormal);
  if (vehicleDesiredRight.lengthSq() < 1e-8) {
    vehicleDesiredRight.set(1, 0, 0);
  } else {
    vehicleDesiredRight.normalize();
  }
  vehicleOrientationMatrix.makeBasis(
    vehicleDesiredRight,
    vehicleDesiredForward,
    vehicleGroundNormal
  );
  vehicleOrientationTargetQuat.setFromRotationMatrix(vehicleOrientationMatrix);
}

function updateVehicleGroundNormalFromTerrain(centerHit, terrainMeshes) {
  let normalReady = false;
  const headingForward = vehicleDesiredForward.set(-Math.sin(vehicleHeadingRad), Math.cos(vehicleHeadingRad), 0).normalize();
  const headingRight = vehicleDesiredRight.set(Math.cos(vehicleHeadingRad), Math.sin(vehicleHeadingRad), 0).normalize();
  const probeForwardM = Math.max(1.0, vehicleBodyLengthM * VEHICLE_SLOPE_PROBE_LENGTH_SCALE);
  const probeRightM = Math.max(0.8, vehicleBodyWidthM * VEHICLE_SLOPE_PROBE_WIDTH_SCALE);
  const centerX = vehicleGroup.position.x;
  const centerY = vehicleGroup.position.y;
  const front = sampleBestVehicleTerrainHit(
    centerX + headingForward.x * probeForwardM,
    centerY + headingForward.y * probeForwardM,
    terrainMeshes
  );
  const back = sampleBestVehicleTerrainHit(
    centerX - headingForward.x * probeForwardM,
    centerY - headingForward.y * probeForwardM,
    terrainMeshes
  );
  const right = sampleBestVehicleTerrainHit(
    centerX + headingRight.x * probeRightM,
    centerY + headingRight.y * probeRightM,
    terrainMeshes
  );
  const left = sampleBestVehicleTerrainHit(
    centerX - headingRight.x * probeRightM,
    centerY - headingRight.y * probeRightM,
    terrainMeshes
  );
  if (front.hit && back.hit && right.hit && left.hit) {
    vehicleProbeLongitudinal.subVectors(front.hit.point, back.hit.point);
    vehicleProbeLateral.subVectors(right.hit.point, left.hit.point);
    if (
      vehicleProbeLongitudinal.lengthSq() > 1e-6 &&
      vehicleProbeLateral.lengthSq() > 1e-6
    ) {
      vehicleProbeNormalWorld.crossVectors(vehicleProbeLateral, vehicleProbeLongitudinal);
      if (vehicleProbeNormalWorld.lengthSq() > 1e-8) {
        vehicleProbeNormalWorld.normalize();
        if (vehicleProbeNormalWorld.dot(up) < 0) {
          vehicleProbeNormalWorld.multiplyScalar(-1);
        }
        terrainDirectionFromWorld(vehicleProbeNormalWorld, vehicleProbeNormalLocal);
        vehicleGroundNormal.copy(vehicleProbeNormalLocal);
        normalReady = true;
      }
    }
  }
  if (!normalReady && centerHit?.face && centerHit.object) {
    vehicleNormalMatrix.getNormalMatrix(centerHit.object.matrixWorld);
    vehicleProbeNormalWorld
      .copy(centerHit.face.normal)
      .applyNormalMatrix(vehicleNormalMatrix)
      .normalize();
    if (vehicleProbeNormalWorld.dot(up) < 0) {
      vehicleProbeNormalWorld.multiplyScalar(-1);
    }
    terrainDirectionFromWorld(vehicleProbeNormalWorld, vehicleProbeNormalLocal);
    vehicleGroundNormal.copy(vehicleProbeNormalLocal);
    normalReady = true;
  }
  if (!normalReady) {
    vehicleGroundNormal.copy(up);
  }
  vehicleGroundNormal.normalize();
}

function vehicleNearTileBbox(bbox) {
  if (!vehicleLoaded || !Array.isArray(bbox) || bbox.length !== 4) return false;
  const x = vehicleGroup.position.x;
  const y = vehicleGroup.position.y;
  return (
    x >= bbox[0] - VEHICLE_RESNAP_MARGIN_M &&
    x <= bbox[2] + VEHICLE_RESNAP_MARGIN_M &&
    y >= bbox[1] - VEHICLE_RESNAP_MARGIN_M &&
    y <= bbox[3] + VEHICLE_RESNAP_MARGIN_M
  );
}

function requestVehicleTerrainResnap(reason = 'terrain-update') {
  if (!vehicleLoaded) return;
  if (vehicleSnapPending) return;
  vehicleSnapPending = true;
  // bootLog('vehicle.resnap.requested', { reason });
}

function setVehicleGroundTarget(nextZ, options = {}) {
  const {
    immediate = false,
    resetVelocity = false,
  } = options;
  if (!Number.isFinite(nextZ)) return;
  vehicleGroundZTarget = nextZ;
  if (resetVelocity) {
    vehicleVerticalVelocity = 0;
  }
  if (immediate) {
    vehicleGroup.position.z = nextZ;
  }
  vehicleMarker.position.z = vehicleGroup.position.z + HOUSE_MARKER_BASE_LIFT;
}

function updateVehicleSuspension(dt) {
  if (!vehicleLoaded || !Number.isFinite(vehicleGroundZTarget)) return;
  const stepDt = Math.min(0.05, Math.max(0.001, dt));
  const omega = 2 * Math.PI * VEHICLE_SUSPENSION_HZ;
  const stiffness = omega * omega;
  const damping = 2 * VEHICLE_SUSPENSION_DAMPING_RATIO * omega;
  const error = vehicleGroundZTarget - vehicleGroup.position.z;
  const accel = stiffness * error - damping * vehicleVerticalVelocity;
  vehicleVerticalVelocity += accel * stepDt;
  vehicleVerticalVelocity = THREE.MathUtils.clamp(
    vehicleVerticalVelocity,
    -VEHICLE_SUSPENSION_MAX_VEL,
    VEHICLE_SUSPENSION_MAX_VEL
  );
  vehicleGroup.position.z += vehicleVerticalVelocity * stepDt;
  if (Math.abs(error) < 0.002 && Math.abs(vehicleVerticalVelocity) < 0.01) {
    vehicleGroup.position.z = vehicleGroundZTarget;
    vehicleVerticalVelocity = 0;
  }
  updateVehicleOrientationTargetFromGround();
  const orientationAlpha = 1 - Math.exp(-VEHICLE_ORIENTATION_RESPONSE * stepDt);
  vehicleGroup.quaternion.slerp(vehicleOrientationTargetQuat, orientationAlpha);
  vehicleMarker.position.z = vehicleGroup.position.z + HOUSE_MARKER_BASE_LIFT;
}

let _vehicleSaveTrailingTimer = 0;
let _vehicleLastSaveAt = 0;
let _vehicleSaveFailureUntilMs = 0;
let _vehicleSaveFailureReported = false;
const VEHICLE_SAVE_THROTTLE_MS = 5000;
const VEHICLE_SAVE_TRAILING_MS = 2000;
function throttledVehicleSave() {
  const now = performance.now();
  // Throttle: save immediately if enough time has passed
  if (now - _vehicleLastSaveAt >= VEHICLE_SAVE_THROTTLE_MS) {
    _vehicleLastSaveAt = now;
    saveVehicleState('drive-throttle');
  }
  // Trailing: always schedule a final save after movement stops
  clearTimeout(_vehicleSaveTrailingTimer);
  _vehicleSaveTrailingTimer = setTimeout(() => {
    _vehicleLastSaveAt = performance.now();
    saveVehicleState('drive-trailing');
  }, VEHICLE_SAVE_TRAILING_MS);
}

async function saveVehicleState(reason = 'manual', options = {}) {
  const {
    snapToGround = false,
    requireGroundedZ = false,
    bypassSnapThrottle = false,
  } = options;
  let zGrounded = false;
  const nowMs = Date.now();
  if (_vehicleSaveFailureUntilMs > nowMs) {
    return false;
  }
  if (snapToGround && vehicleLoaded) {
    vehicleSnapPending = true;
    snapVehicleToTerrain({ forceImmediate: true, bypassThrottle: bypassSnapThrottle });
    zGrounded = !vehicleSnapPending && Number.isFinite(vehicleGroundZTarget);
  }
  const state = getVehicleStateSnapshot();
  if (state == null) return false;
  if (Number.isFinite(vehicleGroundZTarget)) {
    state.z = Number(vehicleGroundZTarget.toFixed(3));
  }
  const terrainSample = sampleBestVehicleTerrainHit();
  if (terrainSample.depth >= 0) {
    state.terrainDepth = terrainSample.depth;
  }
  if (terrainSample.tileId) {
    state.terrainTileId = terrainSample.tileId;
  }
  if ((snapToGround || requireGroundedZ) && !zGrounded) {
    // bootLog('vehicle.state.save.ungrounded', { reason, state }, 'warn');
  }
  try {
    const controller = typeof AbortController !== 'undefined'
      ? new AbortController()
      : null;
    const timeoutHandle = controller != null
      ? window.setTimeout(() => controller.abort(), VEHICLE_SAVE_FETCH_TIMEOUT_MS)
      : null;
    const response = await fetch(VEHICLE_STATE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...state, reason }),
      signal: controller?.signal,
    }).finally(() => {
      if (timeoutHandle != null) {
        window.clearTimeout(timeoutHandle);
      }
    });
    if (!response.ok) {
      const responseText = await response.text().catch(() => '');
      const preview = responseText.slice(0, 180);
      throw new Error(
        `vehicle_state save status ${response.status}${preview ? ` body=${preview}` : ''}`
      );
    }
    if (_vehicleSaveFailureReported) {
      bootLog('vehicle.state.save.recovered', {
        reason,
      });
    }
    _vehicleSaveFailureUntilMs = 0;
    _vehicleSaveFailureReported = false;
    // bootLog('vehicle.state.save.success', { reason, state, zGrounded });
    return true;
  } catch (error) {
    _vehicleSaveFailureUntilMs = Date.now() + VEHICLE_SAVE_FAILURE_COOLDOWN_MS;
    if (!_vehicleSaveFailureReported) {
      const timedOut = error?.name === 'AbortError';
      bootLog('vehicle.state.save.error', {
        reason,
        timeoutMs: VEHICLE_SAVE_FETCH_TIMEOUT_MS,
        timedOut,
        cooldownMs: VEHICLE_SAVE_FAILURE_COOLDOWN_MS,
        message: error?.message ?? String(error),
      }, 'error');
      _vehicleSaveFailureReported = true;
    }
    return false;
  }
}

function loadVehicleState() {
  const state = ASSET_VEHICLE_INSTANCES.length > 0 ? ASSET_VEHICLE_INSTANCES[0] : null;
  if (state == null) {
    bootLog('vehicle.state.load.empty');
    return null;
  }
  const lat = Number(state.lat);
  const lon = Number(state.lon);
  const headingDeg = Number(state.headingDeg);
  const z = Number(state.z);
  const terrainDepthRaw = Number(state.terrainDepth);
  const terrainDepth = Number.isFinite(terrainDepthRaw)
    ? Math.max(0, Math.floor(terrainDepthRaw))
    : null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(headingDeg)) {
    bootLog('vehicle.state.load.invalid', { state }, 'error');
    return null;
  }
  vehicleSavedStatePending = {
    lat,
    lon,
    headingDeg,
    z: Number.isFinite(z) ? z : null,
    terrainDepth,
  };
  return vehicleSavedStatePending;
}

function loadVehicleModel() {
  vehicleLoader.load(
    VEHICLE_MODEL.url,
    gltf => {
      const model = gltf.scene;
      model.rotation.x = Math.PI * 0.5; // Y-up → Z-up
      // Keep original PBR materials for proper lighting
      model.traverse(obj => {
        if (obj.isMesh) {
          obj.castShadow = true;
          obj.receiveShadow = true;
          if (Array.isArray(obj.material)) {
            for (const material of obj.material) {
              applyVehicleMaterialSampling(material);
            }
          } else {
            applyVehicleMaterialSampling(obj.material);
          }
        }
      });
      // Measure model bounding box to compute real-world scale
      const bbox = new THREE.Box3().setFromObject(model);
      const modelSize = new THREE.Vector3();
      bbox.getSize(modelSize);
      // longest axis = model's "length" — scale so it equals realLengthM
      const modelLength = Math.max(modelSize.x, modelSize.y, modelSize.z);
      const vehicleScale = modelLength > 0
        ? VEHICLE_MODEL.realLengthM / modelLength
        : 1;
      const scaledDims = [
        modelSize.x * vehicleScale,
        modelSize.y * vehicleScale,
        modelSize.z * vehicleScale,
      ].sort((a, b) => b - a);
      vehicleBodyLengthM = scaledDims[0];
      vehicleBodyWidthM = scaledDims[1];
      const scaledSpan = modelLength * vehicleScale;
      vehicleShadowRadius = THREE.MathUtils.clamp(
        scaledSpan * 12,
        VEHICLE_SHADOW_MIN_RADIUS,
        VEHICLE_SHADOW_MAX_RADIUS
      );
      // Shift model so its bottom (min z) sits at z=0 in vehicleGroup local space
      model.position.z -= bbox.min.z;
      vehicleConsoleLog(`model bbox: ${modelSize.x.toFixed(2)} x ${modelSize.y.toFixed(2)} x ${modelSize.z.toFixed(2)}, longest=${modelLength.toFixed(2)}, scale=${vehicleScale.toFixed(4)}, bottomOffset=${bbox.min.z.toFixed(2)}`);
      vehicleGroup.add(model);
      // ── Headlights ──────────────────────────────────────────────────
      if (VEHICLE_HEADLIGHTS != null && _vehicleSeedInstance.headlightsOn === true) {
        const localScale = vehicleScale !== 0 ? vehicleScale : 1;
        const hlColor = VEHICLE_HEADLIGHTS.color;
        const hlIntensity = VEHICLE_HEADLIGHTS.intensity;
        const hlAngle = THREE.MathUtils.degToRad(VEHICLE_HEADLIGHTS.angleDeg);
        const hlPenumbra = VEHICLE_HEADLIGHTS.penumbra;
        const hlDistance = VEHICLE_HEADLIGHTS.distanceM;
        const hlDecay = VEHICLE_HEADLIGHTS.decay;
        const hlFrontY = (vehicleBodyLengthM * VEHICLE_HEADLIGHTS.mountFrontRatio) / localScale;
        const hlHeight = VEHICLE_HEADLIGHTS.mountHeightM / localScale;
        const hlSpacing = VEHICLE_HEADLIGHTS.mountSpacingM / localScale;
        const hlTargetY = hlFrontY + (VEHICLE_HEADLIGHTS.targetForwardM / localScale);
        const hlTargetZ = VEHICLE_HEADLIGHTS.targetHeightM / localScale;
        vehicleHeadlightSpots = [];
        for (const side of [-1, 1]) {
          const hl = new THREE.SpotLight(hlColor, hlIntensity, hlDistance, hlAngle, hlPenumbra, hlDecay);
          hl.position.set(side * hlSpacing, hlFrontY, hlHeight);
          hl.castShadow = false;
          const target = new THREE.Object3D();
          target.position.set(side * hlSpacing * VEHICLE_HEADLIGHTS.targetXScale, hlTargetY, hlTargetZ);
          vehicleGroup.add(target);
          hl.target = target;
          vehicleGroup.add(hl);
          vehicleHeadlightSpots.push(hl);
        }
      }
      // Collect vehicle meshes for upward raycast collision
      vehicleMeshes = [];
      model.traverse(obj => { if (obj.isMesh) vehicleMeshes.push(obj); });
      const savedState = vehicleSavedStatePending;
      const startLat = Number.isFinite(savedState?.lat) ? savedState.lat : VEHICLE_MODEL.lat;
      const startLon = Number.isFinite(savedState?.lon) ? savedState.lon : VEHICLE_MODEL.lon;
      const startHeadingDeg = Number.isFinite(savedState?.headingDeg)
        ? savedState.headingDeg
        : VEHICLE_MODEL.headingDeg;
      const startZ = Number.isFinite(savedState?.z) ? savedState.z : (VEHICLE_MODEL.z ?? 0);
      const local = houseLocalFromLatLon(startLat, startLon);
      vehicleHeadingRad = THREE.MathUtils.degToRad(startHeadingDeg);
      vehicleGroundNormal.copy(up);
      updateVehicleOrientationTargetFromGround();
      vehicleGroup.position.set(local.x, local.y, startZ);
      vehicleGroup.quaternion.copy(vehicleOrientationTargetQuat);
      vehicleGroup.scale.setScalar(vehicleScale);
      vehicleLoaded = true;
      vehicleSnapPending = true;
      vehicleAwaitingInitialSnap = true;
      vehicleRestoreRequiresDepth = Boolean(savedState);
      vehicleRestoreDepthTarget = Number.isFinite(savedState?.terrainDepth)
        ? savedState.terrainDepth
        : VEHICLE_RESTORE_MIN_DEPTH;
      vehicleGroundZTarget = Number.isFinite(startZ) ? startZ : null;
      vehicleVerticalVelocity = 0;
      vehicleLastContactDepth = -1;
      vehicleLastContactTileId = null;
      vehicleGroup.visible = false;
      vehicleMarker.position.set(local.x, local.y, HOUSE_MARKER_BASE_LIFT);
      bootLog('vehicle.load.success', {
        url: VEHICLE_MODEL.url,
        modelLength: modelLength.toFixed(2),
        scale: vehicleScale.toFixed(4),
        shadowRadiusM: Number(vehicleShadowRadius.toFixed(1)),
        terrainLiftM: Number(VEHICLE_TERRAIN_LIFT_M.toFixed(3)),
        startLat: Number(startLat.toFixed(8)),
        startLon: Number(startLon.toFixed(8)),
        startHeadingDeg: Number(startHeadingDeg.toFixed(3)),
        startZ: Number(startZ.toFixed(3)),
        restoreDepthTarget: vehicleRestoreDepthTarget,
      });
    },
    undefined,
    error => {
      vehicleConsoleWarn('load failed:', error);
      bootLog('vehicle.load.error', { message: error?.message ?? String(error) });
    }
  );
}

const _vehicleSunLocal = new THREE.Vector3();
function syncVehicleSunLight() {
  if (!vehicleLoaded) return;
  // sunDirection is in ECEF; convert to terrainRoot local (ENU-ish)
  _vehicleSunLocal.set(
    sunDirection.dot(east),
    sunDirection.dot(north),
    sunDirection.dot(up)
  ).normalize();
  // Convert from terrainRoot local into vehicleGroup local so vehicle lighting follows slope tilt.
  vehicleInvQuat.copy(vehicleGroup.quaternion).invert();
  _vehicleSunLocal.applyQuaternion(vehicleInvQuat);
  // Position directional light
  vehicleSunLight.target.position.set(0, 0, 0);
  vehicleSunLight.position.set(
    _vehicleSunLocal.x * 40,
    _vehicleSunLocal.y * 40,
    _vehicleSunLocal.z * 40
  );
}

function createVehicleShadowReceiverFromTerrainMesh(terrainMesh) {
  const receiver = new THREE.Mesh(terrainMesh.geometry, vehicleShadowReceiverMaterial);
  receiver.position.copy(terrainMesh.position);
  receiver.quaternion.copy(terrainMesh.quaternion);
  receiver.scale.copy(terrainMesh.scale);
  receiver.receiveShadow = true;
  receiver.castShadow = false;
  receiver.frustumCulled = false;
  receiver.renderOrder = 25;
  receiver.userData.vehicleShadowTileId = terrainMesh.userData.tileId;
  receiver.userData.sourceGeometry = terrainMesh.geometry;
  return receiver;
}

function clearVehicleShadowReceivers() {
  for (const receiver of vehicleShadowReceivers.values()) {
    vehicleShadowReceiverLayer.remove(receiver);
  }
  vehicleShadowReceivers.clear();
}

function syncVehicleShadowReceivers() {
  if (!vehicleLoaded) {
    clearVehicleShadowReceivers();
    return;
  }
  const activeTileIds = new Set();
  const terrainMeshes = houseTerrainMeshes();
  for (const terrainMesh of terrainMeshes) {
    const tileId = terrainMesh.userData?.tileId;
    if (!tileId) continue;
    activeTileIds.add(tileId);
    const existing = vehicleShadowReceivers.get(tileId);
    if (existing) {
      if (existing.userData.sourceGeometry !== terrainMesh.geometry) {
        vehicleShadowReceiverLayer.remove(existing);
        vehicleShadowReceivers.delete(tileId);
      } else {
        continue;
      }
    }
    if (vehicleShadowReceivers.has(tileId)) {
      continue;
    }
    const receiver = createVehicleShadowReceiverFromTerrainMesh(terrainMesh);
    vehicleShadowReceivers.set(tileId, receiver);
    vehicleShadowReceiverLayer.add(receiver);
  }
  for (const [tileId, receiver] of vehicleShadowReceivers) {
    if (activeTileIds.has(tileId)) continue;
    vehicleShadowReceiverLayer.remove(receiver);
    vehicleShadowReceivers.delete(tileId);
  }
}

function updateVehicleShadowSystem() {
  if (!vehicleLoaded || controls.mapMode) {
    vehicleShadowCasterLight.visible = false;
    vehicleShadowReceiverLayer.visible = false;
    return;
  }
  const sunUp = sunDirection.dot(up);
  if (sunUp <= 0.01) {
    vehicleShadowCasterLight.visible = false;
    vehicleShadowReceiverLayer.visible = false;
    return;
  }
  if (vehicleShadowReceivers.size === 0) {
    vehicleShadowCasterLight.visible = false;
    vehicleShadowReceiverLayer.visible = false;
    return;
  }

  _vehicleSunLocal.set(
    sunDirection.dot(east),
    sunDirection.dot(north),
    sunDirection.dot(up)
  ).normalize();

  vehicleShadowCenterLocal.copy(vehicleGroup.position);
  if (Number.isFinite(vehicleGroundZTarget)) {
    vehicleShadowCenterLocal.z = THREE.MathUtils.lerp(
      vehicleShadowCenterLocal.z,
      vehicleGroundZTarget,
      VEHICLE_SHADOW_GROUND_ANCHOR
    );
  }
  const shadowCenter = vehicleShadowCenterLocal;
  vehicleShadowCasterLight.visible = true;
  vehicleShadowCasterLight.position
    .copy(shadowCenter)
    .addScaledVector(_vehicleSunLocal, VEHICLE_SHADOW_LIGHT_DISTANCE + vehicleShadowRadius);
  vehicleShadowCasterLight.target.position.copy(shadowCenter);
  vehicleShadowCasterLight.target.updateMatrixWorld(true);
  vehicleShadowCasterLight.updateMatrixWorld(true);

  const shadowCamera = vehicleShadowCasterLight.shadow.camera;
  shadowCamera.left = -vehicleShadowRadius;
  shadowCamera.right = vehicleShadowRadius;
  shadowCamera.top = vehicleShadowRadius;
  shadowCamera.bottom = -vehicleShadowRadius;
  shadowCamera.near = 20;
  shadowCamera.far = VEHICLE_SHADOW_LIGHT_DISTANCE + vehicleShadowRadius * 4;
  shadowCamera.updateProjectionMatrix();
  shadowCamera.updateMatrixWorld(true);

  if (VEHICLE_SHADOW_TEXEL_SNAP) {
    vehicleShadowCenterWorld.copy(shadowCenter);
    terrainRoot.localToWorld(vehicleShadowCenterWorld);
    vehicleShadowCenterLight.copy(vehicleShadowCenterWorld).applyMatrix4(shadowCamera.matrixWorldInverse);
    const texelSizeX = (shadowCamera.right - shadowCamera.left) / Math.max(1, vehicleShadowCasterLight.shadow.mapSize.x);
    const texelSizeY = (shadowCamera.top - shadowCamera.bottom) / Math.max(1, vehicleShadowCasterLight.shadow.mapSize.y);
    vehicleShadowSnappedLight.set(
      Math.round(vehicleShadowCenterLight.x / texelSizeX) * texelSizeX,
      Math.round(vehicleShadowCenterLight.y / texelSizeY) * texelSizeY,
      vehicleShadowCenterLight.z
    );
    vehicleShadowSnappedWorld.copy(vehicleShadowSnappedLight).applyMatrix4(shadowCamera.matrixWorld);
    vehicleShadowSnapOffsetWorld.copy(vehicleShadowSnappedWorld).sub(vehicleShadowCenterWorld);
    if (vehicleShadowSnapOffsetWorld.lengthSq() > 0) {
      vehicleShadowSnapOffsetLocal.copy(vehicleShadowCenterWorld).add(vehicleShadowSnapOffsetWorld);
      terrainRoot.worldToLocal(vehicleShadowSnapOffsetLocal);
      vehicleShadowSnapOffsetLocal.sub(vehicleShadowCenterLocal);
      vehicleShadowCasterLight.position.add(vehicleShadowSnapOffsetLocal);
      vehicleShadowCasterLight.target.position.add(vehicleShadowSnapOffsetLocal);
      vehicleShadowCasterLight.target.updateMatrixWorld(true);
      vehicleShadowCasterLight.updateMatrixWorld(true);
    }
  }

  vehicleShadowReceiverMaterial.opacity = VEHICLE_SHADOW_OPACITY;
  vehicleShadowCasterLight.shadow.needsUpdate = true;
  vehicleShadowReceiverLayer.visible = true;
}

function snapVehicleToTerrain(options = {}) {
  const { forceImmediate = false, bypassThrottle = false } = options;
  if (!vehicleLoaded) return;
  const now = performance.now();
  const minInterval = vehicleSnapPending ? VEHICLE_SNAP_PENDING_MS : VEHICLE_SNAP_IDLE_MS;
  if (!bypassThrottle && now - lastVehicleSnapAttemptAt < minInterval) return;
  lastVehicleSnapAttemptAt = now;
  const terrainMeshes = houseTerrainMeshes();
  if (terrainMeshes.length === 0 || vehicleMeshes.length === 0) return;
  const terrainSample = sampleBestVehicleTerrainHit(
    vehicleGroup.position.x,
    vehicleGroup.position.y,
    terrainMeshes
  );
  if (!terrainSample.hit) return;
  const fallbackHit = terrainSample.hit;
  const depth = tileDepthFromId(terrainSample.hit.object?.userData?.tileId);
  const selectedTileId = terrainSample.hit.object?.userData?.tileId ?? null;
  const bestMinDepthHit = depth >= vehicleRestoreDepthTarget ? terrainSample.hit : null;
  const selectedHit = vehicleRestoreRequiresDepth
    ? bestMinDepthHit
    : fallbackHit;
  if (!selectedHit) {
    // Wait for finer terrain under the vehicle before finalizing restore.
    return;
  }
  updateVehicleGroundNormalFromTerrain(selectedHit, terrainMeshes);
  updateVehicleOrientationTargetFromGround();
  const terrainPoint = selectedHit.point.clone();
  // Step 2: temporarily position vehicle high above terrain
  vehicleTargetLocal.copy(terrainPoint);
  terrainRoot.worldToLocal(vehicleTargetLocal);
  const alignImmediately = forceImmediate || vehicleAwaitingInitialSnap;
  const preSnapZ = vehicleGroup.position.z;
  vehicleSnapPrevQuat.copy(vehicleGroup.quaternion);
  vehicleGroup.quaternion.copy(vehicleOrientationTargetQuat);
  vehicleGroup.position.z = vehicleTargetLocal.z + 50; // well above ground
  vehicleGroup.updateMatrixWorld(true);
  // Step 3: raycast UP from terrain surface to find vehicle bottom
  vehicleUpRaycaster.set(terrainPoint, vehicleUpDirection);
  const vehicleHits = vehicleUpRaycaster.intersectObjects(vehicleMeshes);
  let groundedZ = vehicleTargetLocal.z + VEHICLE_TERRAIN_LIFT_M;
  if (vehicleHits.length === 0) {
    // Fallback: just use terrain height + small offset
    groundedZ = vehicleTargetLocal.z + VEHICLE_TERRAIN_LIFT_M;
  } else {
    // The gap between terrain and vehicle bottom
    const gap = vehicleHits[0].distance;
    groundedZ = vehicleGroup.position.z - gap + VEHICLE_TERRAIN_LIFT_M;
  }
  if (!alignImmediately) {
    vehicleGroup.position.z = preSnapZ;
    vehicleGroup.quaternion.copy(vehicleSnapPrevQuat);
  } else {
    vehicleGroup.quaternion.copy(vehicleOrientationTargetQuat);
  }
  const prevDepth = vehicleLastContactDepth;
  const prevTargetZ = vehicleGroundZTarget;
  setVehicleGroundTarget(
    groundedZ,
    { immediate: alignImmediately, resetVelocity: forceImmediate }
  );
  const depthRefined = Number.isFinite(depth) && depth > prevDepth;
  if (depthRefined && Number.isFinite(prevTargetZ)) {
    const dz = groundedZ - prevTargetZ;
    if (Math.abs(dz) > 0.005) {
      vehicleVerticalVelocity += dz * VEHICLE_REFINEMENT_BOUNCE;
      vehicleVerticalVelocity = THREE.MathUtils.clamp(
        vehicleVerticalVelocity,
        -VEHICLE_SUSPENSION_MAX_VEL,
        VEHICLE_SUSPENSION_MAX_VEL
      );
    }
  }
  vehicleSnapPending = false;
  vehicleRestoreRequiresDepth = false;
  vehicleRestoreDepthTarget = -1;
  vehicleLastContactDepth = Number.isFinite(depth) ? depth : vehicleLastContactDepth;
  vehicleLastContactTileId = selectedTileId;
  if (vehicleAwaitingInitialSnap) {
    vehicleAwaitingInitialSnap = false;
    vehicleGroup.visible = true;
  }
}

function updateVehicleFollowCamera() {
  if (!vehicleLoaded) return;
  const heading = vehicleHeadingRad;
  const forwardX = -Math.sin(heading);
  const forwardY = Math.cos(heading);
  const rightX = Math.cos(heading);
  const rightY = Math.sin(heading);
  const radius = Math.sqrt(
    VEHICLE_CAMERA_FOLLOW_DISTANCE * VEHICLE_CAMERA_FOLLOW_DISTANCE +
    VEHICLE_CAMERA_FOLLOW_HEIGHT * VEHICLE_CAMERA_FOLLOW_HEIGHT
  );
  const horizontalRadius = radius * Math.cos(vehicleCameraOrbitPitch);
  const verticalOffset = radius * Math.sin(vehicleCameraOrbitPitch);
  const backScale = Math.cos(vehicleCameraOrbitYaw);
  const sideScale = Math.sin(vehicleCameraOrbitYaw);
  // Compute offset in vehicle-local frame (forward=+Y, right=+X, up=+Z)
  const localOffX = sideScale * horizontalRadius;
  const localOffY = -backScale * horizontalRadius;
  const localOffZ = verticalOffset;
  // Rotate by vehicle orientation so camera tilts with the vehicle on slopes
  vehicleFollowLocal.set(localOffX, localOffY, localOffZ);
  vehicleFollowLocal.applyQuaternion(vehicleGroup.quaternion);
  vehicleFollowLocal.add(vehicleGroup.position);
  vehicleLookTargetLocal.set(
    vehicleGroup.position.x,
    vehicleGroup.position.y,
    vehicleGroup.position.z + VEHICLE_CAMERA_LOOK_HEIGHT
  );
  vehicleFollowWorld.copy(vehicleFollowLocal);
  terrainRoot.localToWorld(vehicleFollowWorld);
  vehicleLookTargetWorld.copy(vehicleLookTargetLocal);
  terrainRoot.localToWorld(vehicleLookTargetWorld);
  camera.position.copy(vehicleFollowWorld);
  camera.up.copy(up);
  camera.lookAt(vehicleLookTargetWorld);
  vehicleLookDirLocal
    .copy(vehicleLookTargetLocal)
    .sub(vehicleFollowLocal)
    .normalize();
  controls.yaw = Math.atan2(-vehicleLookDirLocal.x, vehicleLookDirLocal.y);
  controls.pitch = Math.asin(THREE.MathUtils.clamp(vehicleLookDirLocal.z, -1, 1));
}

function setVehicleControlActive(nextActive, reason = 'manual', options = {}) {
  const { skipExitSave = false } = options;
  driftMode = false;
  const requested = Boolean(nextActive);
  if (requested && (!vehicleLoaded || controls.mapMode)) {
    return false;
  }
  const wasActive = vehicleControlActive;
  const next = requested;
  if (vehicleControlActive === next) {
    return vehicleControlActive;
  }
  vehicleControlActive = next;
  if (vehicleControlActive) {
    controls.speed = 0;
    vehicleCameraOrbitYaw = 0;
    vehicleCameraOrbitPitch = THREE.MathUtils.clamp(
      Math.atan2(VEHICLE_CAMERA_FOLLOW_HEIGHT, VEHICLE_CAMERA_FOLLOW_DISTANCE),
      VEHICLE_CAMERA_ORBIT_PITCH_MIN,
      VEHICLE_CAMERA_ORBIT_PITCH_MAX
    );
    controls.yaw = vehicleHeadingRad;
    updateVehicleFollowCamera();
  }
  if (wasActive && !vehicleControlActive) {
    controls.speed = 0; // stop camera drift when exiting vehicle mode
  }
  if (wasActive && !vehicleControlActive && vehicleLoaded && !skipExitSave) {
    saveVehicleState(`exit-${reason}`, {
      snapToGround: true,
      requireGroundedZ: false,
      bypassSnapThrottle: true,
    });
  }
  bootLog('vehicle.control', {
    active: vehicleControlActive,
    reason,
  });
  return vehicleControlActive;
}

function tryEnterVehicleControlFromPointer(event) {
  if (controls.mapMode || !vehicleLoaded || vehicleMeshes.length === 0) {
    return false;
  }
  mouseNDC.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouseNDC.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouseNDC, camera);
  const hits = raycaster.intersectObjects(vehicleMeshes, false);
  if (hits.length === 0) {
    return false;
  }
  return setVehicleControlActive(true, 'right-click-vehicle');
}
// ── Patria AMV diesel audio ─────────────────────────────────────────────
// Non-positional audio with manual distance-based volume (avoids ECEF panner issues)
const audioListener = new THREE.AudioListener();
camera.add(audioListener);
const dieselSound = new THREE.Audio(audioListener);
dieselSound.setLoop(true);
dieselSound.setVolume(0);
const DIESEL_MAX_VOL = 0;
const DIESEL_FULL_DIST = 15;   // full volume within 15m
const DIESEL_ZERO_DIST = 150;  // silent beyond 150m

function updateDieselVolume() {
  if (!dieselSound.isPlaying) return;
  const camWorld = new THREE.Vector3();
  const vehWorld = new THREE.Vector3();
  camera.getWorldPosition(camWorld);
  vehicleGroup.getWorldPosition(vehWorld);
  const dist = camWorld.distanceTo(vehWorld);
  if (dist <= DIESEL_FULL_DIST) {
    dieselSound.setVolume(DIESEL_MAX_VOL);
  } else if (dist >= DIESEL_ZERO_DIST) {
    dieselSound.setVolume(0);
  } else {
    const t = (dist - DIESEL_FULL_DIST) / (DIESEL_ZERO_DIST - DIESEL_FULL_DIST);
    dieselSound.setVolume(DIESEL_MAX_VOL * (1 - t * t));
  }
}

const audioLoader = new THREE.AudioLoader();
audioLoader.load('/audio/diesel_idle.mp3', buffer => {
  dieselSound.setBuffer(buffer);
  const startAudio = () => {
    if (!dieselSound.isPlaying) {
      dieselSound.play();
    }
    window.removeEventListener('click', startAudio);
    window.removeEventListener('keydown', startAudio);
  };
  window.addEventListener('click', startAudio);
  window.addEventListener('keydown', startAudio);
  bootLog('vehicle.audio.loaded', { duration: buffer.duration.toFixed(1) });
}, undefined, error => {
  console.warn('[VEHICLE] audio load failed:', error);
});
// ── end Patria AMV ──────────────────────────────────────────────────────

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
  if (HOUSE_USE_SHADOW_MAP) {
    houseShadowCasterLight.visible = true;
  }
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
  const eastM = (lon - anchorLon) * 111320 * Math.cos(anchorLat * Math.PI / 180);
  const northM = (lat - anchorLat) * 111320;
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
    houseShadowCasterLight.visible = false;
    houseShadowReceiverLayer.visible = false;
    return;
  }
  if (controls.mapMode) {
    setGate('map-mode');
    houseShadowCasterLight.visible = false;
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
    houseShadowCasterLight.visible = false;
    houseShadowReceiverLayer.visible = false;
    return;
  }
  if (sunUp <= 0.01) {
    setGate('sun-below-horizon');
    houseShadowCasterLight.visible = false;
    houseShadowReceiverLayer.visible = false;
    return;
  }
  if (houseShadowReceivers.size === 0) {
    setGate('no-shadow-receivers');
    houseShadowCasterLight.visible = false;
    houseShadowReceiverLayer.visible = false;
    return;
  }

  setGate('active');
  houseShadowCasterLight.visible = true;
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
  houseShadowCasterLight.target.updateMatrixWorld(true);
  houseShadowCasterLight.updateMatrixWorld(true);

  const shadowCamera = houseShadowCasterLight.shadow.camera;
  shadowCamera.left = -shadowRadius;
  shadowCamera.right = shadowRadius;
  shadowCamera.top = shadowRadius;
  shadowCamera.bottom = -shadowRadius;
  shadowCamera.near = 100;
  shadowCamera.far = HOUSE_SHADOW_LIGHT_DISTANCE + shadowRadius * 4;
  shadowCamera.updateProjectionMatrix();

  houseShadowReceiverMaterial.opacity = HOUSE_SHADOW_OPACITY;
  // Debounce: only re-render shadow map when light moved meaningfully
  const posDelta = _lastHouseShadowPos.distanceTo(houseShadowCasterLight.position);
  const dirDelta = _lastHouseShadowDir.distanceTo(houseShadowLightDirectionLocal);
  const radiusDelta = Math.abs(shadowRadius - _lastHouseShadowRadius);
  if (posDelta > HOUSE_SHADOW_MOVE_THRESHOLD || dirDelta > 0.001 || radiusDelta > 0.5) {
    houseShadowCasterLight.shadow.needsUpdate = true;
    _lastHouseShadowPos.copy(houseShadowCasterLight.position);
    _lastHouseShadowDir.copy(houseShadowLightDirectionLocal);
    _lastHouseShadowRadius = shadowRadius;
  }
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
let lastRenderedDate = new Date(currentDate);

function applyDate(date) {
  lastRenderedDate = date;
  getSunDirectionECEF(date, sunDirection);
  aerialPerspective.sunDirection.copy(sunDirection);
  cloudsEffect.sunDirection.copy(sunDirection);
}
function getGameDateFromBrowserTime(nowMs = Date.now()) {
  const elapsedMs = nowMs - browserTimeStartMs;
  return new Date(gameClockStartMs + elapsedMs * GAME_TIME_SCALE);
}
buildTuningControls(aerialPerspective, cloudsEffect);
// Only apply the default referenceDate if no saved tuning overrides month/hour.
// buildTuningControls already calls applyDate() when restoring saved values.
if (useRealtimeGameClock) {
  applyDate(getGameDateFromBrowserTime());
}

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

// MSAA on the composer — the renderer's antialias:true does nothing when
// postprocessing renders to its own framebuffers. Without this, everything
// (terrain, vehicle, mountains) gets zero anti-aliasing.
const composer = new EffectComposer(renderer, {
  frameBufferType: THREE.HalfFloatType,
  multisampling: Math.min(4, renderer.capabilities.maxSamples)
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

const OCEAN_CLASSIFIER_ENABLED = params.get('oceanClassifier') !== '0';
const OCEAN_EDGE_SEED_MAX_M = paramNumber('oceanEdgeSeedMaxM', 1.5);
const OCEAN_EDGE_PASSABLE_MAX_M = Math.max(
  OCEAN_EDGE_SEED_MAX_M,
  paramNumber('oceanEdgePassableMaxM', 5.0)
);
const OCEAN_PASSABLE_MAX_M = Math.max(
  OCEAN_EDGE_PASSABLE_MAX_M,
  paramNumber('oceanPassableMaxM', 12.0)
);
const OCEAN_EDGE_SEED_SLOPE_MAX = Math.max(0.02, paramNumber('oceanEdgeSeedSlopeMax', 0.22));
const OCEAN_PASSABLE_SLOPE_MAX = Math.max(
  OCEAN_EDGE_SEED_SLOPE_MAX,
  paramNumber('oceanPassableSlopeMax', 0.48)
);
const OCEAN_SEA_LEVEL_M = paramNumber('oceanSeaLevelM', 0.0);
const OCEAN_SHORE_BLEND_M = Math.max(0.5, paramNumber('oceanShoreBlendM', 8.0));
const OCEAN_BASE_DROP_M = Math.max(0.0, paramNumber('oceanBaseDropM', 3.0));
const OCEAN_DEPTH_GAIN = Math.max(0.0, paramNumber('oceanDepthGain', 0.8));
const OCEAN_MAX_DROP_M = Math.max(OCEAN_BASE_DROP_M, paramNumber('oceanMaxDropM', 16.0));
const OCEAN_EDGE_CACHE_MAX = Math.max(512, Math.floor(paramNumber('oceanEdgeCacheMax', 30000)));
const oceanEdgeState = new Map();
let oceanMapDebugEnabled = params.get('oceanMapDebug') === '1';
const OCEAN_COLOR_ASSIST_ENABLED = params.get('oceanColorAssist') !== '0';
const OCEAN_COLOR_SCORE_MIN = THREE.MathUtils.clamp(paramNumber('oceanColorScoreMin', 0.20), 0.0, 1.0);
const OCEAN_COLOR_PASSABLE_SCORE_MIN = THREE.MathUtils.clamp(
  paramNumber('oceanColorPassableScoreMin', 0.18),
  0.0,
  1.0
);
const OCEAN_COLOR_PASSABLE_MAX_M = Math.max(
  OCEAN_PASSABLE_MAX_M,
  OCEAN_PASSABLE_MAX_M + Math.max(0.0, paramNumber('oceanColorPassableExtraM', 12.0))
);
const OCEAN_COLOR_EDGE_MAX_M = Math.max(
  OCEAN_EDGE_PASSABLE_MAX_M,
  OCEAN_EDGE_PASSABLE_MAX_M + Math.max(0.0, paramNumber('oceanColorEdgeExtraM', 10.0))
);
const OCEAN_COLOR_SLOPE_MAX = Math.max(0.02, paramNumber('oceanColorSlopeMax', 0.90));
const OCEAN_GHOST_BRIDGE_ENABLED = params.get('oceanGhostBridge') !== '0';
const OCEAN_GHOST_GAP_PX = Math.max(1, Math.floor(paramNumber('oceanGhostGapPx', 10)));
const OCEAN_GHOST_SCORE_MIN = THREE.MathUtils.clamp(paramNumber('oceanGhostScoreMin', 0.10), 0.0, 1.0);
const OCEAN_GHOST_MIN_SCORE_FRACTION = THREE.MathUtils.clamp(paramNumber('oceanGhostMinScoreFrac', 0.30), 0.0, 1.0);
const OCEAN_GHOST_MAX_ELEV_M = Math.max(OCEAN_COLOR_EDGE_MAX_M, paramNumber('oceanGhostMaxElevM', 28.0));
const OCEAN_GHOST_MAX_SLOPE = Math.max(0.05, paramNumber('oceanGhostMaxSlope', 1.40));
const oceanSampleCanvas = document.createElement('canvas');
const oceanSampleCtx = oceanSampleCanvas.getContext('2d', { willReadFrequently: true });

function parseTileAddress(tileId) {
  if (typeof tileId !== 'string') return null;
  const parts = tileId.split('-');
  if (parts.length !== 3) return null;
  const depth = Number.parseInt(parts[0], 10);
  const col = Number.parseInt(parts[1], 10);
  const row = Number.parseInt(parts[2], 10);
  if (!Number.isFinite(depth) || !Number.isFinite(col) || !Number.isFinite(row)) return null;
  return { depth, col, row };
}

function tileIdFromAddress(depth, col, row) {
  return `${depth}-${col}-${row}`;
}

function neighborOceanSeeds(tileId, res) {
  const address = parseTileAddress(tileId);
  if (!address) return null;
  const { depth, col, row } = address;
  const north = oceanEdgeState.get(tileIdFromAddress(depth, col, row + 1));
  const south = oceanEdgeState.get(tileIdFromAddress(depth, col, row - 1));
  const east = oceanEdgeState.get(tileIdFromAddress(depth, col + 1, row));
  const west = oceanEdgeState.get(tileIdFromAddress(depth, col - 1, row));
  return {
    N: north && north.S?.length === res ? north.S : null,
    S: south && south.N?.length === res ? south.N : null,
    E: east && east.W?.length === res ? east.W : null,
    W: west && west.E?.length === res ? west.E : null,
  };
}

function cacheOceanEdges(tileId, res, mask) {
  const edgeN = new Uint8Array(res);
  const edgeS = new Uint8Array(res);
  const edgeE = new Uint8Array(res);
  const edgeW = new Uint8Array(res);
  const last = res - 1;
  for (let i = 0; i < res; i++) {
    edgeS[i] = mask[i];
    edgeN[i] = mask[last * res + i];
    edgeW[i] = mask[i * res];
    edgeE[i] = mask[i * res + last];
  }
  oceanEdgeState.set(tileId, { N: edgeN, S: edgeS, E: edgeE, W: edgeW });
  if (oceanEdgeState.size > OCEAN_EDGE_CACHE_MAX) {
    const oldest = oceanEdgeState.keys().next().value;
    if (oldest != null) oceanEdgeState.delete(oldest);
  }
}

function sampleOceanBlueScore(texture, res) {
  if (!OCEAN_COLOR_ASSIST_ENABLED || !texture || !texture.image || !oceanSampleCtx) return null;
  try {
    if (oceanSampleCanvas.width !== res || oceanSampleCanvas.height !== res) {
      oceanSampleCanvas.width = res;
      oceanSampleCanvas.height = res;
    }
    oceanSampleCtx.clearRect(0, 0, res, res);
    oceanSampleCtx.drawImage(texture.image, 0, 0, res, res);
    const data = oceanSampleCtx.getImageData(0, 0, res, res).data;
    const score = new Float32Array(res * res);
    for (let i = 0; i < res * res; i++) {
      const o = i * 4;
      const r = data[o] / 255.0;
      const g = data[o + 1] / 255.0;
      const b = data[o + 2] / 255.0;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const sat = (mx - mn) / Math.max(mx, 1e-6);
      const blueDom = b - Math.max(r, g);
      const blueScore = THREE.MathUtils.clamp((blueDom - 0.02) / 0.22, 0.0, 1.0);
      const blueCyan = THREE.MathUtils.clamp((b - 0.5 * r - 0.35 * g) / 0.24, 0.0, 1.0);
      const baseBlue = Math.max(blueScore, blueCyan) * THREE.MathUtils.clamp((sat + 0.05) / 0.35, 0.0, 1.0);
      const redSupp = THREE.MathUtils.clamp((Math.max(g, b) - r - 0.01) / 0.28, 0.0, 1.0);
      const cyanGreen = THREE.MathUtils.clamp((g + b - 1.15 * r - 0.18) / 0.55, 0.0, 1.0);
      const ndwi = THREE.MathUtils.clamp(((g - r) / Math.max(g + r, 1e-6) + 0.08) / 0.55, 0.0, 1.0);
      const lumGate = THREE.MathUtils.clamp((0.95 - mx) / 0.60, 0.0, 1.0);
      const satGate = THREE.MathUtils.clamp((0.92 - sat) / 0.70, 0.0, 1.0);
      const greenishWater = Math.max(cyanGreen * redSupp, ndwi * redSupp) * lumGate * satGate;
      score[i] = Math.max(baseBlue, greenishWater);
    }
    return score;
  } catch {
    return null;
  }
}

function bridgeOceanGhostGaps(ocean, passable, hm, slopeArr, score, res) {
  if (!ocean || !passable || !hm || !slopeArr || !score) return;

  const fillLine = (indexForPos) => {
    for (let line = 0; line < res; line++) {
      let pos = 0;
      while (pos < res) {
        while (pos < res && ocean[indexForPos(line, pos)] === 1) pos += 1;
        if (pos >= res) break;
        const start = pos;
        while (pos < res && ocean[indexForPos(line, pos)] !== 1) pos += 1;
        const end = pos - 1;
        if (start <= 0 || end >= res - 1) continue;
        if (ocean[indexForPos(line, start - 1)] !== 1 || ocean[indexForPos(line, end + 1)] !== 1) continue;
        const gap = end - start + 1;
        if (gap <= 0 || gap > OCEAN_GHOST_GAP_PX) continue;

        let scoreHits = 0;
        let maxElev = -Infinity;
        let maxSlope = -Infinity;
        for (let at = start; at <= end; at++) {
          const idx = indexForPos(line, at);
          if (score[idx] >= OCEAN_GHOST_SCORE_MIN) scoreHits += 1;
          if (hm[idx] > maxElev) maxElev = hm[idx];
          if (slopeArr[idx] > maxSlope) maxSlope = slopeArr[idx];
        }
        const scoreFraction = scoreHits / gap;
        if (
          scoreFraction >= OCEAN_GHOST_MIN_SCORE_FRACTION &&
          maxElev <= OCEAN_GHOST_MAX_ELEV_M &&
          maxSlope <= OCEAN_GHOST_MAX_SLOPE
        ) {
          for (let at = start; at <= end; at++) {
            const idx = indexForPos(line, at);
            ocean[idx] = 1;
            passable[idx] = 1;
          }
        }
      }
    }
  };

  // Two passes lets row/col bridges reinforce each other.
  for (let iter = 0; iter < 2; iter++) {
    fillLine((row, col) => row * res + col); // rows
    fillLine((col, row) => row * res + col); // columns
  }
}

function classifyOceanMask(hm, res, bbox, tileId, blueScore = null) {
  if (!OCEAN_CLASSIFIER_ENABLED || !hm || hm.length !== res * res) return null;
  const spanX = Math.max(1.0, bbox[2] - bbox[0]);
  const spanY = Math.max(1.0, bbox[3] - bbox[1]);
  const pxX = spanX / Math.max(1, res - 1);
  const pxY = spanY / Math.max(1, res - 1);
  const count = res * res;
  const passable = new Uint8Array(count);
  const seed = new Uint8Array(count);
  const ocean = new Uint8Array(count);
  const slopeArr = new Float32Array(count);
  const neighborSeeds = neighborOceanSeeds(tileId, res);

  for (let r = 0; r < res; r++) {
    for (let c = 0; c < res; c++) {
      const idx = r * res + c;
      const e = hm[idx];
      const westIdx = r * res + Math.max(c - 1, 0);
      const eastIdx = r * res + Math.min(c + 1, res - 1);
      const southIdx = Math.max(r - 1, 0) * res + c;
      const northIdx = Math.min(r + 1, res - 1) * res + c;
      const dEdx = (hm[eastIdx] - hm[westIdx]) / ((c > 0 && c < res - 1) ? (2.0 * pxX) : pxX);
      const dEdy = (hm[northIdx] - hm[southIdx]) / ((r > 0 && r < res - 1) ? (2.0 * pxY) : pxY);
      const slope = Math.hypot(dEdx, dEdy);
      slopeArr[idx] = slope;
      const colorWater = blueScore ? blueScore[idx] >= OCEAN_COLOR_PASSABLE_SCORE_MIN : false;
      const basePassable = e <= OCEAN_PASSABLE_MAX_M && slope <= OCEAN_PASSABLE_SLOPE_MAX;
      const colorPassable = colorWater && e <= OCEAN_COLOR_PASSABLE_MAX_M && slope <= OCEAN_COLOR_SLOPE_MAX;
      const isPassable = basePassable || colorPassable;
      if (!isPassable) continue;
      passable[idx] = 1;
      const atSouth = r === 0;
      const atNorth = r === res - 1;
      const atWest = c === 0;
      const atEast = c === res - 1;
      if (!(atSouth || atNorth || atWest || atEast)) continue;
      let seededByNeighbor = false;
      if (atNorth && neighborSeeds?.N) {
        seededByNeighbor = neighborSeeds.N[c] === 1;
      } else if (atSouth && neighborSeeds?.S) {
        seededByNeighbor = neighborSeeds.S[c] === 1;
      } else if (atEast && neighborSeeds?.E) {
        seededByNeighbor = neighborSeeds.E[r] === 1;
      } else if (atWest && neighborSeeds?.W) {
        seededByNeighbor = neighborSeeds.W[r] === 1;
      }
      const baseSeed = e <= OCEAN_EDGE_SEED_MAX_M && slope <= OCEAN_EDGE_SEED_SLOPE_MAX;
      const colorSeed = colorWater && e <= OCEAN_COLOR_EDGE_MAX_M && slope <= OCEAN_COLOR_SLOPE_MAX;
      if (seededByNeighbor || baseSeed || colorSeed) {
        seed[idx] = 1;
      }
    }
  }

  const queue = new Int32Array(count);
  let qHead = 0;
  let qTail = 0;
  for (let i = 0; i < count; i++) {
    if (seed[i] !== 1 || passable[i] !== 1) continue;
    ocean[i] = 1;
    queue[qTail++] = i;
  }
  while (qHead < qTail) {
    const idx = queue[qHead++];
    const r = Math.floor(idx / res);
    const c = idx - r * res;
    if (r > 0) {
      const up = idx - res;
      if (passable[up] === 1 && ocean[up] === 0) {
        ocean[up] = 1;
        queue[qTail++] = up;
      }
    }
    if (r + 1 < res) {
      const down = idx + res;
      if (passable[down] === 1 && ocean[down] === 0) {
        ocean[down] = 1;
        queue[qTail++] = down;
      }
    }
    if (c > 0) {
      const left = idx - 1;
      if (passable[left] === 1 && ocean[left] === 0) {
        ocean[left] = 1;
        queue[qTail++] = left;
      }
    }
    if (c + 1 < res) {
      const right = idx + 1;
      if (passable[right] === 1 && ocean[right] === 0) {
        ocean[right] = 1;
        queue[qTail++] = right;
      }
    }
  }

  const last = res - 1;
  for (let i = 0; i < res; i++) {
    const edgeCells = [
      { idx: i, neighbor: neighborSeeds?.S ? neighborSeeds.S[i] : null },
      { idx: last * res + i, neighbor: neighborSeeds?.N ? neighborSeeds.N[i] : null },
      { idx: i * res, neighbor: neighborSeeds?.W ? neighborSeeds.W[i] : null },
      { idx: i * res + last, neighbor: neighborSeeds?.E ? neighborSeeds.E[i] : null },
    ];
    for (const edge of edgeCells) {
      if (passable[edge.idx] !== 1) {
        ocean[edge.idx] = 0;
        continue;
      }
      if (edge.neighbor != null) {
        ocean[edge.idx] = edge.neighbor === 1 ? 1 : 0;
        continue;
      }
      const colorWater = blueScore ? blueScore[edge.idx] >= OCEAN_COLOR_PASSABLE_SCORE_MIN : false;
      const edgePassableByHeight = hm[edge.idx] <= OCEAN_EDGE_PASSABLE_MAX_M;
      const edgePassableByColor = colorWater && hm[edge.idx] <= OCEAN_COLOR_EDGE_MAX_M && slopeArr[edge.idx] <= OCEAN_COLOR_SLOPE_MAX;
      if (edgePassableByHeight || edgePassableByColor) {
        ocean[edge.idx] = 1;
      }
    }
  }

  if (OCEAN_GHOST_BRIDGE_ENABLED && blueScore) {
    bridgeOceanGhostGaps(ocean, passable, hm, slopeArr, blueScore, res);
  }

  cacheOceanEdges(tileId, res, ocean);
  return { ocean, passable, seed };
}

function adjustedSeabedElevation(e, isOcean) {
  if (!isOcean) return e;
  const depthInput = Math.max(0.0, OCEAN_SEA_LEVEL_M - e);
  const shoreFactor = THREE.MathUtils.clamp((e - OCEAN_SEA_LEVEL_M) / OCEAN_SHORE_BLEND_M, 0.0, 1.0);
  const shoreFade = 1.0 - (shoreFactor * shoreFactor * (3.0 - 2.0 * shoreFactor));
  const drop = Math.min(OCEAN_MAX_DROP_M, (OCEAN_BASE_DROP_M + depthInput * OCEAN_DEPTH_GAIN) * shoreFade);
  return e - drop;
}

function buildMesh(tile, oceanAssistTex = null) {
  const res = tile.resolution, hm = decodeHM(tile.heightmap);
  const [xMin, yMin, xMax, yMax] = tile.bbox;
  const blueScore = sampleOceanBlueScore(oceanAssistTex, res);
  const oceanClass = classifyOceanMask(hm, res, [xMin, yMin, xMax, yMax], tile.id, blueScore);
  const oceanMask = oceanClass?.ocean ?? null;
  const passableMask = oceanClass?.passable ?? null;
  const seedMask = oceanClass?.seed ?? null;
  const pos = new Float32Array(res * res * 3);
  const col = new Float32Array(res * res * 3);
  const uv = new Float32Array(res * res * 2);
  let oceanCount = 0;

  for (let r = 0; r < res; r++) for (let c = 0; c < res; c++) {
    const i = r * res + c, e = hm[i];
    const isOcean = oceanMask ? oceanMask[i] === 1 : e <= OCEAN_EDGE_SEED_MAX_M;
    const isPassable = passableMask ? passableMask[i] === 1 : false;
    const isSeed = seedMask ? seedMask[i] === 1 : false;
    const adjusted = adjustedSeabedElevation(e, isOcean);
    pos[i * 3]     = xMin + (c / (res - 1)) * (xMax - xMin);
    pos[i * 3 + 1] = yMin + (r / (res - 1)) * (yMax - yMin);
    pos[i * 3 + 2] = adjusted * EXAG;
    uv[i * 2] = c / (res - 1);
    uv[i * 2 + 1] = r / (res - 1);
    if (isOcean) {
      oceanCount += 1;
      col[i * 3] = 0.04; col[i * 3 + 1] = 0.68; col[i * 3 + 2] = 0.95;
    } else if (isSeed) {
      col[i * 3] = 0.88; col[i * 3 + 1] = 0.16; col[i * 3 + 2] = 0.80;
    } else if (isPassable) {
      col[i * 3] = 0.96; col[i * 3 + 1] = 0.58; col[i * 3 + 2] = 0.12;
    } else {
      const cl = eColor(e); col[i * 3] = cl.r; col[i * 3 + 1] = cl.g; col[i * 3 + 2] = cl.b;
    }
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
  // NOTE: Must be MeshBasicMaterial, NOT MeshStandardMaterial!
  // MeshStandardMaterial needs scene lights to render — without them all textured
  // tiles (water, lakes, etc.) turn grey. We tried MeshStandardMaterial to get
  // vehicle headlights to illuminate terrain but it breaks everything else.
  // If we revisit headlight-on-terrain lighting, add scene lights first.
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff, side: THREE.FrontSide,
    vertexColors: true,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.userData.tileId = tile.id;
  mesh.userData.bbox = tile.bbox;
  mesh.userData.isWater = oceanCount > 0;
  mesh.userData.oceanCoverage = oceanCount / (res * res);
  mesh.userData.oceanColorAssisted = Boolean(blueScore);
  mesh.userData.oceanTextureSig = oceanAssistTex ? oceanAssistTex.uuid : null;
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
  const passTag = _loadPass === 1 ? '[P1-preview]' : '[P2-full]';
  const ts = (performance.now() / 1000).toFixed(1);
  tileHistory.get(tileId).push(`${ts}s ${passTag} ${msg}`);
  enqueueClientLog('debug', 'tile', { tileId, pass: _loadPass, msg, ts: `${ts}s` });
}

function applyTerrainMaterialMode(mesh, tex) {
  if (!mesh || !mesh.material) return;
  const useOceanOverlay = oceanMapDebugEnabled && controls.mapMode;
  if (useOceanOverlay) {
    mesh.material.map = null;
    mesh.material.vertexColors = true;
    mesh.material.color.set(0xffffff);
    mesh.material.needsUpdate = true;
    return;
  }
  if (tex) mesh.material.map = tex;
  mesh.material.vertexColors = false;
  mesh.material.color.set(0xffffff);
  mesh.material.needsUpdate = true;
}

function rebuildTileMeshWithTexture(mesh, tile, tex) {
  if (!mesh || !tile || !tile.heightmap || !tex) return mesh;
  const depth = tileDepthFromId(tile.id);
  const texSig = tex.uuid;
  const alreadyAssisted = Boolean(mesh.userData?.oceanColorAssisted);
  const assistedSig = mesh.userData?.oceanTextureSig;
  if (alreadyAssisted && assistedSig === texSig) return mesh;

  const rebuilt = buildMesh(tile, tex);
  if (!rebuilt) return mesh;
  rebuilt.material.polygonOffset = true;
  rebuilt.material.polygonOffsetFactor = -depth;
  rebuilt.material.polygonOffsetUnits = -depth;
  rebuilt.userData.waterMask = mesh.userData?.waterMask ?? null;
  terrainRoot.add(rebuilt);
  terrainRoot.remove(mesh);
  if (mesh.geometry) mesh.geometry.dispose();
  if (mesh.material) mesh.material.dispose();
  return rebuilt;
}

function materializeTile(tileId, tex) {
  const tileData = deferredTiles.get(tileId);
  if (!tileData) return;
  deferredTiles.delete(tileId);
  tileLog(tileId, `materialize tex=${tex.image.width}x${tex.image.height}`);
  const mesh = buildMesh(tileData, tex);
  if (!mesh) return;
  applyTerrainMaterialMode(mesh, tex);
  mesh.userData.waterMask = waterMaskCache.get(tileId) || null;
  const depth = parseInt(tileId.split('-')[0]);
  mesh.material.polygonOffset = true;
  mesh.material.polygonOffsetFactor = -depth;
  mesh.material.polygonOffsetUnits = -depth;
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
  if (vehicleNearTileBbox(mesh.userData?.bbox)) {
    const newDepth = tileDepthFromId(tileId);
    const reason = Number.isFinite(newDepth) && newDepth > vehicleLastContactDepth
      ? `terrain-refined-${vehicleLastContactDepth}->${newDepth}`
      : 'terrain-materialized-near-vehicle';
    requestVehicleTerrainResnap(reason);
  }
}

// --- Texture streaming ---

const texCache = new Map();
const texSource = new Map();
const texInflight = new Map();
const texFetching = new Set();
const texRetryAtMs = new Map();
const texRetryCount = new Map();  // tid -> number of consecutive 202 retries
const waterMaskCache = new Map();
const waterMaskInflight = new Map();
const ENABLE_WATER_MASKS = false;
const TEX_MAX = 120; // max concurrent HTTP texture requests (texFetching 202s don't count)
const TEX_RETRY_202_BASE_MS = 2000;   // initial 202 retry delay
const TEX_RETRY_202_MAX_MS = 30000;   // cap backoff at 30s
const TEX_RETRY_ERROR_MS = 3000;
const TEX_REPOLL_BATCH = 8;           // max 202 re-polls fired per frame
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
    let mesh = meshMap.get(t.id);
    if (!mesh) continue;
    mesh = rebuildTileMeshWithTexture(mesh, t, tex);
    meshMap.set(t.id, mesh);
    const useOceanOverlay = oceanMapDebugEnabled && controls.mapMode;
    if (!useOceanOverlay && mesh.material.map !== tex) {
      tileLog(t.id, `apply cached tex (src=${texSource.get(t.id) || '?'})`);
    }
    applyTerrainMaterialMode(mesh, tex);
    mesh.userData.waterMask = waterMaskCache.get(t.id) || null;
  }



  // Fire fetches for hottest uncached tiles (priority-sorted by heatmap).
  // Only count actual HTTP requests (texInflight) against TEX_MAX — NOT
  // texFetching (202 server-pending). Previously texFetching counted too,
  // which starved close tiles when many distant tiles were server-pending.
  const nowMs = performance.now();
  let repollBudget = TEX_REPOLL_BATCH; // limit 202 re-polls per frame
  for (const { tile } of scored) {
    if (texInflight.size >= TEX_MAX) break;
    if (texCache.has(tile.id) || texInflight.has(tile.id)) continue;
    if (texFetching.has(tile.id)) {
      const pendingRetryAt = texRetryAtMs.get(tile.id) ?? 0;
      if (pendingRetryAt > nowMs) continue;
      if (repollBudget <= 0) continue;  // don't remove from texFetching if no budget
      repollBudget--;
      texFetching.delete(tile.id);
    }
    const retryAt = texRetryAtMs.get(tile.id) ?? 0;
    if (retryAt > nowMs) continue;
    texRetryAtMs.delete(tile.id);
    if (_coveredByEnhancedParent(tile)) continue;

    const ac = new AbortController();
    texInflight.set(tile.id, ac);
    const tid = tile.id;
    const t = tile;
    // tileLog(tid, `fetch start (inflight=${texInflight.size}/${TEX_MAX})`);
    fetch(`/api/texture/${tid}.jpg?v=${_texV}`, { signal: ac.signal })
      .then(r => {
        texInflight.delete(tid);
        if (r.status === 202) {
          const n = (texRetryCount.get(tid) || 0) + 1;
          texRetryCount.set(tid, n);
          const delay = Math.min(TEX_RETRY_202_BASE_MS * Math.pow(1.5, n - 1), TEX_RETRY_202_MAX_MS);
          tileLog(tid, `fetch -> 202 (server fetching, retry #${n} in ${(delay/1000).toFixed(1)}s)`);
          texFetching.add(tid);
          texRetryAtMs.set(tid, performance.now() + delay);
          return;
        }
        if (!r.ok) {
          tileLog(tid, `fetch -> HTTP ${r.status}`);
          throw new Error(r.status);
        }
        const ancestorHeader = r.headers.get('X-Tex-Ancestor');
        return r.blob()
          .then(blob => createImageBitmap(blob, { imageOrientation: 'flipY' }))
          .then(bmp => {
            texFetching.delete(tid);
            texRetryAtMs.delete(tid);
            const isAncestorCrop = !!ancestorHeader;
            const texSrc = r.headers.get('X-Tex-Source') || '';
            tileLog(tid, `fetch -> ${bmp.width}x${bmp.height}${isAncestorCrop ? ' ANCESTOR=' + ancestorHeader : ''} src=${texSrc}`);
            const tex = new THREE.Texture(bmp);
            tex.flipY = false;
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.needsUpdate = true;
            if (isAncestorCrop) {
              const n = (texRetryCount.get(tid) || 0) + 1;
              texRetryCount.set(tid, n);
              const delay = Math.min(TEX_RETRY_202_BASE_MS * Math.pow(1.5, n - 1), TEX_RETRY_202_MAX_MS);
              tileLog(tid, `ancestor crop from ${ancestorHeader} — placeholder applied, retry #${n} in ${(delay/1000).toFixed(1)}s`);
              _ancestorLogged.add(tid);
              texFetching.add(tid);
              texRetryAtMs.set(tid, performance.now() + delay);
              // Apply ancestor texture as placeholder (don't cache — will re-fetch for sharp version)
              let mesh = null;
              for (const child of terrainRoot.children) {
                if (child.userData.tileId === tid) { mesh = child; break; }
              }
              if (mesh) {
                applyTerrainMaterialMode(mesh, tex);
              }
            } else {
              _ancestorLogged.delete(tid);
              texRetryCount.delete(tid);
              texCache.set(tid, tex);
              texSource.set(tid, texSrc);
              requestWaterMask(tid);
              tryEvictParent(tid); // boot parent ASAP if all 4 quad siblings are now cached
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
                  mesh = rebuildTileMeshWithTexture(mesh, t, tex);
                  applyTerrainMaterialMode(mesh, tex);
                  mesh.userData.waterMask = waterMaskCache.get(tid) || null;
                } else {
                  tileLog(tid, `cached but NO mesh in scene`);
                }
              }
            }
          });
      })
      .catch(err => {
        texInflight.delete(tid);
        texRetryAtMs.set(tid, performance.now() + TEX_RETRY_ERROR_MS);
        if (err.name !== 'AbortError') {
          tileLog(tid, `fetch error: ${err.message} (retry in ${TEX_RETRY_ERROR_MS}ms)`);
          console.warn(`[TEX] ${tid}:`, err.message);
        }
      });
  }

  // ── Eager parent eviction ──────────────────────────────────────
  // Problem: the normal stale-parent sweeps only run on fetchTiles()
  // and the 1 Hz updateTextures() cycle, so a low-LOD parent (e.g. 11-x)
  // can linger visually on top of its higher-LOD children (e.g. 12-x)
  // for up to a full second after all four children are textured.
  // Because texture fetches are heatmap-sorted (closest-first), nearby
  // parents are the ones that suffer most — their children arrive early
  // but the parent hangs around until the next sweep.
  //
  // Fix: each time a child texture lands and enters texCache, check
  // whether all 4 siblings in that quad now have cached textures.
  // If so, the parent mesh is fully occluded and can be removed
  // immediately. This is a fast-path supplement — the existing sweep
  // logic in updateTextures() and fetchTiles() remains as a safety net.
  function tryEvictParent(childTileId) {
    const addr = parseTileAddress(childTileId);
    if (!addr || addr.depth <= 0) return;
    // Derive parent address: each parent tile covers a 2×2 quad of children.
    // Integer-dividing the child col/row by 2 gives the parent col/row.
    const pCol = addr.col >> 1, pRow = addr.row >> 1;
    const parentId = tileIdFromAddress(addr.depth - 1, pCol, pRow);
    // Check all 4 children in this quad — bail if any is still missing.
    const missingSiblings = [];
    for (let dx = 0; dx < 2; dx++) {
      for (let dy = 0; dy < 2; dy++) {
        const sibId = tileIdFromAddress(addr.depth, pCol * 2 + dx, pRow * 2 + dy);
        if (!texCache.has(sibId)) missingSiblings.push(sibId);
      }
    }
    if (missingSiblings.length > 0) {
      tileLog(parentId, `evict-check — ${missingSiblings.length}/4 siblings still missing: ${missingSiblings.join(', ')} (triggered by ${childTileId})`);
      return;
    }
    // All 4 children textured — find and remove the parent mesh.
    let found = false;
    for (const c of terrainRoot.children) {
      if (c.userData.tileId === parentId) {
        tileLog(parentId, `evicted — eager (all children textured, triggered by ${childTileId})`);
        terrainRoot.remove(c);
        if (c.geometry) c.geometry.dispose();
        if (c.material) c.material.dispose();
        found = true;
        break;
      }
    }
    if (!found) {
      tileLog(parentId, `evict-check — all 4 children textured but parent not in scene (triggered by ${childTileId})`);
    }
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
          applyTerrainMaterialMode(child, tex);
          child.userData.waterMask = waterMaskCache.get(tid) || null;
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
  const lat = anchorLat + northM / 111320;
  const lon = anchorLon + eastM / (111320 * Math.cos(anchorLat * Math.PI / 180));
  return { lat, lon, alt: altM };
}

function getCameraLogSnapshot(camLL = null) {
  const ll = camLL ?? getCameraLatLon();
  const rel = camera.position.clone().sub(anchorPosition);
  const eastM = rel.dot(east);
  const northM = rel.dot(north);
  const upM = rel.dot(up);
  const camStereoApproxX = originX + (ll.lon - anchorLon) * 111320 * Math.cos(anchorLat * Math.PI / 180);
  const camStereoApproxY = originY + (ll.lat - anchorLat) * 111320;
  const num = (value, digits) => (
    Number.isFinite(value) ? Number(value.toFixed(digits)) : null
  );
  return {
    camLat: num(ll.lat, 8),
    camLon: num(ll.lon, 8),
    camAltM: num(ll.alt, 2),
    camEastM: num(eastM, 1),
    camNorthM: num(northM, 1),
    camUpM: num(upM, 1),
    camStereoApproxX: num(camStereoApproxX, 1),
    camStereoApproxY: num(camStereoApproxY, 1),
    originX: num(originX, 1),
    originY: num(originY, 1),
    tileFrameOffsetX: num(tileFrameOffsetX, 1),
    tileFrameOffsetY: num(tileFrameOffsetY, 1),
    tileFrameOffsetReady,
  };
}

function applyTileFrameOffsetToPayload(data) {
  if (!tileFrameOffsetReady || !data) return;
  if (Array.isArray(data.tiles)) {
    for (const tile of data.tiles) {
      if (!Array.isArray(tile?.bbox) || tile.bbox.length !== 4) continue;
      tile.bbox = [
        tile.bbox[0] + tileFrameOffsetX,
        tile.bbox[1] + tileFrameOffsetY,
        tile.bbox[2] + tileFrameOffsetX,
        tile.bbox[3] + tileFrameOffsetY,
      ];
    }
  }
  if (Array.isArray(data.missing)) {
    for (const miss of data.missing) {
      if (!Array.isArray(miss?.bbox) || miss.bbox.length !== 4) continue;
      miss.bbox = [
        miss.bbox[0] + tileFrameOffsetX,
        miss.bbox[1] + tileFrameOffsetY,
        miss.bbox[2] + tileFrameOffsetX,
        miss.bbox[3] + tileFrameOffsetY,
      ];
    }
  }
}

// --- Tile fetching ---

let pollTimer = null;

const PREVIEW_MAX_DEPTH = 10;
const clock = new THREE.Clock();

async function fetchTiles(lat, lon) {
  if (fetching) {
    enqueueClientLog('debug', 'fetchTiles.skip', {
      reason: 'already fetching',
      ...getCameraLogSnapshot(),
    });
    return;
  }
  fetching = true;
  try {
    const t0 = performance.now();
    const heading = controls.yaw;
    const camLL = getCameraLatLon();
    const camSnapshot = getCameraLogSnapshot(camLL);
    const fetchLat = lat ?? camLL.lat;
    const fetchLon = lon ?? camLL.lon;
    const fetchAlt = camLL.alt;
    let url;
    if (isFirstLoad) {
      url = `/api/tiles?lat=${fetchLat}&lon=${fetchLon}&alt=${fetchAlt}&heading=${heading}&maxDepth=${PREVIEW_MAX_DEPTH}&range=${_terrainRange}`;
    } else {
      url = `/api/tiles?lat=${fetchLat}&lon=${fetchLon}&ox=${originX}&oy=${originY}&alt=${fetchAlt}&heading=${heading}&range=${_terrainRange}`;
    }
    enqueueClientLog('info', `fetchTiles.request[pass${_loadPass}]`, {
      pass: _loadPass,
      passLabel: _loadPass === 1 ? 'preview' : 'full',
      isFirstLoad,
      requestLat: fetchLat,
      requestLon: fetchLon,
      requestAltM: fetchAlt,
      headingRad: heading,
      maxDepth: isFirstLoad ? PREVIEW_MAX_DEPTH : null,
      ...camSnapshot,
    });
    const resp = await fetch(url);
    const data = await resp.json();
    if (isFirstLoad && !tileFrameOffsetReady) {
      const rel = camera.position.clone().sub(anchorPosition);
      tileFrameOffsetX = rel.dot(east);
      tileFrameOffsetY = rel.dot(north);
      tileFrameOffsetReady = true;
      enqueueClientLog('info', 'fetchTiles.frame.offset.set', {
        pass: _loadPass,
        passLabel: _loadPass === 1 ? 'preview' : 'full',
        offsetX: Number(tileFrameOffsetX.toFixed(1)),
        offsetY: Number(tileFrameOffsetY.toFixed(1)),
        camEastM: camSnapshot.camEastM,
        camNorthM: camSnapshot.camNorthM,
      });
    }
    applyTileFrameOffsetToPayload(data);
    const withHm = data.tiles.filter(t => t.heightmap).length;
    const noHm = data.tiles.length - withHm;
    const camRel = camera.position.clone().sub(anchorPosition);
    const camLocalX = camRel.dot(east);
    const camLocalY = camRel.dot(north);
    let closestTileId = null;
    let closestTileDist = Infinity;
    let closestTileCx = null;
    let closestTileCy = null;
    for (const tile of data.tiles) {
      if (!Array.isArray(tile?.bbox) || tile.bbox.length !== 4) continue;
      const cx = (tile.bbox[0] + tile.bbox[2]) * 0.5;
      const cy = (tile.bbox[1] + tile.bbox[3]) * 0.5;
      const dx = cx - camLocalX;
      const dy = cy - camLocalY;
      const dist = Math.hypot(dx, dy);
      if (dist < closestTileDist) {
        closestTileDist = dist;
        closestTileId = tile.id ?? null;
        closestTileCx = cx;
        closestTileCy = cy;
      }
    }
    enqueueClientLog('info', `fetchTiles.response[pass${_loadPass}]`, {
      pass: _loadPass,
      passLabel: _loadPass === 1 ? 'preview' : 'full',
      status: resp.status,
      tiles: data.tiles.length,
      withHm,
      noHm,
      missing: data.missing?.length ?? 0,
      downloading: data.downloading?.length ?? 0,
      qx: Number.isFinite(data.qx) ? Number(data.qx.toFixed(1)) : null,
      qy: Number.isFinite(data.qy) ? Number(data.qy.toFixed(1)) : null,
      ox: Number.isFinite(data.ox) ? Number(data.ox.toFixed(1)) : null,
      oy: Number.isFinite(data.oy) ? Number(data.oy.toFixed(1)) : null,
      closestTileId,
      closestTileDistM: Number.isFinite(closestTileDist) ? Number(closestTileDist.toFixed(1)) : null,
      closestTileCx: Number.isFinite(closestTileCx) ? Number(closestTileCx.toFixed(1)) : null,
      closestTileCy: Number.isFinite(closestTileCy) ? Number(closestTileCy.toFixed(1)) : null,
      tileFrameOffsetX: Number(tileFrameOffsetX.toFixed(1)),
      tileFrameOffsetY: Number(tileFrameOffsetY.toFixed(1)),
      tileFrameOffsetReady,
    });
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
      enqueueClientLog('info', 'fetchTiles.origin.set', {
        pass: _loadPass,
        passLabel: _loadPass === 1 ? 'preview' : 'full',
        qx: Number.isFinite(data.qx) ? Number(data.qx.toFixed(1)) : null,
        qy: Number.isFinite(data.qy) ? Number(data.qy.toFixed(1)) : null,
        ox: Number.isFinite(data.ox) ? Number(data.ox.toFixed(1)) : null,
        oy: Number.isFinite(data.oy) ? Number(data.oy.toFixed(1)) : null,
        requestCamStereoApproxX: camSnapshot.camStereoApproxX,
        requestCamStereoApproxY: camSnapshot.camStereoApproxY,
        originDeltaX: Number.isFinite(data.ox) && Number.isFinite(camSnapshot.camStereoApproxX)
          ? Number((data.ox - camSnapshot.camStereoApproxX).toFixed(1))
          : null,
        originDeltaY: Number.isFinite(data.oy) && Number.isFinite(camSnapshot.camStereoApproxY)
          ? Number((data.oy - camSnapshot.camStereoApproxY).toFixed(1))
          : null,
      });
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

    // Evict stale meshes: remove any mesh not in the current tile set,
    // BUT only once every overlapping child has a cached texture.
    // This keeps heightmap ridgelines (and textured parents) visible
    // during the preview→full-depth transition instead of flashing to void.
    const staleToRemove = [];
    for (const child of terrainRoot.children) {
      if (!child.isMesh) continue;
      const tid = child.userData.tileId;
      if (!tid) continue;
      if (!newIds.has(tid)) {
        // NEVER purge a heightmap mesh just because it has no texture.
        // Those dark ridges in the distance are the only terrain visual
        // until higher-depth children arrive with textures.  Treat ALL
        // stale meshes (textured or not) the same: keep them visible
        // until every overlapping child has a cached texture.
        {
          const sb = child.userData.bbox;
          if (sb) {
            let coveredByChildren = true;
            let foundOverlap = false;
            const pdepth = parseInt(tid.split('-')[0]);
            for (const cid of newIds) {
              const cdepth = parseInt(cid.split('-')[0]);
              if (cdepth <= pdepth) continue;
              const cmesh = meshMap.get(cid);
              const cb = cmesh ? cmesh.userData.bbox : tileBboxMap.get(cid);
              if (!cb) continue;
              if (sb[0] <= cb[0] && sb[2] >= cb[2] && sb[1] <= cb[1] && sb[3] >= cb[3]) {
                foundOverlap = true;
                if (!texCache.has(cid)) { coveredByChildren = false; break; }
              }
            }
            if (!foundOverlap) coveredByChildren = false;
            if (coveredByChildren) {
              staleToRemove.push(child);
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

    enqueueClientLog('info', `fetchTiles.diff[pass${_loadPass}]`, { pass: _loadPass, passLabel: _loadPass === 1 ? 'preview' : 'full', added: added.length, removed: removed.length, purgedDeferred: purged, sceneMeshes: terrainRoot.children.filter(c => c.isMesh).length });

    if (added.length > 0) {
      const existingIds = new Set();
      for (const c of terrainRoot.children) {
        if (c.userData.tileId) existingIds.add(c.userData.tileId);
      }
      const addedSet = new Set(added);
      let built = 0, deferred = 0;
      const MESH_BUILD_BUDGET = 200; // max meshes to build per fetch
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
            tileLog(tile.id, `added — deferred (build budget exceeded, built=${built}/${MESH_BUILD_BUDGET})`);
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
            // Textured parent covers this area — defer until our texture
            // arrives so we don't z-fight with the parent.
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

    const meshesAfter = terrainRoot.children.filter(c => c.isMesh).length;
    enqueueClientLog('info', `fetchTiles.built[pass${_loadPass}]`, { pass: _loadPass, passLabel: _loadPass === 1 ? 'preview' : 'full', meshesInScene: meshesAfter, deferred: deferredTiles.size, staleRemoved: staleToRemove.length });

    updateTextures(data.tiles);
    markMissing(data.missing || [], data.downloading || []);
    lastTiles = data.tiles;

    // Update stereo position from camera
    const camLLNow = getCameraLatLon();
    camStereoX = originX + (camLLNow.lon - anchorLon) * 111320 * Math.cos(anchorLat * Math.PI / 180);
    camStereoY = originY + (camLLNow.lat - anchorLat) * 111320;
    lastFetchX = camStereoX;
    lastFetchY = camStereoY;

    const nm = _hmMissing = (data.missing || []).length;
    const nd = _hmDownloading = (data.downloading || []).length;
    const texInFlight = (data.texFetching || 0);
    _srvTexFetching = data.texFetching || 0;
    _srvTexRetry = data.texRetryQueue || 0;
    _srvTexStatus = data.texStatusCounts || {};

    if (pollTimer) clearTimeout(pollTimer);
    if (wasFirstLoad) {
      // Preview pass done — immediately fetch full-depth tiles.
      // The normal eviction/replacement logic will upgrade the low-LOD
      // preview tiles as higher-detail children arrive with textures.
      bootLog('tiles.pass1-preview-done', {
        pass: 1,
        previewTiles: data.tiles.length,
        maxDepth: PREVIEW_MAX_DEPTH,
        meshesInScene: terrainRoot.children.filter(c => c.isMesh).length,
        deferred: deferredTiles.size,
        elapsedMs: Number((performance.now() - t0).toFixed(1))
      });
      fetching = false;
      // DEBUG: Pass 2 disabled — sitting on Pass 1 only to verify
      // preview tiles actually render.
      // _loadPass = 2;
      // requestAnimationFrame(() => fetchTiles());
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
    const dLat = saved.lat - anchorLat;
    const dLon = saved.lon - anchorLon;
    const eM = dLon * 111320 * Math.cos(anchorLat * Math.PI / 180);
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
// Start tile fetch at the current camera location (which may have been restored
// from localStorage), not the static anchor location.
const initialCamLL = getCameraLatLon();
bootLog('tiles.initial-fetch.start', {
  cameraLat: Number(initialCamLL.lat.toFixed(6)),
  cameraLon: Number(initialCamLL.lon.toFixed(6)),
  anchorLat,
  anchorLon
});
fetchTiles();
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
loadVehicleState();
loadVehicleModel();

window.takramDebug = {
  sceneMode: 'clouds-terrain-managed-flask-ux-wip',
  cloudsEffect,
  aerialPerspective,
  referenceDate,
  anchorLat,
  anchorLon,
  controls,
  applyDate,
  bootEvents,
  getBootEvents: () => bootEvents.slice(),
  flushClientLogQueue: () => flushClientLogQueue(),
  fetchTiles,
  loadHouseModel,
  setHousesVisible: visible => setHousesRuntimeVisible(Boolean(visible), 'debug-api'),
  getHousesVisible: () => housesRuntimeVisible,
  saveVehicleState: reason => saveVehicleState(reason ?? 'debug-api'),
  loadVehicleState,
  setVehicleControlActive: active => setVehicleControlActive(Boolean(active), 'debug-api'),
  getVehicleControlActive: () => vehicleControlActive,
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
  mapCam.up.set(0, 0, 0)
    .addScaledVector(north, cosY)
    .addScaledVector(east, -sinY);
  mapCam.lookAt(target);
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
  const clamped = Math.max(MIN_FLIGHT_ALT, Math.min(6000, altitude));
  const delta = clamped - altitude;
  if (Math.abs(delta) > 1e-6) {
    camera.position.addScaledVector(up, delta);
  }
}

function isPressed(primary, secondary) {
  return controls.keys[primary] || controls.keys[secondary];
}

function updateCameraAGL() {
  const terrainMeshes = houseTerrainMeshes();
  if (terrainMeshes.length === 0) return;
  aglRaycaster.set(camera.position, up.clone().negate());
  const hits = aglRaycaster.intersectObjects(terrainMeshes);
  if (hits.length > 0) {
    cameraAGL = hits[0].distance;
  }
}

function aglSpeedFactor() {
  const t = Math.min(1, Math.max(0, cameraAGL / AGL_FULL_SPEED_M));
  return AGL_MIN_FACTOR + (1 - AGL_MIN_FACTOR) * t;
}

function updateMovement(dt) {
  const forwardPressed = isPressed('KeyW', 'ArrowUp');
  const backPressed = isPressed('KeyS', 'ArrowDown');
  const leftPressed = isPressed('KeyA', 'ArrowLeft');
  const rightPressed = isPressed('KeyD', 'ArrowRight');

  if (vehicleControlActive && !controls.mapMode) {
    controls.speed = 0;
    if (!vehicleLoaded) {
      setVehicleControlActive(false, 'vehicle-unloaded');
      return;
    }
    const steer = (leftPressed ? 1 : 0) + (rightPressed ? -1 : 0);
    if (steer !== 0) {
      vehicleHeadingRad += steer * VEHICLE_STEER_SPEED * dt;
    }
    const drive = (forwardPressed ? 1 : 0) + (backPressed ? -1 : 0);
    // Slope gravity: project downhill direction onto vehicle forward axis.
    // groundNormal.z ≈ 1 on flat ground; x/y components point "uphill" in local space.
    // Dot with forward gives slope component: negative = uphill, positive = downhill.
    const slopeForwardComponent = -(
      vehicleGroundNormal.x * (-Math.sin(vehicleHeadingRad)) +
      vehicleGroundNormal.y * Math.cos(vehicleHeadingRad)
    );
    const VEHICLE_SLOPE_GRAVITY = 6.0; // m/s² at 90° slope (~60% of real gravity)
    const slopeAccel = slopeForwardComponent * VEHICLE_SLOPE_GRAVITY;
    // Friction always opposes current motion; slope always pushes downhill.
    const friction = vehicleSpeed > 0 ? -VEHICLE_BRAKE
                   : vehicleSpeed < 0 ?  VEHICLE_BRAKE
                   : 0;
    if (drive !== 0) {
      vehicleSpeed += (drive * VEHICLE_ACCEL + slopeAccel) * dt;
    } else {
      const coastAccel = slopeAccel + friction;
      const prevSpeed = vehicleSpeed;
      vehicleSpeed += coastAccel * dt;
      // Only let friction stop motion, not reverse it (slope CAN reverse it)
      if (prevSpeed > 0 && vehicleSpeed < 0 && slopeAccel >= 0) vehicleSpeed = 0;
      if (prevSpeed < 0 && vehicleSpeed > 0 && slopeAccel <= 0) vehicleSpeed = 0;
      // Slope can start rolling from standstill
      if (prevSpeed === 0) vehicleSpeed = slopeAccel * dt;
    }
    vehicleSpeed = Math.max(-VEHICLE_DRIVE_SPEED, Math.min(VEHICLE_DRIVE_SPEED, vehicleSpeed));
    if (vehicleSpeed !== 0 || steer !== 0) {
      const heading = vehicleHeadingRad;
      const forwardX = -Math.sin(heading);
      const forwardY = Math.cos(heading);
      const driveDist = vehicleSpeed * dt;
      vehicleGroup.position.x += forwardX * driveDist;
      vehicleGroup.position.y += forwardY * driveDist;
      vehicleMarker.position.x = vehicleGroup.position.x;
      vehicleMarker.position.y = vehicleGroup.position.y;
      vehicleSnapPending = true;
      throttledVehicleSave();
      _lastCamMoveTime = performance.now();
      abortAllEnhancements();
    }
    return;
  }

  updateCameraAGL();
  const sf = aglSpeedFactor();
  const ACCEL = BASE_ACCEL * sf;
  const BRAKE = BASE_BRAKE * sf;
  const MAX_SPEED = BASE_MAX_SPEED * sf;
  const STRAFE_SPEED = BASE_STRAFE_SPEED * sf;

  // clamp existing speed to new AGL-scaled max
  controls.speed = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, controls.speed));

  if (forwardPressed) {
    controls.speed = Math.min(controls.speed + ACCEL * dt, MAX_SPEED);
  } else if (backPressed) {
    controls.speed = Math.max(controls.speed - ACCEL * dt, -MAX_SPEED);
  } else if (!driftMode) {
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
  const headingForHud = vehicleControlActive ? vehicleHeadingRad : controls.yaw;
  const deg = (((-headingForHud * 180) / Math.PI) % 360 + 360) % 360;
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const compass = dirs[Math.round(deg / 45) % 8];
  // Heightmap line — always present, stable width
  const hmPending = _hmMissing + _hmDownloading;
  const passLabel = _loadPass === 1
    ? '<span style="color:#ff0">PASS 1 (preview)</span>'
    : '<span style="color:#8f8">PASS 2 (full)</span>';
  const hmLine = `${passLabel}  hm: ${currentTileIds.size} tiles`
    + (hmPending > 0
      ? `  <span style="color:#fc8">${_hmDownloading} downloading  ${_hmMissing} queued</span>`
      : '');

  // Texture line: client fetch status + server-side pipeline
  const srvReady = _srvTexStatus.ready || 0;
  const srvFetching = _srvTexStatus.fetching || 0;
  const srvMissing = _srvTexStatus.missing || 0;
  const srvAncestor = _srvTexStatus.ancestor_fallback || 0;
  let texLine = `tex: ${texCache.size} cached`;
  // Client fetch pipeline
  if (texInflight.size > 0 || texFetching.size > 0) {
    texLine += `  <span style="color:#8cf">http: ${texInflight.size}</span>`;
    texLine += `  <span style="color:#fc8">poll: ${texFetching.size}</span>`;
  }
  // Server-side pipeline — show when there's work happening
  if (_srvTexFetching > 0 || _srvTexRetry > 0 || srvMissing > 0) {
    texLine += `  <span style="color:#f8c">srv: ${_srvTexFetching} fetching</span>`;
    if (_srvTexRetry > 0) texLine += `  <span style="color:#f66">${_srvTexRetry} retry</span>`;
    if (srvMissing > 0) texLine += `  <span style="color:#999">${srvMissing} missing</span>`;
  }
  const es = _enhanceStatus;
  const enhDone = es.done || 0;
  const enhTotal = es.total || 0;
  const enhInProg = es.in_progress || 0;
  const enhEligible = es.eligible || 0;
  if (enhTotal > 0) {
    const pct = Math.round(enhDone / enhTotal * 100);
    let enhParts = [];
    if (enhInProg > 0) enhParts.push(`<span style="color:#f8c">${enhInProg} upscaling</span>`);
    enhParts.push(`<span style="color:#8f8">${enhDone}/${enhTotal} enhanced (${pct}%)</span>`);
    if (enhEligible > 0) enhParts.push(`<span style="color:#fc8">${enhEligible} eligible</span>`);
    texLine += '  ' + enhParts.join('  ');
  }
  const modeLabel = controls.mapMode
    ? 'MAP'
    : (vehicleControlActive ? 'VEHICLE' : 'FLIGHT');
  const modeHtml = vehicleControlActive
    ? '<span style="color:#ff3b30">VEHICLE</span>'
    : modeLabel;

  // Game clock display (bottom-left) — always show the date actually being rendered
  const gameDate = lastRenderedDate;
  // Persist game clock to localStorage ~every 5s
  const _now = performance.now();
  if (_now - _lastGameClockSave > 5000) {
    _lastGameClockSave = _now;
    localStorage.setItem(GAME_CLOCK_STORAGE_KEY, String(gameDate.getTime()));
  }
  const _mn3 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const gdMon = _mn3[gameDate.getUTCMonth()];
  const gdDay = gameDate.getUTCDate();
  const _nuukTime = gameDate.toLocaleString('en-GB', { timeZone: 'America/Nuuk', hour: '2-digit', minute: '2-digit', hour12: false });
  const [gdHH, gdMM] = _nuukTime.split(':');
  const _btnStyle = 'cursor:pointer;padding:0 4px;border:none;background:none;font-size:12px;line-height:1;vertical-align:middle;';
  const _activeClr = '#5af';
  const _dimClr = '#666';
  gameClockEl.innerHTML = `<button data-gc="rw" style="${_btnStyle}color:${_activeClr}" title="−15 min"><i class="fa-solid fa-backward"></i></button>`
    + ` <b>${gdHH}:${gdMM}</b>`
    + (useRealtimeGameClock
      ? `<button data-gc="stop" style="${_btnStyle}color:${_activeClr}" title="Pause"><i class="fa-solid fa-pause"></i></button>`
      : `<button data-gc="play" style="${_btnStyle}color:${_activeClr}" title="Play 24×"><i class="fa-solid fa-play"></i></button>`)
    + `<button data-gc="ff" style="${_btnStyle}color:${_activeClr}" title="+15 min"><i class="fa-solid fa-forward"></i></button>`;

  hud.innerHTML = [
    '<b>Clouds Terrain Managed Flask UX WIP</b>',
    `mode: <b>${modeHtml}</b>`,
    `lat: ${(anchorLat + northM / 111320).toFixed(5)}°  lon: ${(anchorLon + eastM / (111320 * Math.cos(anchorLat * Math.PI / 180))).toFixed(5)}°  alt: ${altM.toFixed(0)}m`,
    `enu: E ${eastM.toFixed(0)}m  N ${northM.toFixed(0)}m  U ${altM.toFixed(0)}m`,
    `speed: ${speedKmh.toFixed(0)} km/h  heading: ${deg.toFixed(0)}° ${compass}`,
    hmLine,
    texLine,
    vehicleControlActive
      ? 'W/S drive, A/D steer, mouse orbit camera, Esc exits vehicle control'
      : 'WASD or Arrows move, Q/Z altitude, drag look',
    'map: left-drag rotate, right-drag pan, wheel zoom',
    controls.mapMode
      ? `ocean overlay: ${oceanMapDebugEnabled ? 'ON' : 'OFF'}  (right-click menu; cyan=ocean, magenta=seed, orange=passable)`
      : '',
    'M map mode, R reset · <span id="debugLogLink" style="color:#0af;text-decoration:underline;cursor:pointer;pointer-events:auto">debug log</span>'
  ].join('<br>');
  alt.textContent =
    `${altM.toFixed(0)}m / ${(altM * 3.28084).toFixed(0)}ft  ${deg.toFixed(0)}° ${compass}` +
    `  FOV ${camera.fov.toFixed(0)}°` +
    (controls.mapMode ? '  [MAP]' : (vehicleControlActive ? '  [VEHICLE]' : ''));
}

function resetView() {
  localStorage.removeItem('clouds-cam');
  localStorage.removeItem(TUNING_STORAGE_KEY);
  localStorage.removeItem(GAME_CLOCK_STORAGE_KEY);
  for (const k of Object.keys(_tuningState)) delete _tuningState[k];
  controls.yaw = defaultYaw;
  controls.pitch = defaultPitch;
  controls.speed = 0;
  controls.dragging = false;
  controls.dragButton = 0;
  controls.mapMode = false;
  setVehicleControlActive(false, 'reset');
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
  // Re-fetch tiles around the reset camera position.
  isFirstLoad = true;
  _loadPass = 1;
  originX = 0; originY = 0;
  camStereoX = 0; camStereoY = 0;
  lastFetchX = 0; lastFetchY = 0;
  tileFrameOffsetX = 0; tileFrameOffsetY = 0;
  tileFrameOffsetReady = false;
  markHousesNeedSnap();
  fetchTiles();
}

let driftMode = false;
let _lastForwardTapTime = 0;
const DOUBLE_TAP_MS = 300;

window.addEventListener('keydown', event => {
  if (event.target.tagName === 'TEXTAREA' || event.target.tagName === 'INPUT') return;
  controls.keys[event.code] = true;
  if ((event.code === 'KeyW' || event.code === 'ArrowUp') && !event.repeat) {
    const now = performance.now();
    if (now - _lastForwardTapTime < DOUBLE_TAP_MS) {
      driftMode = !driftMode;
      console.log(`[drift] ${driftMode ? 'ON' : 'OFF'}`);
      _lastForwardTapTime = 0;
    } else {
      _lastForwardTapTime = now;
    }
  }
  if (event.code === 'Escape' && !event.repeat) {
    if (vehicleControlActive) {
      saveVehicleState('escape', {
        snapToGround: true,
        requireGroundedZ: false,
        bypassSnapThrottle: true,
      });
      setVehicleControlActive(false, 'escape', { skipExitSave: true });
      controls.keys[event.code] = false;
      return;
    }
  }
  if (event.code === 'KeyG' && !event.repeat) {
    toggleGmapsPanel();
    return;
  }
  if (event.code === 'KeyM' && !event.repeat) {
    controls.mapMode = !controls.mapMode;
    driftMode = false;
    if (controls.mapMode) {
      setVehicleControlActive(false, 'map-mode');
    }
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
    if (lastTiles) {
      updateTextures(lastTiles);
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
  if (event.code === 'KeyL' && !event.repeat && vehicleControlActive) {
    for (const hl of vehicleHeadlightSpots) hl.visible = !hl.visible;
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
      const dx = -event.movementX * panStep;
      const dy = event.movementY * panStep;
      const cosY = Math.cos(controls.yaw);
      const sinY = Math.sin(controls.yaw);
      controls.mapPanEast  += dx * cosY + dy * sinY;
      controls.mapPanNorth += -dx * sinY + dy * cosY;
      updateMapCamera();
      return;
    }
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const prevX = event.clientX - event.movementX;
    const prevY = event.clientY - event.movementY;
    const prevAngle = Math.atan2(prevX - cx, -(prevY - cy));
    const currAngle = Math.atan2(event.clientX - cx, -(event.clientY - cy));
    let dAngle = currAngle - prevAngle;
    if (dAngle > Math.PI) dAngle -= 2 * Math.PI;
    if (dAngle < -Math.PI) dAngle += 2 * Math.PI;
    controls.yaw += dAngle;
    return;
  }
  if (vehicleControlActive) {
    vehicleCameraOrbitYaw -= event.movementX * VEHICLE_CAMERA_ORBIT_SENS;
    vehicleCameraOrbitPitch += event.movementY * VEHICLE_CAMERA_ORBIT_SENS;
    vehicleCameraOrbitPitch = THREE.MathUtils.clamp(
      vehicleCameraOrbitPitch,
      VEHICLE_CAMERA_ORBIT_PITCH_MIN,
      VEHICLE_CAMERA_ORBIT_PITCH_MAX
    );
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
  event.preventDefault();
  if (!controls.mapMode) {
    tryEnterVehicleControlFromPointer(event);
    return;
  }
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
    } else if (vehicleControlActive) {
      const scale = zoomIn ? 0.9 : 1.1;
      VEHICLE_CAMERA_FOLLOW_DISTANCE = Math.max(8, Math.min(200, VEHICLE_CAMERA_FOLLOW_DISTANCE * scale));
      VEHICLE_CAMERA_FOLLOW_HEIGHT = Math.max(2, Math.min(80, VEHICLE_CAMERA_FOLLOW_HEIGHT * scale));
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

let lastTexRefresh = 0;
function render() {
  const dt = Math.min(0.05, clock.getDelta());
  const nowMs = performance.now();
  if (useRealtimeGameClock) {
    currentDate.setTime(getGameDateFromBrowserTime().getTime());
  }
  applyDate(currentDate);
  updateMovement(dt);
  applyCameraOrientation();
  updateHud();

  // Update Google Maps panel iframe if open and position changed enough
  if (gmapsPanelOpen && !gmapsPanelMinimized) {
    const nowMs = performance.now();
    const interval = _gmapsActiveTab === 2 ? 200 : GMAPS_UPDATE_INTERVAL;
    if (nowMs - _gmapsLastUpdate > interval) {
      const camLL = getCameraLatLon();
      const lat = camLL.lat.toFixed(4);
      const lon = camLL.lon.toFixed(4);
      if (lat !== _gmapsLastLat || lon !== _gmapsLastLon) {
        if (_gmapsActiveTab === 2) {
          gmapsIframe.contentWindow?.postMessage({ lat: parseFloat(lat), lon: parseFloat(lon) }, '*');
        } else {
          gmapsIframe.src = _gmapsBuildUrl(lat, lon);
        }
        _gmapsLastLat = lat;
        _gmapsLastLon = lon;
        _gmapsLastUpdate = nowMs;
      }
    }
  }

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
    const approxStereoX = originX + (camLL.lon - anchorLon) * 111320 * Math.cos(anchorLat * Math.PI / 180);
    const approxStereoY = originY + (camLL.lat - anchorLat) * 111320;
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
  snapVehicleToTerrain();
  updateDieselVolume();
  updateVehicleSuspension(dt);
  if (vehicleControlActive && !controls.mapMode) {
    updateVehicleFollowCamera();
  }
  syncVehicleSunLight();
  syncVehicleShadowReceivers();
  updateVehicleShadowSystem();
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
  vehicleMarkerLayer.visible = controls.mapMode;
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
    vehicleMarker.scale.setScalar(markerScale * VEHICLE_MARKER_MAP_SCALE);
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
