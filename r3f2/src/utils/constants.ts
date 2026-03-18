import * as THREE from 'three';
import type { CameraMode } from '@/types/vehicle';

// ── URL Parameters ───────────────────────────────────────────────────────
const params = new URLSearchParams(window.location.search);

export function paramNumber(name: string, fallback: number): number {
  const raw = params.get(name);
  if (raw == null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function paramString(name: string, fallback: string): string {
  return params.get(name) ?? fallback;
}

// ── Asset Server ─────────────────────────────────────────────────────────
const DEFAULT_ASSET_SERVER_BASE = 'http://127.0.0.1:8787';
export const ASSET_SERVER_BASE = (() => {
  const raw = params.get('assetServer');
  const text = typeof raw === 'string' ? raw.trim() : '';
  const base = text || DEFAULT_ASSET_SERVER_BASE;
  return base.replace(/\/+$/, '');
})();
export const VEHICLE_STATE_ENDPOINT = `${ASSET_SERVER_BASE}/api/vehicle_state`;
export const ASSETS_ENDPOINT = `${ASSET_SERVER_BASE}/api/assets`;
export const ASSETS_FETCH_TIMEOUT_MS = 1500;
export const VEHICLE_SAVE_FETCH_TIMEOUT_MS = 1500;
export const VEHICLE_SAVE_FAILURE_COOLDOWN_MS = 15000;

// ── Default Location ─────────────────────────────────────────────────────
export const DEFAULT_LOCATION = {
  lat: Number(params.get('lat') ?? 64.1835),
  lon: Number(params.get('lon') ?? -51.7216),
};

// ── Scene ────────────────────────────────────────────────────────────────
export const MAX_VIEW_DIST = 50000;
export const MAP_CAM_ALT = MAX_VIEW_DIST;
export const DEFAULT_MAP_ZOOM = 20000;
export const EXAG = 1.0;

// ── Game Clock ───────────────────────────────────────────────────────────
export const REFERENCE_DATE = new Date('2025-07-01T12:00:00Z');
export const GAME_HOURS_PER_REAL_HOUR = 24;
export const GAME_TIME_SCALE = GAME_HOURS_PER_REAL_HOUR;
export const GAME_CLOCK_STORAGE_KEY = 'game-clock-ms';

// ── Camera Movement ──────────────────────────────────────────────────────
export const BASE_ACCEL = 1200;
export const BASE_BRAKE = 800;
export const BASE_MAX_SPEED = 5000;
export const BASE_STRAFE_SPEED = 800;
export const TURN_SPEED = 1.5;
export const MIN_FLIGHT_ALT = paramNumber('minFlightAlt', 2);
export const AGL_FULL_SPEED_M = 500;
export const AGL_MIN_FACTOR = 0.05;
export const MOUSE_SENS = 0.003;
export const MAP_PAN_FACTOR = 1.2;

// ── Vehicle Physics ──────────────────────────────────────────────────────
export const VEHICLE_DRIVE_SPEED = paramNumber('vehicleDriveSpeed', 24);
export const VEHICLE_ACCEL = paramNumber('vehicleAccel', 24);
export const VEHICLE_BRAKE = paramNumber('vehicleBrake', 3);
export const VEHICLE_STEER_SPEED = paramNumber('vehicleSteerSpeed', 1.5);

export const VEHICLE_CAM_MODES: CameraMode[] = [
  { name: 'CLOSE', dist: 15, height: 5 },
  { name: 'MEDIUM', dist: 25, height: 8 },
  { name: 'FAR', dist: 38, height: 12 },
];
export const VEHICLE_CAMERA_LOOK_HEIGHT = paramNumber('vehicleCamLookHeight', 2.2);
export const VEHICLE_CAMERA_ORBIT_SENS = paramNumber('vehicleCamOrbitSens', MOUSE_SENS);
export const VEHICLE_CAMERA_ORBIT_PITCH_MIN = THREE.MathUtils.degToRad(
  paramNumber('vehicleCamPitchMinDeg', -20)
);
export const VEHICLE_CAMERA_ORBIT_PITCH_MAX = THREE.MathUtils.degToRad(
  paramNumber('vehicleCamPitchMaxDeg', 70)
);

// ── Vehicle Terrain Snap ─────────────────────────────────────────────────
export const VEHICLE_SNAP_IDLE_MS = Math.max(250, paramNumber('vehicleSnapIdleMs', 1000));
export const VEHICLE_SNAP_PENDING_MS = Math.max(50, paramNumber('vehicleSnapPendingMs', 120));
export const VEHICLE_RESTORE_MIN_DEPTH = Math.max(
  0,
  Math.floor(paramNumber('vehicleRestoreMinDepth', 12))
);

// ── Vehicle Suspension ───────────────────────────────────────────────────
export const VEHICLE_SUSPENSION_HZ = Math.max(0.1, paramNumber('vehicleSuspensionHz', 1.8));
export const VEHICLE_SUSPENSION_DAMPING_RATIO = Math.max(
  0.1,
  paramNumber('vehicleSuspensionDampingRatio', 0.72)
);
export const VEHICLE_SUSPENSION_MAX_VEL = Math.max(
  1,
  paramNumber('vehicleSuspensionMaxVel', 12)
);
export const VEHICLE_REFINEMENT_BOUNCE = THREE.MathUtils.clamp(
  paramNumber('vehicleRefinementBounce', 0.35),
  0,
  2
);
export const VEHICLE_RESNAP_MARGIN_M = Math.max(3, paramNumber('vehicleResnapMarginM', 14));
export const VEHICLE_ORIENTATION_RESPONSE = Math.max(
  1,
  paramNumber('vehicleOrientationResponse', 10)
);
export const VEHICLE_SLOPE_PROBE_LENGTH_SCALE = THREE.MathUtils.clamp(
  paramNumber('vehicleSlopeProbeLengthScale', 0.34),
  0.1,
  0.55
);
export const VEHICLE_SLOPE_PROBE_WIDTH_SCALE = THREE.MathUtils.clamp(
  paramNumber('vehicleSlopeProbeWidthScale', 0.45),
  0.2,
  0.7
);

// ── Vehicle Textures ─────────────────────────────────────────────────────
export const VEHICLE_TEXTURE_ANISOTROPY = Math.max(
  1,
  Math.floor(paramNumber('vehicleTextureAnisotropy', 8))
);

// ── Turret & Fire ────────────────────────────────────────────────────────
export const TURRET_PITCH_MIN = THREE.MathUtils.degToRad(-10);
export const TURRET_PITCH_MAX = THREE.MathUtils.degToRad(45);
export const TURRET_MOUSE_SENS = 0.003;
export const FIRE_INTERVAL = 1 / 10; // 600 RPM = 10 rounds/sec
export const TRACER_SPEED = 900; // m/s
export const TRACER_MAX_RANGE = 1500; // m
export const MAX_TRACERS = 10;
export const MAX_IMPACTS = 5;
export const TURRET_CAM_BEHIND = 8;
export const TURRET_CAM_ABOVE = 3;

// ── Vehicle Shadows ──────────────────────────────────────────────────────
export const VEHICLE_SHADOW_MAP_SIZE = 1024;
export const VEHICLE_SHADOW_LIGHT_DISTANCE = 250;
export const VEHICLE_SHADOW_MIN_RADIUS = 60;
export const VEHICLE_SHADOW_MAX_RADIUS = 180;
export const VEHICLE_SHADOW_TEXEL_SNAP = params.get('vehicleShadowTexelSnap') !== '0';
export const VEHICLE_SHADOW_GROUND_ANCHOR = THREE.MathUtils.clamp(
  paramNumber('vehicleShadowGroundAnchor', 1.0),
  0,
  1
);
export const VEHICLE_SHADOW_OPACITY = THREE.MathUtils.clamp(
  paramNumber('vehicleShadowOpacity', 0.95),
  0,
  1
);

// ── Vehicle Markers ──────────────────────────────────────────────────────
export const VEHICLE_MARKER_MAP_SCALE = THREE.MathUtils.clamp(
  paramNumber('vehicleMarkerMapScale', 1.0),
  0.02,
  2
);

// ── House System ─────────────────────────────────────────────────────────
export const HOUSE_SHADOW_MODE = paramString('houseShadowMode', 'shadowmap') as
  | 'shadowmap'
  | 'local';
export const HOUSE_USE_SHADOW_MAP = HOUSE_SHADOW_MODE === 'shadowmap';
export const HOUSE_SHADOW_MAP_SIZE = 2048;
export const HOUSE_SHADOW_OPACITY = THREE.MathUtils.clamp(
  paramNumber('houseShadowOpacity', 0.78),
  0,
  1
);
export const HOUSE_MARKER_HEIGHT = 5000;
export const HOUSE_MARKER_BASE_LIFT = 5;

// ── Terrain Streaming ────────────────────────────────────────────────────
export const REFETCH_DIST = 5000;
export const PREVIEW_MAX_DEPTH = 10;
export const MESH_BUILD_BUDGET = 200;
export const TEX_MAX = 120;

// ── Client Logging ───────────────────────────────────────────────────────
export const CLIENT_LOG_ENDPOINT = '/api/client_log';
export const CLIENT_LOG_ENABLED = params.get('clientLog') !== '0';
export const CLIENT_LOG_BATCH_SIZE = 40;
export const CLIENT_LOG_MAX_QUEUE = 600;
export const CLIENT_LOG_FLUSH_MS = 800;

// ── Vehicle Save ─────────────────────────────────────────────────────────
export const VEHICLE_SAVE_THROTTLE_MS = 5000;
export const VEHICLE_SAVE_TRAILING_MS = 2000;

// ── Water ────────────────────────────────────────────────────────────────
export const WATER_EXTENT = 200_000;

// ── Atmosphere ───────────────────────────────────────────────────────────
export const ATMOSPHERE_CACHE_NAME = 'takram-atmosphere-exr-v1';
export const ATMOSPHERE_TEXTURE_FILES = [
  'transmittance.exr',
  'scattering.exr',
  'irradiance.exr',
  'higher_order_scattering.exr',
];

// ── Logging Style ────────────────────────────────────────────────────────
export const VEHICLE_LOG_STYLE = 'color:#ffbf00;font-weight:600;';
