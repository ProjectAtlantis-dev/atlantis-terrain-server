import {
  adoptTerrainOrigin, buildTerrainTilesRequest, offsetTerrainPayload,
  selectTerrainFrameOffset, summarizeTerrainResponse,
  terrainCameraStereoPosition, terrainPipelineStatus,
} from './terrain-tile-fetch.js';
import { reconcileTerrainTiles } from './terrain-tile-reconciler.js';

export function createTerrainFetchRuntime({
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
  pollMs = 3000,
  scheduleFrame = callback => requestAnimationFrame(callback),
  schedulePoll = (callback, delay) => setTimeout(callback, delay),
  cancelPoll = timer => clearTimeout(timer),
  onSkip = () => {},
  onError = () => {},
  onPreviewComplete = () => {},
  onPoll = () => {},
  onSettled = () => {},
}) {
  let pollTimer = null;
  let generation = 0;
  let activeController = null;

  async function execute({ lat, lon, pass, signal }) {
    state.loadPass = pass;
    const started = now();
    const camera = getCameraLatLon();
    const cameraSnapshot = getCameraSnapshot(camera);
    const request = buildTerrainTilesRequest({
      lat: lat ?? camera.lat, lon: lon ?? camera.lon, altitude: camera.alt,
      heading: getHeading(), range: getRange(), pass,
      previewMaxDepth, isFirstLoad: state.firstLoad,
      frameOffsetReady: state.frameOffsetReady,
      originX: state.originX, originY: state.originY,
      cameraSnapshot,
    });
    enqueueLog('info', `fetchTiles.request[pass${pass}]`, request.logDetails);
    const response = await fetchImpl(request.url, { signal });
    const data = await response.json();
    const local = getCameraLocalPosition();
    const frameOffset = selectTerrainFrameOffset({
      isFirstLoad: state.firstLoad, frameOffsetReady: state.frameOffsetReady,
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

    const wasFirstLoad = state.firstLoad;
    if (wasFirstLoad) {
      const origin = adoptTerrainOrigin({ data, pass, cameraSnapshot });
      state.originX = origin.originX;
      state.originY = origin.originY;
      state.cameraStereoX = state.lastFetchX = origin.cameraX;
      state.cameraStereoY = state.lastFetchY = origin.cameraY;
      state.firstLoad = false;
      enqueueLog('info', 'fetchTiles.origin.set', origin.logDetails);
    }

    const reconciliation = reconcileTerrainTiles({
      tiles: data.tiles, currentTileIds: state.currentTileIds,
      deferredTiles, terrainRoot, lifecycle, priorityForTile,
      textureCache, materialize, buildMesh, log: tileLog,
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
    state.cameraStereoX = state.lastFetchX = stereo.x;
    state.cameraStereoY = state.lastFetchY = stereo.y;
    const pipeline = terrainPipelineStatus(data, wasFirstLoad);
    state.heightmapsMissing = pipeline.missing;
    state.heightmapsDownloading = pipeline.downloading;
    state.serverTexturesFetching = pipeline.textureFetching;
    state.serverTexturesRetrying = pipeline.textureRetryQueue;
    state.serverTextureStatus = pipeline.textureStatusCounts;
    return {
      nextAction: pipeline.nextAction,
      previewDetails: {
        pass: 1, previewTiles: data.tiles.length, maxDepth: previewMaxDepth,
        meshesInScene: reconciliation.sceneMeshes, deferred: deferredTiles.size,
        elapsedMs: Number((now() - started).toFixed(1)),
      },
    };
  }

  async function request(lat, lon) {
    if (state.fetching) {
      onSkip();
      return;
    }
    state.fetching = true;
    const requestGeneration = generation;
    activeController = new AbortController();
    try {
      const result = await execute({
        lat, lon, pass: state.loadPass, signal: activeController.signal,
      });
      if (requestGeneration !== generation) return;
      activeController = null;
      if (pollTimer != null) {
        cancelPoll(pollTimer);
        pollTimer = null;
      }
      if (result.nextAction === 'full-pass') {
        state.fetching = false;
        state.loadPass = 2;
        onPreviewComplete(result);
        scheduleFrame(() => request());
        return;
      }
      if (result.nextAction === 'poll') {
        pollTimer = schedulePoll(() => {
          pollTimer = null;
          onPoll();
          request();
        }, pollMs);
      }
    } catch (error) {
      if (requestGeneration !== generation || error?.name === 'AbortError') return;
      onError(error);
    }
    activeController = null;
    state.fetching = false;
    onSettled();
  }

  function reset(nextPass = 1) {
    generation += 1;
    activeController?.abort();
    activeController = null;
    if (pollTimer != null) cancelPoll(pollTimer);
    pollTimer = null;
    state.loadPass = nextPass;
    state.fetching = false;
  }

  return { execute, request, reset };
}
