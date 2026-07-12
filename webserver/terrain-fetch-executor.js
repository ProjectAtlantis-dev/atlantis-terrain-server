import {
  adoptTerrainOrigin, buildTerrainTilesRequest, offsetTerrainPayload,
  selectTerrainFrameOffset, summarizeTerrainResponse,
  terrainCameraStereoPosition, terrainPipelineStatus,
} from './terrain-tile-fetch.js';
import { reconcileTerrainTiles } from './terrain-tile-reconciler.js';

export function createTerrainFetchExecutor({
  state,
  previewMaxDepth,
  getHeading,
  getRange,
  getCameraLatLon,
  getCameraSnapshot,
  getCameraLocalPosition,
  anchorLatitude,
  anchorLongitude,
  terrainRoot,
  deferredTiles,
  lifecycle,
  priorityForTile,
  isCoveredByEnhancedParent,
  textureCache,
  materialize,
  buildMesh,
  tileLog,
  applyMissing,
  updateTextures,
  prepareUntexturedMesh,
  onMeshAdded,
  onResponseApplied = () => {},
  enqueueLog,
  bootLog,
  fetchImpl = (...args) => fetch(...args),
  now = () => performance.now(),
}) {
  return async function executeTerrainFetch({ lat, lon, pass, signal }) {
    state.pass = pass;
    const started = now();
    const camera = getCameraLatLon();
    const cameraSnapshot = getCameraSnapshot(camera);
    const request = buildTerrainTilesRequest({
      lat: lat ?? camera.lat, lon: lon ?? camera.lon, altitude: camera.alt,
      heading: getHeading(), range: getRange(), pass,
      previewMaxDepth, isFirstLoad: state.isFirstLoad,
      frameOffsetReady: state.frameOffsetReady,
      originX: state.originX, originY: state.originY,
      cameraSnapshot,
    });
    enqueueLog('info', `fetchTiles.request[pass${pass}]`, request.logDetails);
    const response = await fetchImpl(request.url, { signal });
    const data = await response.json();
    const local = getCameraLocalPosition();
    const frameOffset = selectTerrainFrameOffset({
      isFirstLoad: state.isFirstLoad, frameOffsetReady: state.frameOffsetReady,
      cameraEast: local.x, cameraNorth: local.y,
      offsetX: state.frameOffsetX, offsetY: state.frameOffsetY,
    });
    state.frameOffsetX = frameOffset.offsetX;
    state.frameOffsetY = frameOffset.offsetY;
    state.frameOffsetReady = frameOffset.ready;
    if (frameOffset.changed) {
      enqueueLog('info', 'fetchTiles.frame.offset.set', {
        pass, passLabel: pass === 1 ? 'preview' : 'full',
        offsetX: Number(frameOffset.offsetX.toFixed(1)),
        offsetY: Number(frameOffset.offsetY.toFixed(1)),
        camEastM: cameraSnapshot.camEastM, camNorthM: cameraSnapshot.camNorthM,
      });
    }
    offsetTerrainPayload(data, frameOffset.offsetX, frameOffset.offsetY);
    enqueueLog('info', `fetchTiles.response[pass${pass}]`, summarizeTerrainResponse({
      data, status: response.status, pass, cameraX: local.x, cameraY: local.y,
      frameOffsetX: frameOffset.offsetX, frameOffsetY: frameOffset.offsetY,
      frameOffsetReady: frameOffset.ready,
    }));
    if (!state.bootFetchLogged) {
      state.bootFetchLogged = true;
      bootLog('tiles.initial-fetch.response', {
        status: response.status,
        tileCount: Array.isArray(data.tiles) ? data.tiles.length : -1,
      });
    }

    const wasFirstLoad = state.isFirstLoad;
    if (wasFirstLoad) {
      const origin = adoptTerrainOrigin({ data, pass, cameraSnapshot });
      state.originX = origin.originX;
      state.originY = origin.originY;
      state.cameraX = state.lastFetchX = origin.cameraX;
      state.cameraY = state.lastFetchY = origin.cameraY;
      state.isFirstLoad = false;
      enqueueLog('info', 'fetchTiles.origin.set', origin.logDetails);
    }

    const reconciliation = reconcileTerrainTiles({
      tiles: data.tiles, currentTileIds: state.currentTileIds,
      deferredTiles, terrainRoot, lifecycle, priorityForTile,
      isCoveredByEnhancedParent, textureCache, materialize, buildMesh, log: tileLog,
      prepareUntexturedMesh, onMeshAdded,
      onDiff: details => enqueueLog('info', `fetchTiles.diff[pass${pass}]`, {
        pass, passLabel: pass === 1 ? 'preview' : 'full', ...details,
      }),
    });
    state.currentTileIds = reconciliation.nextTileIds;
    enqueueLog('info', `fetchTiles.built[pass${pass}]`, {
      pass, passLabel: pass === 1 ? 'preview' : 'full',
      meshesInScene: reconciliation.sceneMeshes,
      deferred: reconciliation.deferred,
      staleRemoved: reconciliation.staleRemoved,
    });

    updateTextures(data.tiles);
    applyMissing(data.missing || [], data.downloading || []);
    state.lastTiles = data.tiles;
    onResponseApplied();

    const currentCamera = getCameraLatLon();
    const stereo = terrainCameraStereoPosition({
      latitude: currentCamera.lat, longitude: currentCamera.lon,
      anchorLatitude, anchorLongitude,
      originX: state.originX, originY: state.originY,
    });
    state.cameraX = state.lastFetchX = stereo.x;
    state.cameraY = state.lastFetchY = stereo.y;
    const pipeline = terrainPipelineStatus(data, wasFirstLoad);
    state.pipeline = pipeline;
    return {
      nextAction: pipeline.nextAction,
      previewDetails: {
        pass: 1, previewTiles: data.tiles.length, maxDepth: previewMaxDepth,
        meshesInScene: reconciliation.sceneMeshes, deferred: deferredTiles.size,
        elapsedMs: Number((now() - started).toFixed(1)),
      },
    };
  };
}
