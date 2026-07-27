import { approximateLatLonToLocalMeters } from './terrain-local-coordinates.js';

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

export function terrainCameraState({
  cameraLatLon,
  cameraGrid = null,
  yaw,
  pitch,
  mapZoom,
  terrainFrame = null,
}) {
  const state = {
    lat: cameraLatLon.lat,
    lon: cameraLatLon.lon,
    alt: cameraLatLon.alt,
    yaw,
    pitch,
    mapZoom,
  };
  if (terrainFrame) {
    state.terrainFrame = { ...terrainFrame };
  }
  if (Number.isFinite(cameraGrid?.x) && Number.isFinite(cameraGrid?.y)) {
    state.gridX = cameraGrid.x;
    state.gridY = cameraGrid.y;
  }
  return state;
}

export function restoreTerrainCameraState(saved, { anchorLat, anchorLon, defaultAlt = 700 }) {
  if (!saved || !Number.isFinite(saved.lat) || !Number.isFinite(saved.lon)) {
    return null;
  }

  const frame = saved.terrainFrame;
  const terrainFrame = frame
    && Number.isFinite(frame.originX)
    && Number.isFinite(frame.originY)
    && Number.isFinite(frame.offsetX)
    && Number.isFinite(frame.offsetY)
    ? {
        originX: frame.originX,
        originY: frame.originY,
        offsetX: frame.offsetX,
        offsetY: frame.offsetY,
      }
    : null;

  return {
    ...approximateLatLonToLocalMeters({
      lat: saved.lat,
      lon: saved.lon,
      anchorLat,
      anchorLon,
    }),
    alt: Number.isFinite(saved.alt) ? saved.alt : defaultAlt,
    yaw: finiteOrNull(saved.yaw),
    pitch: finiteOrNull(saved.pitch),
    mapZoom: finiteOrNull(saved.mapZoom),
    terrainFrame,
  };
}
