import assert from 'node:assert/strict';
import test from 'node:test';

import {
  headingForward2D,
  priorityHeading,
  terrainTilePriority,
} from './terrain-priority.js';
import { compassHeading } from './terrain-hud.js';
import { applyMapDrag } from './terrain-controls.js';
import { createVehiclePersistenceRuntime, normalizeSavedVehicleState, stepSuspension, stepVehicleDrive, vehicleLocalToLatLon, vehicleStateSnapshot } from './terrain-vehicle.js';
import { scoreTextureTiles, textureRetryDelay, tileDepthFromId } from './terrain-tile-runtime.js';
import { createTextureStreamer, rendererTextureAnisotropy } from './terrain-texture-streamer.js';
import {
  createTerrainTextureController,
  createTerrainTileReconciler,
  createTerrainTileSet,
  createTileLifecycle,
  reconcileTerrainTiles,
} from './terrain-tile-set.js';
import { createTerrainMeshBuilder, decodeTerrainHeightmap } from './terrain-mesh-builder.js';
import { applyTerrainAvailabilityStatus } from './terrain-status-controller.js';
import { collectTerrainDebugMeshes, createTerrainHoverOutlineController, createTerrainMapGridController, summarizeTerrainMesh } from './terrain-debug-runtime.js';
import { createTerrainFetchRuntime } from './terrain-fetch-runtime.js';
import { restoreTerrainCameraState, terrainCameraState } from './terrain-camera-state.js';
import { createTerrainClientLogger } from './terrain-client-logging.js';
import { createTerrainFpsCounter } from './terrain-fps-counter.js';
import { loadTerrainStartupAssets, normalizeTerrainStartupAssets } from './terrain-startup-assets.js';
import { createTerrainAtmosphereTextureRuntime } from './terrain-atmosphere-textures.js';
import { createTerrainTuningControls } from './terrain-tuning-controls.js';
import { bindTerrainCloudComposition, configureTerrainClouds, registerTerrainCloudTuning } from './terrain-cloud-runtime.js';
import { createTerrainHouseConfiguration, createTerrainHouseMarkerRuntime, createTerrainHouseModelController, disposeTerrainHouseTree, markTerrainHousesNeedSnap, terrainHouseLocalPosition, terrainHouseShadowCoverage, terrainHouseZSummary } from './terrain-house-runtime.js';
import {
  buildTerrainTilesRequest,
  adoptTerrainOrigin,
  diffTerrainTileIds,
  evaluateTerrainRefetch,
  offsetTerrainPayload,
  prioritizeTerrainBuildCandidates,
  selectTerrainFrameOffset,
  summarizeTerrainCamera,
  summarizeTerrainResponse,
  terrainCameraCoordinates,
  terrainCameraGridPosition,
  terrainCameraStereoPosition,
  terrainPipelineStatus,
} from './terrain-tile-fetch.js';

test('terrain camera persistence round-trips pose and frame state', () => {
  const saved = terrainCameraState({
    cameraLatLon: { lat: 64.1, lon: -51.2, alt: 123 },
    cameraGrid: { x: -317228.7, y: -2834379.7 },
    yaw: 0.4,
    pitch: -0.2,
    mapZoom: 900,
    terrainFrame: { originX: 1, originY: 2, offsetX: 3, offsetY: 4 },
  });
  assert.deepEqual({ gridX: saved.gridX, gridY: saved.gridY }, {
    gridX: -317228.7,
    gridY: -2834379.7,
  });
  const restored = restoreTerrainCameraState(saved, { anchorLat: 64, anchorLon: -51 });
  assert.ok(Math.abs(restored.eastM - ((-0.2) * 111320 * Math.cos(64 * Math.PI / 180))) < 1e-9);
  assert.ok(Math.abs(restored.northM - (0.1 * 111320)) < 1e-9);
  assert.deepEqual({ ...restored, eastM: 0, northM: 0 }, {
    eastM: 0,
    northM: 0,
    alt: 123,
    yaw: 0.4,
    pitch: -0.2,
    mapZoom: 900,
    terrainFrame: { originX: 1, originY: 2, offsetX: 3, offsetY: 4 },
  });
});

test('terrain camera restore rejects corrupt poses and ignores corrupt frames', () => {
  assert.equal(restoreTerrainCameraState({ lat: '64', lon: -51 }, {
    anchorLat: 64, anchorLon: -51,
  }), null);
  const restored = restoreTerrainCameraState({
    lat: 64, lon: -51, alt: null, yaw: 'bad',
    terrainFrame: { originX: 1, originY: 2, offsetX: NaN, offsetY: 4 },
  }, { anchorLat: 64, anchorLon: -51 });
  assert.equal(restored.alt, 700);
  assert.equal(restored.yaw, null);
  assert.equal(restored.terrainFrame, null);
});

test('shared client logger batches transport and records boot diagnostics', async () => {
  const listeners = new Map();
  const requests = [];
  let now = 100;
  const logger = createTerrainClientLogger({
    sceneMode: 'test-scene',
    batchSize: 2,
    windowRef: {
      addEventListener(type, callback) { listeners.set(type, callback); },
      setTimeout() { return 1; },
    },
    navigatorRef: {},
    performanceRef: {
      now: () => now,
      memory: { usedJSHeapSize: 2 * 1024 * 1024, jsHeapSizeLimit: 8 * 1024 * 1024 },
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true };
    },
  });
  logger.enqueueClientLog('info', 'one', { value: 1 });
  logger.enqueueClientLog('warn', 'two', { value: 2 });
  await Promise.resolve();
  assert.equal(requests.length, 1);
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.sceneMode, 'test-scene');
  assert.deepEqual(payload.entries.map(entry => entry.phase), ['one', 'two']);
  now = 112.5;
  logger.bootLog('ready', { tiles: 4 });
  assert.deepEqual(logger.bootEvents[0], {
    elapsedMs: 12.5,
    phase: 'ready',
    level: 'info',
    details: { tiles: 4 },
    memory: { jsHeapMB: 2, jsHeapLimitMB: 8 },
  });
  assert.ok(listeners.has('error'));
  assert.ok(listeners.has('unhandledrejection'));
  assert.ok(listeners.has('beforeunload'));
});

test('shared FPS counter excludes idle time from its sample', () => {
  const counter = createTerrainFpsCounter({ sampleMs: 500 });
  counter.start(0);
  for (let frame = 1; frame <= 31; frame += 1) counter.frame(frame * 16);
  assert.equal(counter.display, '--');
  counter.frame(512);
  assert.equal(counter.display, '63');
  counter.idle();
  assert.equal(counter.display, 'idle');
  counter.start(10_000);
  counter.frame(10_016);
  assert.equal(counter.display, '--');
});

test('startup asset normalization clones valid records and rejects junk', () => {
  const vehicle = { id: 'v1' };
  const normalized = normalizeTerrainStartupAssets({
    vehicle_definition: { model: 'truck' },
    structure_definition: null,
    vehicle_instances: [vehicle, null, 'bad'],
    structure_instances: [{ id: 's1' }, 4],
  });
  assert.deepEqual(normalized, {
    vehicle_definition: { model: 'truck' },
    structure_definition: {},
    vehicle_instances: [{ id: 'v1' }],
    structure_instances: [{ id: 's1' }],
  });
  assert.notEqual(normalized.vehicle_instances[0], vehicle);
});

test('shared startup asset loader preserves metadata and clears timeout', async () => {
  const logs = [];
  const cleared = [];
  const result = await loadTerrainStartupAssets({
    endpoint: '/assets',
    timeoutMs: 25,
    bootLog: (...args) => logs.push(args),
    setTimeoutImpl: () => 7,
    clearTimeoutImpl: handle => cleared.push(handle),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        source: 'database', schemaVersion: 9, seeded: true,
        vehicle_instances: [{ id: 'v1' }], structure_instances: [{ id: 's1' }],
      }),
    }),
  });
  assert.equal(result.source, 'database');
  assert.equal(result.schemaVersion, 9);
  assert.deepEqual(cleared, [7]);
  assert.equal(logs[0][0], 'assets.fetch.ok');
  assert.equal(logs[0][1].vehicleCount, 1);
  assert.equal(logs[0][1].structureCount, 1);
});

test('shared startup asset loader returns complete defaults on failure', async () => {
  const previousWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await loadTerrainStartupAssets({
      endpoint: '/assets',
      AbortControllerImpl: undefined,
      fetchImpl: async () => ({ ok: false, status: 503 }),
    });
    assert.deepEqual(result, {
      source: 'defaults', schemaVersion: 4, seeded: null,
      vehicle_definition: {}, structure_definition: {},
      vehicle_instances: [], structure_instances: [],
    });
  } finally {
    console.warn = previousWarn;
  }
});

test('shared atmosphere texture runtime caches LUTs and applies them to both targets', async () => {
  const cachedResponse = {
    ok: true,
    clone() { return this; },
    async blob() { return { size: 7 }; },
  };
  const networkResponse = {
    ok: true,
    clone() { return this; },
    async blob() { return { size: 11 }; },
  };
  const stored = [];
  const objectUrls = [];
  const revoked = [];
  const targets = [{}, {}];
  const runtime = createTerrainAtmosphereTextureRuntime({
    baseUrl: '/atmosphere', cacheName: 'lut-cache', fileNames: ['a.exr', 'b.exr'],
    targets,
    testOverrides: {
      LoadingManager: class {},
      PrecomputedTexturesLoader: class {},
      window: { caches: true },
      caches: { async open(name) {
        assert.equal(name, 'lut-cache');
        return {
          async match(url) { return url.endsWith('/a.exr') ? cachedResponse : null; },
          async put(url, response) { stored.push([url, response]); },
        };
      } },
      async fetch(url) {
        assert.equal(url, '/atmosphere/b.exr');
        return networkResponse;
      },
      URL: {
        createObjectURL(blob) { const url = `blob:${blob.size}`; objectUrls.push(url); return url; },
        revokeObjectURL(url) { revoked.push(url); },
      },
    },
  });

  const prepared = await runtime.prepareUrlMap();
  assert.equal(prepared.cacheHits, 1);
  assert.equal(prepared.networkHits, 1);
  assert.deepEqual(objectUrls, ['blob:7', 'blob:11']);
  assert.deepEqual(stored, [['/atmosphere/b.exr', networkResponse]]);
  runtime.apply({ transmittance: 'texture' });
  assert.deepEqual(targets, [{ transmittance: 'texture' }, { transmittance: 'texture' }]);
  runtime.revokeObjectUrls(prepared.urlMap);
  assert.deepEqual(revoked, objectUrls);
});

test('shared tuning controls initialize, persist, update, and reset widgets', () => {
  const elements = [];
  const documentImpl = { createElement(tagName) {
    const element = {
      tagName, style: {}, children: [],
      append(...children) { this.children.push(...children); },
      appendChild(child) { this.children.push(child); },
    };
    elements.push(element);
    return element;
  } };
  const body = documentImpl.createElement('section');
  const state = { exposure: 2, clouds: false };
  const changes = [];
  let saves = 0;
  const tuning = createTerrainTuningControls({
    body, state, documentImpl, save: () => { saves += 1; },
  });
  const section = tuning.section('Clouds');
  assert.equal(section.textContent, 'Clouds');
  const slider = tuning.slider('exposure', {
    value: 1, min: 0, max: 4, step: 0.1, decimals: 1,
    onChange: value => changes.push(['exposure', value]),
  });
  const toggle = tuning.toggle('clouds', {
    value: true, onChange: value => changes.push(['clouds', value]),
  });
  assert.deepEqual(changes, [['exposure', 2], ['clouds', false]]);

  slider.value = '3.5';
  slider.oninput();
  toggle.checked = true;
  toggle.onchange();
  assert.deepEqual(state, { exposure: 3.5, clouds: true });
  assert.equal(saves, 2);

  tuning.setSliderValue('exposure', 2.25);
  assert.equal(slider.value, 2.25);
  tuning.reset();
  assert.equal(slider.value, 1);
  assert.equal(toggle.checked, true);
  assert.deepEqual(changes.slice(-2), [['exposure', 1], ['clouds', true]]);
});

test('shared cloud runtime configures layers and synchronizes atmosphere composition', () => {
  const vector = () => ({ values: [], set(...values) { this.values = values; } });
  const listeners = new Map();
  const effect = {
    cloudLayers: Array.from({ length: 4 }, () => ({})),
    localWeatherVelocity: vector(), shapeVelocity: vector(), shapeDetailVelocity: vector(),
    shadow: {}, scatteringCoefficient: 2, absorptionCoefficient: 3,
    atmosphereOverlay: 'overlay', atmosphereShadow: 'shadow', atmosphereShadowLength: 42,
    events: {
      addEventListener(type, listener) { listeners.set(type, listener); },
      removeEventListener(type, listener) {
        if (listeners.get(type) === listener) listeners.delete(type);
      },
    },
  };
  class LocalWeather {}
  class CloudShape {}
  class CloudShapeDetail {}
  class Turbulence {}
  assert.deepEqual(configureTerrainClouds({
    effect, LocalWeather, CloudShape, CloudShapeDetail, Turbulence,
  }), { scattering: 2, absorption: 3 });
  assert.deepEqual(effect.cloudLayers.map(layer => layer.altitude), [1550, 1800, 8300, 9100]);
  assert.equal(effect.cloudLayers[3].densityScale, 0);
  assert.deepEqual(effect.localWeatherVelocity.values, [0.00004, 0]);
  assert.ok(effect.localWeatherTexture instanceof LocalWeather);

  const aerial = {};
  const binding = bindTerrainCloudComposition(effect, aerial);
  assert.deepEqual(aerial, { overlay: 'overlay', shadow: 'shadow', shadowLength: 42 });
  effect.atmosphereShadowLength = 84;
  listeners.get('change')({ property: 'atmosphereShadowLength' });
  assert.equal(aerial.shadowLength, 84);
  binding.dispose();
  assert.equal(listeners.has('change'), false);
});

test('shared cloud tuning registers controls and applies altitude, cirrus, and drift changes', () => {
  const definitions = new Map();
  const sections = [];
  const effect = {
    coverage: 0.28,
    cloudLayers: [1550, 1800, 8300, 9100].map(altitude => ({
      altitude, densityScale: 0, weatherExponent: 1, shapeAmount: 0.3,
    })),
    localWeatherVelocity: { values: [], set(...values) { this.values = values; } },
  };
  const controls = {};
  registerTerrainCloudTuning({
    effect, controls,
    section: label => sections.push(label),
    slider: (label, options) => { definitions.set(label, options); return { label }; },
    toggle: (label, options) => { definitions.set(label, options); return { label }; },
  });
  assert.deepEqual(sections, ['Clouds']);
  assert.equal(definitions.size, 8);
  assert.equal(controls._cirrusCheckbox.label, 'cirrus');

  definitions.get('cloud altitude').onChange(-2000);
  assert.deepEqual(effect.cloudLayers.map(layer => layer.altitude), [0, 0, 6300, 7100]);
  definitions.get('cirrus').onChange(true);
  assert.equal(effect.cloudLayers[3].densityScale, 0.004);
  definitions.get('drift speed').onChange(0.001);
  definitions.get('drift direction').onChange(90);
  assert.ok(Math.abs(effect.localWeatherVelocity.values[0]) < 1e-12);
  assert.ok(Math.abs(effect.localWeatherVelocity.values[1] - 0.001) < 1e-12);
});

test('shared house configuration and placement preserve terrain conventions', () => {
  const logs = [];
  const configured = createTerrainHouseConfiguration({
    definition: { url: ' house.glb ', enabled: true, altOffsetM: 2, hotReloadMs: 100 },
    instances: [{ id: 'h1' }], source: 'database', bootLog: (...args) => logs.push(args),
  });
  assert.deepEqual(configured.model, {
    url: 'house.glb', altOffsetM: 2, hotReloadMs: 500, enabled: true,
  });
  assert.deepEqual(configured.sites, [{ id: 'h1' }]);
  assert.equal(logs.length, 0);
  const local = terrainHouseLocalPosition(64.1, -51.2, 64, -51);
  assert.ok(Math.abs(local.y - 11132) < 1e-9);
});

test('shared house shadow coverage bounds loaded instances', () => {
  const houses = [
    { group: { position: { x: 0, y: 10, z: 2 } } },
    { group: { position: { x: 100, y: 30, z: 4 } } },
  ];
  assert.deepEqual(terrainHouseShadowCoverage(houses, {
    baseRadius: 50, radiusPadding: 10, maxRadius: 500,
  }), {
    centerX: 50, centerY: 20, centerZ: 3,
    minX: 0, minY: 10, maxX: 100, maxY: 30, shadowRadius: 120,
  });
});

test('shared house marker runtime creates and updates instance records', () => {
  const children = [];
  const markerChildren = [];
  const runtime = createTerrainHouseMarkerRuntime({
    documentRef: { createElement: () => ({ width: 0, height: 0, getContext: () => null }) },
    markerHeight: 100,
    baseLift: 5,
    colors: [0xff0000],
  });
  const { instances, byId } = runtime.createHouseInstances({
    sites: [{ id: 'nuuk-h1', tileId: '12-1-2' }],
    houseLayer: { add: value => children.push(value) },
    markerLayer: { add: value => markerChildren.push(value) },
  });
  assert.equal(instances.length, 1);
  assert.equal(byId.get('nuuk-h1'), instances[0]);
  assert.equal(children[0].name, 'house-nuuk-h1');
  assert.equal(markerChildren[0].name, 'house-marker-nuuk-h1');
  instances[0].group.position.set(10, 20, 30);
  runtime.updateHouseMarkerPosition(instances[0]);
  assert.deepEqual(instances[0].marker.position.toArray(), [10, 20, 35]);
});

test('shared house model controller rejects stale loads and reloads changed assets', async () => {
  const loads = [];
  const templates = [];
  let signature = 'a';
  const controller = createTerrainHouseModelController({
    model: { enabled: true, url: '/house.glb', hotReloadMs: 10 },
    loader: { load: (url, success) => loads.push({ url, success }) },
    instanceCount: 2,
    now: () => 123,
    onTemplate: template => templates.push(template),
    fetchImpl: async () => ({
      ok: true,
      headers: { get: name => name === 'etag' ? signature : '' },
    }),
  });
  controller.load('first');
  controller.load('second');
  loads[0].success({ scene: 'stale' });
  loads[1].success({ scene: 'current' });
  assert.deepEqual(templates, ['current']);
  await controller.updateHotReload(10);
  signature = 'b';
  await controller.updateHotReload(20);
  assert.equal(loads.length, 3);
  assert.equal(loads[2].url, '/house.glb?cb=123');
});

test('shared house disposal and snap summaries preserve lifecycle state', () => {
  let geometryDisposals = 0;
  let materialDisposals = 0;
  const material = { dispose: () => { materialDisposals += 1; } };
  const geometry = { dispose: () => { geometryDisposals += 1; } };
  disposeTerrainHouseTree({
    traverse(callback) {
      callback({ isMesh: true, geometry, material });
      callback({ isMesh: true, geometry, material });
    },
  }, new Set(), new Set());
  assert.equal(geometryDisposals, 1);
  assert.equal(materialDisposals, 1);
  const houses = [{
    site: { id: 'h1', lat: 1, lon: 2, tileId: '3-4-5' },
    group: { position: { z: 7.125 } }, snapPending: false,
  }];
  assert.equal(terrainHouseZSummary(houses)[0].z, 7.125);
  markTerrainHousesNeedSnap(houses);
  assert.equal(houses[0].snapPending, true);
});

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
    requestGridX: null, requestGridY: null,
    headingRad: 0.5, maxDepth: 10, camEastM: 3,
  });
});

test('terrain full request reuses a restored frame', () => {
  const request = buildTerrainTilesRequest({
    lat: 64, lon: -51, altitude: 50, heading: 0, range: 40000,
    pass: 2, previewMaxDepth: 10, isFirstLoad: true,
    frameOffsetReady: true, originX: -12.5, originY: 99.25,
    queryX: 123.5, queryY: -456.25,
  });
  assert.equal(request.url, '/api/tiles?sx=123.5&sy=-456.25&alt=50&heading=0&range=40000&ox=-12.5&oy=99.25');
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
  const reconcile = createTerrainTileReconciler({
    terrainRoot,
    deferredTiles,
    lifecycle: { sweepStaleParents: () => 0 },
    priorityForTile: tile => tile.priority,
    textureCache: new Map(),
    meshRuntime: { materialize: () => assert.fail('unexpected materialize') },
    buildMesh: tile => {
      built.push(tile.id);
      return {
        isMesh: true, userData: { tileId: tile.id, bbox: tile.bbox },
        material: { map: null },
      };
    },
    log: () => {},
    buildBudget: 1,
  });
  const result = reconcile([
      { id: 'far', bbox: [10, 10, 11, 11], heightmap: 'hm', priority: 9 },
      { id: 'hot', bbox: [0, 0, 1, 1], heightmap: 'hm', priority: 1 },
    ], new Set(), {
    onDiff: details => { diffDetails = details; },
  });
  assert.deepEqual(built, ['hot']);
  assert.deepEqual([...deferredTiles.keys()], ['hot', 'far']);
  assert.equal(result.sceneMeshes, 1);
  assert.deepEqual(diffDetails, { added: 2, removed: 0, purgedDeferred: 0, sceneMeshes: 0 });
});

test('terrain tile set owns reconciliation, scene residency, and texture demand', () => {
  const terrainRoot = {
    children: [],
    add(mesh) { this.children.push(mesh); },
    remove(mesh) { this.children = this.children.filter(child => child !== mesh); },
  };
  const textureRequests = [];
  const textureStreamer = {
    texCache: new Map(),
    texSource: new Map(),
    pump(scored) { textureRequests.push(...scored.map(item => item.tile.id)); },
  };
  const tileSet = createTerrainTileSet({
    terrainRoot,
    textureStreamer,
    terrain: {},
    renderBackend: {},
    view: { controls: { mapMode: false } },
    log() {},
    testOverrides: {
      buildMesh: tile => ({
        isMesh: true,
        userData: { tileId: tile.id, bbox: tile.bbox },
        material: {
          map: null,
          color: { value: null, set(value) { this.value = value; } },
          dispose() {},
        },
        geometry: { dispose() {} },
      }),
      priorityForTile: () => 0,
      getVisibilityDistance: () => 1000,
      createDesaturatedTexture: source => ({ source, desaturated: true, dispose() {} }),
    },
  });
  const tile = { id: '1-0-0', bbox: [0, 0, 1, 1], heightmap: 'hm' };
  const baseTexture = { disposed: false, dispose() { this.disposed = true; } };
  const reconciliation = tileSet.reconcile([tile]);
  tileSet.updateTextures([tile]);
  assert.equal(terrainRoot.children.length, 1);
  assert.equal(tileSet.deferredTiles.get(tile.id), tile);
  assert.equal(tileSet.currentTileIds, reconciliation.nextTileIds);
  assert.deepEqual(textureRequests, [tile.id]);

  terrainRoot.children[0].material.map = baseTexture;
  terrainRoot.children[0].userData.terrainBaseTexture = baseTexture;
  assert.equal(terrainRoot.children[0].material.map, baseTexture);
  assert.equal(tileSet.setClassifierMode(true), true);
  assert.equal(terrainRoot.children[0].material.map.desaturated, true);
  assert.equal(terrainRoot.children[0].material.map.source, baseTexture);
  const classifierTexture = { classifier: true };
  tileSet.setClassifierTexture(tile.id, classifierTexture);
  assert.equal(terrainRoot.children[0].material.map, classifierTexture);
  tileSet.setClassifierTexture(tile.id, null);
  assert.equal(terrainRoot.children[0].material.map.desaturated, true);
  assert.equal(tileSet.setClassifierMode(false), false);
  assert.equal(terrainRoot.children[0].material.map, baseTexture);
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
  assert.deepEqual(terrainCameraGridPosition({
    eastM: 16009.6, northM: -11162.2,
    originX: -335838.3, originY: -2826817.5,
    frameOffsetX: -2600, frameOffsetY: -3600,
  }), { x: -317228.7, y: -2834379.7 });
});

test('shared terrain refetch decision enforces distance and trigger interval', () => {
  assert.deepEqual(evaluateTerrainRefetch({
    cameraX: 6000, cameraY: 0, lastFetchX: 0, lastFetchY: 0,
    nowMs: 1000, lastTriggerMs: 0, distanceThreshold: 5000, triggerIntervalMs: 500,
  }), { distance: 6000, shouldFetch: true, nextTriggerMs: 1000 });
  assert.equal(evaluateTerrainRefetch({
    cameraX: 7000, cameraY: 0, lastFetchX: 0, lastFetchY: 0,
    nowMs: 1200, lastTriggerMs: 1000, distanceThreshold: 5000, triggerIntervalMs: 500,
  }).shouldFetch, false);
  assert.equal(evaluateTerrainRefetch({
    cameraX: 100, cameraY: 0, lastFetchX: 0, lastFetchY: 0,
    nowMs: 5000, lastTriggerMs: 0, distanceThreshold: 5000, triggerIntervalMs: 500,
  }).shouldFetch, false);
});

test('shared camera coordinates and log summary use one ENU conversion', () => {
  const vector = (x, y, z) => ({
    x, y, z,
    clone() { return vector(this.x, this.y, this.z); },
    sub(other) { this.x -= other.x; this.y -= other.y; this.z -= other.z; return this; },
    dot(other) { return this.x * other.x + this.y * other.y + this.z * other.z; },
  });
  const coordinates = terrainCameraCoordinates({
    position: vector(10, 20, 30), anchorPosition: vector(0, 0, 0),
    east: vector(1, 0, 0), north: vector(0, 1, 0), up: vector(0, 0, 1),
    anchorLatitude: 64, anchorLongitude: -51, originX: 100, originY: 200,
  });
  assert.equal(coordinates.eastM, 10);
  assert.equal(coordinates.northM, 20);
  assert.equal(coordinates.alt, 30);
  const summary = summarizeTerrainCamera(coordinates, {
    originX: 100, originY: 200, frameOffsetX: 10, frameOffsetY: 20,
    frameOffsetReady: true,
  });
  assert.equal(summary.camEastM, 10);
  assert.equal(summary.camNorthM, 20);
  assert.equal(summary.camStereoApproxX, 110);
  assert.equal(summary.camStereoApproxY, 220);
});

function createTestFetchRuntime({ fetchImpl, onSkip, ...options } = {}) {
  const state = {
    loadPass: 1, fetching: false, firstLoad: true, frameOffsetReady: false,
    frameOffsetX: 0, frameOffsetY: 0, originX: 0, originY: 0,
    cameraStereoX: 0, cameraStereoY: 0, lastFetchX: 0, lastFetchY: 0,
    currentTileIds: new Set(), lastTiles: null, bootFetchLogged: false,
  };
  const terrainRoot = { children: [] };
  const deferredTiles = new Map();
  const runtime = createTerrainFetchRuntime({
    state,
    previewMaxDepth: 10,
    view: { anchorLatitude: 64, anchorLongitude: -51 },
    vehicle: {},
    testOverrides: {
      getCameraCoordinates: () => ({ lat: 64, lon: -51, alt: 100 }),
      getCameraSnapshot: () => ({ camEastM: 0, camNorthM: 0 }),
      getCameraLocalPosition: () => ({ x: 0, y: 0 }),
      getHeading: () => 0,
      getRange: () => 1000,
    },
    terrain: {
      reconcile: (tiles, { onDiff }) => reconcileTerrainTiles({
        tiles, currentTileIds: state.currentTileIds, terrainRoot, deferredTiles,
        lifecycle: { sweepStaleParents: () => 0 },
        priorityForTile: () => 0, textureCache: new Map(),
        materialize() {}, buildMesh() {}, log() {}, onDiff,
      }),
      updateTextures() {},
    },
    logger: { enqueue() {}, boot() {} },
    events: { onSkip },
    fetchImpl,
    ...options,
  });
  return { runtime, state };
}

test('shared fetch runtime serializes preview, full pass, and polling', async () => {
  const passes = [];
  let frameCallback = null;
  let pollCallback = null;
  const responseData = () => ({
    ox: 0, oy: 0, qx: 0, qy: 0, tiles: [],
    missing: passes.length > 1 ? [{}] : [], downloading: [], texFetching: 0,
  });
  const { runtime, state } = createTestFetchRuntime({
    fetchImpl: async () => {
      passes.push(state.loadPass);
      return { status: 200, json: async () => responseData() };
    },
    scheduleFrame: callback => { frameCallback = callback; },
    schedulePoll: callback => { pollCallback = callback; return 7; },
    cancelPoll: () => {},
  });
  await runtime.request();
  assert.deepEqual(passes, [1]);
  assert.equal(state.loadPass, 2);
  await frameCallback();
  assert.deepEqual(passes, [1, 2]);
  assert.equal(typeof pollCallback, 'function');
  await pollCallback();
  assert.deepEqual(passes, [1, 2, 2]);
});

test('shared fetch runtime rejects overlapping requests', async () => {
  let release;
  let skips = 0;
  const { runtime } = createTestFetchRuntime({
    fetchImpl: () => new Promise(resolve => { release = resolve; }),
    onSkip: () => { skips += 1; },
  });
  const first = runtime.request();
  await runtime.request();
  assert.equal(skips, 1);
  release({ status: 200, json: async () => ({
    ox: 0, oy: 0, qx: 0, qy: 0, tiles: [], missing: [], downloading: [], texFetching: 0,
  }) });
  await first;
});

test('reset aborts the active terrain generation and ignores its completion', async () => {
  let activeSignal = null;
  let release;
  const { runtime, state } = createTestFetchRuntime({
    fetchImpl: (_url, { signal }) => {
      activeSignal = signal;
      return new Promise(resolve => { release = resolve; });
    },
  });
  const request = runtime.request();
  runtime.reset(1);
  assert.equal(activeSignal.aborted, true);
  release({ status: 200, json: async () => ({
    ox: 0, oy: 0, qx: 0, qy: 0, tiles: [], missing: [], downloading: [], texFetching: 0,
  }) });
  await request;
  assert.equal(state.loadPass, 1);
  assert.equal(state.fetching, false);
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
      texCache: textures, texSource: new Map(),
      pump() {},
    },
    meshRuntime: {
      materialize(id) { materialized.push(id); deferredTiles.delete(id); },
    },
    lifecycle: { evictCoveredAncestors() {}, sweepStaleParents() {} },
    priorityForTile: () => 0, getVisibilityDistance: () => 1000,
    isCovered: () => false, applyMaterial() {},
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

test('shared texture controller discards late arrivals outside current heatmap demand', () => {
  let callbacks = null;
  let disposed = 0;
  const lateTexture = { dispose: () => { disposed += 1; } };
  const textureCache = new Map([['late', lateTexture]]);
  const textureSource = new Map([['late', 'source']]);
  const controller = createTerrainTextureController({
    terrainRoot: { children: [] }, deferredTiles: new Map(),
    textureStreamer: {
      texCache: textureCache, texSource: textureSource,
      pump(_scored, nextCallbacks) { callbacks = nextCallbacks; },
    },
    meshRuntime: { materialize() {} },
    lifecycle: { evictCoveredAncestors() {}, sweepStaleParents() {} },
    priorityForTile: () => 0, getVisibilityDistance: () => 1000,
    isCovered: () => false, applyMaterial() {}, log() {},
    scheduleFrame() {},
  });
  controller([{ id: 'wanted', bbox: [0, 0, 1, 1] }]);
  callbacks.onTexture({ tileId: 'late', tile: { id: 'late' }, texture: lateTexture });
  assert.equal(textureCache.has('late'), false);
  assert.equal(textureSource.has('late'), false);
  assert.equal(disposed, 1);
});

test('ancestor crops materialize deferred child slots and yield to exact textures', () => {
  const tile = { id: '12-2-2', bbox: [0, 0, 1, 1] };
  const deferredTiles = new Map([[tile.id, tile]]);
  const terrainRoot = { children: [] };
  const textureCache = new Map();
  const frames = [];
  let callbacks;
  let ancestorEvictions = 0;
  const placeholder = {
    disposed: false,
    dispose() { this.disposed = true; },
  };
  const exact = {};
  const applyMaterial = (mesh, texture) => { mesh.material.map = texture; };
  const controller = createTerrainTextureController({
    terrainRoot,
    deferredTiles,
    textureStreamer: {
      texCache: textureCache,
      texSource: new Map(),
      pump(_scored, nextCallbacks) { callbacks = nextCallbacks; },
    },
    meshRuntime: {
      materialize(tileId, texture) {
        const mesh = { userData: { tileId }, material: { map: texture } };
        deferredTiles.delete(tileId);
        terrainRoot.children.push(mesh);
        return mesh;
      },
    },
    lifecycle: {
      evictCoveredAncestors() { ancestorEvictions += 1; },
      sweepStaleParents() {},
    },
    priorityForTile: () => 0,
    getVisibilityDistance: () => 1000,
    applyMaterial,
    log() {},
    scheduleFrame: callback => frames.push(callback),
  });

  controller([tile]);
  callbacks.onPlaceholder({ tileId: tile.id, tile, texture: placeholder });
  assert.equal(deferredTiles.has(tile.id), false);
  assert.equal(terrainRoot.children[0].material.map, placeholder);
  assert.equal(ancestorEvictions, 1);

  textureCache.set(tile.id, exact);
  callbacks.onTexture({ tileId: tile.id, tile, texture: exact });
  frames.shift()();
  assert.equal(terrainRoot.children[0].material.map, exact);
  assert.equal(placeholder.disposed, true);
  assert.equal(terrainRoot.children[0].userData.terrainPlaceholderTexture, undefined);
});

test('shared terrain mesh builder preserves heightmap geometry and metadata', () => {
  const source = new Float32Array([1, 2, 3, 4]);
  const encoded = Buffer.from(source.buffer).toString('base64');
  assert.deepEqual([...decodeTerrainHeightmap(encoded)], [1, 2, 3, 4]);
  let scatterHeightmap = null;
  const build = createTerrainMeshBuilder({
    exaggeration: 2,
    attachScatter: (_mesh, _tile, heightmap) => { scatterHeightmap = heightmap; },
  });
  const mesh = build({
    id: '1-2-3', resolution: 2, bbox: [10, 20, 12, 22], heightmap: encoded,
  });
  assert.deepEqual([...mesh.geometry.attributes.position.array], [
    10, 20, 2, 12, 20, 4, 10, 22, 6, 12, 22, 8,
  ]);
  assert.equal(mesh.userData.tileId, '1-2-3');
  assert.deepEqual([...scatterHeightmap], [1, 2, 3, 4]);
});

test('shared availability status skips textured meshes and prioritizes downloading', () => {
  const meshes = ['downloading', 'missing', 'textured'].map(tileId => ({
    isMesh: true, userData: { tileId }, material: { map: tileId === 'textured' ? {} : null },
  }));
  const applied = [];
  const changed = applyTerrainAvailabilityStatus({
    terrainRoot: { children: meshes },
    missing: [{ id: 'downloading' }, { id: 'missing' }, { id: 'textured' }],
    downloading: ['downloading'],
    applyStatus: (mesh, status) => applied.push([mesh.userData.tileId, status]),
  });
  assert.equal(changed, 2);
  assert.deepEqual(applied, [['downloading', 'downloading'], ['missing', 'missing']]);
});

test('shared terrain debug metadata remains deterministic', () => {
  const mesh = {
    isMesh: true,
    userData: { tileId: 'tile', bbox: [0, 0, 1, 1] },
    material: { map: { image: { width: 256, height: 128 } }, color: { getHexString: () => 'abcdef' } },
  };
  const root = {
    children: [mesh],
    traverse(callback) { callback(mesh); },
  };
  assert.deepEqual(collectTerrainDebugMeshes(root), [mesh]);
  assert.deepEqual(summarizeTerrainMesh(mesh), {
    tileId: 'tile', hasTexture: true, textureSize: '256x128',
    color: '#abcdef', bbox: [0, 0, 1, 1],
  });
});

test('shared terrain hover outline owns replacement and cleanup', () => {
  const root = {
    children: [],
    add(child) { this.children.push(child); },
    remove(child) { this.children = this.children.filter(item => item !== child); },
  };
  let changes = 0;
  const hover = createTerrainHoverOutlineController({
    terrainRoot: root,
    onChanged: () => { changes += 1; },
  });
  const mesh = { userData: { tileId: 'tile', bbox: [0, 0, 10, 20] } };
  assert.equal(hover.show(mesh), true);
  assert.equal(root.children.length, 1);
  assert.equal(hover.show(mesh), false);
  assert.equal(changes, 1);
  assert.equal(hover.show(null), true);
  assert.equal(root.children.length, 0);
  assert.equal(changes, 2);
});

test('map grid uses the exact rendered mesh bounds', () => {
  const root = {
    children: [],
    add(child) { this.children.push(child); },
    remove(child) { this.children = this.children.filter(item => item !== child); },
  };
  const grid = createTerrainMapGridController({ terrainRoot: root });
  const meshes = [
    { userData: { tileId: 'parent', bbox: [0, 0, 8, 8] } },
    { userData: { tileId: 'child', bbox: [8, 0, 12, 4] } },
  ];
  grid.setVisible(true);
  assert.equal(grid.update(meshes), true);
  assert.equal(grid.lines.geometry.attributes.position.count, 16);
  assert.equal(grid.lines.visible, true);
  assert.equal(grid.update(meshes), false);
  grid.setVisible(false);
  assert.equal(grid.lines.visible, false);
  grid.dispose();
  assert.equal(root.children.length, 0);
});

test('shared fetch runtime preserves initial response transition ordering', async () => {
  const events = [];
  const state = {
    loadPass: 1, firstLoad: true, frameOffsetReady: false,
    frameOffsetX: 0, frameOffsetY: 0, originX: 0, originY: 0,
    cameraStereoX: 0, cameraStereoY: 0, lastFetchX: 0, lastFetchY: 0,
    currentTileIds: new Set(), lastTiles: null, bootFetchLogged: false,
    heightmapsMissing: 0, heightmapsDownloading: 0,
    serverTexturesFetching: 0, serverTexturesRetrying: 0, serverTextureStatus: {},
  };
  const terrainRoot = { children: [] };
  const deferredTiles = new Map();
  const runtime = createTerrainFetchRuntime({
    state,
    previewMaxDepth: 10,
    view: { anchorLatitude: 64, anchorLongitude: -51 },
    vehicle: {},
    testOverrides: {
      getCameraCoordinates: () => ({ lat: 64, lon: -51, alt: 100 }),
      getCameraSnapshot: () => ({ camEastM: 5, camNorthM: 6, camStereoApproxX: 10, camStereoApproxY: 20 }),
      getCameraLocalPosition: () => ({ x: 5, y: 6 }),
      getHeading: () => 0,
      getRange: () => 1000,
    },
    terrain: {
      reconcile: (tiles, { onDiff }) => reconcileTerrainTiles({
        tiles, currentTileIds: state.currentTileIds, terrainRoot, deferredTiles,
        lifecycle: { sweepStaleParents: () => 0 },
        priorityForTile: () => 0, textureCache: new Map(),
        materialize() {}, buildMesh() {}, log() {}, onDiff,
      }),
      updateTextures() { events.push('textures'); },
    },
    logger: {
      enqueue(_level, name) { events.push(name); },
      boot(name) { events.push(name); },
    },
    events: { onAvailability() { events.push('missing'); } },
    fetchImpl: async () => ({
      status: 200,
      json: async () => ({
        ox: 10, oy: 20, qx: 11, qy: 21, tiles: [], missing: [], downloading: [],
        texFetching: 0, texRetryQueue: 0, texStatusCounts: {},
      }),
    }),
    now: () => 100,
  });
  const result = await runtime.execute({ pass: 1 });
  assert.equal(result.nextAction, 'full-pass');
  assert.equal(state.firstLoad, false);
  assert.equal(state.originX, 10);
  assert.deepEqual(events, [
    'fetchTiles.request[pass1]', 'fetchTiles.frame.offset.set',
    'fetchTiles.response[pass1]', 'tiles.initial-fetch.response',
    'fetchTiles.origin.set', 'fetchTiles.diff[pass1]', 'fetchTiles.built[pass1]',
    'textures', 'missing',
  ]);
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

test('shared vehicle persistence helpers preserve coordinates and normalize saved state', () => {
  const anchorLat = 64;
  const anchorLon = -51;
  const local = vehicleLocalToLatLon(111320 * Math.cos(anchorLat * Math.PI / 180), 111320, anchorLat, anchorLon);
  assert.ok(Math.abs(local.lat - 65) < 1e-12);
  assert.ok(Math.abs(local.lon - -50) < 1e-12);

  assert.equal(vehicleStateSnapshot({
    loaded: false, position: { x: 0, y: 0, z: 0 }, headingRad: 0, anchorLat, anchorLon,
  }), null);
  assert.deepEqual(vehicleStateSnapshot({
    loaded: true,
    position: { x: 0, y: 0, z: 12.3456 },
    headingRad: -Math.PI / 2,
    anchorLat,
    anchorLon,
  }), { lat: 64, lon: -51, headingDeg: 270, z: 12.346 });

  assert.deepEqual(normalizeSavedVehicleState({
    lat: '64.1', lon: '-51.2', headingDeg: '361.5', z: '8.25', terrainDepth: '7.9',
  }), { lat: 64.1, lon: -51.2, headingDeg: 361.5, z: 8.25, terrainDepth: 7 });
  assert.deepEqual(normalizeSavedVehicleState({
    lat: 64, lon: -51, headingDeg: 0, z: 'bad', terrainDepth: -2,
  }), { lat: 64, lon: -51, headingDeg: 0, z: null, terrainDepth: 0 });
  assert.equal(normalizeSavedVehicleState({ lat: 64, lon: 'bad', headingDeg: 0 }), null);
});

test('shared vehicle persistence runtime posts snapshots, throttles saves, and cools down failures', async () => {
  let dateMs = 1000;
  let performanceMs = 6000;
  let timerId = 0;
  const timers = new Map();
  const requests = [];
  const logs = [];
  let shouldFail = false;
  const runtime = createVehiclePersistenceRuntime({
    endpoint: '/vehicle', timeoutMs: 1500, failureCooldownMs: 5000,
    throttleMs: 5000, trailingMs: 2000,
    createSnapshot: () => ({ lat: 64, lon: -51, z: 8 }),
    dateNow: () => dateMs,
    performanceNow: () => performanceMs,
    setTimeoutImpl(callback, delay) {
      timerId += 1; timers.set(timerId, { callback, delay }); return timerId;
    },
    clearTimeoutImpl(id) { timers.delete(id); },
    AbortControllerImpl: null,
    bootLog: (...args) => logs.push(args),
    async fetchImpl(url, options) {
      requests.push([url, JSON.parse(options.body)]);
      return shouldFail
        ? { ok: false, status: 503, async text() { return 'offline'; } }
        : { ok: true, status: 200 };
    },
  });

  assert.equal(await runtime.save('manual'), true);
  assert.deepEqual(requests[0], ['/vehicle', { lat: 64, lon: -51, z: 8, reason: 'manual' }]);
  runtime.throttledSave();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests[1][1].reason, 'drive-throttle');
  const trailing = [...timers.values()].find(timer => timer.delay === 2000);
  performanceMs = 7000;
  trailing.callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests[2][1].reason, 'drive-trailing');

  shouldFail = true;
  assert.equal(await runtime.save('failure'), false);
  assert.equal(logs.at(-1)[0], 'vehicle.state.save.error');
  const requestCount = requests.length;
  assert.equal(await runtime.save('cooldown'), false);
  assert.equal(requests.length, requestCount);
  dateMs += 5001;
  shouldFail = false;
  assert.equal(await runtime.save('recovered'), true);
  assert.equal(logs.at(-1)[0], 'vehicle.state.save.recovered');
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

test('shared tile depth parsing rejects malformed ids', () => {
  assert.equal(tileDepthFromId('12-1400-700'), 12);
  assert.equal(tileDepthFromId('bad'), -1);
  assert.equal(tileDepthFromId(null), -1);
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

test('texture heatmap refines equivalent coverage before coarse parents', () => {
  const tiles = [
    { id: '8-87-48', bbox: [0, 0, 4, 4], priority: 5.0 },
    { id: '11-699-390', bbox: [1, 1, 3, 3], priority: 5.1 },
    { id: '12-1398-780', bbox: [1, 1, 2, 2], priority: 5.2 },
    { id: '12-2000-2000', bbox: [10, 10, 11, 11], priority: 5.6 },
  ];
  const result = scoreTextureTiles(tiles, tile => tile.priority, 10);
  assert.deepEqual(result.scored.map(item => item.tile.id), [
    '12-1398-780', '11-699-390', '8-87-48', '12-2000-2000',
  ]);
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
    getTextureAnisotropy: () => 16,
  });
  streamer.pump([{ tile: { id: '12-3-4', bbox: [0, 0, 1, 1] } }], {
    isCovered: () => false,
    onPlaceholder: () => assert.fail('unexpected placeholder'),
    onTexture: result => { completed = result; },
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(streamer.texSource.get('12-3-4'), 'dataforsyningen');
  assert.equal(completed.tileId, '12-3-4');
  assert.equal(completed.texture.generateMipmaps, true);
  assert.equal(completed.texture.anisotropy, 8);
});

test('texture anisotropy supports both renderer APIs and fails safely', () => {
  assert.equal(rendererTextureAnisotropy({ getMaxAnisotropy: () => 16 }), 16);
  assert.equal(rendererTextureAnisotropy({
    capabilities: { getMaxAnisotropy: () => 8 },
  }), 8);
  assert.equal(rendererTextureAnisotropy({ getMaxAnisotropy: () => { throw new Error('not ready'); } }), 1);
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
