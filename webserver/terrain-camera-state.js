const METRES_PER_DEGREE = 111320;

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

export function terrainCameraState({
  cameraLatLon,
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
    eastM: (saved.lon - anchorLon) * METRES_PER_DEGREE
      * Math.cos(anchorLat * Math.PI / 180),
    northM: (saved.lat - anchorLat) * METRES_PER_DEGREE,
    alt: Number.isFinite(saved.alt) ? saved.alt : defaultAlt,
    yaw: finiteOrNull(saved.yaw),
    pitch: finiteOrNull(saved.pitch),
    mapZoom: finiteOrNull(saved.mapZoom),
    terrainFrame,
  };
}
