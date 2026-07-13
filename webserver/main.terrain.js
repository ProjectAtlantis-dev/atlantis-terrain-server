// UX WIP scene: preserve baseline rendering, layer in map mode + movement + HUD.
import * as THREE from 'three';
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
import { Ellipsoid, Geodetic, radians } from '@takram/three-geospatial';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { buildAssetLibrary } from './procgen/library.ts';
import { buildTileScatter, disposeTileScatter, updateScatterVisibility, SCATTER_MIN_DEPTH } from './procgen/scatter.ts';
import { createTileLifecycle } from './terrain-tile-lifecycle.js';
import { createTerrainOceanClassifier } from './classifier/terrain-ocean.js';
import { priorityHeading, terrainTilePriority } from './terrain-priority.js';
import { compassHeading, createTerrainHud, renderGameClock, TERRAIN_HUD_LINKS } from './terrain-hud.js';
import { installTerrainKeyboardControls, installTerrainPointerControls } from './terrain-controls.js';
import { stepVehicleDrive } from './terrain-vehicle.js';
import { createTerrainVehicleRuntime } from './terrain-vehicle-runtime.js';
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
import { createTerrainHouseSceneRuntime } from './terrain-house-scene-runtime.js';
import { createTerrainTileMenuRuntime } from './terrain-tile-menu-runtime.js';
import { createWebGLTerrainBackend } from './render-backends/webgl-backend.js';

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

const renderBackend = createWebGLTerrainBackend({
  width: window.innerWidth,
  height: window.innerHeight,
  pixelRatio: window.devicePixelRatio,
  bootLog,
});
const renderer = renderBackend.renderer;
document.body.appendChild(renderer.domElement);
renderer.domElement.addEventListener('contextmenu', event => event.preventDefault());

const { hud, alt, gameClock: gameClockEl } = createTerrainHud({
  onToggleMapMode: () => toggleMapMode(),
  onClockAction: action => {
    if (action === 'rw') _gcRewind();
    else if (action === 'stop') _gcStop();
    else if (action === 'play') _gcPlay();
    else if (action === 'ff') _gcFfwd();
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

const tileMenuRuntime = createTerrainTileMenuRuntime({
  controls, tileInfoElement: tileInfoEl, getTerrainRoot: () => terrainRoot,
  getOceanEnabled: () => oceanMapDebugEnabled,
  toggleOcean: () => { oceanMapDebugEnabled = !oceanMapDebugEnabled; },
  getBathyEnabled: () => bathyFixDebugEnabled,
  toggleBathy: () => { bathyFixDebugEnabled = !bathyFixDebugEnabled; },
  refreshTextures: () => { if (lastTiles) updateTextures(lastTiles); },
  submitEnhancement: (tileId, options) => enhancementController.submit(tileId, options),
  getTextureStreamer: () => textureStreamer,
  onEnhancedDiscarded: streamer => { _lastEnhancedKey = ''; _texV = streamer.version; },
});
const showEnhanceDialog = tileMenuRuntime.showEnhance;
const showTileMenu = tileMenuRuntime.show;
const hideTileMenu = tileMenuRuntime.hide;

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

const seamStatusController = createTerrainSeamStatusController({});

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
const houseRuntime = createTerrainHouseSceneRuntime({
  structureDefinition: STRUCTURE_DEFINITION, startupAssetsResponse,
  scene, renderer, terrainRoot, controls, camera, mapCam, mouseNDC, raycaster,
  up, east, north, anchorLat, anchorLon, paramNumber, bootLog,
  getSunDirection: () => sunDirection,
});
houseRuntime.houseLayer.visible = houseRuntime.housesRuntimeVisible;

const vehicleRuntime = createTerrainVehicleRuntime({
  vehicleDefinition: VEHICLE_DEFINITION,
  vehicleHeadlights: VEHICLE_HEADLIGHTS,
  assetVehicleInstances: ASSET_VEHICLE_INSTANCES,
  startupAssetsResponse, houseSites: houseRuntime.houseSites,
  vehicleStateEndpoint: VEHICLE_STATE_ENDPOINT,
  vehicleSaveTimeoutMs: VEHICLE_SAVE_FETCH_TIMEOUT_MS,
  vehicleSaveFailureCooldownMs: VEHICLE_SAVE_FAILURE_COOLDOWN_MS,
  houseMarkerBaseLift: houseRuntime.HOUSE_MARKER_BASE_LIFT,
  houseMarkerHeight: houseRuntime.HOUSE_MARKER_HEIGHT,
  houseMarkerHaloGeo: houseRuntime.houseMarkerHaloGeo,
  houseMarkerDotGeo: houseRuntime.houseMarkerDotGeo,
  createHouseLabelSprite: houseRuntime.createHouseLabelSprite,
  mouseSensitivity: MOUSE_SENS,
  scene, camera, renderer, terrainRoot, controls, mouseNDC, raycaster,
  up, east, north, anchorLat, anchorLon,
  paramNumber, bootLog, enqueueClientLog,
  houseTerrainMeshes: houseRuntime.houseTerrainMeshes,
  houseLocalFromLatLon: houseRuntime.houseLocalFromLatLon,
  applyCameraOrientation, fetchTiles, getSunDirection: () => sunDirection,
});

const normalPass = renderBackend.createNormalPass(scene, camera);

const cloudsEffect = new CloudsEffect(camera, { resolutionScale: 1 });
const cloudsDefaults = configureTerrainClouds({
  effect: cloudsEffect,
  LocalWeather,
  CloudShape,
  CloudShapeDetail,
  Turbulence,
});

const aerialPerspective = new AerialPerspectiveEffect(camera);
// postprocessing >= 6.38 decodes logarithmic depth inside effect.frag's
// readDepth(), but the pinned three-geospatial checkout still runs its own
// reverseLogDepth() on the result. The double decode collapses reconstructed
// terrain positions, so cloud shadows/god rays project onto a standing
// curtain instead of lying flat on the ground. Strip the second decode.
aerialPerspective.setFragmentShader(
  aerialPerspective.getFragmentShader().replace(
    'depth = reverseLogDepth(depth, cameraNear, cameraFar);',
    ''
  )
);
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

renderBackend.configureScenePipeline({
  scene,
  camera,
  normalPass,
  cloudsEffect,
  aerialPerspective,
});

// --- Heightmap decode + mesh building (adapted for ENU frame) ---

let oceanMapDebugEnabled = false;
// WebGL-only map overlay for persisted server bathymetry corrections. This is
// debug UI state, not part of the shared ocean classifier.
let bathyFixDebugEnabled = false;
const bathyFixMaskCache = new Map();
const bathyFixInflight = new Set();
const bathyFixComposite = new Map();
const terrainOceanClassifier = createTerrainOceanClassifier({ THREE, paramNumber });
const buildMesh = createTerrainMeshBuilder({
  oceanClassifier: terrainOceanClassifier,
  exaggeration: EXAG,
  attachScatter: attachTileScatter,
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

function markMissing(missing, downloading) {
  applyTerrainAvailabilityStatus({
    terrainRoot, missing, downloading,
    applyStatus: (mesh, status) => {
      mesh.material.color.copy(status === 'downloading' ? COLOR_DOWNLOADING : COLOR_MISSING);
      mesh.material.vertexColors = false;
      mesh.material.needsUpdate = true;
    },
  });
}

// --- Deferred tile system ---
const deferredTiles = new Map();
const { history: tileHistory, log: tileLog } = createTileHistory({
  getPass: () => _loadPass,
  emit: details => enqueueClientLog('debug', 'tile', details),
});
tileLifecycle = createTileLifecycle({ terrainRoot, disposeScatter: disposeTileScatter, log: tileLog });

function requestBathyMask(tid) {
  if (bathyFixMaskCache.has(tid) || bathyFixInflight.has(tid)) return;
  bathyFixInflight.add(tid);
  fetch(`/api/bathyfix/${tid}.png`)
    .then(r => {
      if (r.status !== 200) {
        bathyFixInflight.delete(tid);
        bathyFixMaskCache.set(tid, null);
        return null;
      }
      return r.blob()
        .then(blob => createImageBitmap(blob))
        .then(img => {
          bathyFixInflight.delete(tid);
          bathyFixMaskCache.set(tid, img);
          if (bathyFixDebugEnabled && lastTiles) updateTextures(lastTiles);
        });
    })
    .catch(() => bathyFixInflight.delete(tid));
}

// Texture + magenta flatten-mask composite. Base texture bitmaps are
// flipY'd at load (row 0 = south); the mask PNG is row 0 = north, so it
// draws through a vertical flip.
function bathyCompositeTexture(baseTex, maskImg) {
  const w = baseTex.image.width, h = baseTex.image.height;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.drawImage(baseTex.image, 0, 0, w, h);
  ctx.save();
  ctx.translate(0, h);
  ctx.scale(1, -1);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(maskImg, 0, 0, w, h);
  ctx.restore();
  const t = new THREE.Texture(cv);
  t.flipY = false;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
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
  let useTex = tex;
  if (tex && bathyFixDebugEnabled && controls.mapMode) {
    const tid = mesh.userData.tileId;
    const mask = bathyFixMaskCache.get(tid);
    if (mask === undefined) {
      requestBathyMask(tid); // composite applied on next pass once loaded
    } else if (mask) {
      let comp = bathyFixComposite.get(tid);
      if (!comp || comp.baseUuid !== tex.uuid) {
        comp = { tex: bathyCompositeTexture(tex, mask), baseUuid: tex.uuid };
        bathyFixComposite.set(tid, comp);
      }
      useTex = comp.tex;
    }
  }
  let needsUpdate = false;
  if (useTex && mesh.material.map !== useTex) {
    mesh.material.map = useTex;
    needsUpdate = true;
  }
  if (mesh.material.vertexColors) {
    mesh.material.vertexColors = false;
    needsUpdate = true;
  }
  if (mesh.material.color.getHex() !== 0xffffff) {
    mesh.material.color.set(0xffffff);
  }
  if (needsUpdate) mesh.material.needsUpdate = true;
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
  vehicleNearTile: vehicleRuntime.vehicleNearTileBbox,
  getVehicleDepth: () => vehicleRuntime.vehicleLastContactDepth,
  requestVehicleResnap: vehicleRuntime.requestVehicleTerrainResnap,
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
    heading: priorityHeading(vehicleRuntime.vehicleControlActive, vehicleRuntime.vehicleHeadingRad, controls.yaw),
    pitch: controls.pitch,
    usePitch: !vehicleRuntime.vehicleControlActive,
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
const fpsCounter = createTerrainFpsCounter();

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
  getHeading: () => priorityHeading(vehicleRuntime.vehicleControlActive, vehicleRuntime.vehicleHeadingRad, controls.yaw),
  getRange: () => _terrainRange, getCameraLatLon, getCameraSnapshot: getCameraLogSnapshot,
  getCameraLocalPosition: () => {
    const relative = camera.position.clone().sub(anchorPosition);
    return { x: relative.dot(east), y: relative.dot(north) };
  },
  anchorLatitude: anchorLat, anchorLongitude: anchorLon, terrainRoot, deferredTiles,
  lifecycle: tileLifecycle, priorityForTile: tilePriority,
  textureCache: texCache,
  materialize: materializeTile, buildMesh, tileLog, applyMissing: markMissing, updateTextures,
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
  },
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
if (houseRuntime.HOUSE_MODEL.enabled && houseRuntime.housesRuntimeVisible) {
  bootLog('house.initial-load.start', {
    instanceCount: houseRuntime.houseInstances.length
  });
  houseRuntime.markHousesNeedSnap();
  houseRuntime.loadHouseModel('initial');
  houseRuntime.pollHouseModelSignature().then(sig => {
    houseRuntime.houseModelController.adoptSignature(sig);
  });
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
  bootEvents,
  getBootEvents: () => bootEvents.slice(),
  flushClientLogQueue: () => flushClientLogQueue(),
  fetchTiles,
  loadHouseModel: houseRuntime.loadHouseModel,
  setHousesVisible: visible => houseRuntime.setHousesRuntimeVisible(Boolean(visible), 'debug-api'),
  getHousesVisible: () => houseRuntime.housesRuntimeVisible,
  saveVehicleState: reason => vehicleRuntime.saveVehicleState(reason ?? 'debug-api'),
  loadVehicleState: vehicleRuntime.loadVehicleState,
  setVehicleControlActive: active => vehicleRuntime.setVehicleControlActive(Boolean(active), 'debug-api'),
  getVehicleControlActive: () => vehicleRuntime.vehicleControlActive,
  houseInstances: houseRuntime.houseInstances,
  houseZSummary: houseRuntime.houseZSummary,
  houseShadowDebugSummary: houseRuntime.houseShadowDebugSummary,
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
  const terrainMeshes = houseRuntime.houseTerrainMeshes();
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
  const headingForHud = vehicleRuntime.vehicleControlActive ? vehicleRuntime.vehicleHeadingRad : controls.yaw;
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
    : (vehicleRuntime.vehicleControlActive ? 'VEHICLE' : 'FLIGHT');
  const modeHtml = vehicleRuntime.vehicleControlActive
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
    vehicleRuntime.vehicleControlActive
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
    (controls.mapMode ? '  [MAP]' : (vehicleRuntime.vehicleControlActive ? '  [VEHICLE]' : ''));
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
  vehicleRuntime.setVehicleControlActive(false, 'reset');
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
  houseRuntime.markHousesNeedSnap();
  fetchTiles();
}

let driftMode = false;

function toggleMapMode() {
  controls.mapMode = !controls.mapMode;
  driftMode = false;
  controls.strafeSpeed = 0;
  if (controls.mapMode) {
    vehicleRuntime.setVehicleControlActive(false, 'map-mode');
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
  isVehicleActive: () => vehicleRuntime.vehicleControlActive,
  onForwardDoubleTap: () => {
    driftMode = !driftMode;
    console.log(`[drift] ${driftMode ? 'ON' : 'OFF'}`);
  },
  onEscapeVehicle: () => {
    vehicleRuntime.saveVehicleState('escape', { snapToGround: true, requireGroundedZ: false, bypassSnapThrottle: true });
    vehicleRuntime.setVehicleControlActive(false, 'escape', { skipExitSave: true });
  },
  onToggleMap: toggleMapMode,
  onOpenPipeline: () => window.open(HUD_LINKS.pipelineMapLink, '_blank'),
  onOpenHeatmap: () => window.open(HUD_LINKS.radarHeatmapLink, '_blank'),
  onReset: resetView,
  onHouseAction: load => load
    ? houseRuntime.loadHouseModel('keyboard')
    : houseRuntime.setHousesRuntimeVisible(!houseRuntime.housesRuntimeVisible, 'keyboard'),
  onToggleHeadlights: () => {
    for (const light of vehicleRuntime.vehicleHeadlightSpots) light.visible = !light.visible;
  },
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
    housesVisible: houseRuntime.housesRuntimeVisible,
  });
  enqueueClientLog('info', 'click.test', {
    x: event.clientX,
    y: event.clientY,
    mapMode: controls.mapMode,
    shadowMode: houseRuntime.HOUSE_SHADOW_MODE,
    housesVisible: houseRuntime.housesRuntimeVisible,
  });
  flushClientLogQueue();
  try {
    houseRuntime.probeHouseShadowIntersections(event);
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
    vehicleRuntime.tryEnterVehicleControlFromPointer(event);
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
    } else if (vehicleRuntime.vehicleControlActive) {
      const scale = zoomIn ? 0.9 : 1.1;
      vehicleRuntime.VEHICLE_CAMERA_FOLLOW_DISTANCE = Math.max(8, Math.min(200, vehicleRuntime.VEHICLE_CAMERA_FOLLOW_DISTANCE * scale));
      vehicleRuntime.VEHICLE_CAMERA_FOLLOW_HEIGHT = Math.max(2, Math.min(80, vehicleRuntime.VEHICLE_CAMERA_FOLLOW_HEIGHT * scale));
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
  renderBackend.resize(window.innerWidth, window.innerHeight);
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
  fpsCounter.frame(nowMs);
  if (useRealtimeGameClock) {
    currentDate.setTime(getGameDateFromBrowserTime().getTime());
  }
  applyDate(currentDate);
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
  // Periodic texture refresh (~1 Hz)
  if (lastTiles && clock.elapsedTime - lastTexRefresh > 1.0) {
    lastTexRefresh = clock.elapsedTime;
    updateTextures(lastTiles);
    updateEnhancement();
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
  if (houseRuntime.housesRuntimeVisible) {
    houseRuntime.houseLayer.visible = true;
    houseRuntime.updateHouseHotReload(nowMs);
    houseRuntime.snapPendingHouses();
    if (houseRuntime.HOUSE_USE_SHADOW_MAP) {
      houseRuntime.syncHouseShadowReceivers();
      houseRuntime.updateHouseShadowSystem();
      renderer.shadowMap.autoUpdate = true;
      if (
        !houseRuntime.shadowMapReadyLogged &&
        houseRuntime.houseShadowCasterLight.visible &&
        houseRuntime.houseShadowCasterLight.shadow.map != null
      ) {
        houseRuntime.shadowMapReadyLogged = true;
        bootLog('house.shadow.map.ready', {
          width: houseRuntime.houseShadowCasterLight.shadow.map.width,
          height: houseRuntime.houseShadowCasterLight.shadow.map.height,
          receiverCount: houseRuntime.houseShadowReceivers.size
        });
      }
    } else {
      houseRuntime.updateHouseLocalShadows();
      houseRuntime.houseShadowReceiverLayer.visible = false;
      houseRuntime.houseShadowCasterLight.visible = false;
    }
    houseRuntime.maybeLogHouseShadowSnapshot(nowMs);
  } else {
    houseRuntime.houseLayer.visible = false;
    houseRuntime.houseMarkerLayer.visible = false;
    houseRuntime.houseShadowReceiverLayer.visible = false;
    houseRuntime.houseShadowCasterLight.visible = false;
  }
  houseRuntime.houseMarkerLayer.visible = controls.mapMode && houseRuntime.housesRuntimeVisible;
  vehicleRuntime.vehicleMarkerLayer.visible = controls.mapMode;
  enhanceOutlines.visible = controls.mapMode;
  enhancedOutlines.visible = controls.mapMode;
  if (controls.mapMode) {
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
    for (const house of houseRuntime.houseInstances) {
      house.marker.scale.setScalar(markerScale);
    }
    vehicleRuntime.vehicleMarker.scale.setScalar(markerScale * vehicleRuntime.VEHICLE_MARKER_MAP_SCALE);
    scene.fog = null;
    scene.background = _mapBg;
    renderBackend.renderMap(scene, mapCam);
    scene.background = null;
    scene.fog = _sceneFog;
    return;
  }
  if (SCATTER_ENABLED && _scatterLib) updateScatterVisibility(terrainRoot, camera);
  renderBackend.renderScene(scene, camera);
}

renderBackend.setAnimationLoop(render);
