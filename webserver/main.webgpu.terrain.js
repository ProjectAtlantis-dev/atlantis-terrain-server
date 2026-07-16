// UX WIP scene: preserve baseline rendering, layer in map mode + movement + HUD.
import * as THREE from 'three';
import {
  bool,
  color,
  context,
  densityFogFactor,
  fog,
  mrt,
  output,
  pass,
  toneMapping,
  uniform
} from 'three/tsl';
import { MeshLambertNodeMaterial, PostProcessing, WebGPURenderer } from 'three/webgpu';
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
  getECIToECEFRotationMatrix,
  getMoonDirectionECEF,
  getSunDirectionECEF,
  PrecomputedTexturesLoader
} from '@takram/three-atmosphere';
import {
  aerialPerspective as webgpuAerialPerspective,
  AtmosphereContext,
  AtmosphereLight,
  AtmosphereParameters as WebGPUAtmosphereParameters,
  shadowLength,
  skyBackground,
  viewZUnit
} from '@takram/three-atmosphere/webgpu';
import {
  CascadedShadowMapsNode,
  dithering,
  highpVelocity,
  lensFlare,
  temporalAntialias
} from '@takram/three-geospatial/webgpu';
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
import {
  CloudShadowAtmosphereLightNode,
  WebGPUCloudShadows
} from './webgpu-cloud-shadows.js';
import { buildBackupScatterLibrary } from './laas-scatter-adapter.js';
import { GreenlandPatch } from './laas-terrain-patch.js';
import { installMaterialKeyMemo } from './laas/render/ThreePatches.ts';
import { installPositionInvariance } from './laas/render/VegPrepass.ts';
import { buildTileScatter, disposeTileScatter, updateScatterVisibility } from './procgen/scatter.ts';
import { createTileLifecycle } from './terrain-tile-lifecycle.js';
import { createTerrainOceanClassifier } from './classifier/terrain-ocean.js';
import { priorityHeading, terrainTilePriority } from './terrain-priority.js';
import { compassHeading, createTerrainHud, renderGameClock, TERRAIN_HUD_LINKS } from './terrain-hud.js';
import { installTerrainKeyboardControls, installTerrainPointerControls } from './terrain-controls.js';
import { createVehiclePersistenceRuntime, normalizeSavedVehicleState, stepSuspension, stepVehicleDrive, vehicleLocalToLatLon as terrainVehicleLocalToLatLon, vehicleStateSnapshot } from './terrain-vehicle.js';
import { createTileHistory, terrainFogDistance, terrainVisibilityDistance, tileDepthFromId } from './terrain-tile-runtime.js';
import { createTextureStreamer, rendererTextureAnisotropy } from './terrain-texture-streamer.js';
import { createTerrainMeshRuntime } from './terrain-mesh-runtime.js';
import { createTerrainTextureController } from './terrain-texture-controller.js';
import { evaluateTerrainRefetch, summarizeTerrainCamera, terrainCameraCoordinates, terrainCameraStereoPosition } from './terrain-tile-fetch.js';
import { createTerrainFetchScheduler } from './terrain-fetch-scheduler.js';
import { createTerrainEnhancementController } from './terrain-enhancement-controller.js';
import { createTerrainMeshBuilder } from './terrain-mesh-builder.js';
import { applyTerrainAvailabilityStatus, createTerrainSeamStatusController } from './terrain-status-controller.js';
import { collectTerrainDebugMeshes, createTerrainOutlineController, summarizeTerrainMesh } from './terrain-debug-runtime.js';
import { createTerrainFetchExecutor } from './terrain-fetch-executor.js';
import { restoreTerrainCameraState, terrainCameraState } from './terrain-camera-state.js';
import { createTerrainClientLogger } from './terrain-client-logging.js';
import { createTerrainFpsCounter } from './terrain-fps-counter.js';
import { loadTerrainStartupAssets } from './terrain-startup-assets.js';
import { createTerrainAtmosphereTextureRuntime } from './terrain-atmosphere-textures.js';
import { createTerrainTuningControls } from './terrain-tuning-controls.js';
import { bindTerrainCloudComposition, configureTerrainClouds, registerTerrainCloudTuning } from './terrain-cloud-runtime.js';
import { createTerrainHouseConfiguration, createTerrainHouseMarkerRuntime, createTerrainHouseModelController, disposeTerrainHouseTree, markTerrainHousesNeedSnap, terrainHouseLocalPosition, terrainHouseShadowCoverage, terrainHouseZSummary } from './terrain-house-runtime.js';

const USE_WEBGPU_RENDER_BACKEND = true;
// Calibrated against the cloudless WebGL reference. WebGL uses exposure 10
// after relative-luminance normalization; this pair gives the WebGPU AgX path
// a comparable pre-tone-map scale without changing physical scattering.
const WEBGPU_ATMOSPHERE_LUMINANCE_SCALE = 5.0;
const WEBGPU_TONE_MAPPING_EXPOSURE = 2.5;
const WEBGPU_DEFAULT_HAZE = 6.5;
const WEBGPU_SUN_ANGULAR_RADIUS = 0.02;
const WEBGPU_ATMOSPHERE_DEFAULTS = Object.freeze({
  luminanceScale: WEBGPU_ATMOSPHERE_LUMINANCE_SCALE,
  toneMappingExposure: WEBGPU_TONE_MAPPING_EXPOSURE,
  sunAngularRadius: WEBGPU_SUN_ANGULAR_RADIUS,
  sunIntensity: 1,
  rayleighScale: 1,
  mieScale: 1.4,
  groundAlbedo: 0.3,
  // Epipolar god rays (volumetric shadow length fed into the inscatter).
  godRays: true,
  godRaySlices: 512
});
const WEBGPU_CLOUD_SHADOW_DEFAULTS = Object.freeze({
  // WebGPU clouds are intentionally unavailable for now. Takram CloudsEffect
  // is WebGL-only; keep this provisional shadow path hard-disabled until a
  // complete WebGPU cloud renderer exists.
  enabled: false,
  debugSurface: false,
  coverage: 0.52,
  density: 1.15,
  strength: 1
});
const webgpuAtmosphereSettings = { ...WEBGPU_ATMOSPHERE_DEFAULTS };
const webgpuCloudShadowSettings = {
  ...WEBGPU_CLOUD_SHADOW_DEFAULTS,
  // Shareable validation view; the UI toggle remains the normal control.
  enabled: window.location.hash !== '#no-cloud-shadows',
  debugSurface: window.location.hash === '#shadow-mask'
};

// Preserve the small set of boot-only diagnostics before cleaning the visible
// URL. Runtime tuning remains UI-owned; these values exist solely for
// reproducible camera/procgen verification runs.
const BOOT_QUERY = new URLSearchParams(window.location.search);
function bootQueryNumber(name, fallback) {
  const raw = BOOT_QUERY.get(name);
  if (raw == null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

// The main view is controlled entirely through its UI. Discard stale query
// parameters instead of exposing URL state that does not stay in sync.
if (window.location.search) {
  history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
}
const _recolor = false;
const DEFAULT_ASSET_SERVER_BASE = 'http://127.0.0.1:8787';
const ASSET_SERVER_BASE = DEFAULT_ASSET_SERVER_BASE;
const VEHICLE_STATE_ENDPOINT = `${ASSET_SERVER_BASE}/api/vehicle_state`;
const ASSETS_ENDPOINT = `${ASSET_SERVER_BASE}/api/assets`;
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

const anchorLon = DEFAULT_LOCATION.lon;
const anchorLat = DEFAULT_LOCATION.lat;

const startupAssetsResponse = await loadTerrainStartupAssets({
  endpoint: ASSETS_ENDPOINT,
  timeoutMs: ASSETS_FETCH_TIMEOUT_MS,
  bootLog,
});
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
const webgpuFogDensity = uniform(0).setName('webgpuDistanceFogDensity');
// Exposure for the explicit AgX tone-mapping node in the WebGPU post chain
// (the renderer's own tone mapping is disabled there).
const webgpuToneMappingExposure = uniform(WEBGPU_TONE_MAPPING_EXPOSURE).setName('webgpuToneMappingExposure');
if (USE_WEBGPU_RENDER_BACKEND) {
  scene.fog = null;
  scene.fogNode = fog(color(0x000000), densityFogFactor(webgpuFogDensity));
}
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
let tileFetchingReady = false;
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

let webgpuAtmosphereParameters = null;
let webgpuAtmosphereContext = null;
let webgpuSkyBackgroundNode = null;
let webgpuAtmosphereLight = null;
let webgpuAtmosphereNode = null;
let webgpuAtmospherePostProcessing = null;
let webgpuCloudShadows = null;
let webgpuCsmShadowNode = null;
let webgpuShadowLengthNode = null;
let webgpuAtmospherePostProcessingReady = false;
let webgpuSunLastLogMs = 0;
let webgpuSunLastLogDateMs = NaN;

function createWebGPUAtmosphereContext() {
  if (!USE_WEBGPU_RENDER_BACKEND) {
    return null;
  }
  webgpuAtmosphereParameters = new WebGPUAtmosphereParameters();
  webgpuAtmosphereParameters.luminanceScale *= webgpuAtmosphereSettings.luminanceScale;
  webgpuAtmosphereParameters.rayleighScattering.multiplyScalar(webgpuAtmosphereSettings.rayleighScale);
  webgpuAtmosphereParameters.mieScattering.multiplyScalar(webgpuAtmosphereSettings.mieScale);
  webgpuAtmosphereParameters.mieExtinction.multiplyScalar(webgpuAtmosphereSettings.mieScale);
  webgpuAtmosphereParameters.groundAlbedo.setScalar(webgpuAtmosphereSettings.groundAlbedo);

  const atmosphereContext = new AtmosphereContext(webgpuAtmosphereParameters);
  atmosphereContext.camera = camera;
  atmosphereContext.ellipsoid = Ellipsoid.WGS84;
  // Raymarch the inscattered light between camera and surface, accounting for
  // shadowed segments (feeds the epipolar god-ray shadow length).
  atmosphereContext.raymarchScattering = true;
  atmosphereContext.accurateShadowScattering = true;
  // The scene's world coordinates are already ECEF. terrainRoot is the object
  // that carries the local ENU transform for terrain children.
  atmosphereContext.matrixWorldToECEF.value.identity();
  return atmosphereContext;
}

function formatWebGPUSunDebug(date, source = 'update') {
  const sun = webgpuAtmosphereContext?.sunDirectionECEF?.value;
  if (sun == null) {
    return { source, date: date?.toISOString?.() ?? String(date), hasSun: false };
  }
  const eastDot = sun.dot(east);
  const northDot = sun.dot(north);
  const upDot = sun.dot(up);
  const azimuthDeg = (Math.atan2(eastDot, northDot) * 180 / Math.PI + 360) % 360;
  const elevationDeg = Math.asin(THREE.MathUtils.clamp(upDot, -1, 1)) * 180 / Math.PI;
  return {
    source,
    date: date.toISOString(),
    ecef: {
      x: Number(sun.x.toFixed(6)),
      y: Number(sun.y.toFixed(6)),
      z: Number(sun.z.toFixed(6))
    },
    local: {
      east: Number(eastDot.toFixed(6)),
      north: Number(northDot.toFixed(6)),
      up: Number(upDot.toFixed(6)),
      azimuthDeg: Number(azimuthDeg.toFixed(2)),
      elevationDeg: Number(elevationDeg.toFixed(2))
    }
  };
}

function maybeLogWebGPUSun(date, source = 'update', force = false) {
  if (!USE_WEBGPU_RENDER_BACKEND || webgpuAtmosphereContext == null) {
    return;
  }
  const now = performance.now();
  const dateMs = date.getTime();
  if (
    !force &&
    now - webgpuSunLastLogMs < 5000 &&
    Math.abs(dateMs - webgpuSunLastLogDateMs) < 10 * 60 * 1000
  ) {
    return;
  }
  webgpuSunLastLogMs = now;
  webgpuSunLastLogDateMs = dateMs;
  enqueueClientLog('info', 'webgpu.sun', formatWebGPUSunDebug(date, source));
  if (force) {
    flushClientLogQueue();
  }
}

webgpuAtmosphereContext = createWebGPUAtmosphereContext();
if (webgpuAtmosphereContext != null) {
  // v0.19: the context flows to every atmosphere node through the renderer's
  // node context (registered on the renderer right after it is created).
  webgpuSkyBackgroundNode = skyBackground();
  webgpuSkyBackgroundNode.sunNode.angularRadius.value = webgpuAtmosphereSettings.sunAngularRadius;
  webgpuSkyBackgroundNode.sunNode.intensity.value = webgpuAtmosphereSettings.sunIntensity;
  scene.backgroundNode = webgpuSkyBackgroundNode;
}

function updateWebGPUAtmosphereDate(date, sunDirectionECEFSource = null) {
  if (webgpuAtmosphereContext == null) {
    return;
  }
  const { matrixECIToECEF, sunDirectionECEF, moonDirectionECEF } = webgpuAtmosphereContext;
  const matrix = getECIToECEFRotationMatrix(date, matrixECIToECEF.value);
  if (sunDirectionECEFSource != null) {
    sunDirectionECEF.value.copy(sunDirectionECEFSource);
  } else {
    getSunDirectionECEF(date, sunDirectionECEF.value);
  }
  getMoonDirectionECEF(date, moonDirectionECEF.value);
  maybeLogWebGPUSun(date);
}

const controls = {
  yaw: 0,
  pitch: -0.32,
  speed: 0,
  strafeSpeed: 0,
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

function createRenderBackend() {
  const isWebGPU = USE_WEBGPU_RENDER_BACKEND;
  const renderer = isWebGPU
    ? new WebGPURenderer({
        antialias: true,
        samples: 4,
        depth: true,
        logarithmicDepthBuffer: false
      })
    : new THREE.WebGLRenderer({
        antialias: true,
        depth: false,
        logarithmicDepthBuffer: true
      });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.shadowMap.enabled = true;
  if (!isWebGPU) {
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }
  renderer.shadowMap.autoUpdate = true;
  // Tone mapping is applied explicitly in post-processing on both backends:
  // WebGL via ToneMappingEffect, WebGPU via a toneMapping() node in the post
  // chain (an AgX renderer.toneMapping here would double-tone-map).
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = isWebGPU ? WEBGPU_TONE_MAPPING_EXPOSURE : 10;
  bootLog('renderer.ready', {
    backend: isWebGPU ? 'webgpu' : 'webgl',
    width: window.innerWidth,
    height: window.innerHeight,
    pixelRatio: window.devicePixelRatio,
    shadowMap: renderer.shadowMap.type
  });

  return {
    isWebGPU,
    renderer,
    composer: null,
    postProcessing: null,
    ready: !isWebGPU,
    setComposer(composer) {
      this.composer = composer;
    },
    setPostProcessing(postProcessing) {
      this.postProcessing = postProcessing;
    },
    initialize() {
      if (!isWebGPU) {
        return;
      }
      renderer.init()
        .then(() => {
          // GroundRing's shaded grass uses an EqualDepth pass behind an
          // identical depth-only twin. LAAS installs @invariant on every
          // WebGPU vertex position before creating those materials; without
          // it Metal can produce last-bit depth differences and leave the
          // camera-following black/transparent holes seen in the terrain.
          installPositionInvariance(renderer);
          installMaterialKeyMemo(renderer);
          this.ready = true;
          bootLog('renderer.webgpu.ready');
        })
        .catch(error => {
          bootLog('renderer.webgpu.error', {
            message: error?.message ?? String(error),
            stack: error?.stack ?? null
          }, 'error');
        });
    },
    resize(width, height) {
      renderer.setSize(width, height);
      this.composer?.setSize(width, height);
    },
    renderMap(scene, camera) {
      if (!this.ready) return;
      // Map mode renders directly, so the sky must come from the scene
      // background here.
      if (isWebGPU && scene.backgroundNode !== webgpuSkyBackgroundNode) {
        scene.backgroundNode = webgpuSkyBackgroundNode;
      }
      renderer.render(scene, camera);
    },
    renderScene(scene, camera) {
      if (!this.ready) return;
      if (isWebGPU) {
        if (this.postProcessing != null) {
          // The sky is composited by the aerial perspective's sky node in
          // post. The scene pass must NOT render a background: sky pixels
          // must keep the MRT clear value (viewZUnit = 0) that the epipolar
          // god-ray shadow length uses as its "no geometry" sentinel — a
          // background mesh writes its own positionView.z there and corrupts
          // the whole shadow-length buffer (renders as a black world).
          if (scene.backgroundNode != null) {
            scene.backgroundNode = null;
          }
          this.postProcessing.render();
        } else {
          if (scene.backgroundNode == null && webgpuSkyBackgroundNode != null) {
            scene.backgroundNode = webgpuSkyBackgroundNode;
          }
          renderer.render(scene, camera);
        }
      } else {
        this.composer?.render();
      }
    },
    setAnimationLoop(callback) {
      renderer.setAnimationLoop(callback);
    }
  };
}

const renderBackend = createRenderBackend();
const renderer = renderBackend.renderer;
if (renderBackend.isWebGPU && webgpuAtmosphereContext != null) {
  // v0.19 atmosphere nodes resolve their AtmosphereContext through the
  // renderer's node context. The closure reads the module variable, so
  // rebuilds that swap the context need no re-registration.
  renderer.contextNode = context({
    ...renderer.contextNode.value,
    getAtmosphere: () => webgpuAtmosphereContext
  });
}
renderBackend.initialize();
document.body.appendChild(renderer.domElement);
renderer.domElement.addEventListener('contextmenu', event => event.preventDefault());

const { hud, alt, gameClock: gameClockEl } = createTerrainHud({
  onToggleMapMode: () => toggleMapMode(),
  onClockAction: action => {
    if (action === 'rw') _gcRewind();
    else if (action === 'stop') _gcStop();
    else if (action === 'play') _gcPlay();
    else if (action === 'ff') _gcFfwd();
    requestRender();
  },
});
const HUD_LINKS = TERRAIN_HUD_LINKS;

// Transport control handlers for game clock HUD
function _gcRewind() {
  if (useRealtimeGameClock) {
    currentDate.setTime(getGameDateFromBrowserTime().getTime());
  }
  useRealtimeGameClock = false;
  currentDate.setTime(currentDate.getTime() - 15 * 60 * 1000);
  applyDate(currentDate);
  maybeLogWebGPUSun(currentDate, 'clock-rewind', true);
}
function _gcStop() {
  if (useRealtimeGameClock) {
    currentDate.setTime(getGameDateFromBrowserTime().getTime());
  }
  useRealtimeGameClock = false;
  maybeLogWebGPUSun(currentDate, 'clock-stop', true);
}
function _gcPlay() {
  if (!useRealtimeGameClock) {
    gameClockStartMs = currentDate.getTime();
    browserTimeStartMs = Date.now();
    useRealtimeGameClock = true;
  }
  maybeLogWebGPUSun(currentDate, 'clock-play', true);
}
function _gcFfwd() {
  if (useRealtimeGameClock) {
    currentDate.setTime(getGameDateFromBrowserTime().getTime());
  }
  useRealtimeGameClock = false;
  currentDate.setTime(currentDate.getTime() + 15 * 60 * 1000);
  applyDate(currentDate);
  maybeLogWebGPUSun(currentDate, 'clock-forward', true);
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
  enhancementController.submit(tid, {
    positive_prompt: posTA.value,
    negative_prompt: negTA.value,
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
      requestRender();
    });
    tileMenuEl.appendChild(oceanToggleBtn);
  }

  // Per-tile pipeline X-ray (pipeline.html: heightmap → texture → google →
  // buckets → procgen)
  const compareBtn = document.createElement('div');
  compareBtn.style.cssText = 'padding:6px 12px;cursor:pointer';
  compareBtn.textContent = 'Tile inspector';
  compareBtn.addEventListener('mouseenter', () => compareBtn.style.background = 'rgba(255,255,255,0.15)');
  compareBtn.addEventListener('mouseleave', () => compareBtn.style.background = 'none');
  compareBtn.addEventListener('click', () => {
    hideTileMenu();
    window.open(`/pipeline.html?tile=${tileId}`, '_blank');
  });
  tileMenuEl.appendChild(compareBtn);

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
            textureStreamer.invalidate(tileId);
            _lastEnhancedKey = '';
            _texV = textureStreamer.version;
            for (const child of terrainRoot.children) {
              if (child.userData.tileId === tileId) {
                if (child.material.map) {
                  child.material.map.dispose();
                  child.material.map = null;
                }
                child.material.color.set(child.userData.debugColor || 0x888888);
                child.material.needsUpdate = true;
                markSceneMutated();
                requestRender();
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
tuningPanel.addEventListener('input', requestRender);
tuningPanel.addEventListener('change', requestRender);

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
  requestRender();
};

// --- Tuning panel persistence ---
const TUNING_STORAGE_KEY = 'clouds-tuning';
const _tuningState = JSON.parse(localStorage.getItem(TUNING_STORAGE_KEY) || '{}');
const WEBGPU_CALIBRATION_VERSION = 3;
if (_tuningState.webgpuCalibrationVersion !== WEBGPU_CALIBRATION_VERSION) {
  if (_tuningState['webgpu exposure'] == null || _tuningState['webgpu exposure'] === 1.5) {
    _tuningState['webgpu exposure'] = WEBGPU_TONE_MAPPING_EXPOSURE;
  }
  if (_tuningState['webgpu luminance'] == null || _tuningState['webgpu luminance'] === 3.8) {
    _tuningState['webgpu luminance'] = WEBGPU_ATMOSPHERE_LUMINANCE_SCALE;
  }
  if (_tuningState.brightness == null || _tuningState.brightness === 2.2) {
    _tuningState.brightness = WEBGPU_TONE_MAPPING_EXPOSURE;
  }
  if (_tuningState.haze == null || _tuningState.haze === 4.5) {
    _tuningState.haze = WEBGPU_DEFAULT_HAZE;
  }
  _tuningState.webgpuCalibrationVersion = WEBGPU_CALIBRATION_VERSION;
  localStorage.setItem(TUNING_STORAGE_KEY, JSON.stringify(_tuningState));
}
if (_tuningState.brightness == null && _tuningState['webgpu exposure'] != null) {
  _tuningState.brightness = _tuningState['webgpu exposure'];
}
if (_tuningState.haze == null && _tuningState['fog strength'] != null) {
  _tuningState.haze = _tuningState['fog strength'];
}
localStorage.setItem(TUNING_STORAGE_KEY, JSON.stringify(_tuningState));
function saveTuning() {
  localStorage.setItem(TUNING_STORAGE_KEY, JSON.stringify(_tuningState));
}
const hasSavedMonth = Object.prototype.hasOwnProperty.call(_tuningState, 'month');
const hasSavedHour = Object.prototype.hasOwnProperty.call(_tuningState, 'hour (UTC)');
let useRealtimeGameClock = !(hasSavedMonth || hasSavedHour);

// Deferred binding: renderer-specific callbacks are wired after effects exist.
const {
  reset: resetTuningUI,
  section: tuningSectionLabel,
  setSliderValue: tuningSliderSetValue,
  slider: tuningSlider,
  toggle: tuningToggle,
} = createTerrainTuningControls({
  body: tuningBody,
  state: _tuningState,
  save: saveTuning,
});

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
  registerTerrainCloudTuning({
    effect: ce, controls,
    section: tuningSectionLabel,
    slider: tuningSlider,
    toggle: tuningToggle,
  });
  }
  tuningSectionLabel('Terrain');
  tuningSlider('terrain range', {
    min: 10000, max: 50000, step: 1000, value: _terrainRange,
    decimals: 0,
    format: v => `${(v/1000).toFixed(0)}km`,
    onChange: v => {
      _terrainRange = v;
      if (tileFetchingReady) fetchTiles();
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
        applyWebGPUAtmosphereLiveSettings();
      }
    });
    const applyWebGPUHaze = value => {
      controls._fogStrength = value;
      _sceneFog.density = value / getFogDistance();
      webgpuFogDensity.value = _sceneFog.density;
    };
    tuningSlider('haze', {
      min: 0, max: 10, step: 0.5, value: WEBGPU_DEFAULT_HAZE,
      decimals: 1,
      onChange: applyWebGPUHaze
    });
    applyWebGPUHaze(Number(_tuningState.haze ?? WEBGPU_DEFAULT_HAZE));
    tuningSectionLabel('God Rays');
    tuningToggle('god rays', {
      value: WEBGPU_ATMOSPHERE_DEFAULTS.godRays,
      onChange: v => {
        webgpuAtmosphereSettings.godRays = v;
        applyWebGPUAtmosphereLiveSettings();
      }
    });
    tuningSlider('god ray quality', {
      min: 128, max: 1024, step: 64,
      value: WEBGPU_ATMOSPHERE_DEFAULTS.godRaySlices,
      decimals: 0,
      onChange: v => {
        webgpuAtmosphereSettings.godRaySlices = v;
        applyWebGPUAtmosphereLiveSettings();
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

// Production LAAS near-field vegetation. GreenlandPatch only mounts GroundRing
// draws over the streamed terrain; the ArcticDEM meshes remain the ground and
// keep ownership of imagery, picking, collision, and tile lifecycle.
if (typeof window !== 'undefined') window.__enqueueClientLog = enqueueClientLog;
const PROCGEN_PATCH_ENABLED = BOOT_QUERY.get('procgenPatch') !== '0';
const greenlandPatch = PROCGEN_PATCH_ENABLED
  ? new GreenlandPatch(terrainRoot, 1337, {
      loadFields: fetchTileFields,
      getCSM: () => webgpuCsmShadowNode,
      getSunLight: () => webgpuAtmosphereLight,
    })
  : null;

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
let hoverOutlineTileId = null;

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

const seamStatusController = createTerrainSeamStatusController({});

// --- Terrain streaming state ---
const EXAG = 1.0;

// --- Retired per-tile scatter adapter ---------------------------------------
// WebGPU production vegetation now runs through GreenlandPatch → Heightfield
// → GreenlandFlora/runScatter → Forests. Keep this older tile-instancing path
// available for comparison, but never run both populations at once.
const LEGACY_TILE_SCATTER_ENABLED = false;
const SCATTER_SEED = 1337;
let _scatterLib = null;          // resolved library (for updateScatterVisibility)
let _scatterLibPromise = null;   // memoized async build (backup VegLibrary bakes on the GPU)
// WebGPU client uses the FULL backup vegetation (webserver/laas: 30 species, TSL
// node materials) via the adapter — NOT the stripped GLSL procgen/library (WebGL).
function scatterLibrary() {
  if (!LEGACY_TILE_SCATTER_ENABLED) return Promise.resolve(null);
  if (!_scatterLibPromise) {
    _scatterLibPromise = buildBackupScatterLibrary(renderer, SCATTER_SEED)
      .then((lib) => {
        _scatterLib = lib;
        console.log('[scatter] laas veg library built', lib.stats);
        enqueueClientLog('info', 'scatter.library', lib.stats);
        return lib;
      })
      .catch((err) => {
        _scatterLibFailed = true;
        console.error('[scatter] laas library build failed — scatter disabled', err);
        enqueueClientLog('error', 'scatter.library', { error: String(err), stack: String(err?.stack ?? '') });
        return null;
      });
  }
  return _scatterLibPromise;
}
let _scatterLibFailed = false;

// classifier field channels, in the pack order emitted by flaskserver/fields.py
const FIELD_KEYS = ['veg', 'rock', 'snow', 'water', 'slope', 'southness', 'sun', 'altitude', 'moisture'];

const _tileFieldsCache = new Map();
const _tileFieldsPending = new Map();
const _tileFieldsRetryAfter = new Map();
const TILE_FIELDS_RETRY_MS = 2000;

// Fetch + decode the per-tile classifier field set (GET /api/fields → zlib
// "FLD1" blob). Returns { res, chans:{veg,rock,water,...} } or null while the
// first-visit texture/classifier is unavailable. Legacy scatter can use null;
// GreenlandPatch waits and retries rather than inventing vegetation coverage.
async function fetchTileFields(tileId) {
  if (_tileFieldsCache.has(tileId)) return _tileFieldsCache.get(tileId);
  if (_tileFieldsPending.has(tileId)) return _tileFieldsPending.get(tileId);
  if (performance.now() < (_tileFieldsRetryAfter.get(tileId) ?? 0)) return null;

  const pending = (async () => {
    const resp = await fetch(`/api/fields/${tileId}`);
    if (!resp.ok) {
      // 202 is normal while the first-visit satellite texture is still being
      // fetched. Do not cache the miss: GreenlandPatch retries and comes alive
      // as soon as the classifier is available.
      _tileFieldsRetryAfter.set(tileId, performance.now() + TILE_FIELDS_RETRY_MS);
      return null;
    }
    const gz = await resp.arrayBuffer();
    const ds = new DecompressionStream('deflate'); // Python zlib.compress = zlib format
    const raw = new Uint8Array(await new Response(new Blob([gz]).stream().pipeThrough(ds)).arrayBuffer());
    if (raw[0] !== 0x46 || raw[1] !== 0x4c || raw[2] !== 0x44 || raw[3] !== 0x31) return null; // 'FLD1'
    const res = raw[4] | (raw[5] << 8);
    const nf = raw[6];
    const chans = {};
    let off = 8;
    for (let i = 0; i < nf; i++) { chans[FIELD_KEYS[i]] = raw.subarray(off, off + res * res); off += res * res; }
    const fields = { res, chans };
    _tileFieldsCache.set(tileId, fields);
    _tileFieldsRetryAfter.delete(tileId);
    return fields;
  })().catch((error) => {
    _tileFieldsRetryAfter.set(tileId, performance.now() + TILE_FIELDS_RETRY_MS);
    enqueueClientLog('warn', 'fields.fetch', { tileId, error: String(error) });
    return null;
  }).finally(() => {
    _tileFieldsPending.delete(tileId);
  });
  _tileFieldsPending.set(tileId, pending);
  return pending;
}

function attachTileScatter(mesh, tile, hm) {
  if (!mesh || !tile?.id) return;
  // Store per-tile height data UNCONDITIONALLY — the GroundRing patch consumes it
  // (collectTiles) to seed its Heightfield. Building scatter *geometry* is gated
  // separately by LEGACY_TILE_SCATTER_ENABLED (updateNearFieldScatter), so this is not the
  // scatter; it's just the terrain heightmap the grass needs to sit on the ground.
  // Store the input only. The actual build/dispose is CAMERA-FOLLOWING (see
  // updateNearFieldScatter) — only tiles near the camera carry plants. Tiles are
  // ~659 m, so we do NOT scatter miles of terrain; that's what keeps it fast (the
  // backup does the same with near-field rings).
  mesh.userData.scatterInput = { tileId: tile.id, bbox: tile.bbox, hm, res: tile.resolution };
}

// near-field radii (m): build scatter inside NEAR_BUILD, drop past NEAR_DROP
// (hysteresis so it doesn't thrash at the edge). ~1–2 tiles of plants around the
// camera; everything beyond is bare terrain.
const NEAR_BUILD = 650;
const NEAR_DROP = 950;
const _scatterBuilding = new Set();
const _tileCtr = new THREE.Vector3();
const _camCtr = new THREE.Vector3();

async function buildScatterForTile(mesh, inp) {
  try {
    const lib = await scatterLibrary();
    if (!lib || !mesh.parent) return;
    const fields = await fetchTileFields(inp.tileId);
    if (!mesh.parent) return;
    const group = buildTileScatter({
      tileId: inp.tileId, bbox: inp.bbox, hm: inp.hm, res: inp.res, lib, exag: EXAG, fields,
    });
    if (group && mesh.parent) mesh.add(group);
  } catch (err) {
    enqueueClientLog('error', 'scatter.tile', { tileId: inp.tileId, error: String(err) });
  } finally {
    _scatterBuilding.delete(inp.tileId);
  }
}

// Per-frame: build scatter for near tiles, dispose it for far ones, then the
// per-instance max-dist cull. Keeps plant/rock geometry to a small
// camera-following area instead of the whole streamed world.
function updateNearFieldScatter() {
  if (!LEGACY_TILE_SCATTER_ENABLED) return;
  camera.getWorldPosition(_camCtr);
  for (const mesh of terrainRoot.children) {
    const inp = mesh.userData?.scatterInput;
    if (!inp) continue;
    let bs = mesh.geometry?.boundingSphere;
    if (!bs) { mesh.geometry?.computeBoundingSphere?.(); bs = mesh.geometry?.boundingSphere; }
    if (!bs) continue;
    _tileCtr.copy(bs.center).applyMatrix4(mesh.matrixWorld);
    const dist = _tileCtr.distanceTo(_camCtr) - bs.radius;
    const hasScatter = mesh.children.some((c) => c.userData?.isScatter);
    if (dist < NEAR_BUILD && !hasScatter && !_scatterBuilding.has(inp.tileId)) {
      _scatterBuilding.add(inp.tileId);
      buildScatterForTile(mesh, inp);
    } else if (dist > NEAR_DROP && hasScatter) {
      disposeTileScatter(mesh);
      for (let i = mesh.children.length - 1; i >= 0; i--) {
        if (mesh.children[i].userData?.isScatter) mesh.remove(mesh.children[i]);
      }
    }
  }
  if (_scatterLib) updateScatterVisibility(terrainRoot, camera);
}

let tileLifecycle;
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

function paramNumber(_name, fallback) {
  return fallback;
}

const ASSET_VEHICLE_INSTANCES = Array.isArray(startupAssetsResponse.vehicle_instances)
  ? startupAssetsResponse.vehicle_instances
  : [];
const { model: HOUSE_MODEL, sites: houseSites } = createTerrainHouseConfiguration({
  definition: STRUCTURE_DEFINITION,
  instances: startupAssetsResponse.structure_instances,
  source: startupAssetsResponse.source,
  bootLog,
});
const HOUSE_SHADOW_MODE_RAW = 'shadowmap';
const HOUSE_SHADOW_MODE = HOUSE_SHADOW_MODE_RAW === 'local' ? 'local' : 'shadowmap';
const HOUSE_USE_LOCAL_SHADOWS = HOUSE_SHADOW_MODE === 'local';
const HOUSE_USE_SHADOW_MAP = HOUSE_SHADOW_MODE === 'shadowmap';
const HOUSE_LOCAL_SHADOW_DEBUG = true;
const HOUSE_SHADOW_SNAPSHOT_ENABLED = false;
const HOUSE_PROBE_CONSOLE = false;
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

const computeHouseShadowCoverage = loadedHouses => terrainHouseShadowCoverage(loadedHouses, {
  baseRadius: HOUSE_SHADOW_BASE_RADIUS,
  radiusPadding: HOUSE_SHADOW_RADIUS_PADDING,
  maxRadius: HOUSE_SHADOW_MAX_RADIUS,
});
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

const houseMarkerRuntime = createTerrainHouseMarkerRuntime({
  markerHeight: HOUSE_MARKER_HEIGHT,
  baseLift: HOUSE_MARKER_BASE_LIFT,
  colors: HOUSE_MARKER_COLORS,
});
const { instances: houseInstances, byId: houseById } = houseMarkerRuntime.createHouseInstances({
  sites: houseSites,
  houseLayer,
  markerLayer: houseMarkerLayer,
});
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
  structureCount: houseSites.length,
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
const VEHICLE_SHADOW_TEXEL_SNAP = true;
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
  const maxAniso = renderer.capabilities?.getMaxAnisotropy?.() ?? 1;
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
  return terrainVehicleLocalToLatLon(x, y, anchorLat, anchorLon);
}

function getVehicleStateSnapshot() {
  return vehicleStateSnapshot({
    loaded: vehicleLoaded,
    position: vehicleGroup.position,
    headingRad: vehicleHeadingRad,
    anchorLat,
    anchorLon,
  });
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
  const suspension = stepSuspension({
    dt, position: vehicleGroup.position.z, target: vehicleGroundZTarget,
    velocity: vehicleVerticalVelocity, frequency: VEHICLE_SUSPENSION_HZ,
    dampingRatio: VEHICLE_SUSPENSION_DAMPING_RATIO,
    maxVelocity: VEHICLE_SUSPENSION_MAX_VEL,
  });
  vehicleGroup.position.z = suspension.position;
  vehicleVerticalVelocity = suspension.velocity;
  updateVehicleOrientationTargetFromGround();
  const orientationAlpha = 1 - Math.exp(-VEHICLE_ORIENTATION_RESPONSE * suspension.stepDt);
  vehicleGroup.quaternion.slerp(vehicleOrientationTargetQuat, orientationAlpha);
  vehicleMarker.position.z = vehicleGroup.position.z + HOUSE_MARKER_BASE_LIFT;
}

function createVehicleSaveSnapshot(options = {}) {
  const { snapToGround = false, bypassSnapThrottle = false } = options;
  if (snapToGround && vehicleLoaded) {
    vehicleSnapPending = true;
    snapVehicleToTerrain({ forceImmediate: true, bypassThrottle: bypassSnapThrottle });
  }
  const state = getVehicleStateSnapshot();
  if (state == null) return null;
  if (Number.isFinite(vehicleGroundZTarget)) {
    state.z = Number(vehicleGroundZTarget.toFixed(3));
  }
  const terrainSample = sampleBestVehicleTerrainHit();
  if (terrainSample.depth >= 0) state.terrainDepth = terrainSample.depth;
  if (terrainSample.tileId) state.terrainTileId = terrainSample.tileId;
  return state;
}

const vehiclePersistence = createVehiclePersistenceRuntime({
  endpoint: VEHICLE_STATE_ENDPOINT,
  timeoutMs: VEHICLE_SAVE_FETCH_TIMEOUT_MS,
  failureCooldownMs: VEHICLE_SAVE_FAILURE_COOLDOWN_MS,
  createSnapshot: createVehicleSaveSnapshot,
  bootLog,
});
const saveVehicleState = vehiclePersistence.save;
const throttledVehicleSave = vehiclePersistence.throttledSave;

function loadVehicleState() {
  const state = ASSET_VEHICLE_INSTANCES.length > 0 ? ASSET_VEHICLE_INSTANCES[0] : null;
  if (state == null) {
    bootLog('vehicle.state.load.empty');
    return null;
  }
  const normalized = normalizeSavedVehicleState(state);
  if (normalized == null) {
    bootLog('vehicle.state.load.invalid', { state }, 'error');
    return null;
  }
  vehicleSavedStatePending = normalized;
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
    controls.strafeSpeed = 0;
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
    controls.strafeSpeed = 0;
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

const updateHouseMarkerPosition = houseMarkerRuntime.updateHouseMarkerPosition;

function houseLocalFromLatLon(lat, lon) {
  return terrainHouseLocalPosition(lat, lon, anchorLat, anchorLon);
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

const disposeHouseTree = disposeTerrainHouseTree;

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

const markHousesNeedSnap = () => markTerrainHousesNeedSnap(houseInstances);

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

const houseZSummary = () => terrainHouseZSummary(houseInstances);

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

const houseModelController = createTerrainHouseModelController({
  model: HOUSE_MODEL,
  loader: houseLoader,
  instanceCount: houseInstances.length,
  bootLog,
  onTemplate: template => {
    houseModelTemplate = template;
    instantiateHousesFromTemplate();
  },
  onLoaded: snapPendingHouses,
});
const loadHouseModel = houseModelController.load;
const pollHouseModelSignature = houseModelController.pollSignature;
const updateHouseHotReload = houseModelController.updateHotReload;
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
let lastRenderedDate = new Date(currentDate);
let lastSunDirectionSyncDateMs = NaN;

function applyDate(date, { force = true } = {}) {
  const dateMs = date.getTime();
  if (
    !force &&
    Number.isFinite(lastSunDirectionSyncDateMs) &&
    Math.abs(dateMs - lastSunDirectionSyncDateMs) < SUN_DIRECTION_SYNC_INTERVAL_MS
  ) {
    return false;
  }
  lastSunDirectionSyncDateMs = dateMs;
  lastRenderedDate = new Date(date);
  getSunDirectionECEF(date, sunDirection);
  aerialPerspective.sunDirection.copy(sunDirection);
  cloudsEffect.sunDirection.copy(sunDirection);
  updateWebGPUAtmosphereDate(date, sunDirection);
  return true;
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

bindTerrainCloudComposition(cloudsEffect, aerialPerspective);

bootLog('atmosphere.cache.load-sequence.invoke');
createTerrainAtmosphereTextureRuntime({
  baseUrl: DEFAULT_PRECOMPUTED_TEXTURES_URL,
  cacheName: ATMOSPHERE_CACHE_NAME,
  fileNames: ATMOSPHERE_TEXTURE_FILES,
  LoadingManager: THREE.LoadingManager,
  PrecomputedTexturesLoader,
  targets: [aerialPerspective, cloudsEffect],
  bootLog,
}).loadWithLocalCache();

// MSAA on the composer — the renderer's antialias:true does nothing when
// postprocessing renders to its own framebuffers. Without this, everything
// (terrain, vehicle, mountains) gets zero anti-aliasing.
function createSceneComposer(renderer) {
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
  return composer;
}

function createWebGPUAtmospherePostProcessing(renderer) {
  if (webgpuAtmosphereContext == null) {
    return null;
  }
  renderer.library.addLight(CloudShadowAtmosphereLightNode, AtmosphereLight);
  const atmosphereLight = new AtmosphereLight(MAX_VIEW_DIST);
  atmosphereLight.name = 'webgpu-atmosphere-light';

  // Sun-space cascaded shadow maps over the terrain. Feeds both surface
  // shadows and the epipolar god-ray shadow length below.
  atmosphereLight.castShadow = true;
  atmosphereLight.shadow.mapSize.width = 2048;
  atmosphereLight.shadow.mapSize.height = 2048;
  atmosphereLight.shadow.bias = 1e-4;
  atmosphereLight.shadow.camera.near = 0;
  atmosphereLight.shadow.camera.far = 3e5;
  const csmShadowNode = new CascadedShadowMapsNode(atmosphereLight);
  // 3 cascades, not 4: texture-heavy materials (vehicle PBR maps + atmosphere
  // LUTs + cloud shadow) hit WebGPU's 16-sampled-textures-per-stage limit.
  csmShadowNode.cascades = 3;
  csmShadowNode.maxFar = MAX_VIEW_DIST;
  csmShadowNode.fade = false;
  csmShadowNode.lightMargin = 1e5;
  atmosphereLight.shadow.shadowNode = csmShadowNode;
  webgpuCsmShadowNode = csmShadowNode;

  webgpuCloudShadows = new WebGPUCloudShadows({
    anchor: anchorPosition,
    east,
    north,
    up,
    camera,
    atmosphereContext: webgpuAtmosphereContext
  });
  applyWebGPUCloudShadowLiveSettings();
  atmosphereLight.cloudShadow = webgpuCloudShadows;
  scene.add(atmosphereLight);
  scene.add(atmosphereLight.target);
  webgpuAtmosphereLight = atmosphereLight;

  // TAA supersedes MSAA (samples: 0) and stabilizes the epipolar sampling.
  const scenePass = pass(scene, camera, { samples: 0 });
  scenePass.setMRT(mrt({
    output,
    velocity: highpVelocity,
    viewZUnit
  }));
  const colorNode = scenePass.getTextureNode('output');
  const depthNode = scenePass.getTextureNode('depth');
  const velocityNode = scenePass.getTextureNode('velocity');
  const viewZUnitNode = scenePass.getTextureNode('viewZUnit');
  viewZUnitNode.value.format = THREE.RedFormat;

  // Epipolar volumetric shadow length (Intel Outdoor Light Scattering):
  // the per-ray occlusion term that carves god rays out of the inscatter.
  const shadowLengthNode = shadowLength(csmShadowNode, viewZUnitNode);
  webgpuShadowLengthNode = shadowLengthNode;

  const atmosphereNode = webgpuAerialPerspective(colorNode, depthNode, shadowLengthNode);
  atmosphereNode.skyNode.sunNode.angularRadius.value = webgpuAtmosphereSettings.sunAngularRadius;
  atmosphereNode.skyNode.sunNode.intensity.value = webgpuAtmosphereSettings.sunIntensity;
  webgpuAtmosphereNode = atmosphereNode;

  const lensFlareNode = lensFlare(atmosphereNode);
  const toneMappingNode = toneMapping(
    THREE.AgXToneMapping,
    webgpuToneMappingExposure,
    lensFlareNode
  );
  const taaNode = temporalAntialias(toneMappingNode, depthNode, velocityNode, camera);
  const postProcessing = new PostProcessing(renderer);
  let outputNode = taaNode.add(dithering);
  if (window.location.hash === '#shadow-length-internal') {
    // Epipolar pipeline internals (coordinate/min-max/slice textures).
    outputNode = bool(true).select(
      shadowLengthNode.getDebugInternalTexturesNode(),
      outputNode
    );
  } else if (window.location.hash === '#shadow-length') {
    // Shareable validation view (like #shadow-mask): grayscale god-ray shadow
    // length, 1.0 = 10 km of shadowed ray. The node outputs vec2(distance to
    // shadow start, shadowed extent) in unit space — y is the length term.
    // The select keeps the main path in the graph so the scene pass (and its
    // viewZ buffer) still renders.
    outputNode = bool(true).select(
      shadowLengthNode.yyy
        .mul(1 / webgpuAtmosphereParameters.worldToUnit)
        .mul(0.0001),
      outputNode
    );
  }
  postProcessing.outputNode = outputNode;
  // Console-poke handle for shadow/god-ray diagnostics.
  window.__atlantisWebGPU = {
    renderer,
    atmosphereLight,
    csmShadowNode,
    shadowLengthNode,
    atmosphereNode,
    postProcessing,
    scene,
    camera,
    THREE,
    MeshLambertNodeMaterial
  };
  bootLog('renderer.webgpu.atmosphere.ready', {
    godRays: true,
    csmCascades: csmShadowNode.cascades,
    csmMaxFar: csmShadowNode.maxFar
  });
  return postProcessing;
}

const composer = renderBackend.isWebGPU ? null : createSceneComposer(renderer);
renderBackend.setComposer(composer);
webgpuAtmospherePostProcessingReady = true;
if (renderBackend.isWebGPU) {
  rebuildWebGPUAtmosphere();
} else {
  renderBackend.setPostProcessing(null);
}

function applyWebGPUAtmosphereLiveSettings() {
  if (!renderBackend.isWebGPU) {
    return;
  }
  webgpuToneMappingExposure.value = webgpuAtmosphereSettings.toneMappingExposure;
  if (webgpuSkyBackgroundNode?.sunNode != null) {
    webgpuSkyBackgroundNode.sunNode.angularRadius.value = webgpuAtmosphereSettings.sunAngularRadius;
    webgpuSkyBackgroundNode.sunNode.intensity.value = webgpuAtmosphereSettings.sunIntensity;
  }
  const postSun = webgpuAtmosphereNode?.skyNode?.sunNode;
  if (postSun != null) {
    postSun.angularRadius.value = webgpuAtmosphereSettings.sunAngularRadius;
    postSun.intensity.value = webgpuAtmosphereSettings.sunIntensity;
  }
  if (webgpuShadowLengthNode != null) {
    webgpuShadowLengthNode.epipolarSliceCount.value = webgpuAtmosphereSettings.godRaySlices;
    webgpuShadowLengthNode.maxSliceSampleCount.value = webgpuAtmosphereSettings.godRaySlices / 2;
  }
  const activeShadowLength = webgpuAtmosphereSettings.godRays ? webgpuShadowLengthNode : null;
  if (
    webgpuAtmosphereNode != null &&
    webgpuAtmosphereNode.shadowLengthNode !== activeShadowLength
  ) {
    webgpuAtmosphereNode.shadowLengthNode = activeShadowLength;
    if (webgpuAtmosphereNode.skyNode != null) {
      webgpuAtmosphereNode.skyNode.shadowLengthNode = activeShadowLength;
    }
    if (webgpuAtmospherePostProcessing != null) {
      webgpuAtmospherePostProcessing.needsUpdate = true;
    }
  }
}

function applyWebGPUCloudShadowLiveSettings() {
  if (webgpuCloudShadows == null) {
    return;
  }
  webgpuCloudShadows.enabled.value = webgpuCloudShadowSettings.enabled;
  webgpuCloudShadows.debugSurface.value = webgpuCloudShadowSettings.debugSurface;
  webgpuCloudShadows.coverage.value = webgpuCloudShadowSettings.coverage;
  webgpuCloudShadows.density.value = webgpuCloudShadowSettings.density;
  webgpuCloudShadows.strength.value = webgpuCloudShadowSettings.strength;
}

function rebuildWebGPUAtmosphere() {
  if (!renderBackend.isWebGPU || !webgpuAtmospherePostProcessingReady) {
    return;
  }
  if (webgpuAtmosphereLight != null) {
    scene.remove(webgpuAtmosphereLight.target);
    scene.remove(webgpuAtmosphereLight);
    // Also disposes the CSM shadow node and its render targets.
    webgpuAtmosphereLight.dispose();
    webgpuAtmosphereLight = null;
  }
  webgpuCsmShadowNode = null;
  webgpuShadowLengthNode?.dispose?.();
  webgpuShadowLengthNode = null;
  webgpuCloudShadows?.dispose();
  webgpuCloudShadows = null;
  webgpuAtmospherePostProcessing?.dispose?.();
  webgpuAtmosphereNode = null;
  webgpuAtmosphereContext?.dispose?.();
  webgpuAtmosphereContext = createWebGPUAtmosphereContext();
  if (webgpuAtmosphereContext != null) {
    webgpuSkyBackgroundNode = skyBackground();
    scene.backgroundNode = webgpuSkyBackgroundNode;
    updateWebGPUAtmosphereDate(lastRenderedDate);
  } else {
    webgpuSkyBackgroundNode = null;
  }
  webgpuAtmospherePostProcessing = createWebGPUAtmospherePostProcessing(renderer);
  renderBackend.setPostProcessing(webgpuAtmospherePostProcessing);
  applyWebGPUAtmosphereLiveSettings();
}

// --- Heightmap decode + mesh building (adapted for ENU frame) ---

let oceanMapDebugEnabled = false;
const terrainOceanClassifier = createTerrainOceanClassifier({ THREE, paramNumber });
const buildMesh = createTerrainMeshBuilder({
  oceanClassifier: terrainOceanClassifier,
  exaggeration: EXAG,
  attachScatter: attachTileScatter,
  // Lit terrain: receives the AtmosphereLight (physical sun + sky) and the
  // cascaded shadow maps that drive the god rays. The WebGL client keeps its
  // unlit material and applies sun lighting in post instead.
  // shadowSide FrontSide: the tiles are open heightfield sheets, and three's
  // default back-side shadow rendering would cull them out of the shadow maps
  // entirely (leaving CSM/god rays empty).
  createMaterial: () => new MeshLambertNodeMaterial({
    color: 0xffffff, side: THREE.FrontSide, vertexColors: true,
    shadowSide: THREE.FrontSide,
  }),
  shadows: true,
});

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
const COLOR_WEBGPU_UNTEXTURED = new THREE.Color(0x29313a);

function applyWebGPUUntexturedTerrainMaterial(mesh) {
  if (!USE_WEBGPU_RENDER_BACKEND || !mesh?.material || mesh.material.map) {
    return;
  }
  let needsUpdate = false;
  if (mesh.material.vertexColors) {
    mesh.material.vertexColors = false;
    needsUpdate = true;
  }
  if (!mesh.material.color.equals(COLOR_WEBGPU_UNTEXTURED)) {
    mesh.material.color.copy(COLOR_WEBGPU_UNTEXTURED);
  }
  if (needsUpdate) {
    mesh.material.needsUpdate = true;
    markSceneMutated();
  }
}

function markMissing(missing, downloading) {
  applyTerrainAvailabilityStatus({
    terrainRoot, missing, downloading,
    applyStatus: (mesh, status) => {
      mesh.material.color.copy(status === 'downloading' ? COLOR_DOWNLOADING : COLOR_MISSING);
      mesh.material.vertexColors = false;
      mesh.material.needsUpdate = true;
      markSceneMutated();
    },
  });
}

// --- Deferred tile system ---
const deferredTiles = new Map();
const { history: tileHistory, log: tileLog } = createTileHistory({
  getPass: () => _loadPass,
  emit: details => enqueueClientLog('debug', 'tile', details),
});
tileLifecycle = createTileLifecycle({
  terrainRoot,
  disposeScatter: disposeTileScatter,
  log: tileLog,
  onSceneMutated: markSceneMutated,
});

function applyTerrainMaterialMode(mesh, tex) {
  if (!mesh || !mesh.material) return;
  let needsUpdate = false;
  const useOceanOverlay = oceanMapDebugEnabled && controls.mapMode;
  if (useOceanOverlay) {
    if (mesh.material.map !== null) {
      mesh.material.map = null;
      needsUpdate = true;
    }
    if (!mesh.material.vertexColors) {
      mesh.material.vertexColors = true;
      needsUpdate = true;
    }
    mesh.material.color.set(0xffffff);
    if (needsUpdate) {
      mesh.material.needsUpdate = true;
      markSceneMutated();
    }
    return;
  }
  if (tex && mesh.material.map !== tex) {
    mesh.material.map = tex;
    needsUpdate = true;
  }
  if (!tex && USE_WEBGPU_RENDER_BACKEND) {
    applyWebGPUUntexturedTerrainMaterial(mesh);
    return;
  }
  if (mesh.material.vertexColors) {
    mesh.material.vertexColors = false;
    needsUpdate = true;
  }
  mesh.material.color.set(0xffffff);
  if (needsUpdate) {
    mesh.material.needsUpdate = true;
    markSceneMutated();
  }
}

let terrainMeshRuntime;

function rebuildTileMeshWithTexture(mesh, tile, tex) {
  return terrainMeshRuntime.rebuildWithTexture(mesh, tile, tex);
}

function materializeTile(tileId, tex) {
  return terrainMeshRuntime.materialize(tileId, tex);
}

// --- Texture streaming ---

const ENABLE_WATER_MASKS = false;
const TEX_MAX = 120; // max concurrent HTTP texture requests (texFetching 202s don't count)
const TEX_RETRY_202_BASE_MS = 2000;   // initial 202 retry delay
const TEX_RETRY_202_MAX_MS = 30000;   // cap backoff at 30s
const TEX_RETRY_ERROR_MS = 3000;
const TEX_REPOLL_BATCH = 8;           // max 202 re-polls fired per frame
const textureStreamer = createTextureStreamer({
  log: tileLog, recolor: _recolor, enableWaterMasks: ENABLE_WATER_MASKS,
  maxInflight: TEX_MAX, repollBatch: TEX_REPOLL_BATCH,
  retryBaseMs: TEX_RETRY_202_BASE_MS, retryMaxMs: TEX_RETRY_202_MAX_MS,
  retryErrorMs: TEX_RETRY_ERROR_MS,
  getTextureAnisotropy: () => rendererTextureAnisotropy(renderer),
  onWaterMask: () => { markSceneMutated(); requestRender(); },
});
const {
  texCache, texSource, texInflight, texFetching, texRetryAtMs, texRetryCount,
  waterMaskCache, waterMaskInflight, ancestorLogged: _ancestorLogged,
  requestWaterMask,
} = textureStreamer;
let _texV = textureStreamer.version;
terrainMeshRuntime = createTerrainMeshRuntime({
  terrainRoot,
  deferredTiles,
  buildMesh,
  applyMaterial: applyTerrainMaterialMode,
  lifecycle: tileLifecycle,
  log: tileLog,
  getWaterMask: tileId => waterMaskCache.get(tileId),
  getCurrentTileIds: () => currentTileIds,
  tileDepth: tileDepthFromId,
  onMeshAdded: markSceneMutated,
  vehicleNearTile: vehicleNearTileBbox,
  getVehicleDepth: () => vehicleLastContactDepth,
  requestVehicleResnap: requestVehicleTerrainResnap,
});
const updateTerrainTextures = createTerrainTextureController({
  terrainRoot,
  deferredTiles,
  textureStreamer,
  meshRuntime: terrainMeshRuntime,
  lifecycle: tileLifecycle,
  priorityForTile: tilePriority,
  getVisibilityDistance: getTileLoadDistance,
  applyMaterial: applyTerrainMaterialMode,
  getWaterMask: tileId => waterMaskCache.get(tileId),
  isMaterialOverlayActive: () => oceanMapDebugEnabled && controls.mapMode,
  log: tileLog,
  onMaterialApplied: requestRender,
});

// Visibility distance from camera altitude.
// Geometric horizon: sqrt(2 * R_earth * h), clamped to practical atmosphere limits.
// Low alt → ~15km (haze-limited), high alt → scales toward horizon.
function getTileLoadDistance() {
  return terrainVisibilityDistance(getCameraLatLon().alt);
}

function getFogDistance() {
  return terrainFogDistance(getCameraLatLon().alt);
}

function tilePriority(tile) {
  const rel = camera.position.clone().sub(anchorPosition);
  const camLocalX = rel.dot(east);
  const camLocalY = rel.dot(north);
  return terrainTilePriority(tile, {
    cameraX: camLocalX,
    cameraY: camLocalY,
    heading: priorityHeading(vehicleControlActive, vehicleHeadingRad, controls.yaw),
    pitch: controls.pitch,
    usePitch: !vehicleControlActive,
    fovDeg: camera.fov,
    aspect: camera.aspect,
  });
}

function updateTextures(tiles) {
  updateTerrainTextures(tiles);
}

// --- Deferred enhancement (idle-time upgrade) ---

let _lastCamMoveTime = performance.now();
let _enhanceStatus = { total: 0, eligible: 0, done: 0, in_progress: 0 };

const enhancementController = createTerrainEnhancementController({
  log: tileLog,
  textureCache: texCache,
  textureSource: texSource,
  requestWaterMask,
  hasTextureWork: () => texInflight.size > 0 || texFetching.size > 0,
  getLastCameraMoveTime: () => _lastCamMoveTime,
  hasTiles: () => Boolean(lastTiles),
  onStatus: status => { _enhanceStatus = status; },
  applyEnhancedTexture: (tileId, texture) => {
    for (const child of terrainRoot.children) {
      if (!child.isMesh || child.userData.tileId !== tileId) continue;
      applyTerrainMaterialMode(child, texture);
      child.userData.waterMask = waterMaskCache.get(tileId) || null;
        requestRender();
      break;
    }
  },
});
const _enhanceInflight = enhancementController.inflight;
const _enhancePending = enhancementController.pending;
const terrainOutlineController = createTerrainOutlineController({
  terrainRoot, pendingGroup: enhanceOutlines, enhancedGroup: enhancedOutlines,
  pending: _enhancePending, inflight: _enhanceInflight, textureSource: texSource,
});

function abortAllEnhancements() {
  enhancementController.abortAll();
}

function _enhanceBusyCount() {
  return enhancementController.busyCount();
}

function updateEnhancement() {
  enhancementController.update();
}

// --- Camera position → lat/lon conversion ---

function getCameraLatLon() {
  const coordinates = terrainCameraCoordinates({
    position: camera.position, anchorPosition, east, north, up,
    anchorLatitude: anchorLat, anchorLongitude: anchorLon, originX, originY,
  });
  return { lat: coordinates.lat, lon: coordinates.lon, alt: coordinates.alt };
}

function getCameraLogSnapshot(camLL = null) {
  const coordinates = terrainCameraCoordinates({
    position: camera.position, anchorPosition, east, north, up,
    anchorLatitude: anchorLat, anchorLongitude: anchorLon, originX, originY,
  });
  if (camLL) {
    Object.assign(coordinates, camLL);
    const stereo = terrainCameraStereoPosition({
      latitude: camLL.lat, longitude: camLL.lon,
      anchorLatitude: anchorLat, anchorLongitude: anchorLon, originX, originY,
    });
    coordinates.stereoX = stereo.x;
    coordinates.stereoY = stereo.y;
  }
  return summarizeTerrainCamera(coordinates, {
    originX, originY, frameOffsetX: tileFrameOffsetX, frameOffsetY: tileFrameOffsetY,
    frameOffsetReady: tileFrameOffsetReady,
  });
}

// --- Tile fetching ---

const PREVIEW_MAX_DEPTH = 10;
const clock = new THREE.Clock();
const STREAMING_MAINTENANCE_MS = 1000;
const fpsCounter = createTerrainFpsCounter();
let animationLoopActive = false;
let sceneMutationVersion = 0;
let streamingMaintenanceTimer = null;

function markSceneMutated() {
  sceneMutationVersion++;
}

function hasActiveKeyInput() {
  return Object.values(controls.keys).some(Boolean);
}

function needsContinuousRender() {
  return (
    controls.dragging ||
    hasActiveKeyInput() ||
    Math.abs(controls.speed) > 1e-3 ||
    Math.abs(controls.strafeSpeed) > 1e-3 ||
    vehicleControlActive
  );
}

function startRenderLoop() {
  if (animationLoopActive) {
    return;
  }
  animationLoopActive = true;
  clock.getDelta();
  fpsCounter.start(performance.now());
  renderBackend.setAnimationLoop(render);
}

function requestRender() {
  startRenderLoop();
}

function stopRenderLoopIfIdle() {
  if (!animationLoopActive || needsContinuousRender()) {
    return;
  }
  animationLoopActive = false;
  renderBackend.setAnimationLoop(null);
  fpsCounter.idle();
  updateHud();
}

function runStreamingMaintenance() {
  const before = sceneMutationVersion;
  let dateChanged = false;
  if (useRealtimeGameClock) {
    currentDate.setTime(getGameDateFromBrowserTime().getTime());
    dateChanged = applyDate(currentDate, { force: false });
  }
  if (lastTiles) {
    updateTextures(lastTiles);
  }
  updateEnhancement();
  if (dateChanged || sceneMutationVersion !== before) {
    requestRender();
  }
}

const terrainFetchState = {
  get pass() { return _loadPass; }, set pass(value) { _loadPass = value; },
  get isFirstLoad() { return isFirstLoad; }, set isFirstLoad(value) { isFirstLoad = value; },
  get frameOffsetReady() { return tileFrameOffsetReady; }, set frameOffsetReady(value) { tileFrameOffsetReady = value; },
  get frameOffsetX() { return tileFrameOffsetX; }, set frameOffsetX(value) { tileFrameOffsetX = value; },
  get frameOffsetY() { return tileFrameOffsetY; }, set frameOffsetY(value) { tileFrameOffsetY = value; },
  get originX() { return originX; }, set originX(value) { originX = value; },
  get originY() { return originY; }, set originY(value) { originY = value; },
  get cameraX() { return camStereoX; }, set cameraX(value) { camStereoX = value; },
  get cameraY() { return camStereoY; }, set cameraY(value) { camStereoY = value; },
  get lastFetchX() { return lastFetchX; }, set lastFetchX(value) { lastFetchX = value; },
  get lastFetchY() { return lastFetchY; }, set lastFetchY(value) { lastFetchY = value; },
  get currentTileIds() { return currentTileIds; }, set currentTileIds(value) { currentTileIds = value; },
  get lastTiles() { return lastTiles; }, set lastTiles(value) { lastTiles = value; },
  get bootFetchLogged() { return bootFetchLogged; }, set bootFetchLogged(value) { bootFetchLogged = value; },
  set pipeline(value) {
    _hmMissing = value.missing; _hmDownloading = value.downloading;
    _srvTexFetching = value.textureFetching; _srvTexRetry = value.textureRetryQueue;
    _srvTexStatus = value.textureStatusCounts;
  },
};

const performTileFetch = createTerrainFetchExecutor({
  state: terrainFetchState, previewMaxDepth: PREVIEW_MAX_DEPTH,
  getHeading: () => priorityHeading(vehicleControlActive, vehicleHeadingRad, controls.yaw),
  getRange: () => _terrainRange, getCameraLatLon, getCameraSnapshot: getCameraLogSnapshot,
  getCameraLocalPosition: () => {
    const relative = camera.position.clone().sub(anchorPosition);
    return { x: relative.dot(east), y: relative.dot(north) };
  },
  anchorLatitude: anchorLat, anchorLongitude: anchorLon, terrainRoot, deferredTiles,
  lifecycle: tileLifecycle, priorityForTile: tilePriority,
  textureCache: texCache,
  materialize: materializeTile, buildMesh, tileLog, applyMissing: markMissing, updateTextures,
  prepareUntexturedMesh: applyWebGPUUntexturedTerrainMaterial,
  onMeshAdded: markSceneMutated,
  onResponseApplied: requestRender,
  enqueueLog: enqueueClientLog, bootLog,
});

const tileFetchScheduler = createTerrainFetchScheduler({
  execute: performTileFetch,
  onSkip: () => enqueueClientLog('debug', 'fetchTiles.skip', {
    reason: 'already fetching', ...getCameraLogSnapshot(),
  }),
  onState: state => { fetching = state.fetching; _loadPass = state.pass; },
  onPreviewComplete: result => {
    bootLog('tiles.pass1-preview-done', result.previewDetails);
    requestRender();
  },
  onPoll: requestRender,
  onError: err => {
    if (!bootFetchLogged) {
      bootLog('tiles.initial-fetch.error', {
        message: err?.message ?? String(err), stack: err?.stack ?? null,
      });
      bootFetchLogged = true;
    }
    console.error('Fetch error:', err);
  },
  onSettled: () => {
    // Drain accumulated dt so the next render frame doesn't lurch the camera.
    clock.getDelta();
    requestRender();
  },
});

function fetchTiles(lat, lon) {
  return tileFetchScheduler.request(lat, lon);
}

// --- Save/restore camera position ---

function savePosition() {
  if (isFirstLoad) return;
  const camLL = getCameraLatLon();
  const saved = terrainCameraState({
    cameraLatLon: camLL,
    yaw: controls.yaw,
    pitch: controls.pitch,
    mapZoom: controls.mapZoom,
    terrainFrame: tileFrameOffsetReady
      ? { originX, originY, offsetX: tileFrameOffsetX, offsetY: tileFrameOffsetY }
      : null,
  });
  localStorage.setItem('clouds-cam', JSON.stringify(saved));
}
setInterval(savePosition, 2000);
window.addEventListener('beforeunload', savePosition);

// Restore saved camera position (lat/lon/alt are origin-independent)
try {
  // Reproducible visual-verification pose. Query values deliberately override
  // localStorage so a screenshot/test run can revisit the exact same Greenland
  // location and AGL without mutating the user's saved camera.
  const camLatOverride = bootQueryNumber('camLat', NaN);
  const camLonOverride = bootQueryNumber('camLon', NaN);
  const camAltOverride = bootQueryNumber('camAlt', NaN);
  const hasCameraOverride = Number.isFinite(camLatOverride)
    && Number.isFinite(camLonOverride)
    && Number.isFinite(camAltOverride);
  const saved = hasCameraOverride
    ? {
        lat: camLatOverride,
        lon: camLonOverride,
        alt: camAltOverride,
        yaw: bootQueryNumber('camYaw', controls.yaw),
        pitch: bootQueryNumber('camPitch', controls.pitch),
        mapZoom: controls.mapZoom,
      }
    : JSON.parse(localStorage.getItem('clouds-cam'));
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
      originX = frame.originX;
      originY = frame.originY;
      tileFrameOffsetX = frame.offsetX;
      tileFrameOffsetY = frame.offsetY;
      tileFrameOffsetReady = true;
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
tileFetchingReady = true;
fetchTiles();
if (HOUSE_MODEL.enabled && housesRuntimeVisible) {
  bootLog('house.initial-load.start', {
    instanceCount: houseInstances.length
  });
  markHousesNeedSnap();
  loadHouseModel('initial');
  pollHouseModelSignature().then(sig => {
    houseModelController.adoptSignature(sig);
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
  getCloudShadowDebugSummary: () => webgpuCloudShadows?.debugSummary() ?? null,
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
  const nextTileId = mesh?.userData?.tileId ?? null;
  if (nextTileId != null && nextTileId === hoverOutlineTileId && hoverOutline != null) {
    return false;
  }
  let changed = false;
  if (hoverOutline != null) {
    terrainRoot.remove(hoverOutline);
    hoverOutline.geometry?.dispose?.();
    disposeObjectMaterial(hoverOutline.material);
    hoverOutline = null;
    hoverOutlineTileId = null;
    changed = true;
  }
  if (mesh == null) {
    if (changed) {
      markSceneMutated();
      requestRender();
    }
    return changed;
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
      if (changed) {
        markSceneMutated();
        requestRender();
      }
      return changed;
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
  hoverOutlineTileId = nextTileId;
  markSceneMutated();
  requestRender();
  return true;
}

function updateEnhanceOutlines() { terrainOutlineController.updatePending(); }
function updateEnhancedOutlines() { terrainOutlineController.updateEnhanced(); }

function hideTileInfo() {
  tileInfoEl.style.display = 'none';
  showTileBorder(null);
}

function collectDebugMeshes(root) {
  return collectTerrainDebugMeshes(root, debugIntersectables);
}

function meshDebugSummary(mesh) {
  return summarizeTerrainMesh(mesh);
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
    controls.strafeSpeed = 0;
    if (!vehicleLoaded) {
      setVehicleControlActive(false, 'vehicle-unloaded');
      return;
    }
    const steer = (leftPressed ? 1 : 0) + (rightPressed ? -1 : 0);
    const drive = (forwardPressed ? 1 : 0) + (backPressed ? -1 : 0);
    const driveStep = stepVehicleDrive({
      dt, heading: vehicleHeadingRad, speed: vehicleSpeed, steer, drive,
      groundNormalX: vehicleGroundNormal.x, groundNormalY: vehicleGroundNormal.y,
      acceleration: VEHICLE_ACCEL, brake: VEHICLE_BRAKE,
      steerSpeed: VEHICLE_STEER_SPEED, maxSpeed: VEHICLE_DRIVE_SPEED,
    });
    vehicleHeadingRad = driveStep.heading;
    vehicleSpeed = driveStep.speed;
    if (vehicleSpeed !== 0 || steer !== 0) {
      vehicleGroup.position.x += driveStep.deltaX;
      vehicleGroup.position.y += driveStep.deltaY;
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
  controls.strafeSpeed = Math.max(-STRAFE_SPEED, Math.min(STRAFE_SPEED, controls.strafeSpeed));

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
    controls.strafeSpeed = 0;
  } else if (rightPressed) {
    controls.strafeSpeed = Math.min(controls.strafeSpeed + ACCEL * dt, STRAFE_SPEED);
  } else if (leftPressed) {
    controls.strafeSpeed = Math.max(controls.strafeSpeed - ACCEL * dt, -STRAFE_SPEED);
  } else if (!driftMode) {
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
    controls.strafeSpeed = 0;
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
  const speedKmh = Math.hypot(controls.speed, controls.strafeSpeed) * 3.6;
  const headingForHud = vehicleControlActive ? vehicleHeadingRad : controls.yaw;
  const { degrees: deg, compass } = compassHeading(headingForHud);
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
  renderGameClock(gameClockEl, gameDate, useRealtimeGameClock);

  hud.innerHTML = [
    '<b>Clouds Terrain Managed Flask UX WIP</b>',
    `mode: <b>${modeHtml}</b>`,
    `fps: <b>${fpsCounter.display}</b>`,
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
    '<span id="mapModeLink" style="color:#0af;text-decoration:underline;cursor:pointer;pointer-events:auto">map mode</span> (M), R reset · <span id="debugLogLink" style="color:#0af;text-decoration:underline;cursor:pointer;pointer-events:auto">debug log</span>'
    + ' · <span id="pipelineMapLink" title="2D radar in pipeline-map mode — click any tile to open its tile inspector" style="color:#0af;text-decoration:underline;cursor:pointer;pointer-events:auto">pipeline map</span> (P)'
    + ' · <span id="radarHeatmapLink" style="color:#0af;text-decoration:underline;cursor:pointer;pointer-events:auto">heatmap</span> (H)'
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
  controls.strafeSpeed = 0;
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
  textureStreamer.abortAll();
  updateTerrainTextures.reset();
  abortAllEnhancements();
  tileFetchScheduler.reset(1);
  originX = 0; originY = 0;
  camStereoX = 0; camStereoY = 0;
  lastFetchX = 0; lastFetchY = 0;
  tileFrameOffsetX = 0; tileFrameOffsetY = 0;
  tileFrameOffsetReady = false;
  markHousesNeedSnap();
  fetchTiles();
}

let driftMode = false;

function toggleMapMode() {
  controls.mapMode = !controls.mapMode;
  driftMode = false;
  controls.strafeSpeed = 0;
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

installTerrainKeyboardControls({
  controls,
  isVehicleActive: () => vehicleControlActive,
  onForwardDoubleTap: () => {
    driftMode = !driftMode;
    console.log(`[drift] ${driftMode ? 'ON' : 'OFF'}`);
  },
  onEscapeVehicle: () => {
    saveVehicleState('escape', { snapToGround: true, requireGroundedZ: false, bypassSnapThrottle: true });
    setVehicleControlActive(false, 'escape', { skipExitSave: true });
  },
  onToggleMap: toggleMapMode,
  onOpenPipeline: () => window.open(HUD_LINKS.pipelineMapLink, '_blank'),
  onOpenHeatmap: () => window.open(HUD_LINKS.radarHeatmapLink, '_blank'),
  onReset: resetView,
  onHouseAction: load => load
    ? loadHouseModel('keyboard')
    : setHousesRuntimeVisible(!housesRuntimeVisible, 'keyboard'),
  onToggleHeadlights: () => {
    for (const light of vehicleHeadlightSpots) light.visible = !light.visible;
  },
  onChanged: requestRender,
});

installTerrainPointerControls({
  element: renderer.domElement,
  controls,
  mouseSensitivity: MOUSE_SENS,
  mapPanFactor: MAP_PAN_FACTOR,
  isVehicleActive: () => vehicleControlActive,
  onVehicleOrbit: (movementX, movementY) => {
    vehicleCameraOrbitYaw -= movementX * VEHICLE_CAMERA_ORBIT_SENS;
    vehicleCameraOrbitPitch = THREE.MathUtils.clamp(
      vehicleCameraOrbitPitch + movementY * VEHICLE_CAMERA_ORBIT_SENS,
      VEHICLE_CAMERA_ORBIT_PITCH_MIN,
      VEHICLE_CAMERA_ORBIT_PITCH_MAX,
    );
  },
  onMapCameraChanged: updateMapCamera,
  onChanged: requestRender,
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
  const overlappingMeshes = [...new Map(hits
    .filter(hit => hit.object.userData?.tileId && hit.object.userData.tileId !== info.tileId)
    .map(hit => [hit.object.userData.tileId, hit.object])).values()];
  const overlapLines = overlappingMeshes.slice(0, 12)
    .map(overlapMesh => {
      const row = meshDebugSummary(overlapMesh);
      const rsrc = texSource.get(row.tileId) || '';
      return `${row.tileId} ${rsrc || (row.hasTexture ? 'tex' : 'noTex')}`;
    });

  const src = texSource.get(info.tileId) || 'none';
  const isEnhanced = src.includes('enhanced');
  const srcLabel = isEnhanced
    ? `<span style="color:#0f0;font-weight:bold">ENHANCED</span>`
    : `<span style="color:#f80">${src || 'no texture'}</span>`;
  const matHex = info.color !== '-' ? info.color : '#ffffff';
  const seamLabel = seamStatusController.statusHtml(info.tileId);
  tileInfoEl.innerHTML = [
    `<b style="color:${matHex}">${info.tileId}</b>`,
    `tex: ${info.hasTexture ? 'YES' : 'NO'} ${info.textureSize}  source: ${srcLabel}`,
    seamLabel ? `seam: ${seamLabel}` : null,
    `<b>overlaps: ${overlappingMeshes.length}</b>`,
    overlapLines.length > 0 ? overlapLines.join('<br>') : null
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
      requestRender();
    } else if (vehicleControlActive) {
      const scale = zoomIn ? 0.9 : 1.1;
      VEHICLE_CAMERA_FOLLOW_DISTANCE = Math.max(8, Math.min(200, VEHICLE_CAMERA_FOLLOW_DISTANCE * scale));
      VEHICLE_CAMERA_FOLLOW_HEIGHT = Math.max(2, Math.min(80, VEHICLE_CAMERA_FOLLOW_HEIGHT * scale));
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
  const dt = Math.min(0.05, clock.getDelta());
  const nowMs = performance.now();
  fpsCounter.frame(nowMs);
  if (useRealtimeGameClock) {
    currentDate.setTime(getGameDateFromBrowserTime().getTime());
  }
  applyDate(currentDate, { force: false });
  updateMovement(dt);
  applyCameraOrientation();
  updateHud();

  // Update fog density from slider
  const fogStrength = controls._fogStrength ?? (
    renderBackend.isWebGPU ? WEBGPU_DEFAULT_HAZE : 4.5
  );
  _sceneFog.density = fogStrength / getFogDistance();
  webgpuFogDensity.value = renderBackend.isWebGPU ? _sceneFog.density : 0;

  // Animate water
  waterMat.uniforms.time.value = clock.elapsedTime * 0.4;
  waterMat.uniforms.sunDirection.value.copy(sunDirection);
  // The GLSL water material is not supported by WebGPURenderer.
  waterMesh.visible = !renderBackend.isWebGPU && !controls.mapMode;

  // Terrain streaming: check if camera moved far enough to re-fetch
  if (!isFirstLoad) {
    const camLL = getCameraLatLon();
    const stereo = terrainCameraStereoPosition({
      latitude: camLL.lat, longitude: camLL.lon,
      anchorLatitude: anchorLat, anchorLongitude: anchorLon, originX, originY,
    });
    camStereoX = stereo.x;
    camStereoY = stereo.y;
    const refetch = evaluateTerrainRefetch({
      cameraX: camStereoX, cameraY: camStereoY, lastFetchX, lastFetchY,
      nowMs, lastTriggerMs: _lastFetchTriggerMs,
      distanceThreshold: REFETCH_DIST, triggerIntervalMs: 500,
    });
    _lastFetchTriggerMs = refetch.nextTriggerMs;
    if (refetch.shouldFetch) fetchTiles();
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
    webgpuFogDensity.value = 0;
    seamStatusController.poll();
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
    renderBackend.renderMap(scene, mapCam);
    scene.background = null;
    scene.fog = renderBackend.isWebGPU ? null : _sceneFog;
    stopRenderLoopIfIdle();
    return;
  }
  updateNearFieldScatter();
  if (renderBackend.isWebGPU && greenlandPatch) {
    if (!greenlandPatch.ready && !greenlandPatch.building) {
      void greenlandPatch.build(renderer, camera, cameraAGL);
    }
    greenlandPatch.update(renderer, camera, cameraAGL);
  }
  if (renderBackend.isWebGPU && webgpuCloudShadows != null) {
    webgpuCloudShadows.update(renderer, clock.elapsedTime);
  }
  renderBackend.renderScene(scene, camera);
  stopRenderLoopIfIdle();
}

streamingMaintenanceTimer = window.setInterval(runStreamingMaintenance, STREAMING_MAINTENANCE_MS);
startRenderLoop();
