import {
  adoptTerrainOrigin, buildTerrainTilesRequest, offsetTerrainPayload,
  selectTerrainFrameOffset, summarizeTerrainResponse,
  summarizeTerrainCamera, terrainCameraCoordinates, terrainCameraGridPosition,
  terrainCameraStereoPosition, terrainPipelineStatus,
} from './terrain-tile-fetch.js';
import { priorityHeading } from './terrain-priority.js';
import { mergeTerrainTilesAgainstCurrentTileSet } from './terrain-tile-quality.js';
import { MAX_TERRAIN_AGL_M } from './terrain-agl.js';
import { createLodAltitudeStabilizer } from './terrain-lod-altitude.js';
import {
  decodeTerrainBinaryPayload,
  isTerrainBinaryResponse,
} from './terrain-binary-payload.js';
import { createTerrainSampleCache } from './terrain-sample-cache.js';

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
  lodAltitudeStabilizer = createLodAltitudeStabilizer(),
  evictionGate = null,
  sampleCache = createTerrainSampleCache({ evictionGate }),
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
  let queuedRequest = null;

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
    const measuredAgl = testOverrides.getCameraAGL?.()
      ?? view.getCameraAGL?.();
    // Unknown clearance is not camera ASL. Bootstrap with the coarse safety
    // ceiling so startup can only refine after terrain supplies a real AGL;
    // starting at zero would over-refine and immediately request a downgrade.
    // Damp the measurement before it reaches the server's stepped depth cap.
    // Unknown clearance must not anchor the band — it is a bootstrap ceiling,
    // not an observation.
    const heldAgl = lodAltitudeStabilizer.held;
    const lodAltitude = Number.isFinite(measuredAgl)
      ? lodAltitudeStabilizer.stabilize(Math.max(0, measuredAgl))
      : Number.isFinite(heldAgl)
        // A missing surface sample is common while crossing water or a brief
        // residency gap. It is not evidence that the camera climbed to the
        // bootstrap ceiling: keep the last measured demand so one absent
        // sample cannot contract the topology and evict the fine tile set.
        ? heldAgl
        : MAX_TERRAIN_AGL_M;
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
      altitude: lodAltitude,
      heading: testOverrides.getHeading?.()
        ?? view.getHeading?.()
        ?? priorityHeading(
          vehicle.vehicleControlActive,
          vehicle.vehicleHeadingRad,
          view.controls.yaw,
        ),
      range: testOverrides.getRange?.() ?? view.controls.terrainRange,
      buildingsHash: state.buildingsHash,
      isFirstLoad: state.firstLoad,
      frameOffsetReady: state.frameOffsetReady,
      originX: state.originX, originY: state.originY,
      queryX: gridPosition?.x, queryY: gridPosition?.y,
      cameraSnapshot,
    });
    logger.enqueue('info', 'fetchTiles.request', {
      ...request.logDetails,
      // requestAglM is the damped value actually sent; keep the raw sample
      // alongside it so the hysteresis band can be verified from a capture.
      measuredAglM: Number.isFinite(measuredAgl)
        ? Number(measuredAgl.toFixed(1))
        : null,
    });
    // The server may omit samples for every digest in this claim. Keep the
    // corresponding cache-owned arrays alive for exactly this request: the
    // bounded live LRU can otherwise evict an advertised entry while fetch is
    // in flight, leaving a digest-only tile that cannot be materialized.
    const residency = sampleCache.snapshot();
    const response = await fetchImpl(request.url, {
      signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Residency travels in a body because a footprint's worth of digests is
      // far past a safe query-string length and grows with view range.
      // depthCap is the ceiling this client is currently rendering. Echoing
      // it lets the server hold that ceiling through ordinary terrain relief
      // instead of re-deciding from scratch and swapping the whole tile set.
      body: JSON.stringify({
        known: residency.known,
        depthCap: state.depthCap ?? null,
      }),
    });
    // Deserializing the response is synchronous main-thread work despite the
    // await, and lands between frames where a frame-time profiler cannot see
    // it. Time it separately from reconcile so a stall can be blamed on the
    // payload or on mesh building rather than on "somewhere in the callback".
    const parseStartedAt = performance.now();
    const data = isTerrainBinaryResponse(response)
      ? decodeTerrainBinaryPayload(await response.arrayBuffer())
      : await response.json();
    const parseMs = performance.now() - parseStartedAt;
    // Tiles the server withheld carry a digest but no samples; restore them
    // from what we told it we held. A miss here means the two sides disagree
    // about residency, which would render the tile with no elevation data, so
    // it is surfaced rather than silently tolerated.
    let reusedSamples = 0;
    const unresolved = [];
    for (const tile of Array.isArray(data?.tiles) ? data.tiles : []) {
      if (tile.samples instanceof Float32Array) {
        sampleCache.store(tile.id, tile.heightmap, tile.samples);
        continue;
      }
      if (typeof tile.heightmap !== 'string' || tile.heightmapBytes !== 0) continue;
      const held = residency.take(tile.id, tile.heightmap);
      if (held == null) {
        unresolved.push(tile.id);
        continue;
      }
      tile.samples = held;
      reusedSamples += 1;
    }
    if (unresolved.length > 0) {
      logger.enqueue('warn', 'fetchTiles.residency.miss', {
        count: unresolved.length,
        tileIds: unresolved.slice(0, 8),
      });
    }
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
    // Only an aborted request is demoted to this merge path: the single
    // in-flight request is always the newest one dispatched, and demoting it
    // for a merely-queued follow-up starves topology updates entirely.
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

    // An unchanged set arrives as a bare digest; the existing meshes stand.
    if (typeof data.buildingsHash === 'string') {
      state.buildingsHash = data.buildingsHash;
    }
    if (Number.isInteger(data.depthCap)) state.depthCap = data.depthCap;
    if (Array.isArray(data.buildings)) onBuildings(data.buildings);

    const reconcileStartedAt = performance.now();
    const reconciliation = terrain.reconcile(data.tiles, {
      completeCoverage: wasFirstLoad,
      onDiff: details => logger.enqueue('info', 'fetchTiles.diff', details),
    });
    const reconcileMs = performance.now() - reconcileStartedAt;
    logger.enqueue('info', 'fetchTiles.built', {
      meshesInScene: reconciliation.sceneMeshes,
      deferred: reconciliation.deferred,
      responseTiles: data.tiles.length,
      parseMs: Number(parseMs.toFixed(1)),
      reconcileMs: Number(reconcileMs.toFixed(1)),
      evictMs: reconciliation.evictMs,
      buildMs: reconciliation.buildMs,
      refreshMs: reconciliation.refreshMs,
      refreshed: reconciliation.refreshed,
      refreshDeferred: reconciliation.refreshDeferred,
      reusedSamples,
      // The LOD ceiling this response settled on. Without it a capture cannot
      // tell a genuine depth change from footprint drift, which is the
      // distinction that matters when reading eviction counts.
      depthCap: data.depthCap ?? null,
      tilesReused: data.tilesReused ?? null,
      sampleCache: sampleCache.stats(),
      released: reconciliation.released,
      geometryCache: reconciliation.geometryCache,
    });

    terrain.updateTextures(data.tiles);
    onAvailability(data.missing || [], data.downloading || []);
    state.lastTiles = data.tiles;
    onResponseApplied();

    state.cameraStereoX = state.lastFetchX = data.qx;
    state.cameraStereoY = state.lastFetchY = data.qy;
    // Altitude affects the server-side LOD ceiling just as horizontal
    // position affects its radial bands. Advance this only when an
    // authoritative response applies so a descent can keep requesting until
    // the response topology catches up with the live camera height.
    state.lastFetchAltitude = lodAltitude;
    const pipeline = terrainPipelineStatus(data);
    state.heightmapsMissing = pipeline.missing;
    state.heightmapsDownloading = pipeline.downloading;
    state.serverTexturesFetching = pipeline.textureFetching;
    state.serverTexturesRetrying = pipeline.textureRetryQueue;
    state.serverTextureStatus = pipeline.textureStatusCounts;
    return {
      nextAction: pipeline.nextAction,
      pollAfterMs: pipeline.pollAfterMs,
    };
  }

  async function runRequest({ lat, lon }) {
    state.fetching = true;
    const controller = new AbortController();
    activeController = controller;
    try {
      const result = await execute({ lat, lon, signal: controller.signal });
      if (controller.signal.aborted || activeController !== controller) return;
      // A queued follow-up starts as soon as this settles; it owns polling.
      if (result.nextAction === 'poll' && !queuedRequest) {
        pollTimer = schedulePoll(() => {
          pollTimer = null;
          onPoll();
          request();
        }, result.pollAfterMs ?? pollMs);
      }
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      onError(error);
    } finally {
      if (activeController === controller) {
        activeController = null;
        if (queuedRequest) {
          const next = queuedRequest;
          queuedRequest = null;
          await runRequest(next);
        } else {
          state.fetching = false;
          onSettled();
        }
      }
    }
  }

  function request(lat, lon) {
    // Coalesce, never abort: the in-flight request stays authoritative and
    // the newest coordinates run immediately after it settles.
    //
    // LIVELOCK WARNING — the movement-refetch trigger re-fires every 500ms
    // for as long as the camera sits farther than REFETCH_DIST from
    // state.lastFetchX/Y/Altitude, and lastFetch only advances when a response fully
    // applies. A radial fetch usually takes longer than 500ms, so under
    // movement a newer request() always lands mid-flight. Any scheme that
    // lets that newer arrival cancel or demote the in-flight work (aborting
    // it, or version-checking its response into the merge-only path) means
    // no response ever fully applies, lastFetch never advances, the trigger
    // never clears, and LOD topology freezes until a reset — even after the
    // camera stops. Both previous designs failed exactly this way.
    if (activeController) {
      onSkip();
      queuedRequest = { lat, lon };
      return;
    }
    if (pollTimer != null) {
      cancelPoll(pollTimer);
      pollTimer = null;
    }
    return runRequest({ lat, lon });
  }

  function reset() {
    lodAltitudeStabilizer.reset();
    queuedRequest = null;
    activeController?.abort();
    activeController = null;
    if (pollTimer != null) cancelPoll(pollTimer);
    pollTimer = null;
    state.fetching = false;
  }

  return { execute, request, reset };
}
