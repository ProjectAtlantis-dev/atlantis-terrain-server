// UX WIP scene: preserve baseline rendering, layer in map mode + movement + HUD.
import * as THREE from 'three';
import {
  bool,
  color,
  context,
  densityFogFactor,
  float,
  fog,
  mix,
  mrt,
  normalMap,
  normalLocal,
  output,
  pass,
  positionLocal,
  screenUV,
  smoothstep,
  texture,
  toneMapping,
  transformNormalToView,
  uv,
  vec2,
  vec3,
  vec4,
  uniform
} from 'three/tsl';
import {
  MeshLambertNodeMaterial,
  PostProcessing,
  WebGPURenderer,
} from 'three/webgpu';
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
import {
  CloudBeerShadowMapNode,
  CloudDensityField,
  CloudShapeDetailNode,
  CloudShapeNode,
  LocalWeatherNode,
  TurbulenceNode
} from '@takram/three-clouds/webgpu';
import { DitheringEffect } from './three-geospatial/packages/effects/src/index.ts';
import { Ellipsoid, Geodetic, radians } from '@takram/three-geospatial';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  cloudShadowsEnabled,
  CloudShadowAtmosphereLightNode
} from './webgpu-cloud-shadows.js';
import { buildBackupScatterLibrary } from './laas-scatter-adapter.js';
import { GreenlandPatch } from './laas-terrain-patch.js';
import { installMaterialKeyMemo } from './laas/render/ThreePatches.ts';
import { installPositionInvariance } from './laas/render/VegPrepass.ts';
import { vegViewPos } from './laas/render/VegInstance.ts';
import { createGroundingNode } from './webgpu-ground-post.js';
import { createCloudGodRayShadowLength } from './webgpu-cloud-godrays.js';
import { buildTerrainShading } from './laas/render/TerrainMaterial.ts';
import { buildTileScatter, disposeTileScatter, updateScatterVisibility } from './procgen/scatter.ts';
import { createTileLifecycle } from './terrain-tile-lifecycle.js';
import { createTerrainOceanClassifier } from './classifier/terrain-ocean.js';
import { priorityHeading, terrainTilePriority } from './terrain-priority.js';
import {
  predictTerrainStreamingFocus,
  predictiveRefetchDecision,
} from './terrain-streaming-prediction.js';
import { compassHeading, createTerrainHud, renderGameClock, TERRAIN_HUD_LINKS } from './terrain-hud.js';
import { installTerrainKeyboardControls, installTerrainPointerControls } from './terrain-controls.js';
import { normalizeSavedVehicleState, stepSuspension, stepVehicleDrive, vehicleLocalToLatLon as terrainVehicleLocalToLatLon, vehicleStateSnapshot } from './terrain-vehicle.js';
import { createVehicleControlUI } from './terrain-vehicle-controls-ui.js';
import { createVehicleFireRuntime } from './terrain-vehicle-fire.js';
import { applyV22Materials, loadV22TextureSet } from './terrain-v22-materials.js';
import {
  AIRCRAFT_CAMERA_MODES,
  createAircraftState,
  setupAircraftModelParts,
  stepAircraftFlight,
  toggleAircraftEngine,
  updateAircraftVisuals,
} from './terrain-aircraft-runtime.js';
import {
  createVehicleWheelRig,
  createVehicleTurretRig,
  discoverVehicleParts,
  getVehicleWheelContactSnapshot,
  normalizeVehiclePartDefinition,
  spinVehicleWheelRig,
  summarizeVehicleParts,
  summarizeVehicleTurretRig,
  summarizeVehicleWheelRig,
} from './terrain-vehicle-parts.js';
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
import { googleMaps3dUrl } from './terrain-google-maps.js';
import { createGoogleNavigator } from './terrain-google-navigator.js';
import {
  epsg3413DirectionBearing,
  epsg3413ToWgs84,
  wgs84ToEpsg3413,
} from './terrain-polar-stereo.js';
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
  // Slice count controls angular sampling density of the Intel OLS epipolar
  // technique. Undersampling shows as horizontal streaking/banding radiating
  // from the sun's screen-space position (or its off-screen projection) —
  // worst at low sun elevation looking away from the sun, exactly the
  // 2026-07-20 dawn banding report (heading 93°E vs sun azimuth ~38°,
  // elevation ~3° — sun ~55° off-axis, just outside the 60° FOV frustum).
  // Verified 2026-07-18 (PERF_REWORK.md, headless 2560x1440): 512x256 vs
  // 2048x1024 (16x grid) measured 0 fps difference — slice count is not the
  // frame-cost bottleneck, so there's no budget reason to keep it low.
  // Raised to reduce banding; this is an angular-resolution mitigation, not
  // a full fix for the underlying near-off-screen-light degenerate case.
  godRays: true,
  godRaySlices: 2048
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
// laas/ modules read boot flags lazily, long after the query string is
// stripped below — laas/core/BootQuery.ts falls back to this handle.
window.__BOOT_QUERY = BOOT_QUERY;
function bootQueryNumber(name, fallback) {
  const raw = BOOT_QUERY.get(name);
  if (raw == null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}
const VEHICLE_PERSISTENCE_ENABLED = bootQueryNumber('vehiclePersistence', 1) !== 0;

// The main view is controlled entirely through its UI. Discard stale query
// parameters instead of exposing URL state that does not stay in sync.
if (window.location.search) {
  history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
}
const _recolor = false;
const DEFAULT_ASSET_SERVER_BASE = 'http://127.0.0.1:8787';
const ASSET_SERVER_BASE = DEFAULT_ASSET_SERVER_BASE;
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
const VEHICLE_DEFINITIONS = (
  startupAssetsResponse.vehicle_definitions != null
  && typeof startupAssetsResponse.vehicle_definitions === 'object'
  && Object.keys(startupAssetsResponse.vehicle_definitions).length > 0
)
  ? startupAssetsResponse.vehicle_definitions
  : { default: VEHICLE_DEFINITION };
const STRUCTURE_DEFINITION = startupAssetsResponse.structure_definition;
const VEHICLE_HEADLIGHTS = (
  VEHICLE_DEFINITION.headlights != null &&
  typeof VEHICLE_DEFINITION.headlights === 'object'
)
  ? VEHICLE_DEFINITION.headlights
  : null;
const VEHICLE_PART_CONFIG = normalizeVehiclePartDefinition(VEHICLE_DEFINITION);

const scene = new THREE.Scene();
// CSM supplies direct sun but cannot be the only terrain light: shadowed
// ground then falls toward black, especially at Greenland's low sun angles.
// A restrained sky/ground hemisphere is the real-time ambient floor; it does
// not cast or add another shadow pass.
const terrainAmbientLight = new THREE.HemisphereLight(0xb8cee2, 0x263125, 0.35);
terrainAmbientLight.name = 'terrain-ambient-floor';
scene.add(terrainAmbientLight);
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
let webgpuCloudDensityField = null;
let webgpuCloudTextureNodes = [];
let webgpuCsmShadowNode = null;
let webgpuShadowLengthNode = null;
let webgpuActiveShadowLengthNode = null;
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
        logarithmicDepthBuffer: false,
        // LAAS TerrainMaterial (satellite + five field/noise maps) combined
        // with Atlantis CSM/lighting uses 17 fragment sampled textures. The
        // active adapter exposes 48, but WebGPU only grants the conservative
        // default 16 unless the device request asks for the higher limit.
        requiredLimits: { maxSampledTexturesPerShaderStage: 24 }
      })
    : new THREE.WebGLRenderer({
        antialias: true,
        depth: false,
        logarithmicDepthBuffer: true
      });
  renderer.setSize(window.innerWidth, window.innerHeight);
  // Cap DPR at 2: every post pass scales with output pixels, and 3x retina
  // fill is 2.25x the pixels of 2x for no visible gain (PERF_REWORK.md).
  const pixelRatio = Math.min(window.devicePixelRatio, 2);
  renderer.setPixelRatio(pixelRatio);
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
    pixelRatio,
    devicePixelRatio: window.devicePixelRatio,
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
    async clampRequiredLimits() {
      // A requiredLimits entry above what the adapter supports fails DEVICE
      // creation entirely, and three silently falls back to the WebGL backend
      // (headless Chromium adapters cap maxSampledTexturesPerShaderStage at
      // 16 where headed Chrome offers 48). Clamp each requested limit to the
      // adapter's maximum so init degrades per-limit instead of per-backend.
      const requested = renderer.backend?.parameters?.requiredLimits;
      if (requested == null || navigator.gpu == null) {
        return;
      }
      const adapter = await navigator.gpu.requestAdapter().catch(() => null);
      if (adapter == null) {
        return;
      }
      for (const [name, value] of Object.entries(requested)) {
        const supported = adapter.limits[name];
        if (typeof supported === 'number' && value > supported) {
          requested[name] = supported;
          enqueueClientLog('warn', 'renderer.webgpu.limit.clamped', {
            limit: name, requested: value, supported
          });
        }
      }
    },
    initialize() {
      if (!isWebGPU) {
        return;
      }
      this.clampRequiredLimits()
        .then(() => renderer.init())
        .then(() => {
          // GroundRing's shaded grass uses an EqualDepth pass behind an
          // identical depth-only twin. LAAS installs @invariant on every
          // WebGPU vertex position before creating those materials; without
          // it Metal can produce last-bit depth differences and leave the
          // camera-following black/transparent holes seen in the terrain.
          installPositionInvariance(renderer);
          installMaterialKeyMemo(renderer);
          const device = renderer.backend?.device;
          if (device) {
            device.addEventListener('uncapturederror', event => {
              const error = event.error;
              enqueueClientLog('error', 'renderer.webgpu.uncaptured', {
                message: error?.message ?? String(error),
              });
            });
            device.lost.then(info => {
              enqueueClientLog('error', 'renderer.webgpu.device.lost', {
                reason: info.reason,
                message: info.message,
              });
            });
          }
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
  onToggleGoogleNavigator: () => googleNavigator.toggle(),
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
      min: 128, max: 2048, step: 64,
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

// Production LAAS near-field system. GreenlandPatch owns the camera-following
// Heightfield, GroundRing, GPU Forests/rocks and their local scatter buffers;
// ArcticDEM meshes remain authoritative for geometry/picking/collision while
// receiving LAAS TerrainMaterial as their near-field visual LOD.
if (typeof window !== 'undefined') window.__enqueueClientLog = enqueueClientLog;
const PROCGEN_PATCH_ENABLED = BOOT_QUERY.get('procgenPatch') !== '0';
// A preview pass is useful for immediate terrain, but is intentionally too
// coarse to make the once-per-area classifier choice. This flips only after a
// full response has actually settled (not merely when pass 2 is scheduled).
let classifierSourceSelectionReady = false;
const greenlandPatch = PROCGEN_PATCH_ENABLED
  ? new GreenlandPatch(terrainRoot, 1337, {
      loadFields: fetchTileFields,
      // Classifier pages are an area-level decision. Wait for the full terrain
      // response before choosing so the preview's coarse bootstrap page cannot
      // win merely by arriving first; no classifier depth is prescribed here.
      classifierSelectionReady: () => classifierSourceSelectionReady,
      getCSM: () => webgpuCsmShadowNode,
      getSunLight: () => webgpuAtmosphereLight,
      onWindowChanged: () => refreshProcgenTerrainMaterials(),
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
const waterTimeNode = uniform(0).setName('atlantisWaterTime');
// Water does not need a full physical pipeline until the scene has a proper
// environment probe. Lambert keeps atmosphere/shadow composition under the
// WebGPU varying limit and still accepts the animated normal node.
const webgpuWaterMat = new MeshLambertNodeMaterial();
webgpuWaterMat.colorNode = color(0x287f9d);
// Until the geospatial scene has an environment reflection probe, preserve a
// blue sky-reflection floor. Without it the physically lit ocean resolves
// almost black because this scene does not yet provide an environment map.
webgpuWaterMat.emissiveNode = color(0x1b607e);
const waterUv = uv().mul(18);
const waterN0 = texture(
  waterNormalTex,
  waterUv.add(vec2(waterTimeNode.mul(0.012), waterTimeNode.mul(0.007))),
).xyz.mul(2).sub(1);
const waterN1 = texture(
  waterNormalTex,
  waterUv.mul(0.63).add(vec2(waterTimeNode.mul(-0.008), waterTimeNode.mul(0.011))),
).xyz.mul(2).sub(1);
webgpuWaterMat.normalNode = normalMap(waterN0.add(waterN1).normalize());
webgpuWaterMat.side = THREE.FrontSide;
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
const waterMesh = new THREE.Mesh(
  waterGeo,
  USE_WEBGPU_RENDER_BACKEND ? webgpuWaterMat : waterMat,
);
waterMesh.name = 'atlantis-ocean-surface';
waterMesh.position.set(0, 0, 0.5); // just above terrain ocean at z=0
waterMesh.frustumCulled = false;
waterMesh.castShadow = false;
waterMesh.receiveShadow = false;
waterMesh.visible = false;
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
const STREAMING_FOCUS_REFETCH_DIST = 1200;
let originX = 0, originY = 0;        // stereo scene origin from server
let camStereoX = 0, camStereoY = 0;  // current cam position in stereo
let lastFetchX = 0, lastFetchY = 0;
let tileFrameOffsetX = 0;            // shift server stereo-local bboxes into camera ENU-local frame
let tileFrameOffsetY = 0;
let tileFrameOffsetReady = false;
let _lastFetchTriggerMs = 0;
let lastStreamingFocus = null;
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
const _vehicleSeedInstance = ASSET_VEHICLE_INSTANCES.find(instance => {
  const definition = VEHICLE_DEFINITIONS[instance?.definitionId];
  return definition?.vehicleType !== 'aircraft';
}) ?? ASSET_VEHICLE_INSTANCES[0] ?? {};
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
  vehicleDisplayName: VEHICLE_DEFINITION.displayName || null,
  vehicleParts: VEHICLE_PART_CONFIG,
});
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
function createVehicleMarker(labelText, markerId) {
  const marker = new THREE.Group();
  marker.name = `vehicle-marker-${markerId}`;
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
  const label = createHouseLabelSprite(labelText, vehicleMarkerColor);
  label.position.set(0, 0, HOUSE_MARKER_HEIGHT + 900);
  label.renderOrder = 1005;
  marker.add(line, halo, dot, label);
  marker.traverse(object => { object.frustumCulled = false; });
  return marker;
}
const vehicleMarker = createVehicleMarker('AMV', 'amv');
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
// WebGPU already has the scene-wide CSM. The older per-vehicle/per-house
// systems duplicate every terrain tile with a nearly opaque ShadowMaterial
// receiver and add another shadow-casting directional light. Those receivers
// produced the camera-facing black bands seen ~423 m away. Keep the legacy
// receiver path only for WebGL, which does not use the WebGPU CSM.
const DEDICATED_TERRAIN_SHADOW_RECEIVERS = !USE_WEBGPU_RENDER_BACKEND;
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
let vehicleControlActive = false;
const vehicleUpRaycaster = new THREE.Raycaster();
const vehicleUpDirection = up.clone().normalize();
const VEHICLE_DRIVE_SPEED = paramNumber('vehicleDriveSpeed', 24);
const VEHICLE_ACCEL = paramNumber('vehicleAccel', 24);      // m/s² throttle
const VEHICLE_BRAKE = paramNumber('vehicleBrake', 3);       // m/s² engine brake (coast-down)
const VEHICLE_STEER_SPEED = paramNumber('vehicleSteerSpeed', 1.5);
const VEHICLE_CAMERA_MODES = Object.freeze([
  Object.freeze({ name: 'CLOSE', dist: 15, height: 5 }),
  Object.freeze({ name: 'MEDIUM', dist: 25, height: 8 }),
  Object.freeze({ name: 'FAR', dist: 38, height: 12 }),
]);
const TURRET_PITCH_MIN = THREE.MathUtils.degToRad(-10);
const TURRET_PITCH_MAX = THREE.MathUtils.degToRad(45);
const TURRET_MOUSE_SENSITIVITY = 0.003;
const TURRET_CAMERA_BEHIND_M = 8;
const TURRET_CAMERA_ABOVE_M = 3;
const VEHICLE_CAMERA_FOLLOW_DISTANCE_DEFAULT = paramNumber('vehicleCamDistance', 38);
const VEHICLE_CAMERA_FOLLOW_HEIGHT_DEFAULT = paramNumber('vehicleCamHeight', 12);
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
const vehicleDesiredForward = new THREE.Vector3();
const vehicleDesiredRight = new THREE.Vector3();
const vehicleOrientationMatrix = new THREE.Matrix4();
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
const VEHICLE_ENTRY_ID = (
  typeof _vehicleSeedInstance.id === 'string' && _vehicleSeedInstance.id.trim() !== ''
)
  ? _vehicleSeedInstance.id.trim()
  : 'amv-01';
let selectedVehicleId = null;
const vehicleRegistry = new Map();
function createGroundVehicleState({ id, definition, instance, group, marker, sunLight }) {
  const realLengthM = Number.isFinite(definition.realLengthM)
    ? definition.realLengthM
    : VEHICLE_MODEL.realLengthM;
  const tireDiameterM = Number.isFinite(definition.tireDiameterM)
    ? definition.tireDiameterM
    : VEHICLE_MODEL.tireDiameterM;
  const tireRadiusM = Math.max(0, paramNumber('vehicleTireRadiusM', tireDiameterM * 0.5));
  const altOffsetM = Number.isFinite(definition.altOffsetM)
    ? definition.altOffsetM
    : VEHICLE_MODEL.altOffsetM;
  return {
  id,
  vehicleType: 'ground',
  definition,
  instance,
  group,
  marker,
  sunLight,
  meshes: [],
  collisionMeshes: [],
  loaded: false,
  savedStatePending: null,
  snapPending: true,
  lastSnapAttemptAt: 0,
  awaitingInitialSnap: false,
  restoreRequiresDepth: false,
  restoreDepthTarget: -1,
  groundZTarget: null,
  verticalVelocity: 0,
  headingRad: THREE.MathUtils.degToRad(Number(instance.headingDeg) || 0),
  bodyLengthM: realLengthM,
  bodyWidthM: Math.max(2, realLengthM * 0.35),
  tireRadiusM,
  terrainLiftM: altOffsetM + tireRadiusM,
  shadowRadius: 100,
  lastContactDepth: -1,
  lastContactTileId: null,
  parts: null,
  wheelRig: null,
  turretRig: null,
  headlightSpots: [],
  speed: 0,
  cameraFollowDistance: VEHICLE_CAMERA_FOLLOW_DISTANCE_DEFAULT,
  cameraFollowHeight: VEHICLE_CAMERA_FOLLOW_HEIGHT_DEFAULT,
  cameraModeIndex: VEHICLE_CAMERA_MODES.findIndex(mode => (
    mode.dist === VEHICLE_CAMERA_FOLLOW_DISTANCE_DEFAULT
    && mode.height === VEHICLE_CAMERA_FOLLOW_HEIGHT_DEFAULT
  )),
  cameraOrbitYaw: 0,
  cameraOrbitPitch: Math.atan2(
    VEHICLE_CAMERA_FOLLOW_HEIGHT_DEFAULT,
    VEHICLE_CAMERA_FOLLOW_DISTANCE_DEFAULT
  ),
  groundNormal: new THREE.Vector3(0, 0, 1),
  turretControlActive: false,
  turretYawRad: 0,
  turretPitchRad: 0,
  fireHeld: false,
  lastFireAt: -Infinity,
  lastSaveAt: -Infinity,
  saveFailureUntil: 0,
  saveFailureReported: false,
  orientationTarget: new THREE.Quaternion(),
  headlightsConfig: definition.headlights ?? VEHICLE_HEADLIGHTS,
  };
}
const groundVehicleState = createGroundVehicleState({
  id: VEHICLE_ENTRY_ID,
  definition: VEHICLE_DEFINITIONS[_vehicleSeedInstance.definitionId] ?? VEHICLE_DEFINITION,
  instance: _vehicleSeedInstance,
  group: vehicleGroup,
  marker: vehicleMarker,
  sunLight: vehicleSunLight,
});
const groundVehicleEntries = [groundVehicleState];
vehicleRegistry.set(VEHICLE_ENTRY_ID, groundVehicleState);
for (const instance of ASSET_VEHICLE_INSTANCES) {
  if (instance === _vehicleSeedInstance) continue;
  const definition = VEHICLE_DEFINITIONS[instance?.definitionId] ?? VEHICLE_DEFINITION;
  if (definition.vehicleType === 'aircraft') continue;
  const id = typeof instance.id === 'string' && instance.id.trim()
    ? instance.id.trim()
    : `ground-${groundVehicleEntries.length + 1}`;
  const group = new THREE.Group();
  group.name = id;
  terrainRoot.add(group);
  const marker = createVehicleMarker(definition.displayName || 'Vehicle', id);
  vehicleMarkerLayer.add(marker);
  const sunLight = new THREE.DirectionalLight(0xffffff, 3);
  sunLight.castShadow = false;
  group.add(sunLight, sunLight.target, new THREE.AmbientLight(0x8090b0, 1));
  const entry = createGroundVehicleState({ id, definition, instance, group, marker, sunLight });
  groundVehicleEntries.push(entry);
  vehicleRegistry.set(id, entry);
};
const aircraftEntries = [];
for (const instance of ASSET_VEHICLE_INSTANCES) {
  const definition = VEHICLE_DEFINITIONS[instance?.definitionId];
  if (definition?.vehicleType !== 'aircraft') continue;
  const id = typeof instance.id === 'string' && instance.id.trim() ? instance.id.trim() : `aircraft-${aircraftEntries.length + 1}`;
  const group = new THREE.Group();
  group.name = id;
  terrainRoot.add(group);
  const marker = createVehicleMarker(definition.displayName || 'VTOL', id);
  vehicleMarkerLayer.add(marker);
  const state = createAircraftState({ id, definition, instance, group, marker });
  const sunLight = new THREE.DirectionalLight(0xffffff, 3);
  sunLight.castShadow = false;
  group.add(sunLight, sunLight.target, new THREE.AmbientLight(0x8090b0, 1));
  state.sunLight = sunLight;
  aircraftEntries.push(state);
  vehicleRegistry.set(id, state);
}
const vehicleBarrelTipLocal = new THREE.Vector3();
const vehicleTurretDirectionLocal = new THREE.Vector3();
const vehicleTurretCameraLocal = new THREE.Vector3();
const vehicleTurretLookLocal = new THREE.Vector3();
const vehicleTurretCameraWorld = new THREE.Vector3();
const vehicleTurretLookWorld = new THREE.Vector3();
const vehicleTurretUpLocal = new THREE.Vector3();
const vehicleTurretOriginLocal = new THREE.Vector3();

function isVehicleSelected() {
  return selectedVehicleEntry()?.vehicleType === 'ground';
}

function selectedVehicleEntry() {
  return selectedVehicleId ? vehicleRegistry.get(selectedVehicleId) ?? null : null;
}

function isAircraftSelected() {
  return selectedVehicleEntry()?.vehicleType === 'aircraft';
}

function selectedGroundVehicleEntry() {
  const entry = selectedVehicleEntry();
  return entry?.vehicleType === 'ground' ? entry : null;
}

function currentVehicleCameraModeName() {
  const entry = selectedVehicleEntry();
  if (entry?.turretControlActive) return 'TURRET';
  if (entry?.vehicleType === 'aircraft') {
    return AIRCRAFT_CAMERA_MODES[entry.cameraModeIndex]?.name ?? 'CUSTOM';
  }
  return VEHICLE_CAMERA_MODES[entry?.cameraModeIndex ?? groundVehicleState.cameraModeIndex]?.name ?? 'CUSTOM';
}

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

function getVehicleStateSnapshot(entry = groundVehicleState) {
  return vehicleStateSnapshot({
    loaded: entry.loaded,
    position: entry.group.position,
    headingRad: entry.headingRad,
    anchorLat,
    anchorLon,
  });
}

function sampleBestVehicleTerrainHit(
  localX = groundVehicleState.group.position.x,
  localY = groundVehicleState.group.position.y,
  terrainMeshes = null,
  entry = groundVehicleState,
) {
  if (!entry.loaded) {
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

function updateVehicleOrientationTargetFromGround(entry = groundVehicleState) {
  vehicleDesiredForward.set(-Math.sin(entry.headingRad), Math.cos(entry.headingRad), 0);
  vehicleDesiredForward.addScaledVector(
    entry.groundNormal,
    -vehicleDesiredForward.dot(entry.groundNormal)
  );
  if (vehicleDesiredForward.lengthSq() < 1e-8) {
    vehicleDesiredForward.set(0, 1, 0);
  } else {
    vehicleDesiredForward.normalize();
  }
  vehicleDesiredRight.crossVectors(vehicleDesiredForward, entry.groundNormal);
  if (vehicleDesiredRight.lengthSq() < 1e-8) {
    vehicleDesiredRight.set(1, 0, 0);
  } else {
    vehicleDesiredRight.normalize();
  }
  vehicleOrientationMatrix.makeBasis(
    vehicleDesiredRight,
    vehicleDesiredForward,
    entry.groundNormal
  );
  entry.orientationTarget.setFromRotationMatrix(vehicleOrientationMatrix);
}

function updateVehicleGroundNormalFromTerrain(centerHit, terrainMeshes, entry = groundVehicleState) {
  let normalReady = false;
  const headingForward = vehicleDesiredForward.set(-Math.sin(entry.headingRad), Math.cos(entry.headingRad), 0).normalize();
  const headingRight = vehicleDesiredRight.set(Math.cos(entry.headingRad), Math.sin(entry.headingRad), 0).normalize();
  const probeForwardM = Math.max(1.0, entry.bodyLengthM * VEHICLE_SLOPE_PROBE_LENGTH_SCALE);
  const probeRightM = Math.max(0.8, entry.bodyWidthM * VEHICLE_SLOPE_PROBE_WIDTH_SCALE);
  const centerX = entry.group.position.x;
  const centerY = entry.group.position.y;
  const front = sampleBestVehicleTerrainHit(
    centerX + headingForward.x * probeForwardM,
    centerY + headingForward.y * probeForwardM,
    terrainMeshes,
    entry,
  );
  const back = sampleBestVehicleTerrainHit(
    centerX - headingForward.x * probeForwardM,
    centerY - headingForward.y * probeForwardM,
    terrainMeshes,
    entry,
  );
  const right = sampleBestVehicleTerrainHit(
    centerX + headingRight.x * probeRightM,
    centerY + headingRight.y * probeRightM,
    terrainMeshes,
    entry,
  );
  const left = sampleBestVehicleTerrainHit(
    centerX - headingRight.x * probeRightM,
    centerY - headingRight.y * probeRightM,
    terrainMeshes,
    entry,
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
        entry.groundNormal.copy(vehicleProbeNormalLocal);
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
    entry.groundNormal.copy(vehicleProbeNormalLocal);
    normalReady = true;
  }
  if (!normalReady) {
    entry.groundNormal.set(0, 0, 1);
  }
  entry.groundNormal.normalize();
}

function vehicleNearTileBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return false;
  return groundVehicleEntries.some(entry => entry.loaded && (
    entry.group.position.x >= bbox[0] - VEHICLE_RESNAP_MARGIN_M
    && entry.group.position.x <= bbox[2] + VEHICLE_RESNAP_MARGIN_M
    && entry.group.position.y >= bbox[1] - VEHICLE_RESNAP_MARGIN_M
    && entry.group.position.y <= bbox[3] + VEHICLE_RESNAP_MARGIN_M
  ));
}

function requestVehicleTerrainResnap(reason = 'terrain-update') {
  for (const entry of groundVehicleEntries) {
    if (entry.loaded) entry.snapPending = true;
  }
  // bootLog('vehicle.resnap.requested', { reason });
}

function setVehicleGroundTarget(entry, nextZ, options = {}) {
  const {
    immediate = false,
    resetVelocity = false,
  } = options;
  if (!Number.isFinite(nextZ)) return;
  entry.groundZTarget = nextZ;
  if (resetVelocity) {
    entry.verticalVelocity = 0;
  }
  if (immediate) {
    entry.group.position.z = nextZ;
  }
  entry.marker.position.z = entry.group.position.z + HOUSE_MARKER_BASE_LIFT;
}

function updateVehicleSuspension(entry, dt) {
  if (!entry.loaded || !Number.isFinite(entry.groundZTarget)) return;
  const suspension = stepSuspension({
    dt, position: entry.group.position.z, target: entry.groundZTarget,
    velocity: entry.verticalVelocity, frequency: VEHICLE_SUSPENSION_HZ,
    dampingRatio: VEHICLE_SUSPENSION_DAMPING_RATIO,
    maxVelocity: VEHICLE_SUSPENSION_MAX_VEL,
  });
  entry.group.position.z = suspension.position;
  entry.verticalVelocity = suspension.velocity;
  updateVehicleOrientationTargetFromGround(entry);
  const orientationAlpha = 1 - Math.exp(-VEHICLE_ORIENTATION_RESPONSE * suspension.stepDt);
  entry.group.quaternion.slerp(entry.orientationTarget, orientationAlpha);
  entry.marker.position.z = entry.group.position.z + HOUSE_MARKER_BASE_LIFT;
}

function updateVehicleWheelSpin(entry, dt) {
  if (!entry.loaded || entry.wheelRig == null) return;
  spinVehicleWheelRig(entry.wheelRig, entry.speed * dt, entry.tireRadiusM);
}

function createVehicleSaveSnapshot(entry, options = {}) {
  const { snapToGround = false, bypassSnapThrottle = false } = options;
  if (snapToGround && entry.vehicleType === 'ground' && entry.loaded) {
    entry.snapPending = true;
    snapVehicleToTerrain(entry, { forceImmediate: true, bypassThrottle: bypassSnapThrottle });
  }
  const state = getVehicleStateSnapshot(entry);
  if (state == null) return null;
  if (entry.vehicleType === 'ground' && Number.isFinite(entry.groundZTarget)) {
    state.z = Number(entry.groundZTarget.toFixed(3));
  }
  if (entry.vehicleType === 'ground') {
    const terrainSample = sampleBestVehicleTerrainHit(
      entry.group.position.x,
      entry.group.position.y,
      null,
      entry,
    );
    if (terrainSample.depth >= 0) state.terrainDepth = terrainSample.depth;
    if (terrainSample.tileId) state.terrainTileId = terrainSample.tileId;
  }
  return state;
}

async function saveVehicleEntryState(entry, reason = 'manual', options = {}) {
  if (!VEHICLE_PERSISTENCE_ENABLED) return false;
  if (!entry?.loaded || entry.saveFailureUntil > Date.now()) return false;
  const state = createVehicleSaveSnapshot(entry, options);
  if (state == null) return false;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), VEHICLE_SAVE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${ASSET_SERVER_BASE}/api/asset/${encodeURIComponent(entry.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat: state.lat,
        lon: state.lon,
        headingDeg: state.headingDeg,
        z: state.z,
        ...(entry.vehicleType === 'ground' ? {
          properties: {
            ...(state.terrainDepth != null ? { terrainDepth: state.terrainDepth } : {}),
            ...(state.terrainTileId ? { terrainTileId: state.terrainTileId } : {}),
          },
        } : {}),
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`asset patch status ${response.status}`);
    if (entry.saveFailureReported) {
      bootLog('vehicle.state.save.recovered', { id: entry.id, reason });
    }
    entry.saveFailureUntil = 0;
    entry.saveFailureReported = false;
    bootLog('vehicle.state.save.ok', { id: entry.id, reason });
    return true;
  } catch (error) {
    entry.saveFailureUntil = Date.now() + VEHICLE_SAVE_FAILURE_COOLDOWN_MS;
    if (!entry.saveFailureReported) {
      entry.saveFailureReported = true;
      bootLog('vehicle.state.save.error', {
        id: entry.id,
        reason,
        timedOut: error?.name === 'AbortError',
        cooldownMs: VEHICLE_SAVE_FAILURE_COOLDOWN_MS,
        message: error?.message ?? String(error),
      }, 'error');
    }
    return false;
  } finally {
    window.clearTimeout(timeout);
  }
}

function throttledVehicleSave(entry, reason = 'movement-throttle') {
  const now = performance.now();
  if (now - entry.lastSaveAt < 5000) return;
  entry.lastSaveAt = now;
  void saveVehicleEntryState(entry, reason);
}

function loadVehicleState(entry = groundVehicleState) {
  const state = entry.instance?.id ? entry.instance : null;
  if (state == null) {
    bootLog('vehicle.state.load.empty');
    return null;
  }
  const normalized = normalizeSavedVehicleState(state);
  if (normalized == null) {
    bootLog('vehicle.state.load.invalid', { state }, 'error');
    return null;
  }
  entry.savedStatePending = normalized;
  return entry.savedStatePending;
}

function loadVehicleModel(entry = groundVehicleState) {
  const modelUrl = typeof entry.definition.url === 'string' && entry.definition.url.trim()
    ? entry.definition.url
    : VEHICLE_MODEL.url;
  vehicleLoader.load(
    modelUrl,
    gltf => {
      const model = gltf.scene;
      const modelRotation = entry.definition.modelRotationDeg;
      if (Array.isArray(modelRotation) && modelRotation.length === 3) {
        model.rotation.set(...modelRotation.map(THREE.MathUtils.degToRad));
      } else {
        model.rotation.x = Math.PI * 0.5; // Y-up → Z-up
      }
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
        ? entry.bodyLengthM / modelLength
        : 1;
      const scaledDims = [
        modelSize.x * vehicleScale,
        modelSize.y * vehicleScale,
        modelSize.z * vehicleScale,
      ].sort((a, b) => b - a);
      entry.bodyLengthM = scaledDims[0];
      entry.bodyWidthM = scaledDims[1];
      const scaledSpan = modelLength * vehicleScale;
      entry.shadowRadius = THREE.MathUtils.clamp(
        scaledSpan * 12,
        VEHICLE_SHADOW_MIN_RADIUS,
        VEHICLE_SHADOW_MAX_RADIUS
      );
      // Shift model so its bottom (min z) sits at z=0 in vehicleGroup local space
      model.position.z -= bbox.min.z;
      vehicleConsoleLog(`model bbox: ${modelSize.x.toFixed(2)} x ${modelSize.y.toFixed(2)} x ${modelSize.z.toFixed(2)}, longest=${modelLength.toFixed(2)}, scale=${vehicleScale.toFixed(4)}, bottomOffset=${bbox.min.z.toFixed(2)}`);
      entry.group.add(model);
      // ── Headlights ──────────────────────────────────────────────────
      const headlights = entry.headlightsConfig;
      if (headlights != null) {
        const localScale = vehicleScale !== 0 ? vehicleScale : 1;
        const hlColor = headlights.color;
        const hlIntensity = headlights.intensity;
        const hlAngle = THREE.MathUtils.degToRad(headlights.angleDeg);
        const hlPenumbra = headlights.penumbra;
        const hlDistance = headlights.distanceM;
        const hlDecay = headlights.decay;
        const hlFrontY = (entry.bodyLengthM * headlights.mountFrontRatio) / localScale;
        const hlHeight = headlights.mountHeightM / localScale;
        const hlSpacing = headlights.mountSpacingM / localScale;
        const hlTargetY = hlFrontY + (headlights.targetForwardM / localScale);
        const hlTargetZ = headlights.targetHeightM / localScale;
        entry.headlightSpots = [];
        for (const side of [-1, 1]) {
          const hl = new THREE.SpotLight(hlColor, hlIntensity, hlDistance, hlAngle, hlPenumbra, hlDecay);
          hl.position.set(side * hlSpacing, hlFrontY, hlHeight);
          hl.castShadow = false;
          const target = new THREE.Object3D();
          target.position.set(side * hlSpacing * headlights.targetXScale, hlTargetY, hlTargetZ);
          entry.group.add(target);
          hl.target = target;
          hl.visible = entry.instance.headlightsOn === true;
          entry.group.add(hl);
          entry.headlightSpots.push(hl);
        }
      }
      entry.parts = discoverVehicleParts(model, entry.definition);
      const vehiclePartsSummary = summarizeVehicleParts(entry.parts);
      bootLog('vehicle.parts.discovered', { id: entry.id, ...vehiclePartsSummary },
        entry.parts.missing.length > 0 ? 'warn' : 'info');
      const animatedWheelMeshes = new Set(entry.parts.wheels);
      entry.collisionMeshes = [];
      model.traverse(obj => {
        if (obj.isMesh && !animatedWheelMeshes.has(obj)) entry.collisionMeshes.push(obj);
      });
      entry.wheelRig = createVehicleWheelRig(THREE, entry.parts);
      const vehicleWheelRigSummary = summarizeVehicleWheelRig(entry.wheelRig);
      bootLog('vehicle.wheels.rigged', { id: entry.id, ...vehicleWheelRigSummary },
        vehicleWheelRigSummary.skipped.length > 0 ||
        vehicleWheelRigSummary.crossingTriangleCount > 0 ? 'warn' : 'info');
      entry.turretRig = createVehicleTurretRig(THREE, entry.parts);
      const vehicleTurretRigSummary = summarizeVehicleTurretRig(entry.turretRig);
      bootLog('vehicle.turret.rigged', { id: entry.id, ...vehicleTurretRigSummary },
        vehicleTurretRigSummary.warnings.length > 0 ? 'warn' : 'info');
      // Render the accepted vertex-cluster wheel animation, but ground against the
      // static body meshes. Wheel rotation must never change the collision floor.
      entry.meshes = [];
      model.traverse(obj => { if (obj.isMesh) entry.meshes.push(obj); });
      const savedState = entry.savedStatePending;
      // Asset rows created before geographic placement was required can omit
      // lat/lon. Never let one incomplete optional vehicle poison its Group
      // matrix (and every downstream world-space distance) with NaN.
      const startLat = Number.isFinite(savedState?.lat)
        ? savedState.lat
        : Number.isFinite(entry.instance.lat) ? entry.instance.lat : anchorLat;
      const startLon = Number.isFinite(savedState?.lon)
        ? savedState.lon
        : Number.isFinite(entry.instance.lon) ? entry.instance.lon : anchorLon;
      const startHeadingDeg = Number.isFinite(savedState?.headingDeg)
        ? savedState.headingDeg
        : (Number(entry.instance.headingDeg) || 0);
      const startZ = Number.isFinite(savedState?.z) ? savedState.z : (Number(entry.instance.z) || 0);
      const local = houseLocalFromLatLon(startLat, startLon);
      entry.headingRad = THREE.MathUtils.degToRad(startHeadingDeg);
      entry.groundNormal.set(0, 0, 1);
      updateVehicleOrientationTargetFromGround(entry);
      entry.group.position.set(local.x, local.y, startZ);
      entry.group.quaternion.copy(entry.orientationTarget);
      entry.group.scale.setScalar(vehicleScale);
      entry.loaded = true;
      entry.snapPending = true;
      entry.awaitingInitialSnap = true;
      entry.restoreRequiresDepth = Boolean(savedState);
      entry.restoreDepthTarget = Number.isFinite(savedState?.terrainDepth)
        ? savedState.terrainDepth
        : VEHICLE_RESTORE_MIN_DEPTH;
      entry.groundZTarget = Number.isFinite(startZ) ? startZ : null;
      entry.verticalVelocity = 0;
      entry.lastContactDepth = -1;
      entry.lastContactTileId = null;
      // The persisted Z is a valid coarse placement. Keep the vehicle discoverable while
      // the requested terrain depth streams in, then let the existing initial-snap path
      // refine its ground contact. Hiding here can make a loaded vehicle appear missing
      // indefinitely when terrain streaming is slow.
      entry.group.visible = true;
      entry.marker.position.set(local.x, local.y, HOUSE_MARKER_BASE_LIFT);
      bootLog('vehicle.load.success', {
        id: entry.id,
        url: modelUrl,
        modelLength: modelLength.toFixed(2),
        scale: vehicleScale.toFixed(4),
        shadowRadiusM: Number(entry.shadowRadius.toFixed(1)),
        terrainLiftM: Number(entry.terrainLiftM.toFixed(3)),
        startLat: Number(startLat.toFixed(8)),
        startLon: Number(startLon.toFixed(8)),
        startHeadingDeg: Number(startHeadingDeg.toFixed(3)),
        startZ: Number(startZ.toFixed(3)),
        restoreDepthTarget: entry.restoreDepthTarget,
      });
    },
    undefined,
    error => {
      vehicleConsoleWarn('load failed:', error);
      bootLog('vehicle.load.error', { id: entry.id, message: error?.message ?? String(error) });
    }
  );
}

const aircraftGroundRaycaster = new THREE.Raycaster();
const aircraftGroundOrigin = new THREE.Vector3();
const aircraftGroundHitLocal = new THREE.Vector3();
const aircraftCameraLocal = new THREE.Vector3();
const aircraftLookLocal = new THREE.Vector3();
const aircraftCameraWorld = new THREE.Vector3();
const aircraftLookWorld = new THREE.Vector3();
const aircraftHeadingQuat = new THREE.Quaternion();
const aircraftLocalUp = new THREE.Vector3(0, 0, 1);
const aircraftLookDirLocal = new THREE.Vector3();
const v22TextureSet = loadV22TextureSet();

function sampleAircraftGroundZ(entry) {
  const terrainMeshes = houseTerrainMeshes();
  if (terrainMeshes.length === 0) return entry.lastKnownGroundZ;
  aircraftGroundOrigin.set(entry.group.position.x, entry.group.position.y, 20000);
  terrainRoot.localToWorld(aircraftGroundOrigin);
  aircraftGroundRaycaster.set(aircraftGroundOrigin, vehicleDownDirection);
  const hit = aircraftGroundRaycaster.intersectObjects(terrainMeshes, false)[0];
  if (!hit) return entry.lastKnownGroundZ;
  aircraftGroundHitLocal.copy(hit.point);
  terrainRoot.worldToLocal(aircraftGroundHitLocal);
  return aircraftGroundHitLocal.z;
}

function loadAircraftModels() {
  for (const entry of aircraftEntries) {
    vehicleLoader.load(
      entry.definition.url,
      gltf => {
        const model = gltf.scene;
        const rotation = entry.definition.modelRotationDeg;
        if (Array.isArray(rotation) && rotation.length === 3) {
          model.rotation.set(...rotation.map(THREE.MathUtils.degToRad));
        } else {
          model.rotation.x = Math.PI * 0.5;
        }
        const v22Materials = applyV22Materials(model, v22TextureSet);
        model.traverse(object => {
          if (!object.isMesh) return;
          object.castShadow = true;
          object.receiveShadow = true;
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          for (const material of materials) applyVehicleMaterialSampling(material);
        });
        const bounds = new THREE.Box3().setFromObject(model);
        const size = new THREE.Vector3();
        bounds.getSize(size);
        const modelLength = Math.max(size.x, size.y, size.z);
        const scale = modelLength > 0 ? entry.definition.realLengthM / modelLength : 1;
        model.position.z -= bounds.min.z;
        entry.group.add(model);
        entry.group.scale.setScalar(scale);
        entry.meshes = [];
        model.traverse(object => { if (object.isMesh) entry.meshes.push(object); });
        const local = houseLocalFromLatLon(entry.instance.lat, entry.instance.lon);
        entry.group.position.set(local.x, local.y, Number(entry.instance.z) || 0);
        entry.marker.position.set(local.x, local.y, HOUSE_MARKER_BASE_LIFT);
        entry.loaded = true;
        entry.group.visible = true;
        entry.altitudeAGL = Math.max(0, entry.group.position.z - (sampleAircraftGroundZ(entry) ?? 0));
        const parts = setupAircraftModelParts(entry, model, bootLog);
        updateAircraftVisuals(entry, 0);
        bootLog('vehicle.load.success', {
          id: entry.id,
          vehicleType: 'aircraft',
          url: entry.definition.url,
          scale: Number(scale.toFixed(5)),
          parts,
          materials: v22Materials,
        });
        markSceneMutated();
        requestRender();
      },
      undefined,
      error => bootLog('vehicle.load.error', {
        id: entry.id,
        vehicleType: 'aircraft',
        message: error?.message ?? String(error),
      }, 'error'),
    );
  }
}

function updateAircraftFollowCamera(entry) {
  if (!entry?.loaded) return;
  const mode = AIRCRAFT_CAMERA_MODES[entry.cameraModeIndex] ?? AIRCRAFT_CAMERA_MODES[1];
  const radius = Math.hypot(mode.dist, mode.height) * entry.cameraZoom;
  const horizontalRadius = radius * Math.cos(entry.cameraOrbitPitch);
  aircraftCameraLocal.set(
    Math.sin(entry.cameraOrbitYaw) * horizontalRadius,
    -Math.cos(entry.cameraOrbitYaw) * horizontalRadius,
    radius * Math.sin(entry.cameraOrbitPitch),
  );
  aircraftHeadingQuat.setFromAxisAngle(aircraftLocalUp, entry.headingRad);
  aircraftCameraLocal.applyQuaternion(aircraftHeadingQuat).add(entry.group.position);
  aircraftLookLocal.copy(entry.group.position).addScaledVector(aircraftLocalUp, 2);
  aircraftCameraWorld.copy(aircraftCameraLocal);
  terrainRoot.localToWorld(aircraftCameraWorld);
  aircraftLookWorld.copy(aircraftLookLocal);
  terrainRoot.localToWorld(aircraftLookWorld);
  camera.position.copy(aircraftCameraWorld);
  camera.up.copy(up);
  camera.lookAt(aircraftLookWorld);
  aircraftLookDirLocal.copy(aircraftLookLocal).sub(aircraftCameraLocal).normalize();
  controls.yaw = Math.atan2(-aircraftLookDirLocal.x, aircraftLookDirLocal.y);
  controls.pitch = Math.asin(THREE.MathUtils.clamp(aircraftLookDirLocal.z, -1, 1));
}

function syncAircraftSunLights() {
  _vehicleSunLocal.set(
    sunDirection.dot(east),
    sunDirection.dot(north),
    sunDirection.dot(up),
  ).normalize();
  for (const entry of aircraftEntries) {
    if (!entry.loaded) continue;
    entry.sunLight.target.position.set(0, 0, 0);
    entry.sunLight.position.copy(_vehicleSunLocal).multiplyScalar(40);
  }
}

const _vehicleSunLocal = new THREE.Vector3();
function syncVehicleSunLight() {
  for (const entry of groundVehicleEntries) {
    if (!entry.loaded) continue;
    _vehicleSunLocal.set(
      sunDirection.dot(east),
      sunDirection.dot(north),
      sunDirection.dot(up)
    ).normalize();
    vehicleInvQuat.copy(entry.group.quaternion).invert();
    _vehicleSunLocal.applyQuaternion(vehicleInvQuat);
    entry.sunLight.target.position.set(0, 0, 0);
    entry.sunLight.position.copy(_vehicleSunLocal).multiplyScalar(40);
  }
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
  if (!DEDICATED_TERRAIN_SHADOW_RECEIVERS) {
    clearVehicleShadowReceivers();
    vehicleShadowReceiverLayer.visible = false;
    return;
  }
  if (!groundVehicleEntries.some(entry => entry.loaded)) {
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
  if (!DEDICATED_TERRAIN_SHADOW_RECEIVERS) {
    vehicleShadowCasterLight.visible = false;
    vehicleShadowReceiverLayer.visible = false;
    return;
  }
  const selected = selectedVehicleEntry();
  const entry = selected?.vehicleType === 'ground' && selected.loaded
    ? selected
    : groundVehicleEntries.find(candidate => candidate.loaded) ?? null;
  if (entry == null || controls.mapMode) {
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

  vehicleShadowCenterLocal.copy(entry.group.position);
  if (Number.isFinite(entry.groundZTarget)) {
    vehicleShadowCenterLocal.z = THREE.MathUtils.lerp(
      vehicleShadowCenterLocal.z,
      entry.groundZTarget,
      VEHICLE_SHADOW_GROUND_ANCHOR
    );
  }
  const shadowCenter = vehicleShadowCenterLocal;
  vehicleShadowCasterLight.visible = true;
  vehicleShadowCasterLight.position
    .copy(shadowCenter)
    .addScaledVector(_vehicleSunLocal, VEHICLE_SHADOW_LIGHT_DISTANCE + entry.shadowRadius);
  vehicleShadowCasterLight.target.position.copy(shadowCenter);
  vehicleShadowCasterLight.target.updateMatrixWorld(true);
  vehicleShadowCasterLight.updateMatrixWorld(true);

  const shadowCamera = vehicleShadowCasterLight.shadow.camera;
  shadowCamera.left = -entry.shadowRadius;
  shadowCamera.right = entry.shadowRadius;
  shadowCamera.top = entry.shadowRadius;
  shadowCamera.bottom = -entry.shadowRadius;
  shadowCamera.near = 20;
  shadowCamera.far = VEHICLE_SHADOW_LIGHT_DISTANCE + entry.shadowRadius * 4;
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

function snapVehicleToTerrain(entry = groundVehicleState, options = {}) {
  const { forceImmediate = false, bypassThrottle = false } = options;
  if (!entry.loaded) return;
  const now = performance.now();
  const minInterval = entry.snapPending ? VEHICLE_SNAP_PENDING_MS : VEHICLE_SNAP_IDLE_MS;
  if (!bypassThrottle && now - entry.lastSnapAttemptAt < minInterval) return;
  entry.lastSnapAttemptAt = now;
  const terrainMeshes = houseTerrainMeshes();
  if (terrainMeshes.length === 0 || entry.meshes.length === 0) return;
  const terrainSample = sampleBestVehicleTerrainHit(
    entry.group.position.x,
    entry.group.position.y,
    terrainMeshes,
    entry,
  );
  if (!terrainSample.hit) return;
  const fallbackHit = terrainSample.hit;
  const depth = tileDepthFromId(terrainSample.hit.object?.userData?.tileId);
  const selectedTileId = terrainSample.hit.object?.userData?.tileId ?? null;
  const bestMinDepthHit = depth >= entry.restoreDepthTarget ? terrainSample.hit : null;
  const selectedHit = entry.restoreRequiresDepth
    ? bestMinDepthHit
    : fallbackHit;
  if (!selectedHit) {
    // Wait for finer terrain under the vehicle before finalizing restore.
    return;
  }
  updateVehicleGroundNormalFromTerrain(selectedHit, terrainMeshes, entry);
  updateVehicleOrientationTargetFromGround(entry);
  const terrainPoint = selectedHit.point.clone();
  // Step 2: temporarily position vehicle high above terrain
  vehicleTargetLocal.copy(terrainPoint);
  terrainRoot.worldToLocal(vehicleTargetLocal);
  const alignImmediately = forceImmediate || entry.awaitingInitialSnap;
  const preSnapZ = entry.group.position.z;
  vehicleSnapPrevQuat.copy(entry.group.quaternion);
  entry.group.quaternion.copy(entry.orientationTarget);
  entry.group.position.z = vehicleTargetLocal.z + 50; // well above ground
  entry.group.updateMatrixWorld(true);
  // Step 3: raycast UP from terrain surface to find vehicle bottom
  vehicleUpRaycaster.set(terrainPoint, vehicleUpDirection);
  const vehicleHits = vehicleUpRaycaster.intersectObjects(
    entry.collisionMeshes.length > 0 ? entry.collisionMeshes : entry.meshes,
  );
  let groundedZ = vehicleTargetLocal.z + entry.terrainLiftM;
  if (vehicleHits.length === 0) {
    // Fallback: just use terrain height + small offset
    groundedZ = vehicleTargetLocal.z + entry.terrainLiftM;
  } else {
    // The gap between terrain and vehicle bottom
    const gap = vehicleHits[0].distance;
    groundedZ = entry.group.position.z - gap + entry.terrainLiftM;
  }
  if (!alignImmediately) {
    entry.group.position.z = preSnapZ;
    entry.group.quaternion.copy(vehicleSnapPrevQuat);
  } else {
    entry.group.quaternion.copy(entry.orientationTarget);
  }
  const prevDepth = entry.lastContactDepth;
  const prevTargetZ = entry.groundZTarget;
  setVehicleGroundTarget(
    entry,
    groundedZ,
    { immediate: alignImmediately, resetVelocity: forceImmediate }
  );
  const depthRefined = Number.isFinite(depth) && depth > prevDepth;
  if (depthRefined && Number.isFinite(prevTargetZ)) {
    const dz = groundedZ - prevTargetZ;
    if (Math.abs(dz) > 0.005) {
      entry.verticalVelocity += dz * VEHICLE_REFINEMENT_BOUNCE;
      entry.verticalVelocity = THREE.MathUtils.clamp(
        entry.verticalVelocity,
        -VEHICLE_SUSPENSION_MAX_VEL,
        VEHICLE_SUSPENSION_MAX_VEL
      );
    }
  }
  entry.snapPending = false;
  entry.restoreRequiresDepth = false;
  entry.restoreDepthTarget = -1;
  entry.lastContactDepth = Number.isFinite(depth) ? depth : entry.lastContactDepth;
  entry.lastContactTileId = selectedTileId;
  if (entry.awaitingInitialSnap) {
    entry.awaitingInitialSnap = false;
    entry.group.visible = true;
  }
}

function updateVehicleFollowCamera(entry = selectedGroundVehicleEntry()) {
  if (!entry?.loaded) return;
  const heading = entry.headingRad;
  const forwardX = -Math.sin(heading);
  const forwardY = Math.cos(heading);
  const rightX = Math.cos(heading);
  const rightY = Math.sin(heading);
  const radius = Math.sqrt(
    entry.cameraFollowDistance * entry.cameraFollowDistance +
    entry.cameraFollowHeight * entry.cameraFollowHeight
  );
  const horizontalRadius = radius * Math.cos(entry.cameraOrbitPitch);
  const verticalOffset = radius * Math.sin(entry.cameraOrbitPitch);
  const backScale = Math.cos(entry.cameraOrbitYaw);
  const sideScale = Math.sin(entry.cameraOrbitYaw);
  // Compute offset in vehicle-local frame (forward=+Y, right=+X, up=+Z)
  const localOffX = sideScale * horizontalRadius;
  const localOffY = -backScale * horizontalRadius;
  const localOffZ = verticalOffset;
  // Rotate by vehicle orientation so camera tilts with the vehicle on slopes
  vehicleFollowLocal.set(localOffX, localOffY, localOffZ);
  vehicleFollowLocal.applyQuaternion(entry.group.quaternion);
  vehicleFollowLocal.add(entry.group.position);
  vehicleLookTargetLocal.set(
    entry.group.position.x,
    entry.group.position.y,
    entry.group.position.z + VEHICLE_CAMERA_LOOK_HEIGHT
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

function updateVehicleTurretRig(entry = groundVehicleState) {
  if (!entry.loaded || entry.turretRig == null) return;
  if (entry.turretRig.turretPivot) {
    entry.turretRig.turretPivot.rotation.z = entry.turretYawRad;
  }
  if (entry.turretRig.gunPivot) {
    entry.turretRig.gunPivot.rotation.x = entry.turretPitchRad;
  }
  entry.group.updateWorldMatrix(true, true);
}

function getVehicleBarrelTipTerrainLocal(target, entry = selectedGroundVehicleEntry()) {
  if (entry?.turretRig?.gunPivot == null) return target.copy(entry?.group.position ?? vehicleGroup.position);
  target.copy(entry.turretRig.barrelTipLocal);
  entry.turretRig.gunPivot.localToWorld(target);
  terrainRoot.worldToLocal(target);
  return target;
}

function getVehicleTurretDirectionLocal(target, entry = selectedGroundVehicleEntry()) {
  if (entry?.turretRig?.gunPivot == null) {
    return target.set(0, 1, 0).applyQuaternion(entry?.group.quaternion ?? vehicleGroup.quaternion).normalize();
  }
  const origin = vehicleTurretOriginLocal.set(0, 0, 0);
  target.set(0, 1, 0);
  entry.turretRig.gunPivot.localToWorld(origin);
  entry.turretRig.gunPivot.localToWorld(target);
  terrainRoot.worldToLocal(origin);
  terrainRoot.worldToLocal(target);
  return target.sub(origin).normalize();
}

function updateVehicleTurretCamera(entry = selectedGroundVehicleEntry()) {
  if (!entry?.loaded || !entry.turretControlActive) return;
  getVehicleBarrelTipTerrainLocal(vehicleBarrelTipLocal, entry);
  getVehicleTurretDirectionLocal(vehicleTurretDirectionLocal, entry);
  vehicleTurretCameraLocal.copy(vehicleBarrelTipLocal)
    .addScaledVector(vehicleTurretDirectionLocal, -TURRET_CAMERA_BEHIND_M);
  vehicleTurretUpLocal.set(0, 0, 1).applyQuaternion(entry.group.quaternion).normalize();
  vehicleTurretCameraLocal.addScaledVector(vehicleTurretUpLocal, TURRET_CAMERA_ABOVE_M);
  vehicleTurretLookLocal.copy(vehicleBarrelTipLocal)
    .addScaledVector(vehicleTurretDirectionLocal, 500);
  vehicleTurretCameraWorld.copy(vehicleTurretCameraLocal);
  terrainRoot.localToWorld(vehicleTurretCameraWorld);
  vehicleTurretLookWorld.copy(vehicleTurretLookLocal);
  terrainRoot.localToWorld(vehicleTurretLookWorld);
  camera.position.copy(vehicleTurretCameraWorld);
  camera.up.copy(up);
  camera.lookAt(vehicleTurretLookWorld);
}

function setVehicleTurretControlActive(nextActive, reason = 'manual') {
  const entry = selectedGroundVehicleEntry();
  const requested = Boolean(nextActive);
  const available = entry?.turretRig?.turretPivot != null && entry?.turretRig?.gunPivot != null;
  const next = requested && available && vehicleControlActive && isVehicleSelected() && !isAircraftSelected();
  if (entry == null) return false;
  if (entry.turretControlActive === next) return entry.turretControlActive;
  entry.turretControlActive = next;
  if (next) {
    renderer.domElement.requestPointerLock?.();
  } else if (document.pointerLockElement === renderer.domElement) {
    document.exitPointerLock?.();
  }
  if (!next) {
    entry.fireHeld = false;
    vehicleFireRuntime?.stop?.();
  }
  bootLog('vehicle.turret.control', {
    id: entry.id,
    active: entry.turretControlActive,
    available,
    reason,
  });
  requestRender();
  return entry.turretControlActive;
}

function aimVehicleTurret(movementX, movementY) {
  const entry = selectedGroundVehicleEntry();
  if (!entry?.turretControlActive) return;
  entry.turretYawRad -= movementX * TURRET_MOUSE_SENSITIVITY;
  entry.turretPitchRad = THREE.MathUtils.clamp(
    entry.turretPitchRad - movementY * TURRET_MOUSE_SENSITIVITY,
    TURRET_PITCH_MIN,
    TURRET_PITCH_MAX
  );
}

function selectVehicle(reason = 'manual', vehicleId = VEHICLE_ENTRY_ID) {
  if (!vehicleRegistry.has(vehicleId)) return false;
  const changed = selectedVehicleId !== vehicleId;
  if (changed && vehicleControlActive) {
    setVehicleControlActive(false, 'selection-changed');
  }
  selectedVehicleId = vehicleId;
  if (changed) {
    bootLog('vehicle.selection', { id: selectedVehicleId, reason });
  }
  requestRender();
  return true;
}

function cycleVehicleCameraMode(reason = 'manual') {
  const entry = selectedVehicleEntry();
  if (!vehicleControlActive || entry?.turretControlActive) return false;
  if (entry?.vehicleType === 'aircraft') {
    entry.cameraModeIndex = (entry.cameraModeIndex + 1) % AIRCRAFT_CAMERA_MODES.length;
    entry.cameraZoom = 1;
    bootLog('vehicle.camera.mode', {
      id: entry.id,
      mode: AIRCRAFT_CAMERA_MODES[entry.cameraModeIndex].name,
      reason,
    });
    requestRender();
    return true;
  }
  if (!isVehicleSelected()) return false;
  entry.cameraModeIndex = (entry.cameraModeIndex + 1) % VEHICLE_CAMERA_MODES.length;
  const mode = VEHICLE_CAMERA_MODES[entry.cameraModeIndex];
  entry.cameraFollowDistance = mode.dist;
  entry.cameraFollowHeight = mode.height;
  entry.cameraOrbitPitch = THREE.MathUtils.clamp(
    Math.atan2(mode.height, mode.dist),
    VEHICLE_CAMERA_ORBIT_PITCH_MIN,
    VEHICLE_CAMERA_ORBIT_PITCH_MAX
  );
  bootLog('vehicle.camera.mode', { id: entry.id, mode: mode.name, reason });
  requestRender();
  return true;
}

function toggleVehicleHeadlights(reason = 'manual') {
  const entry = selectedGroundVehicleEntry();
  if (!vehicleControlActive || entry == null || entry.headlightSpots.length === 0) {
    return false;
  }
  const nextVisible = !entry.headlightSpots.some(light => light.visible);
  for (const light of entry.headlightSpots) light.visible = nextVisible;
  bootLog('vehicle.headlights', { id: entry.id, visible: nextVisible, reason });
  requestRender();
  return true;
}

function setVehicleControlActive(nextActive, reason = 'manual', options = {}) {
  const { skipExitSave = false } = options;
  driftMode = false;
  const requested = Boolean(nextActive);
  const entry = selectedVehicleEntry();
  if (requested && (entry == null || !entry.loaded || controls.mapMode)) {
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
    entry.cameraOrbitYaw = 0;
    const cameraMode = entry.vehicleType === 'aircraft'
      ? AIRCRAFT_CAMERA_MODES[entry.cameraModeIndex]
      : { dist: entry.cameraFollowDistance, height: entry.cameraFollowHeight };
    entry.cameraOrbitPitch = THREE.MathUtils.clamp(
      Math.atan2(cameraMode.height, cameraMode.dist),
      VEHICLE_CAMERA_ORBIT_PITCH_MIN,
      VEHICLE_CAMERA_ORBIT_PITCH_MAX
    );
    controls.yaw = entry.headingRad;
    if (entry.vehicleType === 'aircraft') updateAircraftFollowCamera(entry);
    else updateVehicleFollowCamera();
  }
  if (wasActive && !vehicleControlActive) {
    setVehicleTurretControlActive(false, `vehicle-exit-${reason}`);
    if (entry?.vehicleType === 'ground') {
      entry.turretYawRad = 0;
      entry.turretPitchRad = 0;
      entry.fireHeld = false;
      updateVehicleTurretRig(entry);
    }
    controls.speed = 0; // stop camera drift when exiting vehicle mode
    controls.strafeSpeed = 0;
  }
  if (wasActive && !vehicleControlActive && entry?.vehicleType === 'ground' && entry.loaded && !skipExitSave) {
    void saveVehicleEntryState(entry, `exit-${reason}`, {
      snapToGround: true,
      requireGroundedZ: false,
      bypassSnapThrottle: true,
    });
  }
  if (wasActive && !vehicleControlActive && entry?.vehicleType === 'aircraft' && !skipExitSave) {
    void saveVehicleEntryState(entry, `exit-${reason}`);
  }
  bootLog('vehicle.control', {
    id: entry?.id ?? null,
    active: vehicleControlActive,
    reason,
  });
  return vehicleControlActive;
}

function pointerVehicleEntry(event) {
  if (controls.mapMode) return null;
  mouseNDC.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouseNDC.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouseNDC, camera);
  let nearest = null;
  for (const entry of vehicleRegistry.values()) {
    if (!entry.loaded || entry.meshes.length === 0) continue;
    const hit = raycaster.intersectObjects(entry.meshes, false)[0];
    if (hit && (nearest == null || hit.distance < nearest.distance)) nearest = { entry, distance: hit.distance };
  }
  return nearest?.entry ?? null;
}

function trySelectVehicleFromPointer(event, { activate = false } = {}) {
  const entry = pointerVehicleEntry(event);
  if (entry == null) return false;
  selectVehicle(activate ? 'right-click-pointer' : 'left-click-pointer', entry.id);
  if (activate) return setVehicleControlActive(true, 'right-click-vehicle');
  return true;
}

function tryEnterVehicleControlFromPointer(event) {
  return trySelectVehicleFromPointer(event, { activate: true });
}

function toggleSelectedAircraftEngine(reason = 'manual') {
  const entry = selectedVehicleEntry();
  if (entry?.vehicleType !== 'aircraft' || !vehicleControlActive) return false;
  const running = toggleAircraftEngine(entry);
  bootLog('vehicle.aircraft.engine', { id: entry.id, running, reason });
  requestRender();
  return running;
}

const vehicleControlUI = createVehicleControlUI();
const vehicleFireRuntime = createVehicleFireRuntime({
  terrainRoot,
  camera,
  getTerrainTargets: houseTerrainMeshes,
  bootLog,
});

function setVehicleFireHeld(held) {
  const entry = selectedGroundVehicleEntry();
  if (entry == null || !entry.turretControlActive || !vehicleControlActive) {
    for (const groundEntry of groundVehicleEntries) groundEntry.fireHeld = false;
    return false;
  }
  entry.fireHeld = Boolean(held);
  if (entry.fireHeld) {
    // Prime audio and produce the first round directly from the trusted pointer
    // event; the frame loop then maintains the configured fire cadence.
    vehicleFireRuntime.primeAudio();
    getVehicleBarrelTipTerrainLocal(vehicleBarrelTipLocal, entry);
    vehicleFireRuntime.fire(entry, vehicleBarrelTipLocal);
  }
  return entry.fireHeld;
}

function updateVehicleFire(dt) {
  const entry = selectedGroundVehicleEntry();
  if (entry?.fireHeld && entry.turretControlActive && vehicleControlActive) {
    getVehicleBarrelTipTerrainLocal(vehicleBarrelTipLocal, entry);
    vehicleFireRuntime.fire(entry, vehicleBarrelTipLocal);
  }
  vehicleFireRuntime.update(dt);
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
const dieselCameraWorld = new THREE.Vector3();
const dieselVehicleWorld = new THREE.Vector3();

function updateDieselVolume() {
  // Audio is intentionally muted in the current game preset. Avoid two
  // world-matrix traversals and allocations per frame, and never pass NaN to
  // Web Audio if an optional asset has malformed transform data.
  if (!dieselSound.isPlaying || !(DIESEL_MAX_VOL > 0)) return;
  const entry = selectedGroundVehicleEntry() ?? groundVehicleEntries.find(candidate => candidate.loaded);
  if (entry == null) return;
  camera.getWorldPosition(dieselCameraWorld);
  entry.group.getWorldPosition(dieselVehicleWorld);
  const dist = dieselCameraWorld.distanceTo(dieselVehicleWorld);
  if (!Number.isFinite(dist)) {
    dieselSound.setVolume(0);
    return;
  }
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
  if (!DEDICATED_TERRAIN_SHADOW_RECEIVERS) {
    clearHouseShadowReceivers();
    houseShadowReceiverLayer.visible = false;
    return;
  }
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

  if (!DEDICATED_TERRAIN_SHADOW_RECEIVERS) {
    setGate('scene-csm');
    houseShadowCasterLight.visible = false;
    houseShadowReceiverLayer.visible = false;
    return;
  }
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
  // 2048/cascade uniformly: ShadowLengthNode derives maxShadowStep and
  // shadowMapTexelSize from cascade 0 only, so mixed per-cascade sizes are
  // unsafe. Resolution is re-evaluated from stationary A/B measurements
  // after split/refresh fixes, not assumed.
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
  // Custom splits: the CSM serves two roles — sharp surface shadows where
  // the LAAS veg patch lives (768 m span, active below 800 m AGL) and macro
  // occlusion to MAX_VIEW_DIST for the epipolar god rays. 'practical' puts
  // the first break at ~8 km (~19 m/texel); pinning it at 500 m gives
  // ~0.6 m/texel near detail while the far cascade keeps mountain/fjord
  // occluders for shadowLength. Values are normalized to
  // min(camera.far, maxFar). Set before first render — CSMShadowNode._init
  // runs updateFrustums(); changing splits at runtime needs a manual
  // updateFrustums() call.
  csmShadowNode.mode = 'custom';
  csmShadowNode.customSplitsCallback = (cascades, near, far, target) => {
    const splitsM = [500, 8000];
    let prev = 0;
    for (let i = 0; i < cascades - 1; i++) {
      const frac = Math.min(Math.max((splitsM[i] ?? far) / far, prev + 1e-4), 1);
      target.push(frac);
      prev = frac;
    }
    target.push(1);
  };
  atmosphereLight.shadow.shadowNode = csmShadowNode;
  webgpuCsmShadowNode = csmShadowNode;

  // Takram volumetric cloud density field + beer shadow map (cascaded cloud
  // optical depth marched from the sun). Replaces the handrolled procedural
  // cloud-shadow quad. The procedural texture nodes compute once on first
  // build; the shadow map recomputes every frame from updateBefore.
  const cloudTextures = {
    localWeather: new LocalWeatherNode(),
    shape: new CloudShapeNode(),
    shapeDetail: new CloudShapeDetailNode(),
    turbulence: new TurbulenceNode()
  };
  // App-loop managed dispatch: their in-frame one-shot computes race the
  // first-frame pipeline builds (atmosphere LUTs) and nondeterministically
  // black out the sky on r182.
  webgpuCloudTextureNodes = Object.values(cloudTextures);
  for (const node of webgpuCloudTextureNodes) {
    node.autoDispatch = false;
  }
  webgpuCloudDensityField = new CloudDensityField({
    localWeatherNode: cloudTextures.localWeather.getTextureNode(),
    shapeNode: cloudTextures.shape.getTextureNode(),
    shapeDetailNode: cloudTextures.shapeDetail.getTextureNode(),
    turbulenceNode: cloudTextures.turbulence.getTextureNode()
  });
  webgpuCloudShadows = new CloudBeerShadowMapNode(camera, webgpuCloudDensityField);
  webgpuCloudShadows.maxFar = MAX_VIEW_DIST;
  applyWebGPUCloudShadowLiveSettings();
  // DETACHED — measured 2026-07-17: attaching the BSM to the light craters
  // the frame rate ~50x (22-30 fps → 0.3, GPU-bound: 92% of CPU time blocks
  // in GPUQueue.submit). Bisected: NOT the compute march (?bsmFreeze=1
  // identical, 1 dispatch) and NOT the sampling math (sampleOpticalDepth
  // stubbed to a constant → still 0.3 fps). The collapse follows the
  // lighting-graph attach itself; WHICH element is unproven — still in the
  // frame with the stub: the custom light subclass, the mix() into
  // lightColor, the renderGroup uniform, changed cache keys/bind groups.
  // Isolation ladder if pursued on r182 (may be mooted by the r185
  // experiment): (1) subclass returning directLight unchanged, (2) *= const,
  // (3) *= uniform(1), (4) *= mix(1, const, uniform), (5) + BSM sample.
  // Present since stage 2 (its 0.5-4 fps "contention" numbers were this).
  // Cloud GOD RAYS don't need this attach — they fold the BSM into
  // shadowLength in the post pass instead.
  // atmosphereLight.cloudShadow = webgpuCloudShadows;
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
  // Own the god-ray quality budget: takram's autoSampleResolution rewrites
  // epipolarSliceCount/maxSliceSampleCount from viewport size every frame,
  // silently quadrupling the configured grid on a 1080p+ window
  // (PERF_REWORK.md). Disabled so godRaySlices is actually honored.
  shadowLengthNode.autoSampleResolution = false;
  shadowLengthNode.epipolarSliceCount.value = webgpuAtmosphereSettings.godRaySlices;
  shadowLengthNode.maxSliceSampleCount.value = webgpuAtmosphereSettings.godRaySlices / 2;
  // firstCascade stays 0: skipping the near cascade measured ZERO fps gain
  // (epipolar cost is not the bottleneck, PERF_REWORK.md 2026-07-18) and at
  // ground level it visibly kills shafts from terrain within 500 m. Set via
  // ?godRayFirstCascade=1 only for A/B.
  shadowLengthNode.firstCascade.value = bootQueryNumber('godRayFirstCascade', 0);
  webgpuShadowLengthNode = shadowLengthNode;

  // Cloud god rays: march the beer shadow map along each view ray in post
  // and merge the cloud shadow segment into the CSM shadow length. Samples
  // the BSM only here — never through light.cloudShadow (see the DETACHED
  // note above). ?cloudGodRays=0 compiles it out.
  let cloudGodRays = null;
  if (webgpuCloudShadows != null && BOOT_QUERY.get('cloudGodRays') !== '0') {
    cloudGodRays = createCloudGodRayShadowLength({
      csmShadowLengthNode: shadowLengthNode,
      beerShadowMap: webgpuCloudShadows,
      depthNode,
      camera,
      atmosphereContext: webgpuAtmosphereContext,
      worldToUnit: webgpuAtmosphereParameters.worldToUnit,
      // half-res march by default; ?cloudGodRaysFull=1 = per-pixel A/B path
      fullRes: BOOT_QUERY.get('cloudGodRaysFull') === '1'
    });
  }
  webgpuActiveShadowLengthNode = cloudGodRays?.node ?? shadowLengthNode;

  // Screen-space grounding (GTAO + contact shadows) on the scene color
  // before aerial perspective. LAAS excludes understory plants from the CSM
  // caster set on the assumption these two layers ground them instead;
  // without this they float. ?gtao=0 / ?contact=0 compile the layers out;
  // grounding.uAoStrength/.uContactStrength (0..1) toggle live for A/B.
  const grounding = createGroundingNode({
    colorNode,
    depthNode,
    camera,
    getSunDirectionECEF: () => webgpuAtmosphereContext?.sunDirectionECEF?.value ?? null,
    enabled: {
      gtao: BOOT_QUERY.get('gtao') !== '0',
      contact: BOOT_QUERY.get('contact') !== '0'
    },
    fullRes: BOOT_QUERY.get('groundingFull') === '1'
  });

  const atmosphereNode = webgpuAerialPerspective(
    grounding.node,
    depthNode,
    webgpuActiveShadowLengthNode
  );
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
    // length, 1.0 = 10 km of shadowed ray. Convention (per the atmosphere
    // runtime.ts branch diagrams, the authority): x = shadowed LENGTH along
    // the ray, y = distance to the shadow segment start, unit space. This
    // view previously displayed .yyy labeled as the length — that showed the
    // START distance; conclusions drawn from it need rechecking.
    // The select keeps the main path in the graph so the scene pass (and its
    // viewZ buffer) still renders.
    outputNode = bool(true).select(
      shadowLengthNode.xxx
        .mul(1 / webgpuAtmosphereParameters.worldToUnit)
        .mul(0.0001),
      outputNode
    );
  } else if (window.location.hash === '#cloud-textures') {
    // Smoke test for the WebGPU clouds port (upstream webgpu/clouds merge):
    // left half = LocalWeatherNode RGB (2D compute), right half = a mid slice
    // of CloudShapeNode (3D compute). Both run their compute dispatch on
    // first build; visible noise on both halves = the texture stack works.
    const weatherNode = new LocalWeatherNode();
    const shapeNode = new CloudShapeNode();
    window.__cloudDebug = { weatherNode, shapeNode };
    const weatherSample = vec4(
      weatherNode.getTextureNode().sample(screenUV.mul(vec3(2, 1, 0).xy)).xyz,
      1
    );
    // Right half tiles 8 Z-slices of the 128^3 shape texture so partial
    // compute coverage (some slices written, others not) is visible.
    const shapeX = screenUV.x.mul(2).sub(1).mul(8);
    const shapeSample = vec4(
      shapeNode
        .getTextureNode()
        .sample(vec3(shapeX.fract(), screenUV.y, shapeX.floor().div(8)))
        .xxx,
      1
    );
    outputNode = bool(true).select(
      screenUV.x.lessThan(0.5).select(weatherSample, shapeSample),
      outputNode
    );
  } else if (window.location.hash === '#cloud-bsm') {
    // Beer shadow map cascades side by side. R channel = distance to cloud
    // front (scaled), G = mean extinction — cloud footprints show as
    // structure in G; empty sky is (maxRayDistance, 0, 0, 0).
    const bsmX = screenUV.x.mul(3);
    const bsmSample = webgpuCloudShadows
      .getTextureNode()
      .sample(vec3(bsmX.fract(), screenUV.y, bsmX.floor().add(0.5).div(3)));
    // Keep the main path in the graph so the scene pass still renders (the
    // CSM and the rest of the pipeline initialize from it).
    outputNode = bool(true).select(
      vec4(
        vec3(
          bsmSample.g.mul(2000),
          bsmSample.b.add(bsmSample.a).mul(0.5),
          bsmSample.r.mul(1e-5)
        ),
        1
      ),
      outputNode
    );
  } else if (window.location.hash === '#cloud-shape-only') {
    // Minimal graph: 3D shape slices only, main path excluded entirely.
    // Distinguishes "3D node broken in-client" from "post graph pressure".
    const shapeNode = new CloudShapeNode();
    window.__cloudDebug = { shapeNode };
    const shapeX = screenUV.x.mul(8);
    outputNode = vec4(
      shapeNode
        .getTextureNode()
        .sample(vec3(shapeX.fract(), screenUV.y, shapeX.floor().div(8)))
        .xxx,
      1
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
    MeshLambertNodeMaterial,
    cloudDensityField: webgpuCloudDensityField,
    beerShadowMap: webgpuCloudShadows,
    grounding: grounding.uniforms,
    cloudGodRays: cloudGodRays?.uniforms ?? null,
    greenlandPatch,
  };
  bootLog('renderer.webgpu.atmosphere.ready', {
    godRays: true,
    csmCascades: csmShadowNode.cascades,
    csmMaxFar: csmShadowNode.maxFar,
    // Which cascade-refresh policy is live this session — check this first
    // before assuming shadow behavior; 'budgeted' is production, 'sync' is
    // the ?csmSyncRefresh=1 diagnostic (forces all cascades every frame).
    csmRefreshMode: CSM_SYNC_REFRESH_DIAGNOSTIC ? 'sync' : 'budgeted',
    csmLegacyStagger: CSM_LEGACY_STAGGER_DIAGNOSTIC,
    godRaySlices: shadowLengthNode.epipolarSliceCount.value,
    godRayMaxSamples: shadowLengthNode.maxSliceSampleCount.value,
    cloudGodRaysEnabled: cloudGodRays != null,
    cloudGodRaysFullRes: BOOT_QUERY.get('cloudGodRaysFull') === '1'
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
  const activeShadowLength = webgpuAtmosphereSettings.godRays
    ? (webgpuActiveShadowLengthNode ?? webgpuShadowLengthNode)
    : null;
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
  cloudShadowsEnabled.value = webgpuCloudShadowSettings.enabled ? 1 : 0;
  if (webgpuCloudDensityField == null) {
    return;
  }
  webgpuCloudDensityField.coverage.value = webgpuCloudShadowSettings.coverage;
  // "density" scales all four layers' density uniformly, preserving the
  // takram per-layer profile ratios.
  const scale = webgpuCloudShadowSettings.density;
  const defaults = webgpuCloudDensityField.layers;
  webgpuCloudDensityField.densityScales.value.set(
    defaults[0].densityScale * scale,
    defaults[1].densityScale * scale,
    defaults[2].densityScale * scale,
    defaults[3].densityScale * scale
  );
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
  webgpuActiveShadowLengthNode = null;
  webgpuCloudShadows?.dispose();
  webgpuCloudShadows = null;
  webgpuCloudDensityField = null;
  webgpuCloudTextureNodes = [];
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
  onSceneMutated: () => { markSceneMutated(); markShadowCastersChanged(); },
});

function clearProcgenTerrainNodes(mesh) {
  const material = mesh?.material;
  if (!material || !mesh.userData.procgenTerrainMaterial) return false;
  material.colorNode = null;
  material.normalNode = null;
  material.roughnessNode = null;
  material.metalnessNode = null;
  mesh.userData.procgenTerrainMaterial = null;
  material.needsUpdate = true;
  return true;
}

function procgenContextIntersectsMesh(contextValue, mesh) {
  const bbox = mesh?.userData?.bbox ?? mesh?.userData?.scatterInput?.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4) return false;
  return (
    bbox[2] >= contextValue.xMin && bbox[0] <= contextValue.xMax &&
    bbox[3] >= contextValue.yMin && bbox[1] <= contextValue.yMax
  );
}

// Shared runtime values: a recenter changes coordinates, not shader structure.
// Embedding centerX/centerY as JS literals made every 192 m move compile a new
// terrain shader for each intersecting tile (multi-second WebGPU hitch).
const procgenCenterX = uniform(0);
const procgenCenterY = uniform(0);

function applyProcgenTerrainNodes(mesh, tex, contextValue) {
  const material = mesh.material;
  const key = `procgen:${tex?.uuid ?? 'fields'}`;
  if (mesh.userData.procgenTerrainMaterial === key) return false;

  // Streamed tile vertices are terrainRoot-local z-up (x=east, y=north,
  // z=elevation). LAAS fields/materials are y-up with +z toward south.
  const laasPosition = vec3(
    positionLocal.x.sub(procgenCenterX),
    positionLocal.z,
    procgenCenterY.sub(positionLocal.y),
  );
  const hf = contextValue.hf;
  const shading = buildTerrainShading({
    normalTex: hf.normalTex,
    biomeTex: hf.biomeTex,
    fieldsTex: hf.fieldsTex,
    noiseA: hf.noiseA,
    noiseB: hf.noiseB,
    mp: hf.mp,
    far: false,
    external: true,
    worldPosition: laasPosition,
    cameraWorldPosition: vegViewPos,
    worldSize: contextValue.worldSize,
  });

  // Geometry ends at 265 m. Keep the matching ground representation fully
  // present through that handoff, then dissolve it into satellite imagery
  // across the clipmap guard band instead of exposing a circular cutoff.
  const cameraDistance = laasPosition.sub(vegViewPos).length();
  const procedural = float(1).sub(smoothstep(270, 350, cameraDistance));
  const satellite = tex ? texture(tex, uv()).rgb : color(COLOR_WEBGPU_UNTEXTURED);
  if (tex) {
    // Textured imagery is the visual authority. Procedural color and normals
    // previously made a pale, camera-following island and projected dark
    // streaks/ovals over the real terrain. The classifier still drives asset
    // placement, but it must not repaint or emboss satellite imagery.
    material.colorNode = satellite;
    material.normalNode = null;
    material.roughnessNode = null;
  } else {
    // Fine height geometry may intentionally materialize before its imagery.
    // In that short-lived case the classifier palette is better than a dark
    // placeholder and is replaced as soon as the real texture arrives.
    material.colorNode = mix(satellite, shading.colorNode, procedural);
    // No imagery yet: retain the classifier material as a temporary visual
    // and its derived micro-normal until the source texture arrives.
    const baseLaasNormal = vec3(normalLocal.x, normalLocal.z, normalLocal.y.negate());
    const blendedLaasNormal = mix(baseLaasNormal, shading.worldNormalNode, procedural).normalize();
    const terrainNormal = vec3(
      blendedLaasNormal.x,
      blendedLaasNormal.z.negate(),
      blendedLaasNormal.y,
    );
    material.normalNode = transformNormalToView(terrainNormal);
    material.roughnessNode = mix(float(1), shading.roughnessNode, procedural);
  }
  material.metalnessNode = float(0);
  material.vertexColors = false;
  mesh.userData.procgenTerrainMaterial = key;
  material.needsUpdate = true;
  return true;
}

function refreshProcgenTerrainMaterials() {
  const contextValue = greenlandPatch?.terrainMaterialContext?.();
  if (contextValue) {
    procgenCenterX.value = contextValue.centerX;
    procgenCenterY.value = contextValue.centerY;
  }
  let applied = 0;
  let cleared = 0;
  for (const child of terrainRoot.children) {
    if (!child.isMesh || !child.material) continue;
    const tex = child.material.map ?? null;
    if (contextValue && procgenContextIntersectsMesh(contextValue, child)) {
      if (applyProcgenTerrainNodes(child, tex, contextValue)) applied++;
    } else {
      if (clearProcgenTerrainNodes(child)) cleared++;
    }
  }
  enqueueClientLog('info', 'patch.materials', {
    center: contextValue?.id ?? null,
    applied,
    cleared,
  });
  markSceneMutated();
}

function applyTerrainMaterialMode(mesh, tex) {
  if (!mesh || !mesh.material) return;
  let needsUpdate = false;
  const useOceanOverlay = oceanMapDebugEnabled && controls.mapMode;
  if (useOceanOverlay) {
    needsUpdate = clearProcgenTerrainNodes(mesh) || needsUpdate;
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
    // Texture→texture rebind keeps the same shader (USE_MAP define unchanged)
    // — never invalidate the pipeline for it. Setting needsUpdate here made
    // every streamed texture arrival and every map-mode toggle recompile the
    // material: hundreds of tiles × pipeline compiles in one frame = the
    // multi-second freeze on M (measured 2.8 s stall headless, ~25 s in a
    // cold/contended session, 2026-07-19). null→texture DOES flip the define
    // and must still recompile.
    const hadMap = mesh.material.map != null;
    mesh.material.map = tex;
    if (!hadMap) needsUpdate = true;
  }
  const contextValue = greenlandPatch?.terrainMaterialContext?.();
  if (contextValue && procgenContextIntersectsMesh(contextValue, mesh)) {
    needsUpdate = applyProcgenTerrainNodes(mesh, tex, contextValue) || needsUpdate;
  } else {
    needsUpdate = clearProcgenTerrainNodes(mesh) || needsUpdate;
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
  onMeshAdded: () => { markSceneMutated(); markShadowCastersChanged(); },
  vehicleNearTile: vehicleNearTileBbox,
  getVehicleDepth: () => selectedGroundVehicleEntry()?.lastContactDepth
    ?? Math.max(-1, ...groundVehicleEntries.map(entry => entry.lastContactDepth)),
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
    heading: priorityHeading(vehicleControlActive, selectedVehicleEntry()?.headingRad ?? controls.yaw, controls.yaw),
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

function traversalMotion() {
  const controlled = vehicleControlActive ? selectedVehicleEntry() : null;
  const heading = priorityHeading(
    vehicleControlActive,
    controlled?.headingRad ?? controls.yaw,
    controls.yaw,
  );
  const speedMps = controlled?.vehicleType === 'aircraft'
    ? Math.abs(controlled.forwardSpeedMs ?? 0)
    : controlled?.vehicleType === 'ground'
      ? Math.abs(controlled.speed ?? 0)
      : Math.hypot(controls.speed, controls.strafeSpeed);
  const controlledPosition = controlled?.group?.position;
  return {
    heading,
    speedMps,
    // Procgen residency follows the controlled vehicle, not an orbiting chase
    // camera. Mouse-look around a stationary vehicle must never move or
    // rebuild the baked asset population.
    focusTerrainX: Number.isFinite(controlledPosition?.x) ? controlledPosition.x : null,
    focusTerrainY: Number.isFinite(controlledPosition?.y) ? controlledPosition.y : null,
    focusTerrainZ: Number.isFinite(controlledPosition?.z) ? controlledPosition.z : null,
  };
}

function terrainStreamingFocus(cameraLL = getCameraLatLon()) {
  const current = terrainCameraStereoPosition({
    latitude: cameraLL.lat,
    longitude: cameraLL.lon,
    anchorLatitude: anchorLat,
    anchorLongitude: anchorLon,
    originX,
    originY,
  });
  const motion = traversalMotion();
  const predicted = predictTerrainStreamingFocus({
    x: current.x,
    y: current.y,
    heading: motion.heading,
    speedMps: motion.speedMps,
  });
  const coordinates = epsg3413ToWgs84(predicted.x, predicted.y);
  lastStreamingFocus = {
    ...predicted,
    lat: coordinates.lat,
    lon: coordinates.lon,
    currentX: current.x,
    currentY: current.y,
  };
  return lastStreamingFocus;
}

function getTerrainRequestFocus(cameraLL) {
  if (isFirstLoad || !tileFrameOffsetReady) return cameraLL;
  const focus = terrainStreamingFocus(cameraLL);
  return {
    lat: focus.lat,
    lon: focus.lon,
    logDetails: {
      streamFocusX: Number(focus.x.toFixed(1)),
      streamFocusY: Number(focus.y.toFixed(1)),
      streamLookaheadM: Number(focus.lookaheadMetres.toFixed(1)),
      streamLookaheadS: Number(focus.lookaheadSeconds.toFixed(1)),
      traversalSpeedMps: Number(focus.speedMps.toFixed(1)),
    },
  };
}

const PROCGEN_FIELD_PREFETCH_COUNT = 32;
const PROCGEN_FIELD_PREFETCH_LEAD_MAX = 768;
const PROCGEN_FINE_GEOMETRY_HALF_SPAN = 512;
function tileOverlapsProcgenGeometryWindow(tile) {
  if (!greenlandPatch || !Array.isArray(tile?.bbox) || tile.bbox.length !== 4) return false;
  const relative = camera.position.clone().sub(anchorPosition);
  const x = relative.dot(east);
  const y = relative.dot(north);
  return tile.bbox[2] >= x - PROCGEN_FINE_GEOMETRY_HALF_SPAN
    && tile.bbox[0] <= x + PROCGEN_FINE_GEOMETRY_HALF_SPAN
    && tile.bbox[3] >= y - PROCGEN_FINE_GEOMETRY_HALF_SPAN
    && tile.bbox[1] <= y + PROCGEN_FINE_GEOMETRY_HALF_SPAN;
}
function prefetchProcgenFields(tiles) {
  if (!greenlandPatch || !Array.isArray(tiles) || tiles.length === 0) return;
  const relative = camera.position.clone().sub(anchorPosition);
  const currentX = relative.dot(east);
  const currentY = relative.dot(north);
  const motion = traversalMotion();
  const lead = Math.min(PROCGEN_FIELD_PREFETCH_LEAD_MAX, motion.speedMps * 4);
  const targetX = currentX - Math.sin(motion.heading) * lead;
  const targetY = currentY + Math.cos(motion.heading) * lead;
  const ranked = [];
  for (const tile of tiles) {
    const bbox = tile?.bbox;
    if (!Array.isArray(bbox) || bbox.length !== 4 || !tile.id) continue;
    const cx = (bbox[0] + bbox[2]) * 0.5;
    const cy = (bbox[1] + bbox[3]) * 0.5;
    const currentD2 = (cx - currentX) ** 2 + (cy - currentY) ** 2;
    const targetD2 = (cx - targetX) ** 2 + (cy - targetY) ** 2;
    ranked.push({ tile, distance2: Math.min(currentD2, targetD2) });
  }
  ranked.sort((a, b) => a.distance2 - b.distance2);
  for (const { tile } of ranked.slice(0, PROCGEN_FIELD_PREFETCH_COUNT)) {
    void fetchTileFields(tile.id);
  }
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
  if (!tileFrameOffsetReady) return getExactCameraLatLon(position);
  const coordinates = terrainCameraCoordinates({
    position, anchorPosition, east, north, up,
    anchorLatitude: anchorLat, anchorLongitude: anchorLon, originX, originY,
  });
  const grid = {
    x: originX + coordinates.eastM - tileFrameOffsetX,
    y: originY + coordinates.northM - tileFrameOffsetY,
  };
  return { ...epsg3413ToWgs84(grid.x, grid.y), alt: coordinates.alt, grid };
}

const googleMapsDirection = new THREE.Vector3();
const googleMapsEast = new THREE.Vector3();
const googleMapsNorth = new THREE.Vector3();
const googleMapsUp = new THREE.Vector3();
function openGoogleMapsView() {
  camera.getWorldDirection(googleMapsDirection);
  const renderedPosition = getRenderedTerrainLatLon();
  Ellipsoid.WGS84.getEastNorthUpVectors(
    camera.position, googleMapsEast, googleMapsNorth, googleMapsUp,
  );
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
    alt: cameraAGL,
    directionEast: gridBearing == null
      ? googleMapsDirection.dot(googleMapsEast)
      : Math.sin(gridBearing * Math.PI / 180),
    directionNorth: gridBearing == null
      ? googleMapsDirection.dot(googleMapsNorth)
      : Math.cos(gridBearing * Math.PI / 180),
    directionUp: googleMapsDirection.dot(googleMapsUp),
    fov: camera.fov,
  });
  window.open(url, '_blank', 'noopener,noreferrer');
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

// Separate from sceneMutationVersion: that counter also bumps on
// material/texture-only mutations, which depth-only shadow maps don't see.
// This one tracks caster GEOMETRY changes (tile mesh add/evict/replace) and
// drives CSM cascade invalidation.
let shadowCasterVersion = 0;
function markShadowCastersChanged() {
  shadowCasterVersion++;
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
  useManifest: true,
  tileBudget: 384,
  previewTileBudget: 16,
  previewBuildBudget: 16,
  fullBuildBudget: 32,
  getHeading: () => priorityHeading(vehicleControlActive, selectedVehicleEntry()?.headingRad ?? controls.yaw, controls.yaw),
  getRange: () => _terrainRange,
  getCameraLatLon,
  getRequestFocus: getTerrainRequestFocus,
  getCameraSnapshot: getCameraLogSnapshot,
  getCameraLocalPosition: () => {
    const relative = camera.position.clone().sub(anchorPosition);
    return { x: relative.dot(east), y: relative.dot(north) };
  },
  anchorLatitude: anchorLat, anchorLongitude: anchorLon, terrainRoot, deferredTiles,
  lifecycle: tileLifecycle, priorityForTile: tilePriority,
  textureCache: texCache,
  materialize: materializeTile, buildMesh, tileLog, applyMissing: markMissing, updateTextures,
  prepareUntexturedMesh: applyWebGPUUntexturedTerrainMaterial,
  forceUntexturedBuild: tileOverlapsProcgenGeometryWindow,
  onMeshAdded: () => { markSceneMutated(); markShadowCastersChanged(); },
  onWorldIdentity: identity => greenlandPatch?.setWorldIdentity(identity),
  onTilesReceived: prefetchProcgenFields,
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
    if (tileFetchScheduler.pass === 2) classifierSourceSelectionReady = true;
    // Drain accumulated dt so the next render frame doesn't lurch the camera.
    clock.getDelta();
    requestRender();
  },
});

function fetchTiles(lat, lon) {
  classifierSourceSelectionReady = false;
  return tileFetchScheduler.request(lat, lon);
}

function navigateCameraTo(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)
      || Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  const altitude = Math.max(MIN_FLIGHT_ALT, getCameraLatLon().alt);
  const targetGrid = wgs84ToEpsg3413(lat, lon);
  if (!Number.isFinite(targetGrid.x) || !Number.isFinite(targetGrid.y)) return false;

  if (!tileFrameOffsetReady) {
    originX = targetGrid.x;
    originY = targetGrid.y;
    tileFrameOffsetX = 0;
    tileFrameOffsetY = 0;
    tileFrameOffsetReady = true;
  }
  const targetEastM = targetGrid.x - originX + tileFrameOffsetX;
  const targetNorthM = targetGrid.y - originY + tileFrameOffsetY;
  controls.speed = 0;
  controls.strafeSpeed = 0;
  controls.dragging = false;
  driftMode = false;
  for (const code of Object.keys(controls.keys)) controls.keys[code] = false;
  setVehicleControlActive(false, 'google-navigate');
  camera.position.copy(anchorPosition)
    .addScaledVector(east, targetEastM)
    .addScaledVector(north, targetNorthM)
    .addScaledVector(up, altitude);
  _lastCamMoveTime = performance.now();
  applyCameraOrientation();
  updateMapCamera();

  textureStreamer.abortAll();
  updateTerrainTextures.reset();
  abortAllEnhancements();
  tileFetchScheduler.reset(1);
  isFirstLoad = true;
  camStereoX = targetGrid.x;
  camStereoY = targetGrid.y;
  lastFetchX = targetGrid.x;
  lastFetchY = targetGrid.y;
  markHousesNeedSnap();
  enqueueClientLog('info', 'google.navigate', {
    lat: Number(lat.toFixed(7)),
    lon: Number(lon.toFixed(7)),
    altitude: Number(altitude.toFixed(1)),
    gridX: Number(targetGrid.x.toFixed(3)),
    gridY: Number(targetGrid.y.toFixed(3)),
    backend: 'webgpu',
  });
  fetchTiles(lat, lon);
  updateHud();
  requestRender();
  return true;
}

const googleNavigator = createGoogleNavigator({
  getCameraLatLon: getRenderedTerrainLatLon,
  navigateTo: navigateCameraTo,
  openGoogle3d: openGoogleMapsView,
  onChanged: requestRender,
});

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
for (const entry of groundVehicleEntries) {
  loadVehicleState(entry);
  loadVehicleModel(entry);
}
loadAircraftModels();

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
  getCloudShadowDebugSummary: () =>
    webgpuCloudDensityField != null
      ? {
          enabled: cloudShadowsEnabled.value === 1,
          coverage: webgpuCloudDensityField.coverage.value,
          densityScales: webgpuCloudDensityField.densityScales.value.toArray(),
          shadowTopHeight: webgpuCloudDensityField.shadowTopHeight.value,
          shadowBottomHeight: webgpuCloudDensityField.shadowBottomHeight.value
        }
      : null,
  flushClientLogQueue: () => flushClientLogQueue(),
  fetchTiles,
  navigateTo: navigateCameraTo,
  getCameraLatLon,
  getRenderedTerrainLatLon,
  loadHouseModel,
  setHousesVisible: visible => setHousesRuntimeVisible(Boolean(visible), 'debug-api'),
  getHousesVisible: () => housesRuntimeVisible,
  saveVehicleState: (reason, id) => {
    const entry = vehicleRegistry.get(id ?? selectedVehicleId ?? VEHICLE_ENTRY_ID);
    return saveVehicleEntryState(entry, reason ?? 'debug-api');
  },
  loadVehicleState,
  setVehicleControlActive: active => setVehicleControlActive(Boolean(active), 'debug-api'),
  getVehicleControlActive: () => vehicleControlActive,
  getSelectedVehicleId: () => selectedVehicleId,
  selectVehicle: id => selectVehicle('debug-api', id ?? VEHICLE_ENTRY_ID),
  getVehicleRegistry: () => Array.from(vehicleRegistry.values(), entry => ({
    id: entry.id,
    vehicleType: entry.vehicleType,
    loaded: entry.loaded,
    visible: entry.group.visible,
    meshCount: entry.meshes.length,
    displayName: entry.definition?.displayName ?? null,
    configuredParts: entry.vehicleType === 'aircraft' ? entry.definition?.parts ?? null : null,
    position: entry.group.position.toArray(),
    headingDeg: Number(THREE.MathUtils.radToDeg(entry.headingRad).toFixed(3)),
    speedMps: entry.vehicleType === 'aircraft' ? entry.forwardSpeedMs : entry.speed,
    engineRunning: entry.vehicleType === 'aircraft' ? entry.engineRunning : null,
    rotorSpool: entry.vehicleType === 'aircraft' ? Number(entry.rotorSpool.toFixed(4)) : null,
    nacelleTiltDeg: entry.vehicleType === 'aircraft' ? Number(entry.nacelleTiltDeg.toFixed(2)) : null,
    flightRegime: entry.vehicleType === 'aircraft' ? entry.flightRegime : null,
    altitudeAGL: entry.vehicleType === 'aircraft' ? Number(entry.altitudeAGL.toFixed(2)) : null,
    verticalSpeedMs: entry.vehicleType === 'aircraft' ? Number(entry.verticalSpeedMs.toFixed(3)) : null,
    rotors: entry.vehicleType === 'aircraft' ? {
      left: entry.leftRotorMesh?.name ?? null,
      right: entry.rightRotorMesh?.name ?? null,
      angleRad: Number(entry.rotorSpinAngle.toFixed(5)),
      angularVelocityRadS: Number(entry.rotorAngularVelocity.toFixed(5)),
    } : null,
    nacelles: entry.vehicleType === 'aircraft' ? {
      left: entry.leftNacellePivot?.name ?? null,
      right: entry.rightNacellePivot?.name ?? null,
      leftRotation: entry.leftNacellePivot?.rotation.toArray().slice(0, 3)
        .map(value => Number(value.toFixed(5))) ?? null,
      rightRotation: entry.rightNacellePivot?.rotation.toArray().slice(0, 3)
        .map(value => Number(value.toFixed(5))) ?? null,
    } : null,
  })),
  cycleVehicleCameraMode: () => cycleVehicleCameraMode('debug-api'),
  getVehicleCameraMode: () => currentVehicleCameraModeName(),
  getVehicleFireSummary: () => vehicleFireRuntime.summary(),
  setVehicleFireHeld,
  getVehicleTurretRigSummary: id => summarizeVehicleTurretRig(
    vehicleRegistry.get(id ?? selectedVehicleId ?? VEHICLE_ENTRY_ID)?.turretRig
  ),
  getVehicleTurretControlActive: () => Boolean(selectedGroundVehicleEntry()?.turretControlActive),
  setVehicleTurretControlActive: active => setVehicleTurretControlActive(
    Boolean(active),
    'debug-api'
  ),
  getVehicleParts: id => vehicleRegistry.get(id ?? selectedVehicleId ?? VEHICLE_ENTRY_ID)?.parts,
  getVehiclePartsSummary: id => summarizeVehicleParts(
    vehicleRegistry.get(id ?? selectedVehicleId ?? VEHICLE_ENTRY_ID)?.parts
  ),
  getVehicleWheelRigSummary: id => summarizeVehicleWheelRig(
    vehicleRegistry.get(id ?? selectedVehicleId ?? VEHICLE_ENTRY_ID)?.wheelRig
  ),
  getVehicleWheelContacts: id => {
    const entry = vehicleRegistry.get(id ?? selectedVehicleId ?? VEHICLE_ENTRY_ID);
    return getVehicleWheelContactSnapshot(
      THREE,
      entry?.wheelRig,
      terrainRoot,
      entry?.group,
      entry?.tireRadiusM,
    );
  },
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

  if (vehicleControlActive && selectedVehicleEntry() == null) {
    setVehicleControlActive(false, 'selection-changed');
  }

  const selectedEntry = selectedVehicleEntry();
  if (vehicleControlActive && selectedEntry?.vehicleType === 'aircraft' && !controls.mapMode) {
    controls.speed = 0;
    controls.strafeSpeed = 0;
    stepAircraftFlight(selectedEntry, {
      forward: forwardPressed,
      back: backPressed,
      left: leftPressed,
      right: rightPressed,
      climb: Boolean(controls.keys.Space),
      descend: Boolean(controls.keys.KeyQ),
    }, dt, sampleAircraftGroundZ(selectedEntry));
    throttledVehicleSave(selectedEntry, 'flight-throttle');
    _lastCamMoveTime = performance.now();
    abortAllEnhancements();
    return;
  }

  if (vehicleControlActive && isVehicleSelected() && !controls.mapMode) {
    controls.speed = 0;
    controls.strafeSpeed = 0;
    if (!selectedEntry.loaded) {
      setVehicleControlActive(false, 'vehicle-unloaded');
      return;
    }
    const steer = (leftPressed ? 1 : 0) + (rightPressed ? -1 : 0);
    const drive = (forwardPressed ? 1 : 0) + (backPressed ? -1 : 0);
    const driveStep = stepVehicleDrive({
      dt, heading: selectedEntry.headingRad, speed: selectedEntry.speed, steer, drive,
      groundNormalX: selectedEntry.groundNormal.x, groundNormalY: selectedEntry.groundNormal.y,
      acceleration: VEHICLE_ACCEL, brake: VEHICLE_BRAKE,
      steerSpeed: VEHICLE_STEER_SPEED, maxSpeed: VEHICLE_DRIVE_SPEED,
    });
    selectedEntry.headingRad = driveStep.heading;
    selectedEntry.speed = driveStep.speed;
    if (selectedEntry.speed !== 0 || steer !== 0) {
      selectedEntry.group.position.x += driveStep.deltaX;
      selectedEntry.group.position.y += driveStep.deltaY;
      selectedEntry.marker.position.x = selectedEntry.group.position.x;
      selectedEntry.marker.position.y = selectedEntry.group.position.y;
      selectedEntry.snapPending = true;
      throttledVehicleSave(selectedEntry, 'drive-throttle');
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
  const hudVehicle = selectedVehicleEntry();
  const rel = camera.position.clone().sub(anchorPosition);
  const eastM = rel.dot(east);
  const northM = rel.dot(north);
  const altM = rel.dot(up);
  const displayedSpeedMps = vehicleControlActive
    ? Math.abs(hudVehicle?.vehicleType === 'aircraft' ? hudVehicle.forwardSpeedMs : (hudVehicle?.speed ?? 0))
    : Math.hypot(controls.speed, controls.strafeSpeed);
  const speedKmh = displayedSpeedMps * 3.6;
  const headingForHud = vehicleControlActive
    ? (hudVehicle?.headingRad ?? controls.yaw)
    : controls.yaw;
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
    : (hudVehicle?.turretControlActive ? 'TURRET' : (vehicleControlActive
      ? (hudVehicle?.vehicleType === 'aircraft' ? 'VTOL' : 'VEHICLE')
      : 'FLIGHT'));
  const modeHtml = hudVehicle?.turretControlActive
    ? '<span style="color:#ff8c00">TURRET</span>'
    : vehicleControlActive
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
    vehicleControlActive && hudVehicle?.vehicleType === 'aircraft'
      ? `${hudVehicle.flightRegime} · rotor ${Math.round(hudVehicle.rotorSpool * 100)}% · nacelles ${hudVehicle.nacelleTiltDeg.toFixed(0)}° · V/S ${hudVehicle.verticalSpeedMs.toFixed(1)} m/s · AGL ${hudVehicle.altitudeAGL.toFixed(0)} m`
      : '',
    hmLine,
    texLine,
    hudVehicle?.turretControlActive
      ? 'Mouse aims turret, W/S drive, A/D steer, T or Esc exits turret · firing pending WebGPU validation'
      : vehicleControlActive && hudVehicle?.vehicleType === 'aircraft'
      ? `E engine (${hudVehicle.engineRunning ? 'ON' : 'OFF'}), Space/Q climb/descend, W/S forward/back, A/D yaw, V camera (${currentVehicleCameraModeName()}), Esc exit`
      : vehicleControlActive
      ? `W/S drive, A/D steer, mouse orbit, V camera (${currentVehicleCameraModeName()}), L lights, Esc exit`
      : (hudVehicle != null
        ? `${hudVehicle.definition?.displayName || 'Vehicle'} selected · right-click it to drive`
        : 'WASD or Arrows move, Q/Z altitude, drag look · click vehicle to select, right-click to drive'),
    'map: left-drag rotate, right-drag pan, wheel zoom',
    controls.mapMode
      ? `ocean overlay: ${oceanMapDebugEnabled ? 'ON' : 'OFF'}  (right-click menu; cyan=ocean, magenta=seed, orange=passable)`
      : '',
    '<span id="mapModeLink" style="color:#0af;text-decoration:underline;cursor:pointer;pointer-events:auto">map mode</span> (M)'
    + ' · <span id="googleNavigatorLink" style="color:#0af;text-decoration:underline;cursor:pointer;pointer-events:auto">Google navigator</span> (G)'
    + ' · <span id="debugLogLink" style="color:#0af;text-decoration:underline;cursor:pointer;pointer-events:auto">debug log</span>'
    + ' · <span id="pipelineMapLink" title="2D radar in pipeline-map mode — click any tile to open its tile inspector" style="color:#0af;text-decoration:underline;cursor:pointer;pointer-events:auto">pipeline map</span> (P)'
    + ' · <span id="radarHeatmapLink" style="color:#0af;text-decoration:underline;cursor:pointer;pointer-events:auto">heatmap</span> (H)'
  ].join('<br>');
  alt.textContent =
    `${altM.toFixed(0)}m / ${(altM * 3.28084).toFixed(0)}ft  ${deg.toFixed(0)}° ${compass}` +
    `  FOV ${camera.fov.toFixed(0)}°` +
    (controls.mapMode ? '  [MAP]' : (hudVehicle?.turretControlActive ? '  [TURRET]' : (vehicleControlActive ? '  [VEHICLE]' : '')));
  const isAircraft = hudVehicle?.vehicleType === 'aircraft';
  const headlightsOn = !isAircraft && Boolean(hudVehicle?.headlightSpots?.some(light => light.visible));
  vehicleControlUI.update({
    selected: hudVehicle != null,
    loaded: Boolean(hudVehicle?.loaded),
    active: vehicleControlActive,
    mapMode: controls.mapMode,
    displayName: hudVehicle?.definition?.displayName || 'Vehicle',
    id: hudVehicle?.id || '',
    cameraMode: currentVehicleCameraModeName(),
    speedMps: isAircraft ? (hudVehicle?.forwardSpeedMs ?? 0) : (hudVehicle?.speed ?? 0),
    hasLights: !isAircraft && (hudVehicle?.headlightSpots?.length ?? 0) > 0,
    lightsOn: headlightsOn,
    hasTurret: !isAircraft && hudVehicle?.turretRig?.gunPivot != null,
    turretActive: Boolean(hudVehicle?.turretControlActive),
    isAircraft,
    engineRunning: Boolean(hudVehicle?.engineRunning),
    rotorSpool: hudVehicle?.rotorSpool ?? 0,
    altitudeAGL: hudVehicle?.altitudeAGL ?? 0,
    verticalSpeedMs: hudVehicle?.verticalSpeedMs ?? 0,
    flightRegime: hudVehicle?.flightRegime ?? 'GROUND',
  });
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

const resetViewButton = document.createElement('button');
resetViewButton.type = 'button';
resetViewButton.id = 'reset-view-button';
resetViewButton.textContent = 'Reset view';
resetViewButton.title = 'Reset camera, tuning, and streamed terrain position';
resetViewButton.style.cssText = [
  'padding:4px 7px',
  'margin-left:auto',
  'margin-right:8px',
  'border:1px solid rgba(255,255,255,0.24)',
  'border-radius:4px',
  'background:rgba(5,10,16,0.72)',
  'color:#9aa8b5',
  'font:11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
  'cursor:pointer',
].join(';');
resetViewButton.addEventListener('click', event => {
  event.stopPropagation();
  if (window.confirm('Reset the camera, tuning, and streamed terrain position?')) resetView();
});
tuningHeader.insertBefore(resetViewButton, tuningHeader.lastElementChild);

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
  isTurretActive: () => Boolean(selectedGroundVehicleEntry()?.turretControlActive),
  onForwardDoubleTap: () => {
    driftMode = !driftMode;
    console.log(`[drift] ${driftMode ? 'ON' : 'OFF'}`);
  },
  onEscapeVehicle: () => {
    if (isAircraftSelected()) {
      setVehicleControlActive(false, 'escape');
    } else {
      void saveVehicleEntryState(selectedVehicleEntry(), 'escape', {
        snapToGround: true,
        requireGroundedZ: false,
        bypassSnapThrottle: true,
      });
      setVehicleControlActive(false, 'escape', { skipExitSave: true });
    }
  },
  onEscapeTurret: () => setVehicleTurretControlActive(false, 'escape'),
  onToggleMap: toggleMapMode,
  onToggleGoogleNavigator: () => googleNavigator.toggle(),
  onOpenPipeline: () => window.open(HUD_LINKS.pipelineMapLink, '_blank'),
  onOpenHeatmap: () => window.open(HUD_LINKS.radarHeatmapLink, '_blank'),
  onHouseAction: load => load
    ? loadHouseModel('keyboard')
    : setHousesRuntimeVisible(!housesRuntimeVisible, 'keyboard'),
  onToggleHeadlights: () => {
    toggleVehicleHeadlights('keyboard');
  },
  onCycleVehicleCamera: () => cycleVehicleCameraMode('keyboard'),
  onToggleTurret: () => setVehicleTurretControlActive(
    !selectedGroundVehicleEntry()?.turretControlActive,
    'keyboard'
  ),
  onToggleAircraftEngine: () => toggleSelectedAircraftEngine('keyboard'),
  onChanged: requestRender,
});

installTerrainPointerControls({
  element: renderer.domElement,
  controls,
  mouseSensitivity: MOUSE_SENS,
  mapPanFactor: MAP_PAN_FACTOR,
  isVehicleActive: () => vehicleControlActive,
  isTurretActive: () => Boolean(selectedGroundVehicleEntry()?.turretControlActive),
  onVehicleOrbit: (movementX, movementY) => {
    const entry = selectedVehicleEntry();
    if (entry == null) return;
    entry.cameraOrbitYaw -= movementX * VEHICLE_CAMERA_ORBIT_SENS;
    entry.cameraOrbitPitch = THREE.MathUtils.clamp(
      entry.cameraOrbitPitch + movementY * VEHICLE_CAMERA_ORBIT_SENS,
      VEHICLE_CAMERA_ORBIT_PITCH_MIN,
      VEHICLE_CAMERA_ORBIT_PITCH_MAX,
    );
  },
  onTurretAim: aimVehicleTurret,
  onFireStart: () => setVehicleFireHeld(true),
  onFireStop: () => setVehicleFireHeld(false),
  onMapCameraChanged: updateMapCamera,
  onChanged: requestRender,
});

document.addEventListener('pointerlockchange', () => {
  if (selectedGroundVehicleEntry()?.turretControlActive && document.pointerLockElement !== renderer.domElement) {
    setVehicleTurretControlActive(false, 'pointer-lock-lost');
  }
  if (document.pointerLockElement !== renderer.domElement) setVehicleFireHeld(false);
});
window.addEventListener('blur', () => setVehicleFireHeld(false));

let vehicleSelectionPointerDown = null;
renderer.domElement.addEventListener('pointerdown', event => {
  vehicleSelectionPointerDown = {
    button: event.button,
    x: event.clientX,
    y: event.clientY,
  };
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
    const down = vehicleSelectionPointerDown;
    vehicleSelectionPointerDown = null;
    const isSelectionClick = down != null && down.button === 0 && event.button === 0 &&
      Math.hypot(event.clientX - down.x, event.clientY - down.y) <= 4;
    if (isSelectionClick) trySelectVehicleFromPointer(event);
    return;
  }
  vehicleSelectionPointerDown = null;
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
      const entry = selectedVehicleEntry();
      if (entry?.vehicleType === 'aircraft') {
        entry.cameraZoom = THREE.MathUtils.clamp(entry.cameraZoom * scale, 0.25, 4);
      } else {
        entry.cameraFollowDistance = Math.max(8, Math.min(200, entry.cameraFollowDistance * scale));
        entry.cameraFollowHeight = Math.max(2, Math.min(80, entry.cameraFollowHeight * scale));
        entry.cameraModeIndex = -1;
      }
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
  waterTimeNode.value = clock.elapsedTime;
  waterMesh.visible = !controls.mapMode;

  // Terrain streaming: check if camera moved far enough to re-fetch
  if (!isFirstLoad) {
    const camLL = getCameraLatLon();
    const stereo = terrainCameraStereoPosition({
      latitude: camLL.lat, longitude: camLL.lon,
      anchorLatitude: anchorLat, anchorLongitude: anchorLon, originX, originY,
    });
    camStereoX = stereo.x;
    camStereoY = stereo.y;
    const focus = terrainStreamingFocus(camLL);
    const refetch = predictiveRefetchDecision({
      focusX: focus.x, focusY: focus.y, lastFocusX: lastFetchX, lastFocusY: lastFetchY,
      nowMs, lastTriggerMs: _lastFetchTriggerMs,
      distanceThreshold: STREAMING_FOCUS_REFETCH_DIST,
      triggerIntervalMs: 1000,
    });
    _lastFetchTriggerMs = refetch.nextTriggerMs;
    if (refetch.shouldFetch) fetchTiles();
  }
  for (const entry of groundVehicleEntries) snapVehicleToTerrain(entry);
  updateDieselVolume();
  for (const entry of groundVehicleEntries) {
    updateVehicleSuspension(entry, dt);
    updateVehicleWheelSpin(entry, dt);
    updateVehicleTurretRig(entry);
  }
  for (const entry of aircraftEntries) updateAircraftVisuals(entry, dt);
  updateVehicleFire(dt);
  if (vehicleControlActive && !controls.mapMode) {
    if (selectedGroundVehicleEntry()?.turretControlActive) updateVehicleTurretCamera();
    else if (isAircraftSelected()) updateAircraftFollowCamera(selectedVehicleEntry());
    else updateVehicleFollowCamera();
  }
  syncVehicleSunLight();
  syncAircraftSunLights();
  syncVehicleShadowReceivers();
  updateVehicleShadowSystem();
  if (housesRuntimeVisible) {
    houseLayer.visible = true;
    updateHouseHotReload(nowMs);
    snapPendingHouses();
    if (DEDICATED_TERRAIN_SHADOW_RECEIVERS && HOUSE_USE_SHADOW_MAP) {
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
    } else if (!USE_WEBGPU_RENDER_BACKEND) {
      updateHouseLocalShadows();
      houseShadowReceiverLayer.visible = false;
      houseShadowCasterLight.visible = false;
    } else {
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
    for (const entry of groundVehicleEntries) {
      entry.marker.scale.setScalar(markerScale * VEHICLE_MARKER_MAP_SCALE);
    }
    for (const entry of aircraftEntries) {
      entry.marker.scale.setScalar(markerScale * VEHICLE_MARKER_MAP_SCALE);
    }
    scene.fog = null;
    scene.background = _mapBg;
    renderBackend.renderMap(scene, mapCam);
    scene.background = null;
    scene.fog = renderBackend.isWebGPU ? null : _sceneFog;
    stopRenderLoopIfIdle();
    return;
  }
  // Procgen culling runs before renderScene(), but Three normally refreshes
  // camera.matrixWorldInverse inside renderScene().  Without this explicit
  // update the GPU cull saw the previous view while terrain rendered from the
  // current view.  When the demand-driven loop stopped after a drag, that
  // stale frustum persisted and grass/rocks popped on camera rotation.
  camera.updateMatrixWorld(true);
  updateNearFieldScatter();
  if (renderBackend.isWebGPU && renderer.backend?.isWebGPUBackend === true && greenlandPatch) {
    // The first response is a deliberately coarse preview. Building LAAS from
    // it permanently seeds the clipmap with parent-tile heights/classifiers,
    // even after the settled terrain pass installs finer coverage.
    const procgenTerrainReady = _loadPass === 2 && !fetching && Array.isArray(lastTiles);
    if (procgenTerrainReady && !greenlandPatch.ready && !greenlandPatch.building) {
      void greenlandPatch.build(renderer, camera, cameraAGL, traversalMotion());
    }
    greenlandPatch.update(renderer, camera, cameraAGL, traversalMotion());
  }
  if (renderBackend.isWebGPU && webgpuCloudShadows != null) {
    // Throttled internally; must run OUTSIDE the render (a compute submit
    // inside the frame corrupts other passes on r182).
    for (const node of webgpuCloudTextureNodes) {
      node.dispatch(renderer);
    }
    // ?bsmFreeze=1: cost-attribution diagnostic — materials keep sampling
    // the beer shadow map but its compute never re-marches.
    if (BOOT_QUERY.get('bsmFreeze') !== '1') {
      webgpuCloudShadows.update(renderer);
    }
  }
  updateTerrainShadowBudget();
  renderBackend.renderScene(scene, camera);
  stopRenderLoopIfIdle();
}

// --- Terrain shadow budget -------------------------------------------------
// Per-cascade caster selection needs NO radial cull here: terrain tiles keep
// frustumCulled=true with valid geometry bounding spheres, so each cascade's
// shadow render already frustum-culls tiles against its own sun-space ortho
// box (which CSMShadowNode extrudes sunward by lightMargin). A castShadow
// radius cap is global across cascades — it would also strip distant
// mountains out of the far cascade that the epipolar god rays march, so it
// is a profiling diagnostic only (?shadowRadialCull=1), never production.
// - Cascade refresh is invalidation-driven, not frame-staggered: three keeps
//   each cascade's depth map and its sampling matrix frozen TOGETHER while
//   needsUpdate is false (shadow.updateMatrices only runs inside
//   renderShadow), so a cached cascade never swims — it only lags coverage.
//   A cascade re-renders when its texel-snapped fit drifts ≥ N texels, the
//   sun moves past its angle threshold, tiles stream, the procgen patch
//   recenters, the vehicle (a scene CSM caster) moves, the projection
//   changes, or a slow wall-clock fallback expires. Frame counts are
//   meaningless at low FPS.
// BOOT_QUERY, not location.search: the boot code strips the query string
// from the URL via history.replaceState right after capturing it.
const SHADOW_RADIAL_CULL_DIAGNOSTIC = BOOT_QUERY.get('shadowRadialCull') === '1';
// A/B diagnostic: ?csmRefreshLegacy=1 selects the old frame-count stagger
// (near cascade every frame, cascade i every 2^i frames) instead of the
// invalidation policy. For measurement-protocol comparisons.
const CSM_LEGACY_STAGGER_DIAGNOSTIC = BOOT_QUERY.get('csmRefreshLegacy') === '1';
// Diagnostic: force all cascades to re-render every frame. NOT the default —
// r182 freezes a cascade's depth map and sampling matrix together while
// needsUpdate=false, so cached cascades lag coverage but never project stale
// depth through a fresh matrix (verified 2026-07-16, PERF_REWORK.md). The
// every-frame path was trialed 2026-07-20 against the dawn banding and did
// not remove it (the bands are epipolar god-ray artifacts, not stale CSM);
// it only added per-frame cascade re-fits (visible full-ground shimmer) and
// re-rendered 3×2048² maps every frame.
const CSM_SYNC_REFRESH_DIAGNOSTIC = BOOT_QUERY.get('csmSyncRefresh') === '1';
const SHADOW_CASTER_RADIUS_M = 20000;
const SHADOW_CULL_INTERVAL_FRAMES = 15;
let shadowBudgetFrame = 0;
const _shadowCasterScratch = new THREE.Vector3();

// Per-cascade thresholds. Drift is measured on the previous frame's fitted
// (texel-snapped) cascade light position — one frame stale, absorbed by the
// threshold. Sun thresholds: real-time sun moves ~0.25°/min, so 0.05° ≈ 12 s
// between near-cascade refreshes from sun motion alone.
// streamHoldMs: tile add/evict/replace marks cascades dirty, but the swap
// preserves the terrain surface (same ground, different tessellation or a
// textured twin), so depth barely changes — coalesce to one refresh per hold
// window instead of chasing the materialization trickle frame by frame.
const CSM_REFRESH_POLICY = [
  // The camera and controlled vehicle travel together. During traversal, a wider drift
  // window plus a 10 Hz vehicle-caster ceiling keeps the near CSM from becoming a mandatory
  // full shadow render on every animation frame. TAA/contact shadows cover the small lag.
  { driftTexels: 2, motionDriftTexels: 8, vehicleHoldMs: 100, sunRadians: 0.05 * THREE.MathUtils.DEG2RAD, streamHoldMs: 2000, fallbackMs: 5000 },    // 0–500 m
  { driftTexels: 2, motionDriftTexels: 4, vehicleHoldMs: 250, sunRadians: 0.10 * THREE.MathUtils.DEG2RAD, streamHoldMs: 5000, fallbackMs: 15000 },   // 0.5–8 km
  { driftTexels: 2, motionDriftTexels: 2, vehicleHoldMs: 500, sunRadians: 0.20 * THREE.MathUtils.DEG2RAD, streamHoldMs: 10000, fallbackMs: 30000 }   // 8–50 km
];
// Refresh budget: at most N cascade rasters per frame (init exempt — a
// never-rendered map is garbage, not merely stale). During flythrough all
// three cascades drift past threshold in the same frames; without a budget
// that's up to 12.6 M shadow texels in one frame. Frozen cascades never
// "swim" on r182 (depth map + sampling matrix freeze together), they only
// lag coverage, so deferring by a frame or two is visually safe. Deferred
// triggers stay sticky per cascade and re-compete next frame; priority is
// recenter/projection > drift > sun > vehicle > stream > fallback, near
// cascade first among equals. ?csmBudget=0 disables the cap (grant all) for
// A/B; ?csmBudget=N raises it.
const CSM_REFRESH_BUDGET = bootQueryNumber('csmBudget', 1);
const CSM_REASON_RANK = {
  init: 0, recenter: 1, projection: 1, drift: 2, sun: 3, vehicle: 4,
  stream: 5, fallback: 6
};
const _csmRefreshStats = { count: [0, 0, 0], reasons: {}, deferred: 0 };
let _csmStateOwner = null;   // csm node the state belongs to (reset on rebuild)
let _csmCascadeState = [];
let _csmSeenSceneVersion = -1;
let _csmSeenPatchCenter = null;
let _csmSeenFov = -1;
let _csmSeenAspect = -1;
const _csmSeenVehicleTransforms = new Map();
const _csmSunScratch = new THREE.Vector3();

function updateTerrainShadowBudget() {
  if (!renderBackend.isWebGPU) {
    return;
  }
  shadowBudgetFrame++;

  const csm = webgpuCsmShadowNode;
  const cascadeLights = csm?.lights;
  if (csm != null && cascadeLights != null && cascadeLights.length > 0) {
    if (CSM_SYNC_REFRESH_DIAGNOSTIC) {
      for (const lwLight of cascadeLights) {
        const shadow = lwLight.shadow;
        if (shadow == null) continue;
        shadow.autoUpdate = true;
        shadow.needsUpdate = true;
      }
      runShadowRadialCullDiagnostic();
      return;
    }
    if (CSM_LEGACY_STAGGER_DIAGNOSTIC) {
      for (let i = 0; i < cascadeLights.length; i++) {
        const shadow = cascadeLights[i].shadow;
        if (shadow == null) continue;
        shadow.autoUpdate = false;
        if ((shadowBudgetFrame & ((1 << i) - 1)) === 0) {
          shadow.needsUpdate = true;
        }
      }
      runShadowRadialCullDiagnostic();
      return;
    }
    if (_csmStateOwner !== csm) {
      _csmStateOwner = csm;
      _csmCascadeState = [];
      _csmRefreshStats.count = [0, 0, 0];
      _csmRefreshStats.reasons = {};
      _csmRefreshStats.deferred = 0;
      csm._refreshStats = _csmRefreshStats;
      // Baseline the change detectors NOW so the first policy frame doesn't
      // fire a spurious 'projection' event — that would call
      // updateFrustums() on a freshly initialized CSM for no reason.
      _csmSeenFov = camera.fov;
      _csmSeenAspect = camera.aspect;
      _csmSeenPatchCenter = greenlandPatch?.centerId ?? null;
      _csmSeenSceneVersion = shadowCasterVersion;
    }
    const nowMs = performance.now();

    // Global invalidation events. Caster streaming only marks cascades
    // dirty (consumed below under each cascade's streamHoldMs); recenter and
    // projection changes refresh immediately.
    let globalReason = null;
    let castersChanged = false;
    if (shadowCasterVersion !== _csmSeenSceneVersion) {
      _csmSeenSceneVersion = shadowCasterVersion;
      castersChanged = true;
    }
    const patchCenter = greenlandPatch?.centerId ?? null;
    if (patchCenter !== _csmSeenPatchCenter) {
      _csmSeenPatchCenter = patchCenter;
      globalReason = 'recenter';
    }
    if (camera.fov !== _csmSeenFov || camera.aspect !== _csmSeenAspect) {
      _csmSeenFov = camera.fov;
      _csmSeenAspect = camera.aspect;
      // Splits and cascade bounds derive from the projection; refit first.
      if (csm.camera != null) {
        csm.updateFrustums();
      }
      globalReason = 'projection';
    }

    // The vehicle casts into the scene CSM (its meshes are castShadow=true)
    // on top of its local shadow light; until that's separated its motion
    // dirties the near cascade.
    let vehicleMoved = false;
    for (const entry of vehicleRegistry.values()) {
      if (!entry.loaded) continue;
      let seen = _csmSeenVehicleTransforms.get(entry.id);
      if (seen == null) {
        seen = { position: new THREE.Vector3(Infinity, Infinity, Infinity), quaternion: new THREE.Quaternion() };
        _csmSeenVehicleTransforms.set(entry.id, seen);
      }
      if (seen.position.distanceToSquared(entry.group.position) > 0.05 * 0.05
        || seen.quaternion.angleTo(entry.group.quaternion) > 0.003) {
        seen.position.copy(entry.group.position);
        seen.quaternion.copy(entry.group.quaternion);
        vehicleMoved = true;
      }
    }

    const sunDir = _csmSunScratch
      .subVectors(csm.light.target.position, csm.light.position)
      .normalize();
    const traversalSpeedMps = traversalMotion().speedMps;
    const traversalActive = vehicleControlActive && traversalSpeedMps > 0.5;

    // Pass 1: collect refresh candidates. Triggers that are consumed by the
    // change detectors above (recenter/projection/vehicle) are latched into
    // sticky per-cascade flags so a deferred cascade re-competes next frame;
    // threshold triggers (drift/sun/stream/fallback) re-detect naturally
    // because state is only stamped on grant.
    const candidates = [];
    for (let i = 0; i < cascadeLights.length; i++) {
      const lwLight = cascadeLights[i];
      const shadow = lwLight.shadow;
      if (shadow == null) continue;
      shadow.autoUpdate = false;
      const policy = CSM_REFRESH_POLICY[Math.min(i, CSM_REFRESH_POLICY.length - 1)];
      let st = _csmCascadeState[i];
      if (st == null) {
        st = _csmCascadeState[i] = {
          fitPos: new THREE.Vector3(),
          sunDir: new THREE.Vector3(),
          lastMs: -Infinity,
          rendered: false,
          dirtyStream: false,
          dirtyGlobal: null,
          dirtyVehicle: false
        };
      }
      if (castersChanged) st.dirtyStream = true;
      if (globalReason != null && st.rendered) st.dirtyGlobal = globalReason;
      if (vehicleMoved && i === 0) st.dirtyVehicle = true;
      let reason = st.rendered ? st.dirtyGlobal : 'init';
      const shadowCam = shadow.camera;
      const texel = Number.isFinite(shadowCam.right) && Number.isFinite(shadowCam.left)
        ? (shadowCam.right - shadowCam.left) / shadow.mapSize.x
        : 0;
      const driftTexels = traversalActive
        ? policy.motionDriftTexels ?? policy.driftTexels
        : policy.driftTexels;
      if (reason == null && texel > 0 &&
          lwLight.position.distanceTo(st.fitPos) > driftTexels * texel) {
        reason = 'drift';
      }
      if (reason == null && sunDir.angleTo(st.sunDir) > policy.sunRadians) {
        reason = 'sun';
      }
      if (reason == null && st.dirtyVehicle
          && nowMs - st.lastMs >= (policy.vehicleHoldMs ?? 0)) {
        reason = 'vehicle';
      }
      if (reason == null && st.dirtyStream && nowMs - st.lastMs > policy.streamHoldMs) {
        reason = 'stream';
      }
      if (reason == null && nowMs - st.lastMs > policy.fallbackMs) {
        reason = 'fallback';
      }
      if (reason != null) {
        candidates.push({ i, st, shadow, light: lwLight, reason });
      }
    }

    // Pass 2: budgeted grants, most urgent first; among equals the STALEST
    // cascade wins (oldest lastMs), which round-robins naturally. Sorting by
    // cascade index here starved the far cascades during sustained flight —
    // the near cascade re-drifts every frame and won every grant, so the far
    // maps froze kilometers behind and projected stale shadow over everything
    // beyond the near range (seen live 2026-07-18 as a giant wrong shadow
    // band outside the LAAS patch).
    candidates.sort((a, b) =>
      (CSM_REASON_RANK[a.reason] ?? 9) - (CSM_REASON_RANK[b.reason] ?? 9) ||
      a.st.lastMs - b.st.lastMs
    );
    let granted = 0;
    for (const c of candidates) {
      const exempt = c.reason === 'init';
      if (!exempt && CSM_REFRESH_BUDGET > 0 && granted >= CSM_REFRESH_BUDGET) {
        _csmRefreshStats.deferred = (_csmRefreshStats.deferred ?? 0) + 1;
        continue;
      }
      if (!exempt) granted++;
      c.shadow.needsUpdate = true;
      c.st.rendered = true;
      c.st.dirtyStream = false;
      c.st.dirtyGlobal = null;
      c.st.dirtyVehicle = false;
      c.st.lastMs = nowMs;
      c.st.fitPos.copy(c.light.position);
      c.st.sunDir.copy(sunDir);
      _csmRefreshStats.count[c.i] = (_csmRefreshStats.count[c.i] ?? 0) + 1;
      _csmRefreshStats.reasons[c.reason] = (_csmRefreshStats.reasons[c.reason] ?? 0) + 1;
    }
  }

  runShadowRadialCullDiagnostic();
}

function runShadowRadialCullDiagnostic() {
  if (!SHADOW_RADIAL_CULL_DIAGNOSTIC) {
    return;
  }
  if (shadowBudgetFrame % SHADOW_CULL_INTERVAL_FRAMES !== 0) {
    return;
  }
  const radiusSq = SHADOW_CASTER_RADIUS_M * SHADOW_CASTER_RADIUS_M;
  scene.traverse(obj => {
    if (!obj.isMesh || obj.userData?.tileId == null) return;
    // Tile coordinates are baked into the geometry (mesh transform stays at
    // the terrain-root origin), so measure the bounding-sphere center in
    // world space — matrixWorld alone reports the same point for every tile.
    const geometry = obj.geometry;
    if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
    const distSq = _shadowCasterScratch
      .copy(geometry.boundingSphere.center)
      .applyMatrix4(obj.matrixWorld)
      .distanceToSquared(camera.position);
    obj.castShadow = distSq < radiusSq;
  });
}

streamingMaintenanceTimer = window.setInterval(runStreamingMaintenance, STREAMING_MAINTENANCE_MS);
startRenderLoop();
