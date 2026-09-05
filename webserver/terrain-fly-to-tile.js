import { epsg3413ToWgs84, wgs84ToEpsg3413 } from './terrain-polar-stereo.js';
import { approximateLatLonToLocalMeters } from './terrain-local-coordinates.js';
import {
  parseTerrainTileId,
  terrainTileBbox,
} from './terrain-tile-address.js';

export {
  TILE_GRID_ROOT_BBOX,
  parseTerrainTileId as parseTileId,
  terrainTileBbox as tileBbox,
} from './terrain-tile-address.js';

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
const LOCATION_VIEW_ALT_M = 1200;
const LOCATION_MAP_SIZE_M = 8000;

/** Ortho half-height at which the tile roughly fills the map view. */
export function tileMapZoom(sizeM) {
  const halfHeight = (sizeM * VIEW_FIT_MARGIN) / 2;
  return Math.min(Math.max(halfHeight, MIN_MAP_ZOOM), MAX_MAP_ZOOM);
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
  const local = approximateLatLonToLocalMeters({
    lat,
    lon,
    anchorLat,
    anchorLon,
  });
  return {
    eastM: local.eastM,
    northM: local.northM,
    sizeM,
    usedFrame: false,
  };
}

export function flyToLocationScenePosition({
  lat, lon, frame, anchorLat, anchorLon, toGrid = wgs84ToEpsg3413,
}) {
  if (frame?.frameOffsetReady) {
    const { x, y } = toGrid(lat, lon);
    return {
      eastM: x - frame.originX + frame.frameOffsetX,
      northM: y - frame.originY + frame.frameOffsetY,
      usedFrame: true,
    };
  }
  return {
    ...approximateLatLonToLocalMeters({ lat, lon, anchorLat, anchorLon }),
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
    // This is a teleport in ASL space; any AGL measured at the old location
    // is invalid until the new terrain is raycast.
    cameraRuntimeState.aglValid = false;
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
    const parsed = parseTerrainTileId(tileId);
    if (!parsed) {
      console.warn(`[fly-to-tile] bad tile id: ${tileId}`);
      return { ok: false, error: `bad tile id: ${tileId}` };
    }
    generation += 1;
    if (pollTimer != null) {
      cancel(pollTimer);
      pollTimer = null;
    }
    const bbox = terrainTileBbox(parsed);
    const target = flyToTileScenePosition({
      bbox, frame: pipelineState, anchorLat, anchorLon,
    });
    const viewAlt = tileViewAltitude(target.sizeM, camera.fov);
    exitVehicle();
    cameraRuntimeState.driftMode = false;
    cameraRuntimeState.forwardLockCoasting = false;
    controls.speed = 0;
    controls.strafeSpeed = 0;
    controls.verticalSpeed = 0;
    controls.bank = 0;
    controls.bankVelocity = 0;
    controls.forwardLockThrottle = 0;
    controls.lookYawOffset = 0;
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

  function flyToLocation({ lat, lon, label = null } = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
        lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return { ok: false, error: 'invalid location coordinates' };
    }
    generation += 1;
    if (pollTimer != null) {
      cancel(pollTimer);
      pollTimer = null;
    }
    const target = flyToLocationScenePosition({
      lat, lon, frame: pipelineState, anchorLat, anchorLon,
    });
    exitVehicle();
    cameraRuntimeState.driftMode = false;
    cameraRuntimeState.forwardLockCoasting = false;
    controls.speed = 0;
    controls.strafeSpeed = 0;
    controls.verticalSpeed = 0;
    controls.bank = 0;
    controls.bankVelocity = 0;
    controls.forwardLockThrottle = 0;
    controls.lookYawOffset = 0;
    controls.yaw = 0;
    controls.pitch = TOP_DOWN_PITCH_RAD;
    placeCamera(target.eastM, target.northM, LOCATION_VIEW_ALT_M);
    applyCameraOrientation();
    if (controls.mapMode) {
      controls.mapPanEast = 0;
      controls.mapPanNorth = 0;
      controls.mapZoom = tileMapZoom(LOCATION_MAP_SIZE_M);
      updateMapCamera();
    }
    enqueueLog('info', 'flyToLocation', {
      label, lat, lon, usedFrame: target.usedFrame,
      eastM: Number(target.eastM.toFixed(1)),
      northM: Number(target.northM.toFixed(1)),
      viewAltM: LOCATION_VIEW_ALT_M,
    });
    requestFetch();
    requestRender();
    const pollState = {
      generation,
      eastM: target.eastM,
      northM: target.northM,
      viewAlt: LOCATION_VIEW_ALT_M,
      expected: camera.position.clone(),
      deadline: now() + GROUND_POLL_TIMEOUT_MS,
    };
    pollTimer = schedule(() => pollGroundCorrection(pollState), GROUND_POLL_MS);
    return { ok: true, lat, lon, label, viewAlt: LOCATION_VIEW_ALT_M };
  }

  return { flyToTile, flyToLocation };
}
