export function buildTerrainTilesRequest({
  lat,
  lon,
  altitude,
  heading,
  range,
  isFirstLoad,
  frameOffsetReady,
  originX,
  originY,
  queryX,
  queryY,
  cameraSnapshot = {},
}) {
  const hasGridPosition = Number.isFinite(queryX) && Number.isFinite(queryY);
  const positionQuery = hasGridPosition
    ? `sx=${queryX}&sy=${queryY}`
    : `lat=${lat}&lon=${lon}`;
  let url = `/api/tiles?${positionQuery}&alt=${altitude}&heading=${heading}&range=${range}`;
  if (!isFirstLoad || frameOffsetReady) url += `&ox=${originX}&oy=${originY}`;
  return {
    url,
    logDetails: {
      isFirstLoad,
      requestLat: lat,
      requestLon: lon,
      requestGridX: hasGridPosition ? queryX : null,
      requestGridY: hasGridPosition ? queryY : null,
      requestAltM: altitude,
      headingRad: heading,
      ...cameraSnapshot,
    },
  };
}

export function diffTerrainTileIds(tiles, currentTileIds) {
  const nextTileIds = new Set(tiles.map(tile => tile.id));
  return {
    nextTileIds,
    added: [...nextTileIds].filter(id => !currentTileIds.has(id)),
    removed: [...currentTileIds].filter(id => !nextTileIds.has(id)),
  };
}

export function prioritizeTerrainBuildCandidates(tiles, addedIds, priorityForTile) {
  return tiles
    .filter(tile => addedIds.has(tile.id) && tile.heightmap)
    .map(tile => ({ tile, prio: priorityForTile(tile) }))
    .sort((a, b) => a.prio - b.prio);
}

export function selectTerrainFrameOffset({
  isFirstLoad, frameOffsetReady, cameraEast, cameraNorth, offsetX, offsetY,
}) {
  if (isFirstLoad && !frameOffsetReady) {
    return { offsetX: cameraEast, offsetY: cameraNorth, ready: true, changed: true };
  }
  return { offsetX, offsetY, ready: frameOffsetReady, changed: false };
}

export function offsetTerrainPayload(data, offsetX, offsetY) {
  if (!data) return data;
  for (const collection of [data.tiles, data.missing]) {
    if (!Array.isArray(collection)) continue;
    for (const item of collection) {
      if (!Array.isArray(item?.bbox) || item.bbox.length !== 4) continue;
      item.bbox = [
        item.bbox[0] + offsetX, item.bbox[1] + offsetY,
        item.bbox[2] + offsetX, item.bbox[3] + offsetY,
      ];
    }
  }
  return data;
}

const rounded = value => Number.isFinite(value) ? Number(value.toFixed(1)) : null;

export function summarizeTerrainResponse({
  data, status, cameraX, cameraY, frameOffsetX, frameOffsetY, frameOffsetReady,
}) {
  const tiles = Array.isArray(data?.tiles) ? data.tiles : [];
  const withHm = tiles.filter(tile => tile.heightmap).length;
  let closest = null;
  for (const tile of tiles) {
    if (!Array.isArray(tile?.bbox) || tile.bbox.length !== 4) continue;
    const cx = (tile.bbox[0] + tile.bbox[2]) * 0.5;
    const cy = (tile.bbox[1] + tile.bbox[3]) * 0.5;
    const distance = Math.hypot(cx - cameraX, cy - cameraY);
    if (!closest || distance < closest.distance) closest = { tile, cx, cy, distance };
  }
  return {
    status,
    tiles: tiles.length,
    withHm,
    noHm: tiles.length - withHm,
    missing: data?.missing?.length ?? 0,
    downloading: data?.downloading?.length ?? 0,
    qx: rounded(data?.qx), qy: rounded(data?.qy),
    ox: rounded(data?.ox), oy: rounded(data?.oy),
    closestTileId: closest?.tile.id ?? null,
    closestTileDistM: closest ? rounded(closest.distance) : null,
    closestTileCx: closest ? rounded(closest.cx) : null,
    closestTileCy: closest ? rounded(closest.cy) : null,
    tileFrameOffsetX: rounded(frameOffsetX),
    tileFrameOffsetY: rounded(frameOffsetY),
    tileFrameOffsetReady: frameOffsetReady,
  };
}

export function adoptTerrainOrigin({ data, cameraSnapshot }) {
  return {
    originX: data.ox,
    originY: data.oy,
    cameraX: data.qx,
    cameraY: data.qy,
    logDetails: {
      qx: rounded(data.qx), qy: rounded(data.qy),
      ox: rounded(data.ox), oy: rounded(data.oy),
      requestCamStereoApproxX: cameraSnapshot.camStereoApproxX,
      requestCamStereoApproxY: cameraSnapshot.camStereoApproxY,
      originDeltaX: Number.isFinite(data.ox) && Number.isFinite(cameraSnapshot.camStereoApproxX)
        ? rounded(data.ox - cameraSnapshot.camStereoApproxX) : null,
      originDeltaY: Number.isFinite(data.oy) && Number.isFinite(cameraSnapshot.camStereoApproxY)
        ? rounded(data.oy - cameraSnapshot.camStereoApproxY) : null,
    },
  };
}

export function terrainCameraStereoPosition({
  latitude, longitude, anchorLatitude, anchorLongitude, originX, originY,
}) {
  return {
    x: originX + (longitude - anchorLongitude) * 111320 * Math.cos(anchorLatitude * Math.PI / 180),
    y: originY + (latitude - anchorLatitude) * 111320,
  };
}

/** Map a local scene position back into the EPSG grid used by tile bboxes. */
export function terrainCameraGridPosition({
  eastM, northM, originX, originY, frameOffsetX, frameOffsetY,
}) {
  return {
    x: originX + eastM - frameOffsetX,
    y: originY + northM - frameOffsetY,
  };
}

export function evaluateTerrainRefetch({
  cameraX, cameraY, lastFetchX, lastFetchY,
  cameraAltitude, lastFetchAltitude,
  nowMs, lastTriggerMs, distanceThreshold, altitudeThreshold = Infinity,
  triggerIntervalMs,
}) {
  const distance = Math.hypot(cameraX - lastFetchX, cameraY - lastFetchY);
  const altitudeDelta = Number.isFinite(cameraAltitude) && Number.isFinite(lastFetchAltitude)
    ? Math.abs(cameraAltitude - lastFetchAltitude)
    : 0;
  const demandChanged = distance > distanceThreshold || altitudeDelta > altitudeThreshold;
  const shouldFetch = demandChanged && nowMs - lastTriggerMs > triggerIntervalMs;
  return {
    distance,
    altitudeDelta,
    shouldFetch,
    nextTriggerMs: shouldFetch ? nowMs : lastTriggerMs,
  };
}

export function terrainCameraCoordinates({
  position, anchorPosition, east, north, up,
  anchorLatitude, anchorLongitude, originX, originY,
}) {
  const relative = position.clone().sub(anchorPosition);
  const eastM = relative.dot(east);
  const northM = relative.dot(north);
  const upM = relative.dot(up);
  const latitude = anchorLatitude + northM / 111320;
  const longitude = anchorLongitude + eastM / (111320 * Math.cos(anchorLatitude * Math.PI / 180));
  const stereo = terrainCameraStereoPosition({
    latitude, longitude, anchorLatitude, anchorLongitude, originX, originY,
  });
  return { lat: latitude, lon: longitude, alt: upM, eastM, northM, upM, stereoX: stereo.x, stereoY: stereo.y };
}

export function summarizeTerrainCamera(coordinates, {
  originX, originY, frameOffsetX, frameOffsetY, frameOffsetReady,
}) {
  const number = (value, digits) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
  return {
    camLat: number(coordinates.lat, 8), camLon: number(coordinates.lon, 8),
    camAltM: number(coordinates.alt, 2), camEastM: number(coordinates.eastM, 1),
    camNorthM: number(coordinates.northM, 1), camUpM: number(coordinates.upM, 1),
    camStereoApproxX: number(coordinates.stereoX, 1),
    camStereoApproxY: number(coordinates.stereoY, 1),
    originX: number(originX, 1), originY: number(originY, 1),
    tileFrameOffsetX: number(frameOffsetX, 1), tileFrameOffsetY: number(frameOffsetY, 1),
    tileFrameOffsetReady: frameOffsetReady,
  };
}

export function terrainPipelineStatus(data) {
  const missing = data?.missing?.length ?? 0;
  const downloading = data?.downloading?.length ?? 0;
  const textureFetching = data?.texFetching ?? 0;
  const syntheticHeightmaps = retryableSyntheticDemCount(data?.tiles);
  return {
    missing,
    downloading,
    syntheticHeightmaps,
    textureFetching,
    textureRetryQueue: data?.texRetryQueue ?? 0,
    textureStatusCounts: data?.texStatusCounts || {},
    nextAction: missing > 0 || downloading > 0 || textureFetching > 0
      || syntheticHeightmaps > 0 ? 'poll' : 'idle',
  };
}
import { retryableSyntheticDemCount } from './terrain-tile-quality.js';
