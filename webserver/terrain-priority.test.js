import assert from 'node:assert/strict';
import test from 'node:test';

import {
  headingForward2D,
  priorityHeading,
  terrainTilePriority,
} from './terrain-priority.js';
import { compassHeading } from './terrain-hud.js';
import { applyMapDrag } from './terrain-controls.js';
import { stepSuspension, stepVehicleDrive } from './terrain-vehicle.js';
import { meshUsesTextureClassification, scoreTextureTiles, textureRetryDelay } from './terrain-tile-runtime.js';
import { createTextureStreamer } from './terrain-texture-streamer.js';
import { createTileLifecycle } from './terrain-tile-lifecycle.js';
import { reconcileTerrainTiles } from './terrain-tile-reconciler.js';
import { createTerrainFetchScheduler } from './terrain-fetch-scheduler.js';
import { createTerrainTextureController } from './terrain-texture-controller.js';
import { createTerrainEnhancementController } from './terrain-enhancement-controller.js';
import {
  buildTerrainTilesRequest,
  adoptTerrainOrigin,
  diffTerrainTileIds,
  offsetTerrainPayload,
  prioritizeTerrainBuildCandidates,
  selectTerrainFrameOffset,
  summarizeTerrainResponse,
  terrainCameraStereoPosition,
  terrainPipelineStatus,
} from './terrain-tile-fetch.js';

test('terrain preview request preserves boot frame semantics', () => {
  const request = buildTerrainTilesRequest({
    lat: 64.1, lon: -51.2, altitude: 120, heading: 0.5, range: 30000,
    pass: 1, previewMaxDepth: 10, isFirstLoad: true,
    frameOffsetReady: false, originX: 1, originY: 2,
    cameraSnapshot: { camEastM: 3 },
  });
  assert.equal(request.url, '/api/tiles?lat=64.1&lon=-51.2&alt=120&heading=0.5&range=30000&maxDepth=10');
  assert.deepEqual(request.logDetails, {
    pass: 1, passLabel: 'preview', isFirstLoad: true,
    requestLat: 64.1, requestLon: -51.2, requestAltM: 120,
    headingRad: 0.5, maxDepth: 10, camEastM: 3,
  });
});

test('terrain full request reuses a restored frame', () => {
  const request = buildTerrainTilesRequest({
    lat: 64, lon: -51, altitude: 50, heading: 0, range: 40000,
    pass: 2, previewMaxDepth: 10, isFirstLoad: true,
    frameOffsetReady: true, originX: -12.5, originY: 99.25,
  });
  assert.equal(request.url, '/api/tiles?lat=64&lon=-51&alt=50&heading=0&range=40000&ox=-12.5&oy=99.25');
  assert.equal(request.logDetails.maxDepth, null);
});

test('terrain tile diff and dirty-paint demand are deterministic', () => {
  const tiles = [
    { id: 'new-far', heightmap: 'x', priority: 9 },
    { id: 'kept', heightmap: 'x', priority: 1 },
    { id: 'new-hot', heightmap: 'x', priority: 2 },
    { id: 'no-heightmap', heightmap: null, priority: 0 },
  ];
  const diff = diffTerrainTileIds(tiles, new Set(['kept', 'removed']));
  assert.deepEqual(diff.added, ['new-far', 'new-hot', 'no-heightmap']);
  assert.deepEqual(diff.removed, ['removed']);
  const candidates = prioritizeTerrainBuildCandidates(
    tiles, new Set(diff.added), tile => tile.priority,
  );
  assert.deepEqual(candidates.map(item => item.tile.id), ['new-hot', 'new-far']);
});

test('terrain response normalization preserves frame and log semantics', () => {
  assert.deepEqual(selectTerrainFrameOffset({
    isFirstLoad: true, frameOffsetReady: false,
    cameraEast: 100.25, cameraNorth: -20.5, offsetX: 0, offsetY: 0,
  }), { offsetX: 100.25, offsetY: -20.5, ready: true, changed: true });
  const data = {
    qx: 1.26, qy: 2.34, ox: 3.45, oy: 4.56,
    tiles: [
      { id: 'near', bbox: [0, 0, 2, 2], heightmap: 'hm' },
      { id: 'far', bbox: [10, 10, 12, 12], heightmap: null },
    ],
    missing: [{ id: 'missing', bbox: [2, 2, 3, 3] }],
    downloading: ['x'],
  };
  offsetTerrainPayload(data, 100, -20);
  assert.deepEqual(data.tiles[0].bbox, [100, -20, 102, -18]);
  assert.deepEqual(data.missing[0].bbox, [102, -18, 103, -17]);
  assert.deepEqual(summarizeTerrainResponse({
    data, status: 200, pass: 2, cameraX: 101, cameraY: -19,
    frameOffsetX: 100, frameOffsetY: -20, frameOffsetReady: true,
  }), {
    pass: 2, passLabel: 'full', status: 200, tiles: 2, withHm: 1, noHm: 1,
    missing: 1, downloading: 1, qx: 1.3, qy: 2.3, ox: 3.5, oy: 4.6,
    closestTileId: 'near', closestTileDistM: 0,
    closestTileCx: 101, closestTileCy: -19,
    tileFrameOffsetX: 100, tileFrameOffsetY: -20, tileFrameOffsetReady: true,
  });
});

test('shared reconciler spends dirty-paint budget in heatmap order', () => {
  const built = [];
  const deferredTiles = new Map();
  const terrainRoot = {
    children: [],
    add(mesh) { this.children.push(mesh); },
  };
  let diffDetails = null;
  const result = reconcileTerrainTiles({
    tiles: [
      { id: 'far', bbox: [10, 10, 11, 11], heightmap: 'hm', priority: 9 },
      { id: 'hot', bbox: [0, 0, 1, 1], heightmap: 'hm', priority: 1 },
    ],
    currentTileIds: new Set(), deferredTiles, terrainRoot,
    lifecycle: { sweepStaleParents: () => 0 },
    priorityForTile: tile => tile.priority,
    isCoveredByEnhancedParent: () => false,
    textureCache: new Map(), materialize: () => assert.fail('unexpected materialize'),
    buildMesh: tile => {
      built.push(tile.id);
      return {
        isMesh: true, userData: { tileId: tile.id, bbox: tile.bbox },
        material: { map: null },
      };
    },
    log: () => {}, buildBudget: 1,
    onDiff: details => { diffDetails = details; },
  });
  assert.deepEqual(built, ['hot']);
  assert.deepEqual([...deferredTiles.keys()], ['hot', 'far']);
  assert.equal(result.sceneMeshes, 1);
  assert.deepEqual(diffDetails, { added: 2, removed: 0, purgedDeferred: 0, sceneMeshes: 0 });
});

test('terrain origin and pipeline decisions preserve two-pass behavior', () => {
  const origin = adoptTerrainOrigin({
    data: { ox: -100.25, oy: 200.25, qx: -90, qy: 210 },
    pass: 1,
    cameraSnapshot: { camStereoApproxX: -95, camStereoApproxY: 205 },
  });
  assert.equal(origin.originX, -100.25);
  assert.equal(origin.cameraY, 210);
  assert.equal(origin.logDetails.originDeltaX, -5.3);
  assert.equal(terrainPipelineStatus({ missing: [], downloading: [], texFetching: 0 }, true).nextAction, 'full-pass');
  assert.equal(terrainPipelineStatus({ missing: [{}], downloading: [], texFetching: 0 }, false).nextAction, 'poll');
  assert.equal(terrainPipelineStatus({ missing: [], downloading: [], texFetching: 0 }, false).nextAction, 'idle');
  assert.deepEqual(terrainCameraStereoPosition({
    latitude: 64, longitude: -51, anchorLatitude: 64, anchorLongitude: -51,
    originX: 12, originY: 34,
  }), { x: 12, y: 34 });
});

test('shared fetch scheduler serializes preview, full pass, and polling', async () => {
  const passes = [];
  let frameCallback = null;
  let pollCallback = null;
  const scheduler = createTerrainFetchScheduler({
    execute: async ({ pass }) => {
      passes.push(pass);
      return { nextAction: pass === 1 ? 'full-pass' : 'poll' };
    },
    scheduleFrame: callback => { frameCallback = callback; },
    schedulePoll: callback => { pollCallback = callback; return 7; },
    cancelPoll: () => {},
  });
  await scheduler.request();
  assert.deepEqual(passes, [1]);
  assert.equal(scheduler.pass, 2);
  await frameCallback();
  assert.deepEqual(passes, [1, 2]);
  assert.equal(typeof pollCallback, 'function');
  await pollCallback();
  assert.deepEqual(passes, [1, 2, 2]);
});

test('shared fetch scheduler rejects overlapping requests', async () => {
  let release;
  let skips = 0;
  const scheduler = createTerrainFetchScheduler({
    execute: () => new Promise(resolve => { release = resolve; }),
    onSkip: () => { skips += 1; },
  });
  const first = scheduler.request();
  await scheduler.request();
  assert.equal(skips, 1);
  release({ nextAction: 'idle' });
  await first;
});

test('shared texture controller budgets scene applications per frame', () => {
  const tiles = [
    { id: 'a', bbox: [0, 0, 1, 1] },
    { id: 'b', bbox: [1, 0, 2, 1] },
  ];
  const textures = new Map(tiles.map(tile => [tile.id, { image: { width: 1, height: 1 } }]));
  const deferredTiles = new Map(tiles.map(tile => [tile.id, tile]));
  const frames = [];
  const materialized = [];
  const controller = createTerrainTextureController({
    terrainRoot: { children: [] }, deferredTiles,
    textureStreamer: {
      texCache: textures, texSource: new Map(), requestWaterMask() {},
      pump() {},
    },
    meshRuntime: {
      materialize(id) { materialized.push(id); deferredTiles.delete(id); },
      rebuildWithTexture: mesh => mesh,
    },
    lifecycle: { evictCoveredAncestors() {}, sweepStaleParents() {} },
    priorityForTile: () => 0, getVisibilityDistance: () => 1000,
    isCovered: () => false, applyMaterial() {}, getWaterMask: () => null,
    log() {}, applicationsPerFrame: 1,
    scheduleFrame: callback => frames.push(callback),
  });
  controller(tiles);
  assert.deepEqual(materialized, []);
  frames.shift()();
  assert.deepEqual(materialized, ['a']);
  frames.shift()();
  assert.deepEqual(materialized, ['a', 'b']);
});

test('shared enhancement controller tracks 202 pending and 429 backoff', () => {
  let timestamp = 1000;
  const controller = createTerrainEnhancementController({
    log() {}, applyEnhancedTexture() {}, requestWaterMask() {},
    textureCache: new Map(), textureSource: new Map(),
    hasTextureWork: () => false, getLastCameraMoveTime: () => 0,
    hasTiles: () => true, now: () => timestamp,
  });
  controller.handleResponse('tile', { status: 202 });
  assert.deepEqual(controller.pending.get('tile'), { submitted: 1000, nextPollAt: 6000 });
  timestamp = 2000;
  controller.handleResponse('tile', { status: 429 }, true);
  assert.equal(controller.backoffUntil, 12000);
  assert.equal(controller.retryAfter.get('tile'), 12000);
  assert.deepEqual(controller.pending.get('tile'), { submitted: 1000, nextPollAt: 12000 });
});

test('cardinal headings use the vehicle convention', () => {
  const cases = [
    [0, 0, 1],
    [Math.PI / 2, -1, 0],
    [Math.PI, 0, -1],
    [-Math.PI / 2, 1, 0],
  ];
  for (const [heading, x, y] of cases) {
    const actual = headingForward2D(heading);
    assert.ok(Math.abs(actual.x - x) < 1e-12);
    assert.ok(Math.abs(actual.y - y) < 1e-12);
  }
});

test('stationary vehicle heading wins over orbiting camera yaw', () => {
  assert.equal(priorityHeading(true, 1.25, -0.75), 1.25);
  assert.equal(priorityHeading(false, 1.25, -0.75), -0.75);
});

test('tile ahead of vehicle is hotter than tile behind it', () => {
  const options = {
    cameraX: 0,
    cameraY: 0,
    heading: 0,
    usePitch: false,
    fovDeg: 60,
    aspect: 16 / 9,
  };
  const ahead = terrainTilePriority({ bbox: [-50, 4950, 50, 5050] }, options);
  const behind = terrainTilePriority({ bbox: [-50, -5050, 50, -4950] }, options);
  assert.ok(ahead < behind);
});

test('HUD compass uses the same heading convention', () => {
  assert.equal(compassHeading(0).compass, 'N');
  assert.equal(compassHeading(Math.PI / 2).compass, 'W');
  assert.equal(compassHeading(-Math.PI / 2).compass, 'E');
});

test('shared map pan respects map yaw', () => {
  globalThis.window = { innerWidth: 1000, innerHeight: 800 };
  const controls = {
    dragButton: 2,
    mapZoom: 1000,
    yaw: 0,
    mapPanEast: 0,
    mapPanNorth: 0,
  };
  assert.equal(
    applyMapDrag(controls, { movementX: 10, movementY: 0 }, 0.002, 1),
    'pan',
  );
  assert.equal(controls.mapPanEast, -20);
  assert.equal(controls.mapPanNorth, 0);
});

test('vehicle drive follows heading and respects speed limit', () => {
  const step = stepVehicleDrive({
    dt: 1, heading: 0, speed: 0, steer: 0, drive: 1,
    groundNormalX: 0, groundNormalY: 0,
    acceleration: 20, brake: 3, steerSpeed: 1.5, maxSpeed: 12,
  });
  assert.equal(step.speed, 12);
  assert.ok(Math.abs(step.deltaX) < 1e-12);
  assert.equal(step.deltaY, 12);
});

test('suspension converges without exceeding velocity limit', () => {
  const step = stepSuspension({
    dt: 0.05, position: 0, target: 10, velocity: 0,
    frequency: 1.8, dampingRatio: 0.72, maxVelocity: 3,
  });
  assert.equal(step.velocity, 3);
  assert.ok(Math.abs(step.position - 0.15) < 1e-12);
});

test('texture retries back off and cap', () => {
  assert.equal(textureRetryDelay(1), 2000);
  assert.equal(textureRetryDelay(2), 3000);
  assert.equal(textureRetryDelay(100), 30000);
});

test('texture classification signature prevents redundant land mesh rebuilds', () => {
  const texture = { uuid: 'texture-1' };
  const mesh = { userData: { oceanColorAssisted: false, oceanTextureSig: 'texture-1' } };
  assert.equal(meshUsesTextureClassification(mesh, texture), true);
});

test('texture candidates are filtered and priority sorted', () => {
  const tiles = [
    { id: 'far', bbox: [0, 0, 1, 1], priority: 9 },
    { id: 'hot', bbox: [0, 0, 1, 1], priority: 1 },
    { id: 'cold', bbox: [0, 0, 1, 1], priority: 20 },
  ];
  const result = scoreTextureTiles(tiles, tile => tile.priority, 10);
  assert.deepEqual(result.scored.map(item => item.tile.id), ['hot', 'far']);
  assert.deepEqual([...result.tileIds], ['far', 'hot', 'cold']);
});

test('shared texture pump records HTTP 202 retry state', async () => {
  const streamer = createTextureStreamer({
    log: () => {},
    fetchImpl: async () => ({ status: 202, ok: false }),
    now: () => 100,
  });
  streamer.pump([{ tile: { id: '12-1-2', bbox: [0, 0, 1, 1] } }], {
    isCovered: () => false,
    onPlaceholder: () => assert.fail('unexpected placeholder'),
    onTexture: () => assert.fail('unexpected texture'),
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(streamer.texFetching.has('12-1-2'), true);
  assert.equal(streamer.texRetryCount.get('12-1-2'), 1);
  assert.equal(streamer.texRetryAtMs.get('12-1-2'), 2100);
});

test('shared texture pump caches successful exact texture', async () => {
  let completed = null;
  const streamer = createTextureStreamer({
    log: () => {},
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      headers: { get: name => name === 'X-Tex-Source' ? 'dataforsyningen' : null },
      blob: async () => ({}),
    }),
    decodeImage: async () => ({ width: 256, height: 256 }),
  });
  streamer.pump([{ tile: { id: '12-3-4', bbox: [0, 0, 1, 1] } }], {
    isCovered: () => false,
    onPlaceholder: () => assert.fail('unexpected placeholder'),
    onTexture: result => { completed = result; },
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(streamer.texSource.get('12-3-4'), 'dataforsyningen');
  assert.equal(completed.tileId, '12-3-4');
});

test('shared lifecycle keeps parent until all four quadrants are textured', () => {
  const parent = {
    isMesh: true,
    userData: { tileId: '10-1-1', bbox: [0, 0, 10, 10] },
    material: { map: null, dispose() {} },
    geometry: { dispose() {} },
  };
  const children = ['11-2-2', '11-2-3', '11-3-2', '11-3-3'].map(tileId => ({
    isMesh: true, userData: { tileId },
    material: { map: {}, dispose() {} }, geometry: { dispose() {} },
  }));
  const root = {
    children: [parent, children[0]],
    remove(mesh) { this.children = this.children.filter(item => item !== mesh); },
    add(mesh) { this.children.push(mesh); },
  };
  const lifecycle = createTileLifecycle({
    terrainRoot: root, disposeScatter: () => {}, log: () => {},
  });
  assert.equal(lifecycle.sweepStaleParents([], new Set(['11-2-2'])), 0);
  root.children.push(...children.slice(1));
  assert.equal(lifecycle.sweepStaleParents([], new Set(children.map(c => c.userData.tileId))), 1);
  assert.deepEqual(root.children, children);
});
