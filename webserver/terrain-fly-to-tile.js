import { epsg3413ToWgs84 } from './terrain-polar-stereo.js';

const METRES_PER_DEGREE = 111320;

// Mirrors GREENLAND_BBOX in flaskserver/tiles.py — the canonical EPSG:3413
// root square every DB tile row is derived from.
export const TILE_GRID_ROOT_BBOX = Object.freeze([
  -1239041.5, -3346077.5, 1460958.5, -646077.5,
]);

const MAX_CAMERA_ALT_M = 6000; // matches the clampAltitude ceiling
const MIN_VIEW_ALT_M = 250;
const VIEW_FIT_MARGIN = 1.3;
const TOP_DOWN_PITCH_RAD = -1.4; // steepest pitch the mouse-look clamp allows
const GROUND_POLL_MS = 500;
const GROUND_POLL_TIMEOUT_MS = 30000;
const GROUND_RAY_START_ALT_M = 9000;
const USER_MOVE_EPSILON_M = 4;
const MIN_MAP_ZOOM = 500;   // matches the map-mode wheel clamp
const MAX_MAP_ZOOM = 40000;

/** Ortho half-height at which the tile roughly fills the map view. */
export function tileMapZoom(sizeM) {
  const halfHeight = (sizeM * VIEW_FIT_MARGIN) / 2;
  return Math.min(Math.max(halfHeight, MIN_MAP_ZOOM), MAX_MAP_ZOOM);
}

export function parseTileId(tileId) {
  if (typeof tileId !== 'string') return null;
  const match = tileId.trim().match(/^(\d+)-(\d+)-(\d+)$/);
  if (!match) return null;
  const depth = Number(match[1]);
  const col = Number(match[2]);
  const row = Number(match[3]);
  if (depth > 30) return null;
  const tilesPerAxis = 2 ** depth;
  if (col >= tilesPerAxis || row >= tilesPerAxis) return null;
  return { depth, col, row, id: `${depth}-${col}-${row}` };
}

export function tileBbox({ depth, col, row }, rootBbox = TILE_GRID_ROOT_BBOX) {
  const tilesPerAxis = 2 ** depth;
  const width = (rootBbox[2] - rootBbox[0]) / tilesPerAxis;
  const height = (rootBbox[3] - rootBbox[1]) / tilesPerAxis;
  const xMin = rootBbox[0] + col * width;
  const yMin = rootBbox[1] + row * height;
  return [xMin, yMin, xMin + width, yMin + height];
}

/**
 * Scene-local ENU position of a tile center. When the terrain frame is
 * established, invert terrainCameraGridPosition so the camera lands exactly
 * where the tile mesh is placed (bbox − origin + frameOffset). Before the
 * first fetch, fall back to the same linear lat/lon mapping the fetch
 * runtime uses, so the server adopts an origin right at the tile.
 */
export function flyToTileScenePosition({
  bbox, frame, anchorLat, anchorLon, toWgs84 = epsg3413ToWgs84,
}) {
  const centerX = (bbox[0] + bbox[2]) / 2;
  const centerY = (bbox[1] + bbox[3]) / 2;
  const sizeM = bbox[2] - bbox[0];
  if (frame?.frameOffsetReady) {
    return {
      eastM: centerX - frame.originX + frame.frameOffsetX,
      northM: centerY - frame.originY + frame.frameOffsetY,
      sizeM,
      usedFrame: true,
    };
  }
  const { lat, lon } = toWgs84(centerX, centerY);
  return {
    eastM: (lon - anchorLon) * METRES_PER_DEGREE * Math.cos(anchorLat * Math.PI / 180),
    northM: (lat - anchorLat) * METRES_PER_DEGREE,
    sizeM,
    usedFrame: false,
  };
}

/** Altitude above ground at which the tile roughly fills the view. */
export function tileViewAltitude(sizeM, fovDeg) {
  const halfFovRad = (fovDeg * Math.PI / 180) / 2;
  const fitAltitude = (sizeM * VIEW_FIT_MARGIN) / (2 * Math.tan(halfFovRad));
  return Math.min(Math.max(fitAltitude, MIN_VIEW_ALT_M), MAX_CAMERA_ALT_M - 500);
}

export function createTerrainFlyToTileRuntime({
  camera,
  anchorPosition,
  east, north, up,
  controls,
  cameraRuntimeState,
  pipelineState,
  anchorLat, anchorLon,
  exitVehicle = () => {},
  applyCameraOrientation = () => {},
  requestFetch = () => {},
  requestRender = () => {},
  updateMapCamera = () => {},
  raycastGroundAltitude = () => null,
  enqueueLog = () => {},
  schedule = (callback, delayMs) => setTimeout(callback, delayMs),
  cancel = timer => clearTimeout(timer),
  now = () => Date.now(),
}) {
  let generation = 0;
  let pollTimer = null;

  function cameraAltitude() {
    return camera.position.clone().sub(anchorPosition).dot(up);
  }

  function placeCamera(eastM, northM, altM) {
    camera.position.copy(anchorPosition)
      .addScaledVector(east, eastM)
      .addScaledVector(north, northM)
      .addScaledVector(up, altM);
    cameraRuntimeState.lastGoodPosition.copy(camera.position);
  }

  // The tile's ground elevation is unknown until its heightmap streams in
  // (over the ice sheet the surface sits well above the initial sea-level
  // guess). Poll until terrain appears under the tile center, then lift the
  // camera to viewAlt above it — unless the user has flown away meanwhile.
  function pollGroundCorrection(pollState) {
    pollTimer = null;
    if (pollState.generation !== generation) return;
    if (camera.position.distanceToSquared(pollState.expected) > USER_MOVE_EPSILON_M ** 2) return;
    const groundAlt = raycastGroundAltitude(pollState.eastM, pollState.northM, GROUND_RAY_START_ALT_M);
    if (Number.isFinite(groundAlt)) {
      const targetAlt = Math.min(groundAlt + pollState.viewAlt, MAX_CAMERA_ALT_M);
      if (Math.abs(targetAlt - cameraAltitude()) > 1) {
        placeCamera(pollState.eastM, pollState.northM, targetAlt);
        pollState.expected = camera.position.clone();
        requestRender();
      }
      return;
    }
    if (now() < pollState.deadline) {
      pollTimer = schedule(() => pollGroundCorrection(pollState), GROUND_POLL_MS);
    }
  }

  function flyToTile(tileId) {
    const parsed = parseTileId(tileId);
    if (!parsed) {
      console.warn(`[fly-to-tile] bad tile id: ${tileId}`);
      return { ok: false, error: `bad tile id: ${tileId}` };
    }
    generation += 1;
    if (pollTimer != null) {
      cancel(pollTimer);
      pollTimer = null;
    }
    const bbox = tileBbox(parsed);
    const target = flyToTileScenePosition({
      bbox, frame: pipelineState, anchorLat, anchorLon,
    });
    const viewAlt = tileViewAltitude(target.sizeM, camera.fov);
    exitVehicle();
    cameraRuntimeState.driftMode = false;
    controls.speed = 0;
    controls.strafeSpeed = 0;
    controls.yaw = 0; // north up, like the tile inspector
    controls.pitch = TOP_DOWN_PITCH_RAD;
    placeCamera(target.eastM, target.northM, viewAlt);
    applyCameraOrientation();
    if (controls.mapMode) {
      // Drop any right-click pan so the map recenters on the tile, and zoom
      // to frame it — the ortho view ignores camera altitude.
      controls.mapPanEast = 0;
      controls.mapPanNorth = 0;
      controls.mapZoom = tileMapZoom(target.sizeM);
      updateMapCamera();
    }
    enqueueLog('info', 'flyToTile', {
      tileId: parsed.id,
      usedFrame: target.usedFrame,
      eastM: Number(target.eastM.toFixed(1)),
      northM: Number(target.northM.toFixed(1)),
      viewAltM: Number(viewAlt.toFixed(1)),
    });
    requestFetch();
    requestRender();
    const pollState = {
      generation,
      eastM: target.eastM,
      northM: target.northM,
      viewAlt,
      expected: camera.position.clone(),
      deadline: now() + GROUND_POLL_TIMEOUT_MS,
    };
    pollTimer = schedule(() => pollGroundCorrection(pollState), GROUND_POLL_MS);
    return { ok: true, tileId: parsed.id, bbox, viewAlt };
  }

  return { flyToTile };
}
