import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as THREE from 'three';

import {
  radialPriorityDistance,
  headingFromForward2D,
  headingForward2D,
  priorityHeading,
  viewHeadingChanged,
  terrainTilePriority,
} from '../terrain-priority.js';
import { cameraDriftIndicator, compassHeading } from '../terrain-hud.js';
import { applyMapDrag } from '../terrain-controls.js';
import { createVehiclePersistenceRuntime, normalizeSavedVehicleState, stepSuspension, stepVehicleDrive, terrainBboxIntersectsCircle, vehicleLatLonToLocal, vehicleLocalToLatLon, vehicleStateSnapshot } from '../terrain-vehicle.js';
import { scoreTextureTiles, textureRetryDelay, tileDepthFromId } from '../terrain-tile-runtime.js';
import { createTextureStreamer, rendererTextureAnisotropy } from '../terrain-texture-streamer.js';
import {
  createTerrainTextureController,
  createTerrainTileSet,
  createTileLifecycle,
  reconcileTerrainTiles,
} from '../terrain-tile-set.js';
import { createTerrainMeshBuilder, decodeTerrainHeightmap } from '../terrain-mesh-builder.js';
import { analyzeTerrainSeams, collectTerrainDebugMeshes, createTerrainHoverOutlineController, createTerrainMapGridController, formatTerrainSeamDiagnostic, summarizeTerrainMesh } from '../terrain-debug-runtime.js';
import { createTerrainFetchRuntime } from '../terrain-fetch-runtime.js';
import { restoreTerrainCameraState, terrainCameraState } from '../terrain-camera-state.js';
import { createTerrainClientLogger } from '../terrain-client-logging.js';
import { createTerrainFpsCounter } from '../terrain-fps-counter.js';
import {
  terrainAglFromIntersections,
  terrainAglFromSurface,
  terrainSurfaceHeightAt,
} from '../terrain-agl.js';
import {
  projectSunDirectionToUv,
  stepSunFlareVisibility,
  sunFlareElevationVisibility,
} from '../terrain-sun-flare-effect.js';
import { loadTerrainStartupAssets, normalizeTerrainStartupAssets } from '../terrain-startup-assets.js';
import { createTerrainAtmosphereTextureRuntime } from '../terrain-atmosphere-textures.js';
import { GRIDLINES_COLOR, createTerrainGridlinesController } from '../terrain-gridlines.js';
import { createTerrainTuningControls } from '../terrain-tuning-controls.js';
import { waterCascadeUpdateDue, waterCascadeUpdateRate } from '../water/water-spectrum.js';
import {
  bindTerrainCloudComposition,
  cloudWeatherUvVelocity,
  configureTerrainClouds,
  invalidateTerrainCloudHistory,
  installTerrainCloudHistoryReset,
  registerTerrainCloudTuning,
} from '../terrain-cloud-runtime.js';
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
} from '../terrain-tile-fetch.js';

test('gridlines batch terrain-conforming tile edges without replacing textures', () => {
  const terrainRoot = new THREE.Group();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 10, 1, 0, 20, 0, 1, 30, 1, 1, 40,
  ], 3));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: {} }));
  mesh.userData = { tileId: '1-0-0', resolution: 2 };
  terrainRoot.add(mesh);
  const originalMaterial = mesh.material;
  const originalTexture = mesh.material.map;
  const originalColor = mesh.material.color.getHex();
  const originalVertexColors = mesh.material.vertexColors;
  const grid = createTerrainGridlinesController({ terrainRoot });
  grid.setVisible(true);
  assert.equal(grid.lines.geometry.getAttribute('position').count, 24);
  assert.equal(grid.lines.isMesh, true);
  assert.equal(grid.lines.material.side, THREE.DoubleSide);
  assert.equal(grid.lines.material.depthTest, true);
  assert.equal(grid.lines.material.depthWrite, false);
  assert.equal(grid.lines.material.color.getHex(), GRIDLINES_COLOR);
  assert.equal(grid.lines.visible, true);
  assert.equal(mesh.material, originalMaterial);
  assert.equal(mesh.material.map, originalTexture);
  assert.equal(mesh.material.color.getHex(), originalColor);
  assert.equal(mesh.material.vertexColors, originalVertexColors);
  grid.setVisible(false);
  assert.equal(grid.lines.visible, false);
  assert.equal(mesh.material, originalMaterial);
  assert.equal(mesh.material.map, originalTexture);
});

test('water cascade pacing slows long and aerial waves without starving updates', () => {
  assert.deepEqual([0, 1, 2].map(index => waterCascadeUpdateRate(index, 0)), [15, 30, 60]);
  assert.deepEqual([0, 1, 2].map(index => waterCascadeUpdateRate(index, 3000)), [8, 15, 20]);
  assert.ok(waterCascadeUpdateRate(2, 1500) < 60);
  assert.ok(waterCascadeUpdateRate(2, 1500) > 20);

  const schedule = {};
  assert.equal(waterCascadeUpdateDue(schedule, 0, 0, 0), true);
  assert.equal(waterCascadeUpdateDue(schedule, 0.03, 0, 0), false);
  assert.equal(waterCascadeUpdateDue(schedule, 1 / 15, 0, 0), true);
  assert.equal(waterCascadeUpdateDue(schedule, 0.01, 0, 0), true);
});

test('vehicle shadow receiver footprint keeps intersecting terrain tiles only', () => {
  assert.equal(terrainBboxIntersectsCircle([0, 0, 100, 100], 50, 50, 10), true);
  assert.equal(terrainBboxIntersectsCircle([0, 0, 100, 100], 110, 50, 10), true);
  assert.equal(terrainBboxIntersectsCircle([0, 0, 100, 100], 111, 50, 10), false);
  assert.equal(terrainBboxIntersectsCircle([100, 100, 0, 0], 50, 50, 0), true);
  assert.equal(terrainBboxIntersectsCircle(null, 50, 50, 10), false);
});

test('analytic sun flare projects a moving world direction into screen space', () => {
  const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 1000);
  camera.position.set(10, 20, 30);
  camera.lookAt(10, 20, 29);
  camera.updateMatrixWorld(true);
  const uv = new THREE.Vector2();
  assert.equal(projectSunDirectionToUv(camera, new THREE.Vector3(0, 0, -1), uv), true);
  assert.ok(Math.abs(uv.x - 0.5) < 1e-12);
  assert.ok(Math.abs(uv.y - 0.5) < 1e-12);
  assert.equal(projectSunDirectionToUv(camera, new THREE.Vector3(0, 0, 1), uv), false);
});

test('analytic sun flare fades gradually through golden hour', () => {
  const up = new THREE.Vector3(0, 0, 1);
  const sunAtElevation = degrees => new THREE.Vector3(
    Math.cos(THREE.MathUtils.degToRad(degrees)),
    0,
    Math.sin(THREE.MathUtils.degToRad(degrees)),
  );
  assert.ok(sunFlareElevationVisibility(sunAtElevation(2), up) < 1e-12);
  const midFade = sunFlareElevationVisibility(sunAtElevation(9), up);
  assert.ok(midFade > 0.2 && midFade < 0.3);
  assert.ok(1 - sunFlareElevationVisibility(sunAtElevation(16), up) < 1e-12);
  assert.equal(sunFlareElevationVisibility(sunAtElevation(-2), up), 0);
});

test('analytic sun flare snaps negligible offscreen visibility to zero', () => {
  const fading = stepSunFlareVisibility(1, 0, 0.75);
  assert.ok(fading > 0 && fading < 1);
  assert.equal(stepSunFlareVisibility(1, 0, 1 / 60, false), 0);
  assert.equal(stepSunFlareVisibility(fading, 0, 10), 0);
  assert.ok(stepSunFlareVisibility(0, 1, 1 / 60) > 0);
});

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

test('terrain AGL accepts local ground hits and rejects coordinate-frame spikes', () => {
  assert.equal(terrainAglFromIntersections([{ distance: 396.97 }]), 396.97);
  assert.equal(terrainAglFromIntersections([{ distance: 6_352_568 }]), null);
  assert.equal(terrainAglFromIntersections([{ distance: -1 }]), null);
  assert.equal(terrainAglFromIntersections([]), null);
});

test('terrain AGL samples the deepest resident surface without a triangle raycast', () => {
  const mesh = (tileId, bbox, heights) => ({
    userData: { tileId, bbox, resolution: 2 },
    geometry: {
      attributes: {
        position: {
          itemSize: 3,
          array: new Float32Array([
            0, 0, heights[0],
            0, 0, heights[1],
            0, 0, heights[2],
            0, 0, heights[3],
          ]),
        },
      },
    },
  });
  const parent = mesh('8-1-1', [0, 0, 10, 10], [0, 0, 0, 0]);
  const child = mesh('10-4-4', [0, 0, 5, 5], [10, 20, 30, 40]);

  assert.equal(terrainSurfaceHeightAt([parent, child], 2.5, 2.5), 25);
  assert.equal(terrainAglFromSurface(125, 25), 100);
  assert.equal(terrainSurfaceHeightAt([parent, child], 8, 8), 0);
  assert.equal(terrainSurfaceHeightAt([parent], 11, 8), null);
});

test('startup asset normalization clones valid records and rejects junk', () => {
  const vehicle = { id: 'v1' };
  const normalized = normalizeTerrainStartupAssets({
    vehicle_definition: { model: 'truck' },
    vehicle_instances: [vehicle, null, 'bad'],
  });
  assert.deepEqual(normalized, {
    vehicle_definition: { model: 'truck' },
    vehicle_instances: [{ id: 'v1' }],
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
        vehicle_instances: [{ id: 'v1' }],
      }),
    }),
  });
  assert.equal(result.source, 'database');
  assert.equal(result.schemaVersion, 9);
  assert.deepEqual(cleared, [7]);
  assert.equal(logs[0][0], 'assets.fetch.ok');
  assert.equal(logs[0][1].vehicleCount, 1);
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
      vehicle_definition: {}, vehicle_instances: [],
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
  const altitude = tuning.slider('cloud altitude', {
    value: 0, min: -2000, max: 5000, step: 50, decimals: 0,
    onChange: value => changes.push(['cloud altitude', value]),
  });
  const toggle = tuning.toggle('clouds', {
    value: true, onChange: value => changes.push(['clouds', value]),
  });
  assert.deepEqual(changes, [['exposure', 2], ['clouds', false]]);
  assert.deepEqual(state, { exposure: 2, clouds: false, 'cloud altitude': 0 });

  slider.value = '3.5';
  slider.oninput();
  altitude.value = '1250';
  altitude.oninput();
  toggle.checked = true;
  toggle.onchange();
  assert.deepEqual(state, { exposure: 3.5, clouds: true, 'cloud altitude': 1250 });
  assert.equal(saves, 3);

  const restoredChanges = [];
  const restoredTuning = createTerrainTuningControls({
    body: documentImpl.createElement('section'),
    state: JSON.parse(JSON.stringify(state)),
    documentImpl,
    save: () => {},
  });
  const restoredAltitude = restoredTuning.slider('cloud altitude', {
    value: 0, min: -2000, max: 5000, step: 50, decimals: 0,
    onChange: value => restoredChanges.push(value),
  });
  assert.equal(restoredAltitude.value, 1250);
  assert.deepEqual(restoredChanges, [1250]);

  tuning.setSliderValue('exposure', 2.25);
  assert.equal(slider.value, 2.25);
  tuning.reset();
  assert.equal(slider.value, 1);
  assert.equal(altitude.value, 0);
  assert.equal(toggle.checked, true);
  assert.deepEqual(changes.slice(-3), [
    ['exposure', 1], ['cloud altitude', 0], ['clouds', true],
  ]);
});

test('shared cloud runtime configures layers and synchronizes atmosphere composition', () => {
  const vector = () => ({ values: [], set(...values) { this.values = values; } });
  const listeners = new Map();
  const effect = {
    cloudLayers: Array.from({ length: 4 }, () => ({})),
    localWeatherVelocity: vector(), shapeVelocity: vector(), shapeDetailVelocity: vector(),
    clouds: {}, shadow: {}, scatteringCoefficient: 2, absorptionCoefficient: 3,
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
  assert.deepEqual(effect.clouds, {
    minStepSize: 20,
    maxStepSize: 400,
    perspectiveStepScale: 1.005,
    maxIterationCount: 750,
  });
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

test('cloud history invalidation seeds every temporal-upscale phase from the current frame', () => {
  // The install anchors on takram's real cloudsResolve.frag; a mocked shader
  // would only validate our own assumptions about it. resolveMaterial receives
  // the source verbatim modulo include resolution, which touches neither anchor.
  const takramResolveShader = readFileSync(
    new URL(
      '../three-geospatial/packages/clouds/src/shaders/cloudsResolve.frag',
      import.meta.url,
    ),
    'utf8',
  );
  const shadowAlpha = { value: 0.01 };
  const cloudsAlpha = { value: 0.1 };
  const resolveMaterial = {
    uniforms: { temporalAlpha: cloudsAlpha },
    fragmentShader: takramResolveShader,
  };
  const effect = {
    temporalUpscale: true,
    shadowPass: { resolveMaterial: { uniforms: { temporalAlpha: shadowAlpha } } },
    cloudsPass: { resolveMaterial },
  };

  assert.equal(installTerrainCloudHistoryReset(effect), true);
  assert.match(resolveMaterial.fragmentShader, /uniform float terrainHistoryReset;/);
  // The reset must land inside temporalUpscale(), ahead of the current-phase
  // branch, so it overrides all 16 Bayer phases — not temporalAntialiasing().
  const resetIndex = resolveMaterial.fragmentShader.indexOf('terrainHistoryReset > 0.5');
  const currentFrameIndex = resolveMaterial.fragmentShader.indexOf('if (currentFrame) {');
  const antialiasingIndex = resolveMaterial.fragmentShader.indexOf('void temporalAntialiasing');
  assert.ok(resetIndex >= 0);
  assert.ok(resetIndex < currentFrameIndex);
  assert.ok(resetIndex < antialiasingIndex);
  assert.equal(installTerrainCloudHistoryReset(effect), true);
  assert.equal(
    resolveMaterial.fragmentShader.match(/terrainHistoryReset > 0\.5/g).length,
    1,
  );

  const restore = invalidateTerrainCloudHistory(effect);
  assert.equal(resolveMaterial.uniforms.terrainHistoryReset.value, 1);
  assert.equal(shadowAlpha.value, 1);
  assert.equal(cloudsAlpha.value, 1);
  assert.equal(invalidateTerrainCloudHistory(effect), restore);

  restore();
  assert.equal(resolveMaterial.uniforms.terrainHistoryReset.value, 0);
  assert.equal(shadowAlpha.value, 0.01);
  assert.equal(cloudsAlpha.value, 0.1);
});

test('shared cloud tuning registers controls and applies altitude, cirrus, and drift changes', () => {
  const definitions = new Map();
  const sections = [];
  let windDirection = 0;
  const effect = {
    coverage: 0.28,
    cloudLayers: [1550, 1800, 8300, 9100].map(altitude => ({
      altitude, densityScale: 0, weatherExponent: 1, shapeAmount: 0.3,
    })),
    localWeatherRepeat: { x: 100, y: 100 },
    localWeatherVelocity: { values: [], set(...values) { this.values = values; } },
  };
  const controls = {};
  let appearanceChanges = 0;
  const tuning = registerTerrainCloudTuning({
    effect, controls,
    section: label => sections.push(label),
    slider: (label, options) => { definitions.set(label, options); return { label }; },
    toggle: (label, options) => { definitions.set(label, options); return { label }; },
    getWindDirection: () => windDirection,
    onAppearanceChange: () => { appearanceChanges += 1; },
  });
  assert.deepEqual(sections, ['Clouds']);
  assert.equal(definitions.size, 7);
  assert.equal(controls._cirrusCheckbox.label, 'cirrus');

  definitions.get('cloud altitude').onChange(-2000);
  assert.deepEqual(effect.cloudLayers.map(layer => layer.altitude), [0, 0, 6300, 7100]);
  definitions.get('cirrus density').onChange(0.0016);
  assert.equal(effect.cloudLayers[3].densityScale, 0);
  definitions.get('cirrus').onChange(true);
  assert.equal(effect.cloudLayers[3].densityScale, 0.0016);
  definitions.get('cirrus density').onChange(0.0012);
  assert.equal(effect.cloudLayers[3].densityScale, 0.0012);
  definitions.get('cirrus coverage').onChange(2.65);
  assert.equal(effect.cloudLayers[3].weatherExponent, 2.65);
  definitions.get('cirrus shape').onChange(0.76);
  assert.equal(effect.cloudLayers[3].shapeAmount, 0.76);
  definitions.get('cirrus').onChange(false);
  assert.equal(effect.cloudLayers[3].densityScale, 0);
  definitions.get('cirrus density').onChange(0.0008);
  assert.equal(effect.cloudLayers[3].densityScale, 0);
  definitions.get('cirrus').onChange(true);
  assert.equal(effect.cloudLayers[3].densityScale, 0.0008);
  assert.equal(appearanceChanges, 7);
  const drift = definitions.get('drift km/h');
  assert.equal(drift.min, 0);
  assert.equal(drift.max, 650);
  assert.equal(drift.step, 5);
  assert.equal(drift.value, 13);
  assert.equal(drift.format(325), '325km/h');
  // Drift heading is slaved to the water wind (compass "blows toward" 0 =
  // north). The km/h display maps onto the exact original 0–0.002 internal
  // texture-offset range, so this midpoint must retain the old 0.001 speed.
  drift.onChange(325);
  assert.ok(Math.abs(effect.localWeatherVelocity.values[0]) < 1e-12);
  assert.ok(Math.abs(effect.localWeatherVelocity.values[1] + 0.001) < 1e-12);
  assert.equal(typeof tuning.syncDrift, 'function');

  windDirection = 90;
  tuning.syncDrift();
  assert.ok(Math.abs(effect.localWeatherVelocity.values[0] + 0.001) < 1e-12);
  assert.ok(Math.abs(effect.localWeatherVelocity.values[1]) < 1e-12);
});

test('cloud weather follows compass headings through the Nuuk cube-sphere basis', () => {
  const degrees = Math.PI / 180;
  const longitude = -51.7216 * degrees;
  const latitude = 64.1835 * degrees;
  const weatherUvBasis = {
    position: {
      x: Math.cos(latitude) * Math.cos(longitude),
      y: Math.cos(latitude) * Math.sin(longitude),
      z: Math.sin(latitude),
    },
    east: { x: -Math.sin(longitude), y: Math.cos(longitude), z: 0 },
    north: {
      x: -Math.sin(latitude) * Math.cos(longitude),
      y: -Math.sin(latitude) * Math.sin(longitude),
      z: Math.cos(latitude),
    },
  };
  const east = cloudWeatherUvVelocity({
    compassDegrees: 90, speed: 1, weatherUvBasis,
  });
  // Geographic east is ~36.8 degrees in the local cube-sphere UV basis, not
  // the texture's +u axis. The negative is the sampling-offset inversion.
  assert.ok(Math.abs(east.x + 0.8003) < 0.001);
  assert.ok(Math.abs(east.y + 0.5996) < 0.001);

  const north = cloudWeatherUvVelocity({
    compassDegrees: 0, speed: 1, weatherUvBasis,
  });
  assert.ok(Math.abs(north.x - 0.6375) < 0.001);
  assert.ok(Math.abs(north.y + 0.7705) < 0.001);
});

test('shared cloud tuning puts the Takram rendering checkbox first in the Clouds section', () => {
  const order = [];
  const renderingStates = [];
  const controls = {};
  registerTerrainCloudTuning({
    effect: {
      coverage: 0.28,
      cloudLayers: [1550, 1800, 8300, 9100].map(altitude => ({
        altitude, densityScale: 0, weatherExponent: 1, shapeAmount: 0.3,
      })),
      localWeatherRepeat: { x: 100, y: 100 },
      localWeatherVelocity: { set() {} },
    },
    controls,
    section: label => order.push(`section:${label}`),
    slider: label => { order.push(`slider:${label}`); return { label }; },
    toggle: (label, options) => {
      order.push(`toggle:${label}`);
      if (label === 'Takram clouds') options.onChange(false);
      return { label };
    },
    renderingEnabled: true,
    onRenderingEnabledChange: enabled => renderingStates.push(enabled),
  });
  assert.deepEqual(order.slice(0, 2), ['section:Clouds', 'toggle:Takram clouds']);
  assert.equal(controls._takramCloudsCheckbox.label, 'Takram clouds');
  assert.deepEqual(renderingStates, [false]);
});

test('terrain request preserves boot frame semantics without client LOD overrides', () => {
  const request = buildTerrainTilesRequest({
    lat: 64.1, lon: -51.2, altitude: 120, heading: 0.5, range: 30000,
    isFirstLoad: true,
    frameOffsetReady: false, originX: 1, originY: 2,
    cameraSnapshot: { camEastM: 3 },
  });
  assert.equal(request.url, '/api/tiles?lat=64.1&lon=-51.2&agl=120&heading=0.5&range=30000');
  assert.deepEqual(request.logDetails, {
    isFirstLoad: true,
    requestLat: 64.1, requestLon: -51.2, requestAglM: 120,
    requestGridX: null, requestGridY: null,
    headingRad: 0.5, camEastM: 3,
  });
});

test('terrain request reuses a restored frame', () => {
  const request = buildTerrainTilesRequest({
    lat: 64, lon: -51, altitude: 50, heading: 0, range: 40000,
    isFirstLoad: true,
    frameOffsetReady: true, originX: -12.5, originY: 99.25,
    queryX: 123.5, queryY: -456.25,
  });
  assert.equal(request.url, '/api/tiles?sx=123.5&sy=-456.25&agl=50&heading=0&range=40000&ox=-12.5&oy=99.25');
  assert.equal('maxDepth' in request.logDetails, false);
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
    data, status: 200, cameraX: 101, cameraY: -19,
    frameOffsetX: 100, frameOffsetY: -20, frameOffsetReady: true,
  }), {
    status: 200, tiles: 2, withHm: 1, noHm: 1,
    missing: 1, downloading: 1, qx: 1.3, qy: 2.3, ox: 3.5, oy: 4.6,
    closestTileId: 'near', closestTileDistM: 0,
    closestTileCx: 101, closestTileCy: -19,
    tileFrameOffsetX: 100, tileFrameOffsetY: -20, tileFrameOffsetReady: true,
  });
});

test('shared reconciler spends dirty-paint budget in priority order', () => {
  const built = [];
  const deferredTiles = new Map();
  const terrainRoot = {
    children: [],
    add(mesh) { this.children.push(mesh); },
  };
  let diffDetails = null;
  const options = {
    terrainRoot,
    deferredTiles,
    lifecycle: {},
    priorityForTile: tile => tile.priority,
    textureCache: new Map(),
    materialize: () => assert.fail('unexpected materialize'),
    buildMesh: tile => {
      built.push(tile.id);
      return {
        isMesh: true, userData: { tileId: tile.id, bbox: tile.bbox },
        material: { map: null },
      };
    },
    log: () => {},
    buildBudget: 1,
  };
  const result = reconcileTerrainTiles({
    ...options,
    tiles: [
      { id: 'far', bbox: [10, 10, 11, 11], heightmap: 'hm', priority: 9 },
      { id: 'hot', bbox: [0, 0, 1, 1], heightmap: 'hm', priority: 1 },
    ],
    currentTileIds: new Set(),
    onDiff: details => { diffDetails = details; },
  });
  assert.deepEqual(built, ['hot']);
  assert.deepEqual([...deferredTiles.keys()], ['hot', 'far']);
  assert.equal(result.sceneMeshes, 1);
  assert.deepEqual(diffDetails, {
    added: 2, removed: 0, purgedDeferred: 0, released: 0, sceneMeshes: 0,
  });
});

test('initial reconciliation completes tile coverage beyond the build budget', () => {
  const built = [];
  const deferredTiles = new Map();
  const terrainRoot = {
    children: [],
    add(mesh) { this.children.push(mesh); },
  };
  const options = {
    terrainRoot,
    deferredTiles,
    lifecycle: {},
    priorityForTile: tile => tile.priority,
    textureCache: new Map(),
    materialize: () => assert.fail('unexpected materialize'),
    buildMesh: tile => {
      built.push(tile.id);
      return {
        isMesh: true,
        userData: { tileId: tile.id, bbox: tile.bbox },
        material: { map: null },
      };
    },
    log: () => {},
    buildBudget: 1,
  };
  reconcileTerrainTiles({
    ...options,
    tiles: [
      { id: 'near', bbox: [0, 0, 1, 1], heightmap: 'hm', priority: 1 },
      { id: 'far', bbox: [10, 10, 11, 11], heightmap: 'hm', priority: 2 },
    ],
    currentTileIds: new Set(),
    completeCoverage: true,
  });
  assert.deepEqual(built, ['near', 'far']);
  assert.deepEqual([...deferredTiles.keys()], ['near', 'far']);
  assert.equal(terrainRoot.children.length, 2);
});

test('reconciliation rebuilds a resident tile when repaired seam geometry changes', () => {
  const oldMesh = {
    isMesh: true,
    userData: {
      tileId: '12-20-40', bbox: [0, 0, 4, 4], heightmapPayload: 'old-repair',
    },
    material: { map: null },
  };
  const terrainRoot = {
    children: [oldMesh],
    add(mesh) { this.children.push(mesh); },
    remove(mesh) { this.children = this.children.filter(item => item !== mesh); },
  };
  const evicted = [];
  const sceneSizesAtEviction = [];
  const built = [];
  const nextTile = {
    id: '12-20-40', bbox: [0, 0, 4, 4], heightmap: 'new-repair', priority: 1,
  };

  const result = reconcileTerrainTiles({
    tiles: [nextTile],
    currentTileIds: new Set([nextTile.id]),
    deferredTiles: new Map(),
    terrainRoot,
    lifecycle: {
      evict(mesh) {
        evicted.push(mesh.userData.tileId);
        sceneSizesAtEviction.push(terrainRoot.children.length);
        terrainRoot.remove(mesh);
      },
    },
    priorityForTile: () => 0,
    textureCache: new Map(),
    materialize() {},
    buildMesh(tile) {
      built.push(tile.id);
      return {
        isMesh: true,
        userData: {
          tileId: tile.id, bbox: tile.bbox, heightmapPayload: tile.heightmap,
        },
        material: { map: null },
      };
    },
    log() {},
  });

  assert.deepEqual(evicted, [nextTile.id]);
  assert.deepEqual(sceneSizesAtEviction, [2]);
  assert.deepEqual(built, [nextTile.id]);
  assert.equal(terrainRoot.children.length, 1);
  assert.equal(terrainRoot.children[0].userData.heightmapPayload, 'new-repair');
  assert.deepEqual(result.added, [nextTile.id]);
  assert.deepEqual(result.removed, []);
});

test('seam refresh keeps old geometry when the replacement is build-budget deferred', () => {
  const oldMesh = {
    isMesh: true,
    userData: {
      tileId: '12-20-40', bbox: [0, 0, 4, 4], heightmapPayload: 'old-repair',
    },
    material: { map: null },
  };
  const terrainRoot = {
    children: [oldMesh],
    add(mesh) { this.children.push(mesh); },
    remove(mesh) { this.children = this.children.filter(item => item !== mesh); },
  };
  const deferredTiles = new Map();
  let evictions = 0;
  let builds = 0;
  const nextTile = {
    id: oldMesh.userData.tileId,
    bbox: oldMesh.userData.bbox,
    heightmap: 'new-repair',
  };

  reconcileTerrainTiles({
    tiles: [nextTile],
    currentTileIds: new Set([nextTile.id]),
    deferredTiles,
    terrainRoot,
    lifecycle: {
      evict() { evictions += 1; },
    },
    priorityForTile: () => 0,
    textureCache: new Map(),
    materialize() {},
    buildMesh() { builds += 1; },
    buildBudget: 0,
    log() {},
  });

  assert.equal(evictions, 0);
  assert.equal(builds, 0);
  assert.deepEqual(terrainRoot.children, [oldMesh]);
  assert.equal(deferredTiles.get(nextTile.id), nextTile);
});

test('reconciliation releases old browser-demand tiles but retains a complete fallback parent', () => {
  const evicted = [];
  const releasedTextures = [];
  const outside = {
    isMesh: true,
    userData: { tileId: '8-10-10', bbox: [100, 100, 110, 110] },
    material: { map: {} },
  };
  const parent = {
    isMesh: true,
    userData: { tileId: '8-20-20', bbox: [0, 0, 8, 8] },
    material: { map: {} },
  };
  const terrainRoot = {
    children: [outside, parent],
    add(mesh) { this.children.push(mesh); },
    remove(mesh) { this.children = this.children.filter(item => item !== mesh); },
  };
  const children = [
    { id: '9-40-40', bbox: [0, 0, 4, 4], heightmap: null },
    { id: '9-41-40', bbox: [4, 0, 8, 4], heightmap: null },
    { id: '9-40-41', bbox: [0, 4, 4, 8], heightmap: null },
    { id: '9-41-41', bbox: [4, 4, 8, 8], heightmap: null },
  ];
  const result = reconcileTerrainTiles({
    tiles: children,
    currentTileIds: new Set(['8-10-10', '8-20-20']),
    deferredTiles: new Map(),
    terrainRoot,
    lifecycle: {
      evict(mesh) { evicted.push(mesh.userData.tileId); terrainRoot.remove(mesh); },
    },
    priorityForTile: () => 0,
    textureCache: new Map(),
    materialize() {},
    buildMesh() {},
    log() {},
    onReleaseTile: tileId => releasedTextures.push(tileId),
  });
  assert.deepEqual(evicted, ['8-10-10']);
  assert.deepEqual(releasedTextures, ['8-10-10']);
  assert.deepEqual(terrainRoot.children, [parent]);
  assert.equal(result.released, 1);
});

test('reconciliation releases resident fine detail when demand coarsens', () => {
  const fine = {
    isMesh: true,
    userData: { tileId: '10-40-40', bbox: [0, 0, 2, 2] },
    material: { map: {} },
  };
  const terrainRoot = {
    children: [fine],
    remove(mesh) { this.children = this.children.filter(item => item !== mesh); },
  };
  const evicted = [];
  const released = [];
  const result = reconcileTerrainTiles({
    tiles: [{ id: '8-10-10', bbox: [0, 0, 8, 8], heightmap: 'coarse' }],
    currentTileIds: new Set([fine.userData.tileId]),
    deferredTiles: new Map(),
    terrainRoot,
    lifecycle: {
      evict(mesh) { evicted.push(mesh.userData.tileId); terrainRoot.remove(mesh); },
    },
    priorityForTile: () => 0,
    textureCache: new Map(),
    materialize() {},
    buildMesh() {},
    log() {},
    onReleaseTile: tileId => released.push(tileId),
  });

  assert.equal(result.nextTileIds.has('8-10-10'), true);
  assert.equal(result.nextTileIds.has(fine.userData.tileId), false);
  assert.deepEqual(evicted, [fine.userData.tileId]);
  assert.deepEqual(released, [fine.userData.tileId]);
  assert.deepEqual(terrainRoot.children, []);
});

test('circular-boundary parent remains only until demanded descendants are materialized', () => {
  const parent = {
    isMesh: true,
    userData: { tileId: '10-351-206', bbox: [0, 0, 8, 8] },
    material: { map: {}, dispose() {} },
    geometry: { dispose() {} },
    children: [],
  };
  const terrainRoot = {
    children: [parent],
    add(mesh) { this.children.push(mesh); },
    remove(mesh) { this.children = this.children.filter(item => item !== mesh); },
  };
  const lifecycle = createTileLifecycle({
    terrainRoot, disposeScatter: () => {}, log: () => {},
  });
  const demanded = [
    { id: '11-702-412', bbox: [0, 0, 4, 4], heightmap: 'hm' },
    { id: '11-703-412', bbox: [4, 0, 8, 4], heightmap: 'hm' },
  ];

  const result = reconcileTerrainTiles({
    tiles: demanded,
    currentTileIds: new Set([parent.userData.tileId]),
    deferredTiles: new Map(),
    terrainRoot,
    lifecycle,
    priorityForTile: () => 0,
    textureCache: new Map(),
    materialize() {},
    buildMesh: () => null,
    log() {},
  });

  assert.equal(result.released, 0);
  assert.deepEqual(terrainRoot.children, [parent]);

  for (const tile of demanded) {
    terrainRoot.add({
      isMesh: true,
      userData: { tileId: tile.id, bbox: tile.bbox },
      material: { map: {}, dispose() {} },
      geometry: { dispose() {} },
      children: [],
    });
  }
  lifecycle.evictCoveredAncestors(
    demanded.at(-1).id,
    new Set(demanded.map(tile => tile.id)),
  );
  assert.equal(terrainRoot.children.includes(parent), false);
});

test('textured parent remains while demanded children are untextured', () => {
  const parent = {
    isMesh: true,
    userData: { tileId: '11-10-20', bbox: [0, 0, 8, 8] },
    material: { map: {}, dispose() {} },
    geometry: { dispose() {} },
    children: [],
  };
  const terrainRoot = {
    children: [parent],
    add(mesh) { this.children.push(mesh); },
    remove(mesh) { this.children = this.children.filter(item => item !== mesh); },
  };
  const lifecycle = createTileLifecycle({
    terrainRoot, disposeScatter: () => {}, log: () => {},
  });
  const children = [
    { id: '12-20-40', bbox: [0, 0, 4, 4], heightmap: 'water' },
    { id: '12-21-40', bbox: [4, 0, 8, 4], heightmap: 'water' },
    { id: '12-20-41', bbox: [0, 4, 4, 8], heightmap: 'water' },
    { id: '12-21-41', bbox: [4, 4, 8, 8], heightmap: 'water' },
  ];

  const result = reconcileTerrainTiles({
    tiles: children,
    currentTileIds: new Set([parent.userData.tileId]),
    deferredTiles: new Map(),
    terrainRoot,
    lifecycle,
    priorityForTile: () => 0,
    textureCache: new Map(),
    materialize() {},
    buildMesh: tile => ({
      isMesh: true,
      userData: { tileId: tile.id, bbox: tile.bbox },
      material: { map: null, dispose() {} },
      geometry: { dispose() {} },
      children: [],
    }),
    prepareUntexturedMesh() {},
    log() {},
    buildBudget: 4,
  });

  assert.deepEqual(
    terrainRoot.children.map(mesh => mesh.userData.tileId).sort(),
    [parent.userData.tileId],
  );
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
    renderBackend: { kind: 'webgpu', prepareUntexturedTerrain() {} },
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
    },
  });
  const tile = { id: '1-0-0', bbox: [0, 0, 1, 1], heightmap: 'hm' };
  const baseTexture = { disposed: false, dispose() { this.disposed = true; } };
  const reconciliation = tileSet.reconcile([tile]);
  tileSet.updateTextures([tile]);
  assert.equal(terrainRoot.children.length, 1);
  assert.equal(terrainRoot.children[0].material.polygonOffset, false);
  assert.equal(terrainRoot.children[0].material.polygonOffsetFactor, 0);
  assert.equal(terrainRoot.children[0].material.polygonOffsetUnits, 0);
  assert.equal(tileSet.deferredTiles.get(tile.id), tile);
  assert.equal(tileSet.currentTileIds, reconciliation.nextTileIds);
  assert.deepEqual(textureRequests, [tile.id]);

  terrainRoot.children[0].material.map = baseTexture;
  terrainRoot.children[0].userData.terrainBaseTexture = baseTexture;
  assert.equal(terrainRoot.children[0].material.map, baseTexture);
});

test('terrain tile set does not queue excess geometry on animation frames', () => {
  const frames = [];
  const terrainRoot = {
    children: [],
    add(mesh) { this.children.push(mesh); },
    remove(mesh) { this.children = this.children.filter(child => child !== mesh); },
  };
  const tileSet = createTerrainTileSet({
    terrainRoot,
    textureStreamer: {
      texCache: new Map(), texSource: new Map(), pump() {}, releaseTile() {},
    },
    terrain: {},
    renderBackend: { kind: 'webgl', prepareUntexturedTerrain() {} },
    view: { controls: { mapMode: false } },
    log() {},
    testOverrides: {
      buildBudget: 1,
      scheduleFrame: callback => frames.push(callback),
      priorityForTile: tile => tile.priority,
      getVisibilityDistance: () => 1000,
      buildMesh: tile => ({
        isMesh: true,
        children: [],
        userData: { tileId: tile.id, bbox: tile.bbox },
        material: { map: null, color: { set() {} }, dispose() {} },
        geometry: { dispose() {} },
      }),
    },
  });
  const tiles = [
    { id: '8-0-0', bbox: [0, 0, 1, 1], heightmap: 'hm', priority: 1 },
    { id: '8-1-0', bbox: [1, 0, 2, 1], heightmap: 'hm', priority: 2 },
  ];
  tileSet.reconcile(tiles, { completeCoverage: true });
  assert.deepEqual(
    terrainRoot.children.map(mesh => mesh.userData.tileId),
    ['8-0-0', '8-1-0'],
  );
  assert.equal(frames.length, 0);
});

test('terrain origin and pipeline decisions use one request mode', () => {
  const origin = adoptTerrainOrigin({
    data: { ox: -100.25, oy: 200.25, qx: -90, qy: 210 },
    cameraSnapshot: { camStereoApproxX: -95, camStereoApproxY: 205 },
  });
  assert.equal(origin.originX, -100.25);
  assert.equal(origin.cameraY, 210);
  assert.equal(origin.logDetails.originDeltaX, -5.3);
  assert.equal(terrainPipelineStatus({ missing: [{}], downloading: [], texFetching: 0 }).nextAction, 'poll');
  assert.equal(terrainPipelineStatus({ missing: [], downloading: [], texFetching: 0 }).nextAction, 'idle');
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
  }), { distance: 6000, altitudeDelta: 0, shouldFetch: true, nextTriggerMs: 1000 });
  assert.equal(evaluateTerrainRefetch({
    cameraX: 7000, cameraY: 0, lastFetchX: 0, lastFetchY: 0,
    nowMs: 1200, lastTriggerMs: 1000, distanceThreshold: 5000, triggerIntervalMs: 500,
  }).shouldFetch, false);
  assert.equal(evaluateTerrainRefetch({
    cameraX: 100, cameraY: 0, lastFetchX: 0, lastFetchY: 0,
    nowMs: 5000, lastTriggerMs: 0, distanceThreshold: 5000, triggerIntervalMs: 500,
  }).shouldFetch, false);
});

test('shared terrain refetch decision reacts to a vertical descent', () => {
  const descent = {
    cameraX: 0, cameraY: 0, lastFetchX: 0, lastFetchY: 0,
    cameraAltitude: 1190, lastFetchAltitude: 1400,
    nowMs: 1000, lastTriggerMs: 0,
    distanceThreshold: 1000, altitudeThreshold: 100, triggerIntervalMs: 500,
  };
  assert.deepEqual(evaluateTerrainRefetch(descent), {
    distance: 0, altitudeDelta: 210, shouldFetch: true, nextTriggerMs: 1000,
  });
  assert.equal(evaluateTerrainRefetch({
    ...descent, cameraAltitude: 1350,
  }).shouldFetch, false);
  assert.equal(evaluateTerrainRefetch({
    ...descent, nowMs: 1200, lastTriggerMs: 1000,
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

function createTestFetchRuntime({
  fetchImpl,
  onSkip,
  cameraCoordinates = { lat: 64, lon: -51, alt: 100 },
  cameraAgl,
  ...options
} = {}) {
  const state = {
    fetching: false, firstLoad: true, frameOffsetReady: false,
    frameOffsetX: 0, frameOffsetY: 0, originX: 0, originY: 0,
    cameraStereoX: 0, cameraStereoY: 0, lastFetchX: 0, lastFetchY: 0,
    currentTileIds: new Set(), lastTiles: null, bootFetchLogged: false,
  };
  const terrainRoot = { children: [] };
  const deferredTiles = new Map();
  const runtime = createTerrainFetchRuntime({
    state,
    view: { anchorLatitude: 64, anchorLongitude: -51 },
    vehicle: {},
    testOverrides: {
      getCameraCoordinates: () => cameraCoordinates,
      getCameraAGL: () => cameraAgl,
      getCameraSnapshot: () => ({ camEastM: 0, camNorthM: 0 }),
      getCameraLocalPosition: () => ({ x: 0, y: 0 }),
      getHeading: () => 0,
      getRange: () => 1000,
    },
    terrain: {
      reconcile: (tiles, { onDiff }) => reconcileTerrainTiles({
        tiles, currentTileIds: state.currentTileIds, terrainRoot, deferredTiles,
        lifecycle: {},
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

test('shared fetch runtime sends AGL rather than ASL for mountainside LOD', async () => {
  let requestedUrl = null;
  const { runtime, state } = createTestFetchRuntime({
    cameraCoordinates: { lat: 64, lon: -51, alt: 344 },
    cameraAgl: 8,
    fetchImpl: async url => {
      requestedUrl = url;
      return {
        status: 200,
        json: async () => ({
          ox: 0, oy: 0, qx: 0, qy: 0, tiles: [],
          missing: [], downloading: [], texFetching: 0,
        }),
      };
    },
  });

  await runtime.request();

  assert.match(requestedUrl, /[?&]agl=8(?:&|$)/);
  assert.doesNotMatch(requestedUrl, /[?&](?:alt|agl)=344(?:&|$)/);
  assert.equal(state.lastFetchAltitude, 8);
});

test('shared fetch runtime bootstraps coarse and never substitutes ASL when AGL is unknown', async () => {
  let requestedUrl = null;
  const { runtime, state } = createTestFetchRuntime({
    cameraCoordinates: { lat: 64, lon: -51, alt: 934 },
    cameraAgl: undefined,
    fetchImpl: async url => {
      requestedUrl = url;
      return {
        status: 200,
        json: async () => ({
          ox: 0, oy: 0, qx: 0, qy: 0, tiles: [],
          missing: [], downloading: [], texFetching: 0,
        }),
      };
    },
  });

  await runtime.request();

  assert.match(requestedUrl, /[?&]agl=10000(?:&|$)/);
  assert.doesNotMatch(requestedUrl, /[?&](?:alt|agl)=934(?:&|$)/);
  assert.equal(state.lastFetchAltitude, 10_000);
});

test('shared fetch runtime polls pending terrain without a duplicate startup pass', async () => {
  let requests = 0;
  let pollCallback = null;
  const responseData = () => ({
    ox: 0, oy: 0, qx: 0, qy: 0, tiles: [],
    missing: requests === 1 ? [{}] : [], downloading: [], texFetching: 0,
  });
  const { runtime, state } = createTestFetchRuntime({
    fetchImpl: async () => {
      requests += 1;
      return { status: 200, json: async () => responseData() };
    },
    schedulePoll: callback => { pollCallback = callback; return 7; },
    cancelPoll: () => {},
  });
  await runtime.request();
  assert.equal(requests, 1);
  assert.equal(state.lastFetchAltitude, 10_000);
  assert.equal(typeof pollCallback, 'function');
  await pollCallback();
  assert.equal(requests, 2);
});

test('shared fetch runtime coalesces movement without starving the latest request', async () => {
  const releases = [];
  const signals = [];
  const urls = [];
  let notifySecondStarted;
  const secondStarted = new Promise(resolve => { notifySecondStarted = resolve; });
  let coalesced = 0;
  const { runtime, state } = createTestFetchRuntime({
    fetchImpl: (url, { signal }) => {
      urls.push(url);
      signals.push(signal);
      if (signals.length === 2) notifySecondStarted();
      return new Promise(resolve => { releases.push(resolve); });
    },
    onSkip: () => { coalesced += 1; },
  });
  const first = runtime.request(64.1, -51.1);
  runtime.request(64.2, -51.2);
  runtime.request(64.3, -51.3);
  assert.equal(coalesced, 2);
  assert.equal(signals[0].aborted, false);
  assert.equal(releases.length, 1);
  assert.match(urls[0], /lat=64\.1&lon=-51\.1/);

  releases[0]({ status: 200, json: async () => ({
    ox: 0, oy: 0, qx: 1, qy: 2, tiles: [], missing: [], downloading: [], texFetching: 0,
  }) });
  await secondStarted;
  assert.equal(releases.length, 2);
  assert.equal(signals[1].aborted, false);
  assert.match(urls[1], /lat=64\.3&lon=-51\.3/);
  // The in-flight response stays authoritative: it fully applies (advancing
  // lastFetch so movement refetches cannot starve topology forever) before
  // the coalesced follow-up runs.
  assert.equal(state.cameraStereoX, 1);
  assert.equal(state.lastFetchX, 1);
  assert.equal(state.fetching, true);

  releases[1]({ status: 200, json: async () => ({
    ox: 0, oy: 0, qx: 20, qy: 30, tiles: [], missing: [], downloading: [], texFetching: 0,
  }) });
  await first;
  assert.equal(state.cameraStereoX, 20);
  assert.equal(state.cameraStereoY, 30);
  assert.equal(state.fetching, false);
});

test('sustained movement pressure never starves topology updates (livelock regression)', async () => {
  // The maintenance loop re-fires request() every 500ms while the camera sits
  // far from lastFetchX/Y, and lastFetch only advances on a full apply. With
  // fetches slower than 500ms, every fetch has a newer request land mid-flight
  // — forever. Two earlier designs froze LOD topology here: aborting the
  // in-flight fetch on the newer arrival, and version-demoting its response to
  // the merge-only path. Each response below must fully own topology and
  // advance lastFetch despite the runtime never going idle.
  const releases = [];
  const signals = [];
  let fetches = 0;
  const startWaiters = new Map();
  const waitForFetch = n => new Promise(resolve => {
    if (fetches >= n) resolve();
    else startWaiters.set(n, resolve);
  });
  const { runtime, state } = createTestFetchRuntime({
    fetchImpl: (_url, { signal }) => {
      fetches += 1;
      signals.push(signal);
      startWaiters.get(fetches)?.();
      return new Promise(resolve => { releases.push(resolve); });
    },
  });
  const respond = (index, qx, tiles) => releases[index]({
    status: 200,
    json: async () => ({
      ox: 0, oy: 0, qx, qy: 0, tiles, missing: [], downloading: [], texFetching: 0,
    }),
  });

  const chain = runtime.request();
  runtime.request();
  respond(0, 1, [{ id: '9-0-0', heightmap: 'a' }]);
  await waitForFetch(2);
  assert.equal(state.lastFetchX, 1);
  assert.deepEqual(state.lastTiles.map(tile => tile.id), ['9-0-0']);

  runtime.request();
  respond(1, 2, [{ id: '12-0-0', heightmap: 'b' }]);
  await waitForFetch(3);
  assert.equal(state.lastFetchX, 2);
  assert.deepEqual(state.lastTiles.map(tile => tile.id), ['12-0-0']);

  respond(2, 3, [{ id: '12-1-1', heightmap: 'c' }]);
  await chain;
  assert.equal(state.lastFetchX, 3);
  assert.deepEqual(state.lastTiles.map(tile => tile.id), ['12-1-1']);
  assert.equal(state.fetching, false);
  assert.equal(signals.some(signal => signal.aborted), false);
});

test('shared fetch runtime rejects an HTTP error before terrain reconciliation', async () => {
  let reportedError = null;
  const { runtime, state } = createTestFetchRuntime({
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'database is locked' }),
    }),
    events: {
      onError(error) { reportedError = error; },
    },
  });
  await runtime.request();
  assert.match(reportedError?.message ?? '', /terrain tile request failed \(500\): database is locked/);
  assert.equal(state.firstLoad, true);
  assert.equal(state.lastTiles, null);
  assert.equal(state.fetching, false);
});

test('reset aborts the active terrain request and gates its completion by the current tile set', async () => {
  let activeSignal = null;
  let release;
  const { runtime, state } = createTestFetchRuntime({
    fetchImpl: (_url, { signal }) => {
      activeSignal = signal;
      return new Promise(resolve => { release = resolve; });
    },
  });
  const request = runtime.request();
  runtime.reset();
  assert.equal(activeSignal.aborted, true);
  release({ status: 200, json: async () => ({
    ox: 0, oy: 0, qx: 0, qy: 0, tiles: [], missing: [], downloading: [], texFetching: 0,
  }) });
  await request;
  assert.equal(state.lastTiles, null);
  assert.equal(state.fetching, false);
});

test('superseded depth-12 response cannot replace latest depth-10 demand', async () => {
  const releases = [];
  const { runtime, state } = createTestFetchRuntime({
    fetchImpl: () => new Promise(resolve => { releases.push(resolve); }),
  });
  const oldRequest = runtime.request();
  runtime.reset();
  const latestRequest = runtime.request();

  releases[0]({ status: 200, json: async () => ({
    ox: 0, oy: 0, qx: 12, qy: 12,
    tiles: [{ id: '12-old', heightmap: 'old' }],
    missing: [], downloading: [], texFetching: 0,
  }) });
  await oldRequest;
  assert.equal(state.lastTiles, null);

  releases[1]({ status: 200, json: async () => ({
    ox: 0, oy: 0, qx: 10, qy: 10,
    tiles: [{ id: '10-latest', heightmap: 'latest' }],
    missing: [], downloading: [], texFetching: 0,
  }) });
  await latestRequest;
  assert.deepEqual(state.lastTiles.map(tile => tile.id), ['10-latest']);
  assert.equal(state.cameraStereoX, 10);
  assert.equal(state.cameraStereoY, 10);
});

test('superseded response admits only exact quality upgrades in the latest tile set', async () => {
  const releases = [];
  const { runtime, state } = createTestFetchRuntime({
    fetchImpl: () => new Promise(resolve => { releases.push(resolve); }),
  });
  const baseline = runtime.request();
  releases[0]({ status: 200, json: async () => ({
    ox: 0, oy: 0, qx: 0, qy: 0,
    tiles: [], missing: [], downloading: [], texFetching: 0,
  }) });
  await baseline;

  const oldRequest = runtime.request();
  runtime.reset();
  const latestRequest = runtime.request();
  releases[2]({ status: 200, json: async () => ({
    ox: 0, oy: 0, qx: 10, qy: 10,
    tiles: [
      { id: '10-381-194', source: 'arcticdem_10m', heightmap: 'latest-parent' },
      { id: '11-800-400', source: 'procedural', heightmap: 'latest-synthetic' },
    ],
    missing: [], downloading: [], texFetching: 0,
  }) });
  await latestRequest;

  releases[1]({ status: 200, json: async () => ({
    ox: 0, oy: 0, qx: 12, qy: 12,
    tiles: [
      { id: '12-1525-779', source: 'arcticdem_10m', heightmap: 'stale-child' },
      { id: '11-800-400', source: 'arcticdem_10m', heightmap: 'late-real' },
    ],
    missing: [], downloading: [], texFetching: 0,
  }) });
  await oldRequest;

  assert.deepEqual(
    state.lastTiles.map(tile => tile.id),
    ['10-381-194', '11-800-400'],
  );
  assert.equal(state.lastTiles[0].heightmap, 'latest-parent');
  assert.equal(state.lastTiles[1].heightmap, 'late-real');
  assert.equal(state.cameraStereoX, 10);
  assert.equal(state.cameraStereoY, 10);
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
    lifecycle: { evictCoveredAncestors() {} },
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

test('shared texture controller discards late arrivals outside current browser demand', () => {
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
    lifecycle: { evictCoveredAncestors() {} },
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
  assert.equal(ancestorEvictions, 2);
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
  assert.deepEqual([...mesh.geometry.attributes.position.array.slice(0, 12)], [
    10, 20, 2, 12, 20, 4, 10, 22, 6, 12, 22, 8,
  ]);
  assert.equal(mesh.geometry.attributes.position.count, 20);
  assert.equal(mesh.geometry.attributes.color.count, 20);
  assert.equal(mesh.geometry.attributes.uv.count, 20);
  assert.equal(mesh.geometry.index.count, 30);
  assert.equal(mesh.userData.skirtDepth, 60);
  assert.deepEqual([...mesh.geometry.attributes.position.array.slice(12, 18)], [
    10, 20, 2, 10, 20, -58,
  ]);
  assert.equal(mesh.userData.tileId, '1-2-3');
  assert.equal(mesh.userData.resolution, 2);
  assert.deepEqual([...scatterHeightmap], [1, 2, 3, 4]);
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

test('seam grid colors shared edges by measured failure and reports both tiles', () => {
  const root = {
    children: [],
    add(child) { this.children.push(child); },
    remove(child) { this.children = this.children.filter(item => item !== child); },
  };
  const grid = createTerrainMapGridController({ terrainRoot: root });
  const build = createTerrainMeshBuilder({ exaggeration: 1, attachScatter() {} });
  const encoded = values => Buffer.from(new Float32Array(values).buffer).toString('base64');
  const meshes = [
    build({ id: '11-1-1', resolution: 2, bbox: [0, 0, 8, 8], heightmap: encoded([0, 0, 0, 0]) }),
    build({ id: '12-2-2', resolution: 2, bbox: [8, 0, 12, 4], heightmap: encoded([2, 2, 2, 2]) }),
  ];
  grid.setVisible(true);
  assert.equal(grid.update(meshes), true);
  assert.equal(grid.lines.geometry.attributes.position.count, 2);
  assert.equal(grid.lines.geometry.attributes.color.count, 2);
  assert.equal(grid.lines.material.vertexColors, true);
  assert.equal(grid.lines.material.toneMapped, false);
  assert.equal(grid.lines.material.depthWrite, false);
  assert.equal(grid.diagnostics.length, 1);
  assert.equal(grid.diagnostics[0].severity, 'bad');
  assert.equal(grid.diagnostics[0].maxHeightGap, 2);
  assert.equal(grid.diagnostics[0].depthDelta, 1);
  assert.match(formatTerrainSeamDiagnostic(grid.diagnosticsForTile('11-1-1')[0]), /12-2-2.*2\.00m gap.*cross-LOD/);
  assert.match(formatTerrainSeamDiagnostic(grid.diagnosticsForTile('12-2-2')[0]), /11-1-1.*2\.00m gap.*cross-LOD/);
  assert.equal(grid.lines.visible, true);
  assert.equal(grid.update(meshes), false);
  grid.setVisible(false);
  assert.equal(grid.lines.visible, false);
  grid.dispose();
  assert.equal(root.children.length, 0);
});

test('seam analysis leaves aligned geometry quiet and detects normal-only seams', () => {
  const build = createTerrainMeshBuilder({ exaggeration: 1, attachScatter() {} });
  const encoded = values => Buffer.from(new Float32Array(values).buffer).toString('base64');
  const flat = build({ id: '12-0-0', resolution: 2, bbox: [0, 0, 1, 1], heightmap: encoded([0, 0, 0, 0]) });
  const aligned = build({ id: '12-1-0', resolution: 2, bbox: [1, 0, 2, 1], heightmap: encoded([0, 0, 0, 0]) });
  assert.equal(analyzeTerrainSeams([flat, aligned])[0].severity, 'healthy');

  const slope = build({ id: '12-1-0', resolution: 2, bbox: [1, 0, 2, 1], heightmap: encoded([0, 10, 0, 10]) });
  const seam = analyzeTerrainSeams([flat, slope])[0];
  assert.equal(seam.maxHeightGap, 0);
  assert.equal(seam.severity, 'bad');
  assert.ok(seam.maxNormalAngle > 20);
});

test('shared fetch runtime preserves initial response transition ordering', async () => {
  const events = [];
  const state = {
    firstLoad: true, frameOffsetReady: false,
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
        lifecycle: {},
        priorityForTile: () => 0, textureCache: new Map(),
        materialize() {}, buildMesh() {}, log() {}, onDiff,
      }),
      updateTextures() { events.push('textures'); },
    },
    logger: {
      enqueue(_level, name) { events.push(name); },
      boot(name) { events.push(name); },
    },
    events: {
      onBuildings(buildings) { events.push(`buildings:${buildings.length}`); },
      onAvailability() { events.push('missing'); },
    },
    fetchImpl: async () => ({
      status: 200,
      json: async () => ({
        ox: 10, oy: 20, qx: 11, qy: 21, tiles: [], buildings: [{ id: 'b' }],
        missing: [], downloading: [],
        texFetching: 0, texRetryQueue: 0, texStatusCounts: {},
      }),
    }),
  });
  const result = await runtime.execute({});
  assert.equal(result.nextAction, 'idle');
  assert.equal(state.firstLoad, false);
  assert.equal(state.originX, 10);
  assert.deepEqual(events, [
    'fetchTiles.request', 'fetchTiles.frame.offset.set',
    'fetchTiles.response', 'tiles.initial-fetch.response',
    'fetchTiles.origin.set', 'buildings:1', 'fetchTiles.diff', 'fetchTiles.built',
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

test('projected camera direction determines terrain demand heading', () => {
  assert.equal(headingFromForward2D(0, 1), 0);
  assert.equal(headingFromForward2D(-1, 0), Math.PI / 2);
  assert.equal(headingFromForward2D(1, 0), -Math.PI / 2);
  assert.equal(headingFromForward2D(0, 0, 1.25), 1.25);
});

test('stationary vehicle heading wins over orbiting camera yaw', () => {
  assert.equal(priorityHeading(true, 1.25, -0.75), 1.25);
  assert.equal(priorityHeading(false, 1.25, -0.75), -0.75);
});

test('view heading reset detection wraps angles and catches any real motion', () => {
  const threshold = 2 * Math.PI / 180;
  assert.equal(viewHeadingChanged(0, Number.EPSILON), true);
  assert.equal(viewHeadingChanged(0, 1 * Math.PI / 180, threshold), false);
  assert.equal(viewHeadingChanged(0, 3 * Math.PI / 180, threshold), true);
  assert.equal(viewHeadingChanged(Math.PI - 0.01, -Math.PI + 0.01, threshold), false);
  assert.equal(viewHeadingChanged(Math.PI - 0.03, -Math.PI + 0.03, threshold), true);
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

test('terrain priority distance is circular in every heading', () => {
  assert.equal(radialPriorityDistance(0, 40000), 40000);
  assert.equal(radialPriorityDistance(0, -20000), 20000);
  assert.equal(radialPriorityDistance(20000, 0), 20000);
  assert.ok(Math.abs(
    radialPriorityDistance(-40000, 0) - 40000,
  ) < 1e-9);
});

test('HUD compass uses the same heading convention', () => {
  assert.equal(compassHeading(0).compass, 'N');
  assert.equal(compassHeading(Math.PI / 2).compass, 'W');
  assert.equal(compassHeading(-Math.PI / 2).compass, 'E');
});

test('HUD renders a visible camera forward-lock indicator only while drifting', () => {
  assert.equal(cameraDriftIndicator(false), '');
  const active = cameraDriftIndicator(true);
  assert.match(active, /cameraDriftIndicator/);
  assert.match(active, /FORWARD LOCK/);
  assert.match(active, /Double-tap W or ↑ to disable/);
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
  const roundTrip = vehicleLatLonToLocal(local.lat, local.lon, anchorLat, anchorLon);
  assert.ok(Math.abs(roundTrip.x - 111320 * Math.cos(anchorLat * Math.PI / 180)) < 1e-6);
  assert.ok(Math.abs(roundTrip.y - 111320) < 1e-6);

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

test('texture demand refines equivalent coverage before coarse parents', () => {
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

test('flushing texture work always advances the cache version', () => {
  const streamer = createTextureStreamer({ log: () => {} });
  const initial = streamer.version;
  streamer.abortAll();
  const firstFlush = streamer.version;
  streamer.abortAll();
  assert.ok(firstFlush > initial);
  assert.ok(streamer.version > firstFlush);
});

test('leaving heading demand retains cached paint for immediate reuse', () => {
  const streamer = createTextureStreamer({ log: () => {} });
  const texture = { dispose() { assert.fail('cached paint must not be disposed'); } };
  streamer.texCache.set('11-10-20', texture);
  streamer.texSource.set('11-10-20', 'dataforsyningen');
  streamer.releaseTileDemand('11-10-20');
  assert.equal(streamer.texCache.get('11-10-20'), texture);
  assert.equal(streamer.texSource.get('11-10-20'), 'dataforsyningen');
});

test('road debug invalidates cached variants and marks texture requests', async () => {
  let requestedUrl = null;
  const stale = { disposed: false, dispose() { this.disposed = true; } };
  const streamer = createTextureStreamer({
    log: () => {},
    fetchImpl: async url => {
      requestedUrl = url;
      return { status: 202, ok: false };
    },
  });
  streamer.texCache.set('12-1-2', stale);
  assert.equal(streamer.setRoadDebug(true), true);
  assert.equal(streamer.texCache.size, 0);
  assert.equal(stale.disposed, false);
  streamer.pump([{ tile: { id: '12-1-2', bbox: [0, 0, 1, 1] } }], {
    isCovered: () => false,
    onPlaceholder: () => {},
    onTexture: () => {},
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(requestedUrl, /roadDebug=1/);
  assert.doesNotMatch(requestedUrl, /[?&]demand(?:Client)?=/);
  assert.equal(streamer.releaseStaleTexture(stale), true);
  assert.equal(stale.disposed, true);
});

test('pink water debug is independent from roads and marks texture requests', async () => {
  let requestedUrl = null;
  const streamer = createTextureStreamer({
    log: () => {},
    fetchImpl: async url => {
      requestedUrl = url;
      return { status: 202, ok: false };
    },
  });
  assert.equal(streamer.roadDebug, false);
  assert.equal(streamer.setWaterDebug(true), true);
  assert.equal(streamer.roadDebug, false);
  streamer.pump([{ tile: { id: '12-1-2', bbox: [0, 0, 1, 1] } }], {
    isCovered: () => false,
    onPlaceholder: () => {},
    onTexture: () => {},
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(requestedUrl, /waterDebug=1/);
  assert.doesNotMatch(requestedUrl, /roadDebug=1/);
});

test('Åbent Land hydrography debug is independently requested in blue mode', async () => {
  let requestedUrl = null;
  const streamer = createTextureStreamer({
    log: () => {},
    fetchImpl: async url => {
      requestedUrl = url;
      return { status: 202, ok: false };
    },
  });
  assert.equal(streamer.waterDebug, false);
  assert.equal(streamer.setHydroDebug(true), true);
  assert.equal(streamer.waterDebug, false);
  streamer.pump([{ tile: { id: '12-1409-827', bbox: [0, 0, 1, 1] } }], {
    isCovered: () => false,
    onPlaceholder: () => {},
    onTexture: () => {},
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(requestedUrl, /hydroDebug=1/);
  assert.doesNotMatch(requestedUrl, /waterDebug=1/);
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

test('shared texture pump immediately refills freed concurrency slots', async () => {
  const requests = [];
  const resolvers = [];
  const streamer = createTextureStreamer({
    log: () => {},
    maxInflight: 2,
    fetchImpl: url => new Promise(resolve => {
      requests.push(url);
      resolvers.push(resolve);
    }),
    decodeImage: async () => ({ width: 256, height: 256 }),
  });
  const response = {
    status: 200,
    ok: true,
    headers: { get: () => null },
    blob: async () => ({}),
  };
  const scored = [1, 2, 3].map(index => ({
    tile: { id: `12-1-${index}`, bbox: [0, 0, 1, 1] },
  }));

  streamer.pump(scored, {
    isCovered: () => false,
    onPlaceholder: () => assert.fail('unexpected placeholder'),
    onTexture: () => {},
  });
  assert.equal(requests.length, 2);

  resolvers[0](response);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 3);

  resolvers[1](response);
  resolvers[2](response);
  await new Promise(resolve => setImmediate(resolve));
});

test('aborted texture demand does not refill cancelled work', async () => {
  const requests = [];
  let resolveRequest;
  const streamer = createTextureStreamer({
    log: () => {},
    maxInflight: 1,
    fetchImpl: url => new Promise(resolve => {
      requests.push(url);
      resolveRequest = resolve;
    }),
    decodeImage: async () => ({ width: 256, height: 256 }),
  });
  const scored = [1, 2].map(index => ({
    tile: { id: `12-2-${index}`, bbox: [0, 0, 1, 1] },
  }));
  streamer.pump(scored, {
    isCovered: () => false,
    onPlaceholder: () => assert.fail('unexpected placeholder'),
    onTexture: () => {},
  });
  assert.equal(requests.length, 1);

  streamer.abortAll();
  resolveRequest({
    status: 200,
    ok: true,
    headers: { get: () => null },
    blob: async () => ({}),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1);
});

test('texture anisotropy supports both renderer APIs and fails safely', () => {
  assert.equal(rendererTextureAnisotropy({ getMaxAnisotropy: () => 16 }), 16);
  assert.equal(rendererTextureAnisotropy({
    capabilities: { getMaxAnisotropy: () => 8 },
  }), 8);
  assert.equal(rendererTextureAnisotropy({ getMaxAnisotropy: () => { throw new Error('not ready'); } }), 1);
});

test('shared lifecycle materializes a tile without forcing a world-matrix walk', () => {
  const terrainRoot = new THREE.Group();
  const mesh = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial(),
  );
  mesh.userData.tileId = '8-1-1';
  let updateArguments = null;
  mesh.updateWorldMatrix = (...args) => { updateArguments = args; };
  const lifecycle = createTileLifecycle({
    terrainRoot,
    disposeScatter: () => {},
    log: () => {},
  });

  lifecycle.replaceForMaterialized(mesh, new Set([mesh.userData.tileId]));

  assert.equal(updateArguments, null);
  assert.equal(terrainRoot.children.includes(mesh), true);
});

test('shared lifecycle retires parent when all demanded descendants are textured', () => {
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
  const demandedIds = new Set(children.map(c => c.userData.tileId));
  root.children.push(...children.slice(1));
  lifecycle.evictCoveredAncestors(children.at(-1).userData.tileId, demandedIds);
  assert.deepEqual(root.children, children);
});

test('shared lifecycle discards a coarse source after demanded children are chopped from it', () => {
  const parent = {
    isMesh: true,
    userData: { tileId: '11-719-386' },
    material: { map: {}, dispose() {} },
    geometry: { dispose() {} },
  };
  const children = ['12-1438-772', '12-1438-773'].map(tileId => {
    const texture = {};
    return {
      isMesh: true,
      userData: { tileId, terrainPlaceholderTexture: texture },
      material: { map: texture, dispose() {} },
      geometry: { dispose() {} },
    };
  });
  const root = {
    children: [parent, ...children],
    remove(mesh) { this.children = this.children.filter(item => item !== mesh); },
  };
  const released = [];
  const lifecycle = createTileLifecycle({
    terrainRoot: root,
    disposeScatter: () => {},
    log: () => {},
    onReleaseTile: tileId => released.push(tileId),
  });

  lifecycle.evictCoveredAncestors(
    children.at(-1).userData.tileId,
    new Set(children.map(child => child.userData.tileId)),
  );

  assert.equal(root.children.includes(parent), false);
  assert.deepEqual(released, [parent.userData.tileId]);
});

test('shared lifecycle counts ancestor-crop children as replacement coverage', () => {
  const parent = {
    isMesh: true,
    userData: { tileId: '11-719-386' },
    material: { map: {}, dispose() {} },
    geometry: { dispose() {} },
  };
  const children = ['12-1438-772', '12-1438-773', '12-1439-772', '12-1439-773']
    .map(tileId => ({
      isMesh: true,
      userData: { tileId },
      material: { map: {}, dispose() {} },
      geometry: { dispose() {} },
    }));
  children[3].userData.terrainPlaceholderTexture = children[3].material.map;
  const root = {
    children: [parent, ...children],
    remove(mesh) { this.children = this.children.filter(item => item !== mesh); },
  };
  const lifecycle = createTileLifecycle({
    terrainRoot: root, disposeScatter: () => {}, log: () => {},
  });

  lifecycle.evictCoveredAncestors(children[3].userData.tileId);
  assert.equal(root.children.includes(parent), false);
});
