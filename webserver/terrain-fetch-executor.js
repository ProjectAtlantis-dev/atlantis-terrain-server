import {
  adoptTerrainOrigin, buildTerrainTilesRequest, offsetTerrainPayload,
  hydrateTerrainHeightmaps, selectTerrainFrameOffset, summarizeTerrainResponse,
  terrainCameraStereoPosition, terrainPipelineStatus,
} from './terrain-tile-fetch.js';
import { reconcileTerrainTiles } from './terrain-tile-reconciler.js';

export function terrainResidencyBudgetForPass({
  pass,
  tileBudget,
  previewTileBudget,
}) {
  const full = Math.max(1, Math.floor(Number(tileBudget) || 1));
  const preview = Math.max(1, Math.floor(Number(previewTileBudget) || full));
  return pass === 1 ? Math.min(full, preview) : full;
}

export function createTerrainFetchExecutor({
  state,
  previewMaxDepth,
  useManifest = false,
  tileBudget = 384,
  previewTileBudget = 16,
  previewBuildBudget = 16,
  fullBuildBudget = 32,
  getHeading,
  getRange,
  getCameraLatLon,
  getRequestFocus = camera => camera,
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
  forceUntexturedBuild = () => false,
  onMeshAdded,
  onWorldIdentity = () => {},
  onTilesReceived = () => {},
  onResponseApplied = () => {},
  enqueueLog,
  bootLog,
  fetchImpl = (...args) => fetch(...args),
  now = () => performance.now(),
}) {
  const heightmapCache = new Map();
  return async function executeTerrainFetch({ lat, lon, pass, signal }) {
    state.pass = pass;
    const started = now();
    const camera = getCameraLatLon();
    const focus = lat == null || lon == null
      ? getRequestFocus(camera)
      : { lat, lon };
    const cameraSnapshot = getCameraSnapshot(camera);
    const request = buildTerrainTilesRequest({
      lat: focus?.lat ?? camera.lat, lon: focus?.lon ?? camera.lon, altitude: camera.alt,
      heading: getHeading(), range: getRange(), pass,
      previewMaxDepth, isFirstLoad: state.isFirstLoad,
      frameOffsetReady: state.frameOffsetReady,
      originX: state.originX, originY: state.originY,
      useManifest,
      tileBudget: terrainResidencyBudgetForPass({ pass, tileBudget, previewTileBudget }),
      cameraSnapshot,
    });
    Object.assign(request.logDetails, focus?.logDetails ?? {});
    enqueueLog('info', `fetchTiles.request[pass${pass}]`, request.logDetails);
    const response = await fetchImpl(request.url, { signal });
    const data = await response.json();
    onWorldIdentity({
      worldSeed: data?.worldSeed,
      procgenVersion: data?.procgenVersion,
    });
    if (data?.manifest) {
      const hydration = await hydrateTerrainHeightmaps(data.tiles, {
        cache: heightmapCache,
        fetchImpl,
        signal,
      });
      enqueueLog('info', `fetchTiles.heightPages[pass${pass}]`, hydration);
    }
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
    onTilesReceived(data.tiles);
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
      textureCache, materialize, buildMesh, log: tileLog,
      buildBudget: pass === 1 ? previewBuildBudget : fullBuildBudget,
      prepareUntexturedMesh, forceUntexturedBuild, onMeshAdded,
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
    state.cameraX = stereo.x;
    state.cameraY = stereo.y;
    // Track the manifest focus, which may be predicted ahead of the physical
    // camera. Refetch hysteresis compares the next prediction to this request,
    // not to wherever the camera happened to be after network/build latency.
    state.lastFetchX = Number.isFinite(data.qx) ? data.qx : stereo.x;
    state.lastFetchY = Number.isFinite(data.qy) ? data.qy : stereo.y;
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
