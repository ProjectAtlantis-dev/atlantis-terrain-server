import {
  adoptTerrainOrigin, buildTerrainTilesRequest, offsetTerrainPayload,
  selectTerrainFrameOffset, summarizeTerrainResponse,
  summarizeTerrainCamera, terrainCameraCoordinates, terrainCameraGridPosition,
  terrainCameraStereoPosition, terrainPipelineStatus,
} from './terrain-tile-fetch.js';
import { priorityHeading } from './terrain-priority.js';
import { mergeTerrainTilesAgainstCurrentTileSet } from './terrain-tile-quality.js';

export function createTerrainFetchRuntime({
  state,
  view,
  vehicle,
  terrain,
  logger,
  fetchImpl = (...args) => fetch(...args),
  pollMs = 3000,
  schedulePoll = (callback, delay) => setTimeout(callback, delay),
  cancelPoll = timer => clearTimeout(timer),
  events = {},
  testOverrides = {},
}) {
  const {
    onResponseApplied = () => {},
    onBuildings = () => {},
    onAvailability = () => {},
    onSkip = () => {},
    onError = () => {},
    onPoll = () => {},
    onSettled = () => {},
  } = events;
  let pollTimer = null;
  let activeController = null;

  function getCameraCoordinates() {
    return testOverrides.getCameraCoordinates?.() ?? terrainCameraCoordinates({
      position: view.camera.position,
      anchorPosition: view.anchorPosition,
      east: view.east,
      north: view.north,
      up: view.up,
      anchorLatitude: view.anchorLatitude,
      anchorLongitude: view.anchorLongitude,
      originX: state.originX,
      originY: state.originY,
    });
  }

  function getCameraSnapshot(coordinates) {
    return testOverrides.getCameraSnapshot?.(coordinates) ?? summarizeTerrainCamera(coordinates, {
      originX: state.originX,
      originY: state.originY,
      frameOffsetX: state.frameOffsetX,
      frameOffsetY: state.frameOffsetY,
      frameOffsetReady: state.frameOffsetReady,
    });
  }

  async function execute({ lat, lon, signal }) {
    const cameraCoordinates = getCameraCoordinates();
    const cameraSnapshot = getCameraSnapshot(cameraCoordinates);
    const gridPosition = state.frameOffsetReady
      ? terrainCameraGridPosition({
          eastM: cameraCoordinates.eastM,
          northM: cameraCoordinates.northM,
          originX: state.originX,
          originY: state.originY,
          frameOffsetX: state.frameOffsetX,
          frameOffsetY: state.frameOffsetY,
        })
      : null;
    const request = buildTerrainTilesRequest({
      lat: lat ?? cameraCoordinates.lat,
      lon: lon ?? cameraCoordinates.lon,
      altitude: cameraCoordinates.alt,
      heading: testOverrides.getHeading?.()
        ?? view.getHeading?.()
        ?? priorityHeading(
          vehicle.vehicleControlActive,
          vehicle.vehicleHeadingRad,
          view.controls.yaw,
        ),
      range: testOverrides.getRange?.() ?? view.controls.terrainRange,
      isFirstLoad: state.firstLoad,
      frameOffsetReady: state.frameOffsetReady,
      originX: state.originX, originY: state.originY,
      queryX: gridPosition?.x, queryY: gridPosition?.y,
      cameraSnapshot,
    });
    logger.enqueue('info', 'fetchTiles.request', request.logDetails);
    const response = await fetchImpl(request.url, { signal });
    const data = await response.json();
    if (response.ok === false || response.status >= 400) {
      const detail = typeof data?.error === 'string' ? `: ${data.error}` : '';
      throw new Error(`terrain tile request failed (${response.status})${detail}`);
    }
    if (!Array.isArray(data?.tiles)) {
      throw new TypeError('terrain tile response is missing a tiles array');
    }
    // The server may still complete and cache work from an older camera view.
    // The browser's current tile set, rather than the response epoch, owns
    // tile topology. A late response may improve an exact resident tile, but
    // may not introduce children, parents, or geography absent from that set.
    if (signal?.aborted) {
      offsetTerrainPayload(data, state.frameOffsetX, state.frameOffsetY);
      const admission = mergeTerrainTilesAgainstCurrentTileSet(
        state.lastTiles,
        data.tiles,
      );
      logger.enqueue('info', 'fetchTiles.response.superseded', {
        responseTiles: data.tiles.length,
        currentTiles: state.lastTiles?.length ?? 0,
        admittedExactUpgrades: admission.acceptedTileIds.length,
        rejectedOutsideTileSet: admission.rejectedTileIds.length,
        demUpgraded: admission.demUpgraded,
        textureUpgraded: admission.textureUpgraded,
      });
      if (admission.acceptedTileIds.length === 0) {
        return { nextAction: 'discarded' };
      }
      terrain.reconcile(admission.tiles, {
        onDiff: details => logger.enqueue('info', 'fetchTiles.diff[superseded]', details),
      });
      terrain.updateTextures(admission.tiles);
      state.lastTiles = admission.tiles;
      onResponseApplied();
      return { nextAction: 'stale-upgrades' };
    }
    const local = testOverrides.getCameraLocalPosition?.() ?? {
      x: cameraCoordinates.eastM,
      y: cameraCoordinates.northM,
    };
    const frameOffset = selectTerrainFrameOffset({
      isFirstLoad: state.firstLoad, frameOffsetReady: state.frameOffsetReady,
      cameraEast: local.x, cameraNorth: local.y,
      offsetX: state.frameOffsetX, offsetY: state.frameOffsetY,
    });
    state.frameOffsetX = frameOffset.offsetX;
    state.frameOffsetY = frameOffset.offsetY;
    state.frameOffsetReady = frameOffset.ready;
    if (frameOffset.changed) {
      logger.enqueue('info', 'fetchTiles.frame.offset.set', {
        offsetX: Number(frameOffset.offsetX.toFixed(1)),
        offsetY: Number(frameOffset.offsetY.toFixed(1)),
        camEastM: cameraSnapshot.camEastM, camNorthM: cameraSnapshot.camNorthM,
      });
    }
    offsetTerrainPayload(data, frameOffset.offsetX, frameOffset.offsetY);
    logger.enqueue('info', 'fetchTiles.response', summarizeTerrainResponse({
      data, status: response.status, cameraX: local.x, cameraY: local.y,
      frameOffsetX: frameOffset.offsetX, frameOffsetY: frameOffset.offsetY,
      frameOffsetReady: frameOffset.ready,
    }));
    if (!state.bootFetchLogged) {
      state.bootFetchLogged = true;
      logger.boot('tiles.initial-fetch.response', {
        status: response.status,
        tileCount: Array.isArray(data.tiles) ? data.tiles.length : -1,
      });
    }

    const wasFirstLoad = state.firstLoad;
    if (wasFirstLoad) {
      const origin = adoptTerrainOrigin({ data, cameraSnapshot });
      state.originX = origin.originX;
      state.originY = origin.originY;
      state.cameraStereoX = state.lastFetchX = origin.cameraX;
      state.cameraStereoY = state.lastFetchY = origin.cameraY;
      state.firstLoad = false;
      logger.enqueue('info', 'fetchTiles.origin.set', origin.logDetails);
    }

    if (Array.isArray(data.buildings)) onBuildings(data.buildings);

    const reconciliation = terrain.reconcile(data.tiles, {
      completeCoverage: wasFirstLoad,
      onDiff: details => logger.enqueue('info', 'fetchTiles.diff', details),
    });
    logger.enqueue('info', 'fetchTiles.built', {
      meshesInScene: reconciliation.sceneMeshes,
      deferred: reconciliation.deferred,
      staleRemoved: reconciliation.staleRemoved,
    });

    terrain.updateTextures(data.tiles);
    onAvailability(data.missing || [], data.downloading || []);
    state.lastTiles = data.tiles;
    onResponseApplied();

    state.cameraStereoX = state.lastFetchX = data.qx;
    state.cameraStereoY = state.lastFetchY = data.qy;
    const pipeline = terrainPipelineStatus(data);
    state.heightmapsMissing = pipeline.missing;
    state.heightmapsDownloading = pipeline.downloading;
    state.serverTexturesFetching = pipeline.textureFetching;
    state.serverTexturesRetrying = pipeline.textureRetryQueue;
    state.serverTextureStatus = pipeline.textureStatusCounts;
    return { nextAction: pipeline.nextAction };
  }

  async function request(lat, lon) {
    if (state.fetching) {
      onSkip();
      return;
    }
    state.fetching = true;
    const controller = new AbortController();
    activeController = controller;
    try {
      const result = await execute({
        lat, lon, signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (activeController === controller) activeController = null;
      if (pollTimer != null) {
        cancelPoll(pollTimer);
        pollTimer = null;
      }
      if (result.nextAction === 'poll') {
        pollTimer = schedulePoll(() => {
          pollTimer = null;
          onPoll();
          request();
        }, pollMs);
      }
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      onError(error);
    }
    if (activeController === controller) activeController = null;
    state.fetching = false;
    onSettled();
  }

  function reset() {
    activeController?.abort();
    activeController = null;
    if (pollTimer != null) cancelPoll(pollTimer);
    pollTimer = null;
    state.fetching = false;
  }

  return { execute, request, reset };
}
