// UX WIP scene: preserve baseline rendering, layer in map mode + movement + HUD.
import * as THREE from 'three';
import {
  AerialPerspectiveEffect,
  DEFAULT_PRECOMPUTED_TEXTURES_URL,
  getSunDirectionECEF
} from '@takram/three-atmosphere';
import {
  CloudShape,
  CloudShapeDetail,
  CloudsEffect,
  LocalWeather,
  Turbulence
} from '@takram/three-clouds';
import { Ellipsoid, Geodetic, radians } from '@takram/three-geospatial';
import { NormalPass } from 'postprocessing';
import { buildAssetLibrary } from './procgen/library.ts';
import { buildTileScatter, updateScatterVisibility, SCATTER_MIN_DEPTH } from './procgen/scatter.ts';
import { headingFromForward2D } from './terrain-priority.js';
import { createTerrainHeadingDemandController } from './terrain-heading-demand.js';
import { compassHeading, createTerrainHud, renderGameClock } from './terrain-hud.js';
import { applyMapDrag, installTerrainKeyboardControls, installTerrainPointerControls } from './terrain-controls.js';
import { stepVehicleDrive } from './terrain-vehicle.js';
import { createTerrainVehicleRuntime } from './terrain-vehicle-runtime.js';
import { createTileHistory, terrainFogDistance, tileDepthFromId } from './terrain-tile-runtime.js';
import { createTextureStreamer, rendererTextureAnisotropy } from './terrain-texture-streamer.js';
import { evaluateTerrainRefetch, summarizeTerrainCamera, terrainCameraCoordinates, terrainCameraGridPosition, terrainCameraStereoPosition } from './terrain-tile-fetch.js';
import { collectTerrainDebugMeshes, createTerrainHoverOutlineController, createTerrainMapGridController, formatTerrainSeamDiagnostic, summarizeTerrainMesh } from './terrain-debug-runtime.js';
import { createTerrainFetchRuntime } from './terrain-fetch-runtime.js';
import { createTerrainTileSet } from './terrain-tile-set.js';
import { createTerrainGridlinesRuntime } from './terrain-gridlines-runtime.js';
import { restoreTerrainCameraState, terrainCameraState } from './terrain-camera-state.js';
import { createTerrainClientLogger } from './terrain-client-logging.js';
import { createTerrainFpsCounter } from './terrain-fps-counter.js';
import { loadTerrainStartupAssets } from './terrain-startup-assets.js';
import { createTerrainAtmosphereTextureRuntime } from './terrain-atmosphere-textures.js';
import { createTerrainTuningControls } from './terrain-tuning-controls.js';
import {
  bindTerrainCloudComposition,
  configureTerrainClouds,
  invalidateTerrainCloudHistory,
  registerTerrainCloudTuning,
} from './terrain-cloud-runtime.js';
import { createTerrainBuildingsRuntime } from './terrain-buildings-runtime.js';
import { createTerrainTileMenuRuntime } from './terrain-tile-menu-runtime.js';
import { createTerrainHeatmapRuntime } from './terrain-heatmap-runtime.js';
import { resolveTerrainViewToggle } from './terrain-view-mode.js';
import { googleMaps3dUrl } from './terrain-google-maps.js';
import { createTerrainFlyToTileRuntime } from './terrain-fly-to-tile.js';
import { epsg3413DirectionBearing, epsg3413ToWgs84 } from './terrain-polar-stereo.js';
import { createWaterRuntime, DEFAULT_WATER_PARAMS } from './water/water-runtime.js';
import { FAST_TIME_SCALE, getFastTimeRange } from './terrain-game-clock.js';
import { advanceRealtimeMovement, MAX_REALTIME_STEP_SECONDS } from './terrain-realtime-step.js';

export async function startTerrainApplication({
  backend = 'webgl',
  onToggleRenderBackend = () => {},
} = {}) {
if (backend !== 'webgl' && backend !== 'webgpu') {
  throw new TypeError(`unsupported terrain backend: ${backend}`);
}
const USE_WEBGPU_RENDER_BACKEND = backend === 'webgpu';
const backendModule = USE_WEBGPU_RENDER_BACKEND
  ? await import('./render-backends/webgpu-backend.js')
  : await import('./render-backends/webgl-backend.js');
// Both backends use AgX, but their pre-tone-map luminance units differ. WebGL's
// relative-luminance pipeline needs exposure 10; WebGPU's physical atmosphere
// is calibrated at 2.5. Treat these as input normalization, not different looks.
const WEBGL_TONE_MAPPING_EXPOSURE = 10;
const WEBGPU_TONE_MAPPING_EXPOSURE = 2.5;
const WEBGPU_ATMOSPHERE_LUMINANCE_SCALE = 5.0;
const WEBGPU_DEFAULT_HAZE = 6.5;
const WEBGPU_SUN_ANGULAR_RADIUS = 0.02;
const WEBGPU_ATMOSPHERE_DEFAULTS = Object.freeze({
  luminanceScale: WEBGPU_ATMOSPHERE_LUMINANCE_SCALE,
  toneMappingExposure: WEBGPU_TONE_MAPPING_EXPOSURE,
  sunAngularRadius: WEBGPU_SUN_ANGULAR_RADIUS,
  sunIntensity: 1,
  rayleighScale: 1,
  mieScale: 1.4,
  groundAlbedo: 0.3
});
const WEBGPU_CLOUD_SHADOW_DEFAULTS = Object.freeze({
  // The dual-depth path is implemented as an opt-in diagnostic until its
  // sun-depth convention and shaft energy are calibrated visually.
  enabled: false,
  debugSurface: false,
  coverage: 0.52,
  density: 1.15,
  strength: 1,
  shaftsEnabled: false,
  shaftStrength: 0.82,
  indirectFloor: 0.28
});
const webgpuAtmosphereSettings = { ...WEBGPU_ATMOSPHERE_DEFAULTS };
const webgpuCloudShadowSettings = {
  ...WEBGPU_CLOUD_SHADOW_DEFAULTS,
  // Shareable opt-in validation views; the UI toggles remain normal controls.
  enabled: window.location.hash === '#cloud-shadows'
    || window.location.hash === '#shadow-mask',
  shaftsEnabled: window.location.hash === '#god-rays',
  debugSurface: window.location.hash === '#shadow-mask'
};

// The main view is controlled entirely through its UI. Discard stale query
// parameters instead of exposing URL state that does not stay in sync.
if (window.location.search) {
  history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
}
// Flask is the viewer's only backend. It owns terrain/asset reconciliation
// and reads the shared catalog without exposing the asset service to clients.
const VEHICLE_STATE_ENDPOINT = '/api/vehicle_state';
const ASSETS_ENDPOINT = '/api/assets';
const ASSETS_FETCH_TIMEOUT_MS = 1500;
const VEHICLE_SAVE_FETCH_TIMEOUT_MS = 1500;
const VEHICLE_SAVE_FAILURE_COOLDOWN_MS = 15000;
const {
  bootEvents, bootLog, enqueueClientLog, flushClientLogQueue,
} = createTerrainClientLogger({ sceneMode: 'clouds-terrain-managed-flask-ux-wip' });
bootLog('script.start', {
  href: window.location.href,
  userAgent: navigator.userAgent
});
// Force immediate flush so we know the log pipeline is alive.
flushClientLogQueue();

// Use summer daytime in Nuuk so textured ground is clearly visible.
const referenceDate = new Date('2025-07-01T12:00:00Z');
const GAME_TIME_SCALE = 1;
const SUN_DIRECTION_SYNC_INTERVAL_MS = 60 * 1000;
const GAME_CLOCK_STORAGE_KEY = 'game-clock-ms';
const savedGameClockMs = Number(localStorage.getItem(GAME_CLOCK_STORAGE_KEY));
const gameClockState = {
  anchorGameTimeMs: savedGameClockMs || referenceDate.getTime(),
  anchorBrowserTimeMs: Date.now(),
  lastSavedAtMs: 0,
  running: true,
  timeScale: GAME_TIME_SCALE,
  stopGameTimeMs: null,
  renderedDate: null,
  lastSunSyncTimeMs: NaN,
};
const currentDate = new Date(gameClockState.anchorGameTimeMs);
gameClockState.renderedDate = new Date(currentDate);

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

const anchorLon = DEFAULT_LOCATION.lon;
const anchorLat = DEFAULT_LOCATION.lat;

const startupAssetsResponse = await loadTerrainStartupAssets({
  endpoint: ASSETS_ENDPOINT,
  timeoutMs: ASSETS_FETCH_TIMEOUT_MS,
  bootLog,
});
const VEHICLE_DEFINITION = startupAssetsResponse.vehicle_definition;
const VEHICLE_HEADLIGHTS = (
  VEHICLE_DEFINITION.headlights != null &&
  typeof VEHICLE_DEFINITION.headlights === 'object'
)
  ? VEHICLE_DEFINITION.headlights
  : null;

const scene = new THREE.Scene();
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
// Enough headroom to inspect the complete local coverage circle.
const MAX_MAP_ZOOM = 100000;

const controls = {
  yaw: 0,
  pitch: -0.32,
  speed: 0,
  strafeSpeed: 0,
  dragging: false,
  dragButton: 0,
  mapMode: false,
  seamMode: false,
  mapZoom: DEFAULT_MAP_ZOOM,
  mapPanEast: 0,
  mapPanNorth: 0,
  terrainRange: 30000,
  keys: {}
};
const terrainViewForward = new THREE.Vector3();
function getTerrainViewHeading() {
  camera.getWorldDirection(terrainViewForward);
  return headingFromForward2D(
    terrainViewForward.dot(east),
    terrainViewForward.dot(north),
    controls.yaw,
  );
}
const BASE_ACCEL = 1200;
const BASE_BRAKE = 800;
const BASE_MAX_SPEED = 5000;
const BASE_STRAFE_SPEED = 800;
const TURN_SPEED = 1.5;
const MIN_FLIGHT_ALT = paramNumber('minFlightAlt', 2);
// AGL-based speed scaling: full speed at AGL_FULL_SPEED_M, minimum factor at ground level
const AGL_FULL_SPEED_M = 500;
const AGL_MIN_FACTOR = 0.05;
const aglRaycaster = new THREE.Raycaster();
const MOUSE_SENS = 0.003;
const MAP_PAN_FACTOR = 1.2;

const defaultCameraPosition = camera.position.clone();
const cameraRuntimeState = {
  agl: AGL_FULL_SPEED_M, // Assume high until the first terrain raycast.
  lastGoodPosition: camera.position.clone(),
  lastMoveTime: performance.now(),
  driftMode: false,
};
const initialForward = anchorPosition.clone().sub(camera.position).normalize();
const defaultYaw = Math.atan2(-initialForward.dot(east), initialForward.dot(north));
const defaultPitch = Math.asin(Math.max(-1, Math.min(1, initialForward.dot(up))));
controls.yaw = defaultYaw;
controls.pitch = defaultPitch;

const renderBackend = backendModule.createTerrainBackend({
  width: window.innerWidth,
  height: window.innerHeight,
  pixelRatio: window.devicePixelRatio,
  toneMappingExposure: USE_WEBGPU_RENDER_BACKEND
    ? WEBGPU_TONE_MAPPING_EXPOSURE
    : WEBGL_TONE_MAPPING_EXPOSURE,
  scene,
  bootLog,
  gpuProfilerEnabled: !USE_WEBGPU_RENDER_BACKEND
    && localStorage.getItem('terrain-gpu-profiler') === '1',
});
const webgpuAtmosphere = USE_WEBGPU_RENDER_BACKEND
  ? renderBackend.createAtmosphere({
      scene, camera,
      anchor: anchorPosition, east, north, up, maxViewDistance: MAX_VIEW_DIST,
      settings: webgpuAtmosphereSettings,
      cloudShadowSettings: webgpuCloudShadowSettings,
      bootLog, enqueueLog: enqueueClientLog, flushLog: flushClientLogQueue,
    })
  : null;
const maybeLogWebGPUSun = (...args) => webgpuAtmosphere?.maybeLogSun(...args);
const renderer = renderBackend.renderer;
document.body.appendChild(renderer.domElement);
renderer.domElement.addEventListener('contextmenu', event => event.preventDefault());
let heatmapRuntime = null;

const { hud, alt, gameClock: gameClockEl } = createTerrainHud({
  onToggleMapMode: () => toggleMapMode(),
  onToggleSeamMode: () => toggleSeamMode(),
  onToggleHeatmap: () => toggleHeatmap(),
  onToggleGridlines: () => toggleGridlines(),
  onToggleRenderBackend: () => {
    // beforeunload normally saves this too, but make the renderer transition
    // self-contained so a fast reload cannot race the camera/frame snapshot.
    savePosition();
    onToggleRenderBackend();
  },
  onToggleRoadDebug: () => toggleRoadDebug(),
  onReset: () => resetView(),
  onClockAction: action => {
    if (action === 'rw') rewindGameClock();
    else if (action === 'stop') stopGameClock();
    else if (action === 'play') playGameClock();
    else if (action === 'ff') fastForwardGameClock();
    requestRender();
  },
});

// Transport control handlers for game clock HUD
function rewindGameClock() {
  if (gameClockState.running) currentDate.setTime(getGameDateFromBrowserTime().getTime());
  gameClockState.running = false;
  gameClockState.timeScale = GAME_TIME_SCALE;
  gameClockState.stopGameTimeMs = null;
  currentDate.setTime(currentDate.getTime() - 15 * 60 * 1000);
  applyDate(currentDate);
  maybeLogWebGPUSun(currentDate, 'clock-rewind', true);
}
function stopGameClock() {
  if (gameClockState.running) currentDate.setTime(getGameDateFromBrowserTime().getTime());
  gameClockState.running = false;
  gameClockState.timeScale = GAME_TIME_SCALE;
  gameClockState.stopGameTimeMs = null;
  maybeLogWebGPUSun(currentDate, 'clock-stop', true);
}
function playGameClock() {
  if (!gameClockState.running) {
    gameClockState.anchorGameTimeMs = currentDate.getTime();
    gameClockState.anchorBrowserTimeMs = Date.now();
    gameClockState.running = true;
    gameClockState.timeScale = GAME_TIME_SCALE;
    gameClockState.stopGameTimeMs = null;
  }
  maybeLogWebGPUSun(currentDate, 'clock-play', true);
}
function fastForwardGameClock() {
  if (gameClockState.running) currentDate.setTime(getGameDateFromBrowserTime().getTime());
  gameClockState.running = false;
  gameClockState.timeScale = GAME_TIME_SCALE;
  gameClockState.stopGameTimeMs = null;
  currentDate.setTime(currentDate.getTime() + 15 * 60 * 1000);
  applyDate(currentDate);
  maybeLogWebGPUSun(currentDate, 'clock-forward', true);
}

function startFastTime() {
  if (controls.mapMode) return;
  const { startMs, endMs } = getFastTimeRange(currentDate);
  currentDate.setTime(startMs);
  gameClockState.anchorGameTimeMs = startMs;
  gameClockState.anchorBrowserTimeMs = Date.now();
  gameClockState.timeScale = FAST_TIME_SCALE;
  gameClockState.stopGameTimeMs = endMs;
  gameClockState.running = true;
  applyDate(currentDate);
  maybeLogWebGPUSun(currentDate, 'clock-fast-time', true);
  requestRender();
}

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
  'z-index:30'
].join(';');
document.body.appendChild(tileInfoEl);

const seamLegendEl = document.createElement('div');
seamLegendEl.setAttribute('aria-label', 'Seam diagnostic legend');
seamLegendEl.style.cssText = [
  'position:absolute', 'right:12px', 'bottom:12px', 'display:none', 'z-index:6',
  'color:#e2e8f0', 'background:rgba(2,6,23,0.88)', 'padding:8px 12px',
  'border:1px solid #334155', 'border-radius:6px',
  'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
  'pointer-events:none',
].join(';');
seamLegendEl.innerHTML = [
  '<b>Shared-edge health</b>',
  '<span style="color:#ff1744">●</span> bad: &gt;1m height or &gt;20° normals',
  '<span style="color:#f59e0b">●</span> inspect: &gt;5cm height or &gt;5° normals',
  '<span style="color:#64748b">●</span> aligned',
  'Hover a tile for exact edge + neighbor.',
].join('<br>');
document.body.appendChild(seamLegendEl);

// --- Atmosphere / Clouds tuning panel ---
const tuningPanel = document.createElement('div');
tuningPanel.style.cssText = [
  'position:absolute',
  'top:12px',
  'right:12px',
  'width:340px',
  'max-width:calc(100vw - 24px)',
  'box-sizing:border-box',
  'background:rgba(0,0,0,0.8)',
  'color:#dbe5f1',
  'font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
  'border-radius:8px',
  'z-index:10',
  'user-select:none',
  'backdrop-filter:blur(6px)'
].join(';');
document.body.appendChild(tuningPanel);
tuningPanel.addEventListener('input', requestRender);
tuningPanel.addEventListener('change', requestRender);

const tuningHeader = document.createElement('div');
tuningHeader.style.cssText = 'padding:8px 12px;cursor:pointer;display:flex;justify-content:space-between;align-items:center';
tuningHeader.innerHTML = '<span>Scene settings</span><span id="tuning-toggle">&#9660;</span>';
tuningPanel.appendChild(tuningHeader);

const tuningBody = document.createElement('div');
tuningBody.style.cssText = [
  'padding:0 12px 10px',
  'display:none',
  'max-height:calc(100vh - 70px)',
  'overflow-y:auto',
  'overflow-x:hidden',
  'overscroll-behavior:contain'
].join(';');
tuningPanel.appendChild(tuningBody);

let tuningPanelOpen = false;
tuningHeader.onclick = () => {
  tuningPanelOpen = !tuningPanelOpen;
  tuningBody.style.display = tuningPanelOpen ? 'block' : 'none';
  document.getElementById('tuning-toggle').innerHTML = tuningPanelOpen ? '&#9650;' : '&#9660;';
  requestRender();
};

// --- Tuning panel persistence ---
const TUNING_STORAGE_KEY = 'clouds-tuning';
const tuningState = JSON.parse(localStorage.getItem(TUNING_STORAGE_KEY) || '{}');
const WEBGPU_CALIBRATION_VERSION = 6;
if (tuningState.webgpuCalibrationVersion !== WEBGPU_CALIBRATION_VERSION) {
  if (
    tuningState['webgpu exposure'] == null
    || tuningState['webgpu exposure'] === 1.5
    || tuningState['webgpu exposure'] === 10
  ) {
    tuningState['webgpu exposure'] = WEBGPU_TONE_MAPPING_EXPOSURE;
  }
  if (tuningState['webgpu luminance'] == null || tuningState['webgpu luminance'] === 3.8) {
    tuningState['webgpu luminance'] = WEBGPU_ATMOSPHERE_LUMINANCE_SCALE;
  }
  if (
    tuningState.brightness == null
    || tuningState.brightness === 2.2
    || tuningState.brightness === 10
  ) {
    tuningState.brightness = WEBGPU_TONE_MAPPING_EXPOSURE;
  }
  if (tuningState.haze == null || tuningState.haze === 4.5) {
    tuningState.haze = WEBGPU_DEFAULT_HAZE;
  }
  // Version 6 introduced experimental dual-depth volumetrics. Never carry an
  // opt-in from an earlier development session into the normal renderer.
  tuningState['cloud shadows'] = false;
  tuningState['god rays'] = false;
  tuningState.webgpuCalibrationVersion = WEBGPU_CALIBRATION_VERSION;
}
if (tuningState.brightness == null && tuningState['webgpu exposure'] != null) {
  tuningState.brightness = tuningState['webgpu exposure'];
}
if (tuningState.haze == null && tuningState['fog strength'] != null) {
  tuningState.haze = tuningState['fog strength'];
}
localStorage.setItem(TUNING_STORAGE_KEY, JSON.stringify(tuningState));
function saveTuning() {
  localStorage.setItem(TUNING_STORAGE_KEY, JSON.stringify(tuningState));
}
const hasSavedMonth = Object.prototype.hasOwnProperty.call(tuningState, 'month');
const hasSavedHour = Object.prototype.hasOwnProperty.call(tuningState, 'hour (UTC)');
gameClockState.running = !(hasSavedMonth || hasSavedHour);

// Deferred binding: renderer-specific callbacks are wired after effects exist.
const {
  reset: resetTuningUI,
  section: tuningSectionLabel,
  slider: tuningSlider,
  toggle: tuningToggle,
} = createTerrainTuningControls({
  body: tuningBody,
  state: tuningState,
  save: saveTuning,
});

// We'll call this after aerialPerspective + cloudsEffect are created.
function buildTuningControls(ap, ce) {
  let cloudTuning = null;
  tuningSectionLabel('Date / Time');
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  tuningSlider('month', {
    min: 1, max: 12, step: 1, value: referenceDate.getUTCMonth() + 1,
    decimals: 0,
    format: v => monthNames[v - 1],
    onChange: v => {
      gameClockState.running = false;
      currentDate.setUTCMonth(v - 1);
      applyDate(currentDate);
    }
  });

  if (!USE_WEBGPU_RENDER_BACKEND) {
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
  if (renderBackend.lensFlare) {
    tuningSectionLabel('Lens Flare');
    tuningSlider('flare intensity', {
      min: 0, max: 0.05, step: 0.001, value: renderBackend.lensFlare.intensity,
      decimals: 3,
      onChange: v => { renderBackend.lensFlare.intensity = v; }
    });
    tuningSlider('flare threshold', {
      min: 0, max: 30, step: 0.5, value: renderBackend.lensFlare.thresholdLevel,
      decimals: 1,
      onChange: v => { renderBackend.lensFlare.thresholdLevel = v; }
    });
  }
  cloudTuning = registerTerrainCloudTuning({
    effect: ce, controls,
    section: tuningSectionLabel,
    slider: tuningSlider,
    toggle: tuningToggle,
    // one wind: cloud drift heading follows the water wind direction
    getWindDirection: () => waterParams.windDirection,
    renderingEnabled: renderBackend.takramCloudsEnabled,
    onRenderingEnabledChange: enabled => {
      renderBackend.setTakramCloudsEnabled(enabled);
    },
  });
  }
  if (waterRuntime.enabled) {
  tuningSectionLabel('Water');
  tuningToggle('dynamic water', {
    value: waterParams.enabled,
    onChange: v => { waterParams.enabled = v; }
  });
  tuningSlider('wind speed', {
    min: 1, max: 28, step: 0.1, value: waterParams.windSpeed,
    decimals: 1,
    onChange: v => { waterParams.windSpeed = v; waterRuntime.applyWind(); }
  });
  tuningSlider('wind dir', {
    min: 0, max: 360, step: 1, value: waterParams.windDirection,
    decimals: 0,
    format: v => `${v.toFixed(0)}°`,
    onChange: v => {
      waterParams.windDirection = v;
      waterRuntime.applyWind();
      cloudTuning?.syncDrift();
    }
  });
  tuningSlider('fetch', {
    min: 10, max: 1000, step: 10, value: waterParams.fetchKm,
    decimals: 0,
    format: v => `${v.toFixed(0)}km`,
    onChange: v => { waterParams.fetchKm = v; waterRuntime.applyWind(); }
  });
  tuningSlider('shore fetch ramp', {
    min: 0, max: 8000, step: 100, value: waterParams.shoreFetchRamp,
    decimals: 0,
    format: v => `${v.toFixed(0)}m`,
    onChange: v => { waterParams.shoreFetchRamp = v; }
  });
  tuningSlider('swell scale', {
    min: 0.3, max: 2, step: 0.01, value: waterParams.amplitude,
    onChange: v => { waterParams.amplitude = v; waterRuntime.applyWind(); }
  });
  tuningSlider('choppiness', {
    min: 0.4, max: 1.6, step: 0.01, value: waterParams.choppiness,
    onChange: v => { waterParams.choppiness = v; }
  });
  tuningSlider('water opacity', {
    min: 0, max: 0.8, step: 0.01, value: waterParams.opacity,
    onChange: v => { waterParams.opacity = v; }
  });
  tuningSlider('water reflect', {
    min: 0, max: 1.5, step: 0.01, value: waterParams.reflectivity,
    onChange: v => { waterParams.reflectivity = v; }
  });
  tuningSlider('sun glint', {
    min: 0, max: 4, step: 0.05, value: waterParams.glintStrength,
    onChange: v => { waterParams.glintStrength = v; }
  });
  tuningSlider('water absorb', {
    min: 0, max: 0.4, step: 0.005, value: waterParams.absorption,
    decimals: 3,
    onChange: v => { waterParams.absorption = v; }
  });
  tuningSlider('north cliff reflection pad', {
    min: 0, max: 2000, step: 25, value: waterParams.northCliffReflectionPadding,
    decimals: 0,
    format: v => `${v.toFixed(0)}m`,
    onChange: v => { waterParams.northCliffReflectionPadding = v; }
  });
  tuningSlider('water bright', {
    min: 0.1, max: 6, step: 0.05, value: waterParams.radiance,
    onChange: v => { waterParams.radiance = v; }
  });
  }
  tuningSectionLabel('Terrain');
  tuningSlider('terrain range', {
    min: 10000, max: 50000, step: 1000, value: controls.terrainRange,
    decimals: 0,
    format: v => `${(v/1000).toFixed(0)}km`,
    onChange: v => {
      controls.terrainRange = v;
      if (terrainPipelineState.ready) terrainFetchRuntime.request();
    }
  });
  tuningSectionLabel('Atmosphere');
  if (USE_WEBGPU_RENDER_BACKEND) {
    tuningSlider('brightness', {
      min: 0.5, max: 4, step: 0.05,
      value: WEBGPU_ATMOSPHERE_DEFAULTS.toneMappingExposure,
      decimals: 2,
      onChange: v => {
        webgpuAtmosphereSettings.toneMappingExposure = v;
        webgpuAtmosphere?.applyLiveSettings();
      }
    });
    const applyWebGPUHaze = value => {
      controls._fogStrength = value;
      renderBackend.setFogDensity(value / getFogDistance());
    };
    tuningSlider('haze', {
      min: 0, max: 10, step: 0.5, value: WEBGPU_DEFAULT_HAZE,
      decimals: 1,
      onChange: applyWebGPUHaze
    });
    applyWebGPUHaze(Number(tuningState.haze ?? WEBGPU_DEFAULT_HAZE));
    tuningSectionLabel('Experimental Volumetrics');
    tuningToggle('cloud shadows', {
      value: webgpuCloudShadowSettings.enabled,
      onChange: v => {
        webgpuCloudShadowSettings.enabled = v;
        webgpuAtmosphere?.applyCloudShadowSettings();
      }
    });
    tuningSlider('cloud coverage', {
      min: 0, max: 1, step: 0.01,
      value: webgpuCloudShadowSettings.coverage,
      decimals: 2,
      onChange: v => {
        webgpuCloudShadowSettings.coverage = v;
        webgpuAtmosphere?.applyCloudShadowSettings();
      }
    });
    tuningSlider('cloud density', {
      min: 0, max: 2.5, step: 0.01,
      value: webgpuCloudShadowSettings.density,
      decimals: 2,
      onChange: v => {
        webgpuCloudShadowSettings.density = v;
        webgpuAtmosphere?.applyCloudShadowSettings();
      }
    });
    tuningSlider('shadow strength', {
      min: 0, max: 2, step: 0.01,
      value: webgpuCloudShadowSettings.strength,
      decimals: 2,
      onChange: v => {
        webgpuCloudShadowSettings.strength = v;
        webgpuAtmosphere?.applyCloudShadowSettings();
      }
    });
    tuningToggle('god rays', {
      value: webgpuCloudShadowSettings.shaftsEnabled,
      onChange: v => {
        webgpuCloudShadowSettings.shaftsEnabled = v;
        webgpuAtmosphere?.applyCloudShadowSettings();
      }
    });
    tuningSlider('indirect floor', {
      min: 0, max: 1, step: 0.01,
      value: webgpuCloudShadowSettings.indirectFloor,
      decimals: 2,
      onChange: v => {
        webgpuCloudShadowSettings.indirectFloor = v;
        webgpuAtmosphere?.applyCloudShadowSettings();
      }
    });
    tuningSlider('god ray strength', {
      min: 0, max: 1, step: 0.01,
      value: webgpuCloudShadowSettings.shaftStrength,
      decimals: 2,
      onChange: v => {
        webgpuCloudShadowSettings.shaftStrength = v;
        webgpuAtmosphere?.applyCloudShadowSettings();
      }
    });
    tuningToggle('shadow mask', {
      value: webgpuCloudShadowSettings.debugSurface,
      onChange: v => {
        webgpuCloudShadowSettings.debugSurface = v;
        webgpuAtmosphere?.applyCloudShadowSettings();
      }
    });
  } else {
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
  }

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

// --- Fjord water (ocean2 FFT port) ---
// A camera-following FFT water surface at local z=0; masked water terrain is
// dropped to -3 m server-side, so the surface has volume above the seabed
// and land occludes it naturally. Inert on backends without createWater.
const waterParams = { ...DEFAULT_WATER_PARAMS };
// Bumped whenever a tile's displayed texture actually changes; the water
// runtime re-captures its bathymetry (which bakes tile-texture brightness
// into the reflection gate) once the streaming burst settles instead of
// serving a stale capture.
let terrainTextureVersion = 0;
const appliedTileTextures = new WeakMap();
const waterRuntime = createWaterRuntime({
  backend: renderBackend, scene, terrainRoot,
  anchorPosition, east, north, up,
  getSunDirection: () => sunDirection,
  getTextureVersion: () => terrainTextureVersion,
  log: (event, details) => enqueueClientLog('info', event, details),
  params: waterParams,
});

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
// The centered map-location arrow is UI, not world geometry. Keep a DOM
// presentation as the authoritative marker so backend depth/post-processing
// changes cannot make the navigation indicator disappear.
const mapLocationMarkerEl = document.createElement('div');
mapLocationMarkerEl.setAttribute('aria-label', 'Current camera location');
mapLocationMarkerEl.style.cssText = [
  'position:fixed', 'left:50%', 'top:50%', 'width:18px', 'height:24px',
  'transform:translate(-50%,-50%)',
  'pointer-events:none', 'z-index:18', 'display:none',
].join(';');
// Centered, heading-up ship silhouette with a warm-yellow fill and ochre
// two-pixel outline.
mapLocationMarkerEl.innerHTML = [
  '<svg viewBox="-9 -13 18 25" width="18" height="25" aria-hidden="true">',
  '<path d="M 0 -12 L 8 10 L 0 5 L -8 10 Z" ',
  'fill="#ffe14a" stroke="#806c00" stroke-width="2" stroke-linejoin="round"/>',
  '</svg>',
].join('');
document.body.appendChild(mapLocationMarkerEl);
const markerCameraRel = new THREE.Vector3();
const mapScreenUp = new THREE.Vector3();
const markerForwardLocal = new THREE.Vector3(0, 1, 0);
const markerHeadingLocal = new THREE.Vector3();
const movementForward = new THREE.Vector3();
const movementRight = new THREE.Vector3();
const raycaster = new THREE.Raycaster();
const mouseNDC = new THREE.Vector2();
const debugIntersectables = [];
const hoverOutlineController = createTerrainHoverOutlineController({
  terrainRoot,
  onChanged: () => { markSceneMutated(); requestRender(); },
});
const mapGridController = createTerrainMapGridController({ terrainRoot });

// --- Terrain streaming state ---
const EXAG = 1.0;

// --- Procedural asset scatter (fable5-world-demo port, chain validation) ---
// Temporarily disabled; keep the procedural vegetation pipeline intact for re-enabling.
const SCATTER_ENABLED = false;
const SCATTER_SEED = 1337;
let _scatterLib = null;   // built lazily on the first deep tile
let _scatterLibFailed = false;
function scatterLibrary() {
  if (_scatterLib || _scatterLibFailed || !SCATTER_ENABLED) return _scatterLib;
  try {
    _scatterLib = buildAssetLibrary(renderer, SCATTER_SEED);
    console.log('[scatter] asset library built', _scatterLib.stats);
    enqueueClientLog('info', 'scatter.library', _scatterLib.stats);
  } catch (err) {
    _scatterLibFailed = true;
    console.error('[scatter] library build failed — scatter disabled', err);
    enqueueClientLog('error', 'scatter.library', { error: String(err) });
  }
  return _scatterLib;
}

function attachTileScatter(mesh, tile, hm) {
  if (!SCATTER_ENABLED || !mesh || !tile?.id) return;
  const depth = tileDepthFromId(tile.id);
  if (depth < SCATTER_MIN_DEPTH) return;
  const lib = scatterLibrary();
  if (!lib) return;
  try {
    const group = buildTileScatter({
      tileId: tile.id,
      bbox: tile.bbox,
      hm,
      res: tile.resolution,
      lib,
      exag: EXAG
    });
    if (group) mesh.add(group);
  } catch (err) {
    enqueueClientLog('error', 'scatter.tile', { tileId: tile.id, error: String(err) });
  }
}

const REFETCH_DIST = 5000;
const terrainPipelineState = {
  ready: false,
  originX: 0,
  originY: 0,
  cameraStereoX: 0,
  cameraStereoY: 0,
  lastFetchX: 0,
  lastFetchY: 0,
  frameOffsetX: 0,
  frameOffsetY: 0,
  frameOffsetReady: false,
  lastFetchTriggerMs: 0,
  fetching: false,
  firstLoad: true,
  loadPass: 1,
  bootFetchLogged: false,
  lastTiles: null,
  heightmapsMissing: 0,
  heightmapsDownloading: 0,
  serverTexturesFetching: 0,
  serverTexturesRetrying: 0,
  serverTextureStatus: {},
}; // end terrain pipeline state

heatmapRuntime = createTerrainHeatmapRuntime({
  getView: () => {
    if (terrainPipelineState.firstLoad) return null;
    const cosine = Math.cos(controls.yaw);
    const sine = Math.sin(controls.yaw);
    const panX = controls.mapPanEast * cosine - controls.mapPanNorth * sine;
    const panY = controls.mapPanEast * sine + controls.mapPanNorth * cosine;
    const relative = camera.position.clone().sub(anchorPosition);
    return {
      x: terrainPipelineState.cameraStereoX + panX,
      y: terrainPipelineState.cameraStereoY + panY,
      cameraX: terrainPipelineState.cameraStereoX,
      cameraY: terrainPipelineState.cameraStereoY,
      alt: relative.dot(up),
      yaw: getTerrainViewHeading(),
      zoom: controls.mapZoom,
      range: controls.terrainRange,
    };
  },
  onWheel: deltaY => {
    controls.mapZoom *= deltaY < 0 ? 0.85 : 1.18;
    controls.mapZoom = Math.max(500, Math.min(MAX_MAP_ZOOM, controls.mapZoom));
    savePosition();
    updateMapCamera();
    requestRender();
  },
  onDrag: (event, button) => {
    controls.dragButton = button;
    const action = applyMapDrag(controls, event, MOUSE_SENS, MAP_PAN_FACTOR);
    if (action === 'pan') updateMapCamera();
    requestRender();
  },
  onTileClick: tile => window.open(`/pipeline.html?tile=${tile.id}`, '_blank'),
});

function paramNumber(_name, fallback) {
  return fallback;
}

const ASSET_VEHICLE_INSTANCES = Array.isArray(startupAssetsResponse.vehicle_instances)
  ? startupAssetsResponse.vehicle_instances
  : [];
const vehicleRuntime = createTerrainVehicleRuntime({
  vehicleDefinition: VEHICLE_DEFINITION,
  vehicleHeadlights: VEHICLE_HEADLIGHTS,
  assetVehicleInstances: ASSET_VEHICLE_INSTANCES,
  startupAssetsResponse,
  vehicleStateEndpoint: VEHICLE_STATE_ENDPOINT,
  vehicleSaveTimeoutMs: VEHICLE_SAVE_FETCH_TIMEOUT_MS,
  vehicleSaveFailureCooldownMs: VEHICLE_SAVE_FAILURE_COOLDOWN_MS,
  mouseSensitivity: MOUSE_SENS,
  scene, camera, renderer, terrainRoot, controls, mouseNDC, raycaster,
  up, east, north, anchorLat, anchorLon,
  paramNumber, bootLog, enqueueClientLog,
  getSunDirection: () => sunDirection,
});

const normalPass = new NormalPass(scene, camera);

const cloudsEffect = new CloudsEffect(camera, { resolutionScale: 1 });
const cloudsDefaults = configureTerrainClouds({
  effect: cloudsEffect,
  LocalWeather,
  CloudShape,
  CloudShapeDetail,
  Turbulence,
});

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
let restoreCloudTemporalHistory = null;

function applyDate(date, { force = true } = {}) {
  const dateMs = date.getTime();
  if (
    !force &&
    Number.isFinite(gameClockState.lastSunSyncTimeMs) &&
    Math.abs(dateMs - gameClockState.lastSunSyncTimeMs) < SUN_DIRECTION_SYNC_INTERVAL_MS
  ) {
    return false;
  }
  gameClockState.lastSunSyncTimeMs = dateMs;
  gameClockState.renderedDate = new Date(date);
  const previousSunDirection = sunDirection.clone();
  getSunDirectionECEF(date, sunDirection);
  if (
    !USE_WEBGPU_RENDER_BACKEND &&
    !previousSunDirection.equals(sunDirection)
  ) {
    restoreCloudTemporalHistory = invalidateTerrainCloudHistory(cloudsEffect);
  }
  aerialPerspective.sunDirection.copy(sunDirection);
  cloudsEffect.sunDirection.copy(sunDirection);
  webgpuAtmosphere?.updateDate(date, sunDirection);
  return true;
}
function getGameDateFromBrowserTime(nowMs = Date.now()) {
  const elapsedMs = nowMs - gameClockState.anchorBrowserTimeMs;
  const gameTimeMs = gameClockState.anchorGameTimeMs + elapsedMs * gameClockState.timeScale;
  if (gameClockState.stopGameTimeMs != null && gameTimeMs >= gameClockState.stopGameTimeMs) {
    const stopGameTimeMs = gameClockState.stopGameTimeMs;
    gameClockState.running = false;
    gameClockState.timeScale = GAME_TIME_SCALE;
    gameClockState.stopGameTimeMs = null;
    return new Date(stopGameTimeMs);
  }
  return new Date(gameTimeMs);
}
buildTuningControls(aerialPerspective, cloudsEffect);
// Only apply the default referenceDate if no saved tuning overrides month/hour.
// buildTuningControls already calls applyDate() when restoring saved values.
if (gameClockState.running) {
  applyDate(getGameDateFromBrowserTime());
}

bindTerrainCloudComposition(cloudsEffect, aerialPerspective);

bootLog('atmosphere.cache.load-sequence.invoke');
createTerrainAtmosphereTextureRuntime({
  baseUrl: DEFAULT_PRECOMPUTED_TEXTURES_URL,
  cacheName: ATMOSPHERE_CACHE_NAME,
  fileNames: ATMOSPHERE_TEXTURE_FILES,
  targets: [aerialPerspective, cloudsEffect],
  bootLog,
}).loadWithLocalCache();

renderBackend.configureScenePipeline({
  scene, camera, normalPass, cloudsEffect, aerialPerspective,
  sunDirection, up,
  date: gameClockState.renderedDate,
});

// --- Heightmap decode + mesh building (adapted for ENU frame) ---

// --- Tile priority colors ---

function priorityColor(priority, minP, maxP) {
  if (maxP <= minP) return new THREE.Color(1, 0, 0);
  const t = Math.min(1, Math.max(0, (priority - minP) / (maxP - minP)));
  if (t < 0.33) return new THREE.Color(1, t / 0.33, 0);
  if (t < 0.66) return new THREE.Color(1 - (t - 0.33) / 0.33, 1, 0);
  return new THREE.Color(0, 1 - (t - 0.66) / 0.34, (t - 0.66) / 0.34);
}

// --- Deferred tile system ---
const { history: tileHistory, log: tileLog } = createTileHistory({
  getPass: () => terrainPipelineState.loadPass,
  emit: (details, level) => enqueueClientLog(level, 'tile', details),
});

// --- Texture streaming ---

// Flask performs texture work with four background workers.  A much larger
// client fan-out only fills the Vite proxy with idle upstream sockets and can
// exhaust Flask's descriptor budget before useful work starts.
const TEX_MAX = 24; // max concurrent HTTP texture requests (texFetching 202s don't count)
const TEX_RETRY_202_BASE_MS = 2000;   // initial 202 retry delay
const TEX_RETRY_202_MAX_MS = 30000;   // cap backoff at 30s
const TEX_RETRY_ERROR_MS = 3000;
const TEX_REPOLL_BATCH = 8;           // max 202 re-polls fired per frame
const textureStreamer = createTextureStreamer({
  log: tileLog,
  maxInflight: TEX_MAX, repollBatch: TEX_REPOLL_BATCH,
  retryBaseMs: TEX_RETRY_202_BASE_MS, retryMaxMs: TEX_RETRY_202_MAX_MS,
  retryErrorMs: TEX_RETRY_ERROR_MS,
  getTextureAnisotropy: () => rendererTextureAnisotropy(renderer),
});
const {
  texCache, texSource, texInflight, texFetching,
} = textureStreamer;
let buildingsRuntime = null;
const terrainTileSet = createTerrainTileSet({
  terrainRoot,
  textureStreamer,
  terrain: {
    exaggeration: EXAG,
    attachScatter: attachTileScatter,
  },
  renderBackend,
  view: {
    camera, anchorPosition, east, north, up, controls,
    getHeading: getTerrainViewHeading,
  },
  log: tileLog,
  vehicle: vehicleRuntime,
  events: {
    onMutated: markSceneMutated,
    // onMaterialApplied fires for every tile on every application pass, not
    // just real changes — the reconciler reapplies constantly. Only actual
    // map swaps may bump the texture version, or the water runtime's
    // "textures settled" recapture never settles and rebakes the bathymetry
    // (a full ortho scene render) every debounce interval forever.
    onMaterialApplied: mesh => {
      const map = mesh?.material?.map ?? null;
      if (appliedTileTextures.get(mesh) !== map) {
        appliedTileTextures.set(mesh, map);
        terrainTextureVersion += 1;
      }
      requestRender();
    },
  },
});
const gridlinesRuntime = createTerrainGridlinesRuntime({
  terrainRoot,
  onChanged: () => {
    updateHud();
    requestRender();
  },
});
buildingsRuntime = createTerrainBuildingsRuntime({
  terrainRoot,
  pipelineState: terrainPipelineState,
  exaggeration: EXAG,
  onMutated: markSceneMutated,
  requestRender,
});

function getFogDistance() {
  return terrainFogDistance(getCameraLatLon().alt);
}

const tileMenuRuntime = createTerrainTileMenuRuntime({
  tileInfoElement: tileInfoEl,
});
const showTileMenu = tileMenuRuntime.show;
const hideTileMenu = tileMenuRuntime.hide;

// --- Camera position → lat/lon conversion ---

function getCameraLatLon(position = camera.position) {
  const coordinates = terrainCameraCoordinates({
    position, anchorPosition, east, north, up,
    anchorLatitude: anchorLat, anchorLongitude: anchorLon,
    originX: terrainPipelineState.originX, originY: terrainPipelineState.originY,
  });
  return { lat: coordinates.lat, lon: coordinates.lon, alt: coordinates.alt };
}

const exactCameraGeodetic = new Geodetic();

function getExactCameraLatLon(position = camera.position) {
  exactCameraGeodetic.setFromECEF(position);
  return {
    lat: exactCameraGeodetic.latitude * 180 / Math.PI,
    lon: exactCameraGeodetic.longitude * 180 / Math.PI,
    alt: exactCameraGeodetic.height,
  };
}

function getRenderedTerrainLatLon(position = camera.position) {
  if (!terrainPipelineState.frameOffsetReady) return getExactCameraLatLon(position);
  const coordinates = terrainCameraCoordinates({
    position, anchorPosition, east, north, up,
    anchorLatitude: anchorLat, anchorLongitude: anchorLon,
    originX: terrainPipelineState.originX, originY: terrainPipelineState.originY,
  });
  const grid = terrainCameraGridPosition({
    eastM: coordinates.eastM,
    northM: coordinates.northM,
    originX: terrainPipelineState.originX,
    originY: terrainPipelineState.originY,
    frameOffsetX: terrainPipelineState.frameOffsetX,
    frameOffsetY: terrainPipelineState.frameOffsetY,
  });
  return { ...epsg3413ToWgs84(grid.x, grid.y), alt: coordinates.alt, grid };
}

const googleMapsDirection = new THREE.Vector3();
const googleMapsEast = new THREE.Vector3();
const googleMapsNorth = new THREE.Vector3();
const googleMapsUp = new THREE.Vector3();
let lastGoogleCoordinateComparison = null;

function openGoogleMapsView() {
  camera.getWorldDirection(googleMapsDirection);
  const exactPosition = getExactCameraLatLon();
  const renderedPosition = getRenderedTerrainLatLon();
  const linearPosition = getCameraLatLon();
  Ellipsoid.WGS84.getEastNorthUpVectors(
    camera.position,
    googleMapsEast,
    googleMapsNorth,
    googleMapsUp,
  );
  raycaster.set(camera.position, googleMapsDirection);
  const centerHit = raycaster.intersectObjects(
    collectTerrainDebugMeshes(terrainRoot, debugIntersectables),
    false,
  )[0];
  const aimPosition = centerHit ? getRenderedTerrainLatLon(centerHit.point) : null;
  const gridBearing = renderedPosition.grid
    ? epsg3413DirectionBearing({
        x: renderedPosition.grid.x,
        y: renderedPosition.grid.y,
        directionX: googleMapsDirection.dot(east),
        directionY: googleMapsDirection.dot(north),
      })
    : null;
  const url = googleMaps3dUrl({
    lat: renderedPosition.lat,
    lon: renderedPosition.lon,
    alt: cameraRuntimeState.agl,
    directionEast: gridBearing == null ? googleMapsDirection.dot(googleMapsEast) : Math.sin(gridBearing * Math.PI / 180),
    directionNorth: gridBearing == null ? googleMapsDirection.dot(googleMapsNorth) : Math.cos(gridBearing * Math.PI / 180),
    directionUp: googleMapsDirection.dot(googleMapsUp),
    fov: camera.fov,
  });
  const latitudeRadians = exactPosition.lat * Math.PI / 180;
  lastGoogleCoordinateComparison = {
    camera: renderedPosition,
    aim: aimPosition,
  };
  console.info('[google-3d] camera coordinate comparison', {
    cameraWgs84: exactPosition,
    renderedTerrainWgs84: renderedPosition,
    centerAimWgs84: aimPosition,
    gridBearing,
    linearEnu: linearPosition,
    linearMinusExactMeters: {
      east: (linearPosition.lon - exactPosition.lon) * 111320 * Math.cos(latitudeRadians),
      north: (linearPosition.lat - exactPosition.lat) * 111320,
    },
    agl: cameraRuntimeState.agl,
    url,
  });
  updateHud();
  window.open(url, '_blank', 'noopener,noreferrer');
}

function getCameraLogSnapshot(camLL = null) {
  const coordinates = terrainCameraCoordinates({
    position: camera.position, anchorPosition, east, north, up,
    anchorLatitude: anchorLat, anchorLongitude: anchorLon,
    originX: terrainPipelineState.originX, originY: terrainPipelineState.originY,
  });
  if (camLL) {
    Object.assign(coordinates, camLL);
    const stereo = terrainCameraStereoPosition({
      latitude: camLL.lat, longitude: camLL.lon,
      anchorLatitude: anchorLat, anchorLongitude: anchorLon,
      originX: terrainPipelineState.originX, originY: terrainPipelineState.originY,
    });
    coordinates.stereoX = stereo.x;
    coordinates.stereoY = stereo.y;
  }
  return summarizeTerrainCamera(coordinates, {
    originX: terrainPipelineState.originX, originY: terrainPipelineState.originY,
    frameOffsetX: terrainPipelineState.frameOffsetX, frameOffsetY: terrainPipelineState.frameOffsetY,
    frameOffsetReady: terrainPipelineState.frameOffsetReady,
  });
}

// --- Tile fetching ---

const PREVIEW_MAX_DEPTH = 10;
const clock = new THREE.Clock();
const STREAMING_MAINTENANCE_MS = 1000;
const fpsCounter = createTerrainFpsCounter();

function markSceneMutated() { renderBackend.markSceneMutated(); }

function hasActiveKeyInput() {
  return Object.values(controls.keys).some(Boolean);
}

function needsContinuousRender() {
  return (
    controls.dragging ||
    hasActiveKeyInput() ||
    Math.abs(controls.speed) > 1e-3 ||
    Math.abs(controls.strafeSpeed) > 1e-3 ||
    vehicleRuntime.vehicleControlActive ||
    gameClockState.stopGameTimeMs != null ||
    // Animated water must hold the loop open on backends that actually idle
    // (WebGPU; the WebGL backend never stops once started). Mirrors the
    // waterRuntime.update visibility gate.
    (waterRuntime.enabled && waterParams.enabled && !controls.mapMode)
  );
}

function requestRender() { renderBackend.requestRender(); }

renderBackend.configureDemandRendering({
  render,
  needsContinuousRender,
  onStart: () => {
    clock.getDelta();
    fpsCounter.start(performance.now());
  },
  onIdle: () => {
    fpsCounter.idle();
    updateHud();
  },
});

function runStreamingMaintenance() {
  const before = renderBackend.sceneMutationVersion;
  let dateChanged = false;
  if (gameClockState.running) {
    currentDate.setTime(getGameDateFromBrowserTime().getTime());
    dateChanged = applyDate(currentDate, { force: false });
  }
  if (terrainPipelineState.lastTiles) {
    terrainTileSet.updateTextures(terrainPipelineState.lastTiles);
    gridlinesRuntime.update();
  }
  if (dateChanged || renderBackend.sceneMutationVersion !== before) {
    requestRender();
  }
}

const terrainFetchEvents = {
  onResponseApplied: requestRender,
  onBuildings: buildings => buildingsRuntime?.reconcile(buildings),
  onSkip: () => enqueueClientLog('debug', 'fetchTiles.skip', {
    reason: 'already fetching', ...getCameraLogSnapshot(),
  }),
  onPreviewComplete(result) {
    bootLog('tiles.pass1-preview-done', result.previewDetails);
    requestRender();
  },
  onPoll: requestRender,
  onError(error) {
    if (!terrainPipelineState.bootFetchLogged) {
      bootLog('tiles.initial-fetch.error', {
        message: error?.message ?? String(error), stack: error?.stack ?? null,
      });
      terrainPipelineState.bootFetchLogged = true;
    }
    console.error('Fetch error:', error);
  },
  onSettled() {
    // Do not read the movement clock here. Fetch callbacks can settle between
    // animation frames, and draining it would silently discard travel time.
    // Demand-render startup already resets the clock after a genuinely idle
    // period via configureDemandRendering.onStart.
    requestRender();
  },
};
const terrainFetchRuntime = createTerrainFetchRuntime({
  state: terrainPipelineState,
  previewMaxDepth: PREVIEW_MAX_DEPTH,
  view: {
    camera, anchorPosition, east, north, up, controls,
    anchorLatitude: anchorLat,
    anchorLongitude: anchorLon,
    getHeading: getTerrainViewHeading,
  },
  vehicle: vehicleRuntime,
  terrain: terrainTileSet,
  logger: { enqueue: enqueueClientLog, boot: bootLog },
  events: terrainFetchEvents,
});
const initialTerrainDemandHeading = getTerrainViewHeading();
const TERRAIN_DEMAND_HEADING_THRESHOLD = 2 * Math.PI / 180;
const TERRAIN_DEMAND_HEADING_SETTLE_MS = 200;

function commitTerrainDemandHeading(previousHeading, heading) {
  // Circular geometry demand is heading-independent. Turning only reranks
  // paint within the existing footprint; it must not rebuild tile residency.
  terrainTileSet.refreshTextures();
  enqueueClientLog('info', 'terrainDemand.heading.reset', {
    previousHeading, heading,
  });
  requestRender();
}
const terrainHeadingDemand = createTerrainHeadingDemandController({
  initialHeading: initialTerrainDemandHeading,
  threshold: TERRAIN_DEMAND_HEADING_THRESHOLD,
  settleMs: TERRAIN_DEMAND_HEADING_SETTLE_MS,
  onCommit: commitTerrainDemandHeading,
});

function rebuildTerrainDemandForViewDirection() {
  const heading = getTerrainViewHeading();
  return terrainHeadingDemand.observe(heading, {
    ready: !terrainPipelineState.firstLoad,
  });
}

// --- Fly to tile (T key, ?tile= URL param) ---

function activeTerrainMeshes() {
  return terrainRoot.children.filter(
    child => child.isMesh && Boolean(child.userData?.tileId),
  );
}

function raycastGroundAltitude(eastM, northM, startAltM) {
  const terrainMeshes = activeTerrainMeshes();
  if (terrainMeshes.length === 0) return null;
  const rayOrigin = anchorPosition.clone()
    .addScaledVector(east, eastM)
    .addScaledVector(north, northM)
    .addScaledVector(up, startAltM);
  aglRaycaster.set(rayOrigin, up.clone().negate());
  const hits = aglRaycaster.intersectObjects(terrainMeshes);
  if (hits.length === 0) return null;
  return startAltM - hits[0].distance;
}

const flyToTileRuntime = createTerrainFlyToTileRuntime({
  camera, anchorPosition, east, north, up, controls, cameraRuntimeState,
  pipelineState: terrainPipelineState, anchorLat, anchorLon,
  exitVehicle: () => vehicleRuntime.setVehicleControlActive(false, 'fly-to-tile'),
  applyCameraOrientation,
  requestFetch: () => terrainFetchRuntime.request(),
  requestRender,
  updateMapCamera,
  raycastGroundAltitude,
  enqueueLog: enqueueClientLog,
});

function promptFlyToTile() {
  const tileId = window.prompt('Fly to tile (depth-col-row):', '');
  if (tileId) flyToTileRuntime.flyToTile(tileId);
}

// --- Save/restore camera position ---

function savePosition() {
  if (terrainPipelineState.firstLoad) return;
  const coordinates = terrainCameraCoordinates({
    position: camera.position, anchorPosition, east, north, up,
    anchorLatitude: anchorLat, anchorLongitude: anchorLon,
    originX: terrainPipelineState.originX, originY: terrainPipelineState.originY,
  });
  const cameraGrid = terrainCameraGridPosition({
    eastM: coordinates.eastM,
    northM: coordinates.northM,
    originX: terrainPipelineState.originX,
    originY: terrainPipelineState.originY,
    frameOffsetX: terrainPipelineState.frameOffsetX,
    frameOffsetY: terrainPipelineState.frameOffsetY,
  });
  const saved = terrainCameraState({
    cameraLatLon: { lat: coordinates.lat, lon: coordinates.lon, alt: coordinates.alt },
    cameraGrid,
    yaw: getTerrainViewHeading(),
    pitch: controls.pitch,
    mapZoom: controls.mapZoom,
    terrainFrame: terrainPipelineState.frameOffsetReady
      ? {
          originX: terrainPipelineState.originX, originY: terrainPipelineState.originY,
          offsetX: terrainPipelineState.frameOffsetX, offsetY: terrainPipelineState.frameOffsetY,
        }
      : null,
  });
  localStorage.setItem('clouds-cam', JSON.stringify(saved));
}
setInterval(savePosition, 250);
window.addEventListener('beforeunload', savePosition);

// Restore saved camera position (lat/lon/alt are origin-independent)
try {
  const saved = JSON.parse(localStorage.getItem('clouds-cam'));
  const restored = restoreTerrainCameraState(saved, { anchorLat, anchorLon });
  if (restored) {
    camera.position.copy(anchorPosition)
      .addScaledVector(east, restored.eastM)
      .addScaledVector(north, restored.northM)
      .addScaledVector(up, restored.alt);
    if (restored.yaw != null) controls.yaw = restored.yaw;
    if (restored.pitch != null) controls.pitch = restored.pitch;
    // A reload restores a pose, not an in-progress movement. Restoring the
    // old velocity made braking carry the camera several metres after boot,
    // which looked like a small coordinate-system offset.
    controls.speed = 0;
    controls.strafeSpeed = 0;
    if (restored.mapZoom != null) controls.mapZoom = restored.mapZoom;
    const frame = restored.terrainFrame;
    if (frame) {
      terrainPipelineState.originX = frame.originX;
      terrainPipelineState.originY = frame.originY;
      terrainPipelineState.frameOffsetX = frame.offsetX;
      terrainPipelineState.frameOffsetY = frame.offsetY;
      terrainPipelineState.frameOffsetReady = true;
    }
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
terrainPipelineState.ready = true;
// ?tile=12-1461-786 starts the session centered over that tile (overrides the
// restored camera). flyToTile triggers the initial fetch itself, so the tile
// becomes the adopted origin; fall back to a normal fetch on a bad id.
const bootFlyToTileId = new URLSearchParams(window.location.search).get('tile');
if (!bootFlyToTileId || !flyToTileRuntime.flyToTile(bootFlyToTileId).ok) {
  terrainFetchRuntime.request();
}
vehicleRuntime.loadVehicleState();
vehicleRuntime.loadVehicleModel();

window.takramDebug = {
  sceneMode: 'clouds-terrain-managed-flask-ux-wip',
  cloudsEffect,
  aerialPerspective,
  referenceDate,
  anchorLat,
  anchorLon,
  controls,
  applyDate,
  flyToTile: tileId => flyToTileRuntime.flyToTile(tileId),
  bootEvents,
  getBootEvents: () => bootEvents.slice(),
  getCloudShadowDebugSummary: () => webgpuAtmosphere?.debugSummary() ?? null,
  // Water port bisect: 0 normal | 1 fetch open | 2 +de-tile bypass | 3 data paint
  setWaterDebugMode: mode => waterRuntime.setDebugMode?.(mode),
  flushClientLogQueue: () => flushClientLogQueue(),
  fetchTiles: terrainFetchRuntime.request,
  setBuildingsVisible: visible => buildingsRuntime.setVisible(visible),
  getBuildingsMesh: () => buildingsRuntime.getMesh(),
  saveVehicleState: reason => vehicleRuntime.saveVehicleState(reason ?? 'debug-api'),
  loadVehicleState: vehicleRuntime.loadVehicleState,
  setVehicleControlActive: active => vehicleRuntime.setVehicleControlActive(Boolean(active), 'debug-api'),
  getVehicleControlActive: () => vehicleRuntime.vehicleControlActive,
  gpuProfiler: renderBackend.gpuProfiler ?? null,
  setGpuProfilerEnabled: enabled => renderBackend.gpuProfiler?.setEnabled(Boolean(enabled)) ?? false,
  setGpuProfilerSampleInterval: frames => renderBackend.gpuProfiler?.setSampleInterval(frames) ?? null,
  clearGpuProfile: () => renderBackend.gpuProfiler?.clear(),
  getGpuProfile: () => renderBackend.gpuProfiler?.getSummary() ?? {
    supported: false,
    enabled: false,
    reason: 'GPU pass timing is currently available only on the WebGL backend',
  },
  terrainRoot,
  texCache,
  deferredTiles: terrainTileSet.deferredTiles,
  tileHistory,
  get currentTileIds() { return terrainTileSet.currentTileIds; },
  getSunDirection: () => sunDirection.clone()
};

// A DOM event bridge makes the latest result readable from automation worlds
// that intentionally cannot see page-script globals. It does no work unless a
// diagnostic explicitly requests a snapshot.
document.addEventListener('terrain-gpu-profile-request', () => {
  document.documentElement.dataset.terrainGpuProfile = JSON.stringify(
    window.takramDebug.getGpuProfile(),
  );
});

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

function hideTileInfo() {
  tileInfoEl.style.display = 'none';
  hoverOutlineController.show(null);
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
  const terrainMeshes = activeTerrainMeshes();
  if (terrainMeshes.length === 0) return;
  aglRaycaster.set(camera.position, up.clone().negate());
  const hits = aglRaycaster.intersectObjects(terrainMeshes);
  if (hits.length > 0) {
    cameraRuntimeState.agl = hits[0].distance;
  }
}

function aglSpeedFactor() {
  const t = Math.min(1, Math.max(0, cameraRuntimeState.agl / AGL_FULL_SPEED_M));
  return AGL_MIN_FACTOR + (1 - AGL_MIN_FACTOR) * t;
}

function updateMovement(dt) {
  const forwardPressed = isPressed('KeyW', 'ArrowUp');
  const backPressed = isPressed('KeyS', 'ArrowDown');
  const leftPressed = isPressed('KeyA', 'ArrowLeft');
  const rightPressed = isPressed('KeyD', 'ArrowRight');

  if (vehicleRuntime.vehicleControlActive && !controls.mapMode) {
    controls.speed = 0;
    controls.strafeSpeed = 0;
    if (!vehicleRuntime.vehicleLoaded) {
      vehicleRuntime.setVehicleControlActive(false, 'vehicle-unloaded');
      return;
    }
    const steer = (leftPressed ? 1 : 0) + (rightPressed ? -1 : 0);
    const drive = (forwardPressed ? 1 : 0) + (backPressed ? -1 : 0);
    const driveStep = stepVehicleDrive({
      dt, heading: vehicleRuntime.vehicleHeadingRad, speed: vehicleRuntime.vehicleSpeed, steer, drive,
      groundNormalX: vehicleRuntime.vehicleGroundNormal.x, groundNormalY: vehicleRuntime.vehicleGroundNormal.y,
      acceleration: vehicleRuntime.VEHICLE_ACCEL, brake: vehicleRuntime.VEHICLE_BRAKE,
      steerSpeed: vehicleRuntime.VEHICLE_STEER_SPEED, maxSpeed: vehicleRuntime.VEHICLE_DRIVE_SPEED,
    });
    vehicleRuntime.vehicleHeadingRad = driveStep.heading;
    vehicleRuntime.vehicleSpeed = driveStep.speed;
    if (vehicleRuntime.vehicleSpeed !== 0 || steer !== 0) {
      vehicleRuntime.vehicleGroup.position.x += driveStep.deltaX;
      vehicleRuntime.vehicleGroup.position.y += driveStep.deltaY;
      vehicleRuntime.vehicleMarker.position.x = vehicleRuntime.vehicleGroup.position.x;
      vehicleRuntime.vehicleMarker.position.y = vehicleRuntime.vehicleGroup.position.y;
      vehicleRuntime.vehicleSnapPending = true;
      vehicleRuntime.throttledVehicleSave();
      cameraRuntimeState.lastMoveTime = performance.now();
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
  controls.strafeSpeed = Math.max(-STRAFE_SPEED, Math.min(STRAFE_SPEED, controls.strafeSpeed));

  if (forwardPressed) {
    controls.speed = Math.min(controls.speed + ACCEL * dt, MAX_SPEED);
  } else if (backPressed) {
    controls.speed = Math.max(controls.speed - ACCEL * dt, -MAX_SPEED);
  } else if (!cameraRuntimeState.driftMode) {
    if (controls.speed > 0) {
      controls.speed = Math.max(controls.speed - BRAKE * dt, 0);
    } else if (controls.speed < 0) {
      controls.speed = Math.min(controls.speed + BRAKE * dt, 0);
    }
  }

  if (controls.mapMode) {
    controls.strafeSpeed = 0;
  } else if (rightPressed) {
    controls.strafeSpeed = Math.min(controls.strafeSpeed + ACCEL * dt, STRAFE_SPEED);
  } else if (leftPressed) {
    controls.strafeSpeed = Math.max(controls.strafeSpeed - ACCEL * dt, -STRAFE_SPEED);
  } else if (!cameraRuntimeState.driftMode) {
    if (controls.strafeSpeed > 0) {
      controls.strafeSpeed = Math.max(controls.strafeSpeed - BRAKE * dt, 0);
    } else if (controls.strafeSpeed < 0) {
      controls.strafeSpeed = Math.min(controls.strafeSpeed + BRAKE * dt, 0);
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
    if (controls.strafeSpeed !== 0) {
      move.addScaledVector(movementRight, controls.strafeSpeed * dt);
    }
  }
  if (controls.keys.KeyQ) {
    move.addScaledVector(up, STRAFE_SPEED * dt * 0.5);
  }
  if (controls.keys.KeyZ) {
    move.addScaledVector(up, -STRAFE_SPEED * dt * 0.5);
  }
  if (move.lengthSq() > 0) {
    cameraRuntimeState.lastMoveTime = performance.now();
  }
  camera.position.add(move);
  // NaN guard — if camera position gets corrupted (e.g. bad terrain data
  // or degenerate lookAt), snap back to last known good position.
  if (isNaN(camera.position.x) || isNaN(camera.position.y) || isNaN(camera.position.z)) {
    console.warn('[CAM] NaN detected — restoring last good position');
    camera.position.copy(cameraRuntimeState.lastGoodPosition);
    controls.speed = 0;
    controls.strafeSpeed = 0;
  } else {
    cameraRuntimeState.lastGoodPosition.copy(camera.position);
  }
  clampAltitude();
}

let lastHudHtml = '';
let lastAltText = '';

function updateHud() {
  const rel = camera.position.clone().sub(anchorPosition);
  const eastM = rel.dot(east);
  const northM = rel.dot(north);
  const altM = rel.dot(up);
  const exactPosition = getRenderedTerrainLatLon();
  const speedKmh = Math.hypot(controls.speed, controls.strafeSpeed) * 3.6;
  const headingForHud = vehicleRuntime.vehicleControlActive ? vehicleRuntime.vehicleHeadingRad : controls.yaw;
  const { degrees: deg, compass } = compassHeading(headingForHud);
  // Heightmap line — always present, stable width
  const hmPending = terrainPipelineState.heightmapsMissing + terrainPipelineState.heightmapsDownloading;
  const passLabel = terrainPipelineState.loadPass === 1
    ? '<span style="color:#ff0">PASS 1 (preview)</span>'
    : '<span style="color:#8f8">PASS 2 (full)</span>';
  const hmLine = `${passLabel}  hm: ${terrainTileSet.currentTileIds.size} tiles`
    + (hmPending > 0
      ? `  <span style="color:#fc8">${terrainPipelineState.heightmapsDownloading} downloading  ${terrainPipelineState.heightmapsMissing} queued</span>`
      : '');

  // Texture line: client fetch status + server-side pipeline
  const srvReady = terrainPipelineState.serverTextureStatus.ready || 0;
  const srvFetching = terrainPipelineState.serverTextureStatus.fetching || 0;
  const srvMissing = terrainPipelineState.serverTextureStatus.missing || 0;
  const srvAncestor = terrainPipelineState.serverTextureStatus.ancestor_fallback || 0;
  let texLine = `tex: ${texCache.size} cached`;
  // Client fetch pipeline
  if (texInflight.size > 0 || texFetching.size > 0) {
    texLine += `  <span style="color:#8cf">http: ${texInflight.size}</span>`;
    texLine += `  <span style="color:#fc8">poll: ${texFetching.size}</span>`;
  }
  // Server-side pipeline — show when there's work happening
  if (terrainPipelineState.serverTexturesFetching > 0 || terrainPipelineState.serverTexturesRetrying > 0 || srvMissing > 0) {
    texLine += `  <span style="color:#f8c">srv: ${terrainPipelineState.serverTexturesFetching} fetching</span>`;
    if (terrainPipelineState.serverTexturesRetrying > 0) texLine += `  <span style="color:#f66">${terrainPipelineState.serverTexturesRetrying} retry</span>`;
    if (srvMissing > 0) texLine += `  <span style="color:#999">${srvMissing} missing</span>`;
  }
  const modeLabel = heatmapRuntime?.active
    ? 'HEATMAP'
    : controls.seamMode
      ? 'SEAMS'
      : controls.mapMode
        ? 'MAP'
        : (vehicleRuntime.vehicleControlActive ? 'VEHICLE' : 'FLIGHT');
  const modeHtml = vehicleRuntime.vehicleControlActive
    ? '<span style="color:#ff3b30">VEHICLE</span>'
    : modeLabel;
  const gridlinesLine = gridlinesRuntime.active
    ? 'gridlines: <span id="gridlinesModeLink" style="color:#8f8;text-decoration:underline;cursor:pointer;pointer-events:auto">ON</span>'
    : 'gridlines: <span id="gridlinesModeLink" style="color:#0af;text-decoration:underline;cursor:pointer;pointer-events:auto">off</span>';
  const renderBackendLabel = backend === 'webgpu' ? 'WebGPU' : 'WebGL';
  const nextRenderBackendLabel = backend === 'webgpu' ? 'WebGL' : 'WebGPU';
  const roadDebugColor = textureStreamer.roadDebug ? '#ff3b30' : '#0af';
  const roadDebugLabel = textureStreamer.roadDebug ? 'roads RED' : 'roads';

  // Game clock display (bottom-left) — always show the date actually being rendered
  const gameDate = gameClockState.renderedDate;
  const now = performance.now();
  if (now - gameClockState.lastSavedAtMs > 5000) {
    gameClockState.lastSavedAtMs = now;
    localStorage.setItem(GAME_CLOCK_STORAGE_KEY, String(gameDate.getTime()));
  }
  renderGameClock(gameClockEl, gameDate, gameClockState.running, gameClockState.timeScale);

  const hudHtml = [
    '<b>Clouds Terrain Managed Flask UX WIP</b>',
    `mode: <b>${modeHtml}</b>`,
    `renderer: <span id="renderBackendLink" title="Switch to ${nextRenderBackendLabel}" style="color:#0af;text-decoration:underline;cursor:pointer;pointer-events:auto">${renderBackendLabel}</span>`,
    `fps: <b>${fpsCounter.display}</b>`,
    `lat: ${exactPosition.lat.toFixed(7)}°  lon: ${exactPosition.lon.toFixed(7)}°  alt: ${altM.toFixed(0)}m`,
    lastGoogleCoordinateComparison
      ? `Google compare · camera ${lastGoogleCoordinateComparison.camera.lat.toFixed(7)}, ${lastGoogleCoordinateComparison.camera.lon.toFixed(7)}` +
        (lastGoogleCoordinateComparison.aim
          ? ` · aim ${lastGoogleCoordinateComparison.aim.lat.toFixed(7)}, ${lastGoogleCoordinateComparison.aim.lon.toFixed(7)}`
          : ' · aim: no terrain hit')
      : '',
    `enu: E ${eastM.toFixed(0)}m  N ${northM.toFixed(0)}m  U ${altM.toFixed(0)}m`,
    `speed: ${speedKmh.toFixed(0)} km/h  heading: ${deg.toFixed(0)}° ${compass}`,
    hmLine,
    texLine,
    gridlinesLine,
    vehicleRuntime.vehicleControlActive
      ? 'W/S drive, A/D steer, mouse orbit camera, Esc exits vehicle control'
      : 'WASD or Arrows move, Q/Z altitude, drag look',
    'map: left-drag rotate, right-drag pan, wheel zoom',
    `<span id="mapModeLink" style="color:#0af;text-decoration:underline;cursor:pointer;pointer-events:auto">${controls.mapMode && !controls.seamMode && !heatmapRuntime?.active ? '3D view' : 'map mode'}</span> (M)` +
      ` · <span id="seamModeLink" style="color:#0af;text-decoration:underline;cursor:pointer;pointer-events:auto">${controls.seamMode ? '3D view' : 'seam view'}</span>` +
      ` · <span id="heatmapModeLink" style="color:#0af;text-decoration:underline;cursor:pointer;pointer-events:auto">${heatmapRuntime?.active ? '3D view' : 'heatmap'}</span>` +
      ' · Google 3D (G)' +
      ' · fast time 03:00–03:00 (P)' +
      ` · <span id="roadDebugLink" style="color:${roadDebugColor};text-decoration:underline;cursor:pointer;pointer-events:auto">${roadDebugLabel}</span>` +
      ' · <span id="resetViewLink" style="color:#0af;text-decoration:underline;cursor:pointer;pointer-events:auto">reset</span>' +
      ' · <span id="debugLogLink" style="color:#0af;text-decoration:underline;cursor:pointer;pointer-events:auto">debug log</span>'
  ].join('<br>');
  // Rewriting innerHTML every rendered frame forces a DOM parse + relayout
  // even when nothing changed — only write when the content differs. The
  // selection guards pause writes while the user is selecting HUD text to
  // copy; the cache comparison retries the write once the guard lifts.
  if (hudHtml !== lastHudHtml) {
    const selection = window.getSelection();
    const selectionInsideHud = Boolean(
      selection && !selection.isCollapsed && (
        hud.contains(selection.anchorNode) || hud.contains(selection.focusNode)
      )
    );
    if (hud.dataset.selecting !== 'true' && !selectionInsideHud) {
      hud.innerHTML = hudHtml;
      lastHudHtml = hudHtml;
    }
  }
  const altText =
    `${altM.toFixed(0)}m / ${(altM * 3.28084).toFixed(0)}ft  ${deg.toFixed(0)}° ${compass}` +
    `  FOV ${camera.fov.toFixed(0)}°` +
    (heatmapRuntime?.active
      ? '  [HEATMAP]'
      : (controls.seamMode
        ? '  [SEAMS]'
        : (controls.mapMode ? '  [MAP]' : (vehicleRuntime.vehicleControlActive ? '  [VEHICLE]' : ''))));
  if (altText !== lastAltText) {
    alt.textContent = altText;
    lastAltText = altText;
  }
}

function resetView() {
  localStorage.removeItem('clouds-cam');
  localStorage.removeItem(TUNING_STORAGE_KEY);
  localStorage.removeItem(GAME_CLOCK_STORAGE_KEY);
  for (const k of Object.keys(tuningState)) delete tuningState[k];
  controls.yaw = defaultYaw;
  controls.pitch = defaultPitch;
  controls.speed = 0;
  controls.strafeSpeed = 0;
  controls.dragging = false;
  controls.dragButton = 0;
  controls.mapMode = false;
  controls.seamMode = false;
  heatmapRuntime?.setPresentation('hidden');
  vehicleRuntime.setVehicleControlActive(false, 'reset');
  controls.mapPanEast = 0;
  controls.mapPanNorth = 0;
  controls.mapZoom = DEFAULT_MAP_ZOOM;
  camera.position.copy(defaultCameraPosition);
  camera.fov = 60;
  camera.updateProjectionMatrix();
  syncMapModePresentation();
  hideTileInfo();
  applyCameraOrientation();
  updateMapCamera();
  // Reset all tuning sliders/toggles to defaults (clouds, cirrus, fog, etc.)
  resetTuningUI();
  camera.far = MAX_VIEW_DIST;
  camera.updateProjectionMatrix();
  // Close atmosphere panel
  tuningPanelOpen = false;
  tuningBody.style.display = 'none';
  document.getElementById('tuning-toggle').innerHTML = '&#9660;';
  updateHud();
  // Re-fetch tiles around the reset camera position.
  terrainPipelineState.firstLoad = true;
  textureStreamer.abortAll();
  terrainTileSet.resetTextureApplications();
  terrainFetchRuntime.reset(1);
  terrainPipelineState.originX = 0; terrainPipelineState.originY = 0;
  terrainPipelineState.cameraStereoX = 0; terrainPipelineState.cameraStereoY = 0;
  terrainPipelineState.lastFetchX = 0; terrainPipelineState.lastFetchY = 0;
  terrainPipelineState.frameOffsetX = 0; terrainPipelineState.frameOffsetY = 0;
  terrainPipelineState.frameOffsetReady = false;
  terrainFetchRuntime.request();
}

function toggleRoadDebug() {
  const enabled = textureStreamer.setRoadDebug(!textureStreamer.roadDebug);
  terrainTileSet.resetTextureApplications();
  terrainTileSet.refreshTextures();
  enqueueClientLog('info', 'roads.debug.toggle', { enabled });
  updateHud();
  requestRender();
  return enabled;
}

function syncMapModePresentation() {
  // Map-only presentation belongs to one state boundary. The world-space
  // marker remains disabled; the centered DOM arrow is backend-independent.
  camMarker.visible = false;
  const heatmapActive = Boolean(heatmapRuntime?.active);
  if (heatmapRuntime) {
    heatmapRuntime.setPresentation(
      controls.mapMode ? (heatmapActive ? 'heatmap' : 'edges') : 'hidden',
    );
  }
  mapLocationMarkerEl.style.display = controls.mapMode && !heatmapActive ? 'block' : 'none';
  renderer.domElement.style.visibility = heatmapActive ? 'hidden' : 'visible';
  tuningPanel.style.display = controls.mapMode ? 'none' : '';
  seamLegendEl.style.display = controls.seamMode && !heatmapActive ? 'block' : 'none';
}

function toggleHeatmap() {
  const transition = resolveTerrainViewToggle({
    mapMode: controls.mapMode,
    heatmapActive: heatmapRuntime.active,
    seamMode: controls.seamMode,
  }, 'heatmap');
  if (!transition.accepted) return;
  controls.mapMode = transition.mapMode;
  controls.seamMode = transition.seamMode;
  if (transition.heatmapActive) {
    cameraRuntimeState.driftMode = false;
    controls.strafeSpeed = 0;
    vehicleRuntime.setVehicleControlActive(false, 'heatmap-mode');
    controls.mapPanEast = 0;
    controls.mapPanNorth = 0;
    updateMapCamera();
  }
  heatmapRuntime.setPresentation(transition.heatmapActive ? 'heatmap' : 'hidden');
  hideTileInfo();
  hideTileMenu();
  syncMapModePresentation();
  updateHud();
  requestRender();
}

function toggleMapMode() {
  const transition = resolveTerrainViewToggle({
    mapMode: controls.mapMode,
    heatmapActive: heatmapRuntime.active,
    seamMode: controls.seamMode,
  }, 'map');
  if (!transition.accepted) return;
  controls.mapMode = transition.mapMode;
  controls.seamMode = transition.seamMode;
  heatmapRuntime.setPresentation('hidden');
  cameraRuntimeState.driftMode = false;
  controls.strafeSpeed = 0;
  if (controls.mapMode) {
    vehicleRuntime.setVehicleControlActive(false, 'map-mode');
  }
  syncMapModePresentation();
  controls.mapPanEast = 0;
  controls.mapPanNorth = 0;
  if (controls.mapMode) {
    updateMapCamera();
  } else {
    hideTileInfo();
    hideTileMenu();
  }
  if (terrainPipelineState.lastTiles) {
    terrainTileSet.refreshTextures();
  }
}

function toggleSeamMode() {
  const transition = resolveTerrainViewToggle({
    mapMode: controls.mapMode,
    heatmapActive: heatmapRuntime.active,
    seamMode: controls.seamMode,
  }, 'seam');
  if (!transition.accepted) return;
  controls.mapMode = transition.mapMode;
  controls.seamMode = transition.seamMode;
  heatmapRuntime.setPresentation('hidden');
  cameraRuntimeState.driftMode = false;
  controls.strafeSpeed = 0;
  if (controls.mapMode) {
    vehicleRuntime.setVehicleControlActive(false, 'seam-mode');
  }
  controls.mapPanEast = 0;
  controls.mapPanNorth = 0;
  if (controls.mapMode) {
    updateMapCamera();
  } else {
    hideTileInfo();
    hideTileMenu();
  }
  syncMapModePresentation();
  updateHud();
  requestRender();
}

function toggleGridlines() {
  if (controls.mapMode) return;
  gridlinesRuntime.toggle();
}

installTerrainKeyboardControls({
  controls,
  isVehicleActive: () => vehicleRuntime.vehicleControlActive,
  onForwardDoubleTap: () => {
    cameraRuntimeState.driftMode = !cameraRuntimeState.driftMode;
    console.log(`[drift] ${cameraRuntimeState.driftMode ? 'ON' : 'OFF'}`);
  },
  onEscapeVehicle: () => {
    vehicleRuntime.saveVehicleState('escape', { snapToGround: true, requireGroundedZ: false, bypassSnapThrottle: true });
    vehicleRuntime.setVehicleControlActive(false, 'escape', { skipExitSave: true });
  },
  onToggleMap: toggleMapMode,
  onOpenGoogleMaps: openGoogleMapsView,
  onFlyToTile: promptFlyToTile,
  onStartFastTime: startFastTime,
  onToggleHeadlights: () => {
    for (const light of vehicleRuntime.vehicleHeadlightSpots) light.visible = !light.visible;
  },
  onChanged: requestRender,
});

installTerrainPointerControls({
  element: renderer.domElement,
  controls,
  mouseSensitivity: MOUSE_SENS,
  mapPanFactor: MAP_PAN_FACTOR,
  isVehicleActive: () => vehicleRuntime.vehicleControlActive,
  onVehicleOrbit: (movementX, movementY) => {
    vehicleRuntime.vehicleCameraOrbitYaw -= movementX * vehicleRuntime.VEHICLE_CAMERA_ORBIT_SENS;
    vehicleRuntime.vehicleCameraOrbitPitch = THREE.MathUtils.clamp(
      vehicleRuntime.vehicleCameraOrbitPitch + movementY * vehicleRuntime.VEHICLE_CAMERA_ORBIT_SENS,
      vehicleRuntime.VEHICLE_CAMERA_ORBIT_PITCH_MIN,
      vehicleRuntime.VEHICLE_CAMERA_ORBIT_PITCH_MAX,
    );
  },
  onMapCameraChanged: updateMapCamera,
  onChanged: requestRender,
});

renderer.domElement.addEventListener('click', event => {
  if (!controls.mapMode) {
    return;
  }
  const targets = collectTerrainDebugMeshes(terrainRoot, debugIntersectables);
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
  const topInfo = summarizeTerrainMesh(hits[0].object);
  const topSrc = texSource.get(topInfo.tileId) || '';
  showTileMenu(event.clientX, event.clientY, topInfo.tileId, topSrc);

  hits.forEach((hit, index) => {
    const info = summarizeTerrainMesh(hit.object);
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
  const gridlines3dHover = gridlinesRuntime.active && !controls.mapMode;
  if ((!controls.mapMode && !gridlines3dHover) || controls.dragging) {
    hideTileInfo();
    return;
  }
  const targets = collectTerrainDebugMeshes(terrainRoot, debugIntersectables);
  if (targets.length === 0) {
    hideTileInfo();
    return;
  }
  mouseNDC.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouseNDC.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouseNDC, controls.mapMode ? mapCam : camera);
  const hits = raycaster.intersectObjects(targets);
  if (hits.length === 0) {
    hideTileInfo();
    return;
  }

  const mesh = hits[0].object;
  if (gridlines3dHover) {
    hoverOutlineController.show(null);
    tileInfoEl.textContent = `tile: ${mesh.userData.tileId}`;
    tileInfoEl.style.left = `${Math.max(8, Math.min(event.clientX + 14, window.innerWidth - 180))}px`;
    tileInfoEl.style.top = `${Math.max(8, Math.min(event.clientY + 14, window.innerHeight - 42))}px`;
    tileInfoEl.style.right = 'auto';
    tileInfoEl.style.display = 'block';
    return;
  }
  hoverOutlineController.show(mesh, 'outline');
  tileInfoEl.style.left = 'auto';
  tileInfoEl.style.top = '12px';
  tileInfoEl.style.right = '12px';
  const info = summarizeTerrainMesh(mesh);
  const overlappingMeshes = [...new Map(hits
    .filter(hit => hit.object.userData?.tileId && hit.object.userData.tileId !== info.tileId)
    .map(hit => [hit.object.userData.tileId, hit.object])).values()];
  const overlapLines = overlappingMeshes.slice(0, 12)
    .map(overlapMesh => {
      const row = summarizeTerrainMesh(overlapMesh);
      const rsrc = texSource.get(row.tileId) || '';
      return `${row.tileId} ${rsrc || (row.hasTexture ? 'tex' : 'noTex')}`;
    });

  const src = texSource.get(info.tileId) || 'none';
  const srcLabel = `<span style="color:#f80">${src || 'no texture'}</span>`;
  const matHex = info.color !== '-' ? info.color : '#ffffff';
  const seamRows = controls.seamMode ? mapGridController.diagnosticsForTile(info.tileId) : [];
  const badSeams = seamRows.filter(seam => seam.severity === 'bad').length;
  const warningSeams = seamRows.filter(seam => seam.severity === 'warning').length;
  tileInfoEl.innerHTML = [
    `<b style="color:${matHex}">${info.tileId}</b>`,
    `tex: ${info.hasTexture ? 'YES' : 'NO'} ${info.textureSize}  source: ${srcLabel}`,
    controls.seamMode
      ? `<b>shared edges: ${seamRows.length} · <span style="color:#ff1744">${badSeams} bad</span> · <span style="color:#f59e0b">${warningSeams} inspect</span></b>`
      : null,
    ...seamRows.slice(0, 8).map(seam => {
      const color = seam.severity === 'bad' ? '#ff1744' : seam.severity === 'warning' ? '#f59e0b' : '#94a3b8';
      return `<span style="color:${color}">${formatTerrainSeamDiagnostic(seam)}</span>`;
    }),
    `<b>overlaps: ${overlappingMeshes.length}</b>`,
    overlapLines.length > 0 ? overlapLines.join('<br>') : null
  ].filter(Boolean).join('<br>');
  tileInfoEl.style.display = 'block';
});

renderer.domElement.addEventListener('mouseleave', hideTileInfo);

renderer.domElement.addEventListener('contextmenu', event => {
  event.preventDefault();
  if (!controls.mapMode) {
    vehicleRuntime.tryEnterVehicleControlFromPointer(event);
    return;
  }
  const targets = collectTerrainDebugMeshes(terrainRoot, debugIntersectables);
  if (targets.length === 0) return;
  mouseNDC.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouseNDC.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouseNDC, mapCam);
  const hits = raycaster.intersectObjects(targets);
  if (hits.length === 0) return;
  const info = summarizeTerrainMesh(hits[0].object);
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
      controls.mapZoom = Math.max(500, Math.min(MAX_MAP_ZOOM, controls.mapZoom));
      savePosition();
      updateMapCamera();
      requestRender();
    } else if (vehicleRuntime.vehicleControlActive) {
      const scale = zoomIn ? 0.9 : 1.1;
      vehicleRuntime.VEHICLE_CAMERA_FOLLOW_DISTANCE = Math.max(8, Math.min(200, vehicleRuntime.VEHICLE_CAMERA_FOLLOW_DISTANCE * scale));
      vehicleRuntime.VEHICLE_CAMERA_FOLLOW_HEIGHT = Math.max(2, Math.min(80, vehicleRuntime.VEHICLE_CAMERA_FOLLOW_HEIGHT * scale));
      requestRender();
    } else {
      camera.fov *= zoomIn ? 0.95 : 1.05;
      camera.fov = Math.max(20, Math.min(100, camera.fov));
      camera.updateProjectionMatrix();
      requestRender();
    }
  },
  { passive: false }
);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderBackend.resize(window.innerWidth, window.innerHeight);
  updateMapCamera();
  requestRender();
});

applyCameraOrientation();
camera.updateProjectionMatrix();
camera.updateMatrixWorld(true);
updateMapCamera();
updateHud();

function render() {
  const elapsedDt = clock.getDelta();
  // Movement consumes the entire wall-clock interval. If rendering stalls,
  // intermediate simulation states are advanced without rendering and this
  // frame presents only the current camera/vehicle position.
  advanceRealtimeMovement(elapsedDt, updateMovement);
  // Purely visual simulations may drop stale time to avoid a large unstable
  // water or suspension step after a delayed frame.
  const dt = Math.min(MAX_REALTIME_STEP_SECONDS, elapsedDt);
  const nowMs = performance.now();
  fpsCounter.frame(nowMs);
  if (gameClockState.running) {
    currentDate.setTime(getGameDateFromBrowserTime().getTime());
  }
  applyDate(currentDate, { force: false });
  applyCameraOrientation();
  rebuildTerrainDemandForViewDirection();
  updateHud();
  syncMapModePresentation();

  // Update fog density from slider
  const fogStrength = controls._fogStrength ?? renderBackend.defaultFogStrength;
  renderBackend.setFogDensity(fogStrength / getFogDistance());
  renderBackend.setMapMode(controls.mapMode);

  waterRuntime.update({
    dt, camera,
    visible: waterParams.enabled && !controls.mapMode,
  });

  // Terrain streaming: check if camera moved far enough to re-fetch
  if (!terrainPipelineState.firstLoad) {
    const coordinates = terrainCameraCoordinates({
      position: camera.position, anchorPosition, east, north, up,
      anchorLatitude: anchorLat, anchorLongitude: anchorLon,
      originX: terrainPipelineState.originX, originY: terrainPipelineState.originY,
    });
    const gridPosition = terrainCameraGridPosition({
      eastM: coordinates.eastM,
      northM: coordinates.northM,
      originX: terrainPipelineState.originX,
      originY: terrainPipelineState.originY,
      frameOffsetX: terrainPipelineState.frameOffsetX,
      frameOffsetY: terrainPipelineState.frameOffsetY,
    });
    terrainPipelineState.cameraStereoX = gridPosition.x;
    terrainPipelineState.cameraStereoY = gridPosition.y;
    const refetch = evaluateTerrainRefetch({
      cameraX: terrainPipelineState.cameraStereoX, cameraY: terrainPipelineState.cameraStereoY,
      lastFetchX: terrainPipelineState.lastFetchX, lastFetchY: terrainPipelineState.lastFetchY,
      nowMs, lastTriggerMs: terrainPipelineState.lastFetchTriggerMs,
      distanceThreshold: REFETCH_DIST, triggerIntervalMs: 500,
    });
    terrainPipelineState.lastFetchTriggerMs = refetch.nextTriggerMs;
    if (refetch.shouldFetch) terrainFetchRuntime.request();
  }
  vehicleRuntime.snapVehicleToTerrain();
  vehicleRuntime.updateDieselVolume();
  vehicleRuntime.updateVehicleSuspension(dt);
  if (vehicleRuntime.vehicleControlActive && !controls.mapMode) {
    vehicleRuntime.updateVehicleFollowCamera();
  }
  vehicleRuntime.syncVehicleSunLight();
  vehicleRuntime.syncVehicleShadowReceivers();
  vehicleRuntime.updateVehicleShadowSystem();
  vehicleRuntime.vehicleMarkerLayer.visible = controls.mapMode;
  mapGridController.setVisible(controls.seamMode && !heatmapRuntime.active);
  if (controls.mapMode) {
    if (!heatmapRuntime.active) {
      mapGridController.update(collectTerrainDebugMeshes(terrainRoot, debugIntersectables));
    }
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
    vehicleRuntime.vehicleMarker.scale.setScalar(markerScale * vehicleRuntime.VEHICLE_MARKER_MAP_SCALE);
    renderBackend.renderMap(scene, mapCam, _mapBg);
    renderBackend.stopRenderLoopIfIdle();
    return;
  }
  if (SCATTER_ENABLED && _scatterLib) updateScatterVisibility(terrainRoot, camera);
  webgpuAtmosphere?.updateCloudShadows(clock.elapsedTime);
  try {
    renderBackend.renderScene(scene, camera);
  } finally {
    restoreCloudTemporalHistory?.();
    restoreCloudTemporalHistory = null;
  }
  renderBackend.stopRenderLoopIfIdle();
}

window.setInterval(runStreamingMaintenance, STREAMING_MAINTENANCE_MS);
renderBackend.startRenderLoop();
}
