import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
  bathymetrySoundingTooltipHtml,
  buildBathymetryMapGroup,
  createTerrainBathymetryMapRuntime,
  nearestBathymetrySounding,
  soundingHealthColor,
} from '../terrain-bathymetry-map-runtime.js';

const payload = {
  coverage: [{ tileId: '8-1-2', bbox: [0, 10, 20, 30] }],
  coverageCount: 1,
  soundings: [
    {
      id: 'source|12-1-2',
      sourceUrl: 'https://example.test/grid',
      recordId: '12-1-2',
      sourceAsset: 'bathymetry.tif',
      evidenceFormat: 'raster',
      latitude: 64.1,
      longitude: -51.2,
      x: 5,
      y: 6,
      depthM: 120,
      kind: 'actual',
      health: 'yellow',
      modeledDepthM: 100,
      modelDeltaM: -20,
      modelErrorM: 24.5,
      modelTileId: '12-1-2',
      comparisonMethod: 'corner_rms',
      modelSampleCount: 4,
      evidenceCornersM: [110, 120, 130, 140],
      modeledCornersM: [90, 100, 105, 115],
    },
    {
      id: 'bound', x: 7, y: 8, depthM: 80, kind: 'at_least', health: 'red',
    },
  ],
  soundingCount: 2,
};

test('bathymetry map builds coverage quads and vertical sounding markers', () => {
  const group = buildBathymetryMapGroup(payload, {
    offsetX: 100, offsetY: -50, exaggeration: 2,
  });
  const coverage = group.children.find(child => child.userData.isBathymetryCoverage);
  const lines = group.children.find(child => child.isLineSegments);
  const actualPoints = group.children.find(
    child => child.userData.bathymetryMarkerShape === 'circle',
  );
  const soundingPoints = group.children.find(
    child => child.userData.bathymetryMarkerShape === 'square',
  );
  assert.ok(coverage);
  assert.equal(coverage.geometry.getIndex().count, 6);
  assert.equal(lines.geometry.getAttribute('position').count, 4);
  assert.equal(actualPoints.geometry.getAttribute('position').count, 1);
  assert.equal(soundingPoints.geometry.getAttribute('position').count, 1);
  assert.equal(lines.geometry.getAttribute('position').getZ(1), -240);
  assert.equal(actualPoints.geometry.getAttribute('position').getX(0), 105);
  assert.equal(soundingPoints.geometry.getAttribute('position').getX(0), 107);
  assert.ok(actualPoints.material.map?.isDataTexture);
  assert.equal(soundingPoints.material.map, null);
  assert.equal(coverage.material.toneMapped, false);
  assert.equal(lines.material.toneMapped, false);
  assert.equal(actualPoints.material.toneMapped, false);
  assert.equal(soundingPoints.material.toneMapped, false);
  assert.equal(lines.material.depthTest, true);
  assert.equal(lines.material.depthWrite, false);
  assert.equal(actualPoints.material.depthTest, true);
  assert.equal(actualPoints.material.depthWrite, false);
  assert.equal(soundingPoints.material.depthTest, true);
  assert.equal(soundingPoints.material.depthWrite, false);
  assert.equal(coverage.material.blending, THREE.AdditiveBlending);
  assert.equal(lines.material.blending, THREE.NormalBlending);
  assert.equal(actualPoints.material.blending, THREE.NormalBlending);
  assert.equal(soundingPoints.material.blending, THREE.NormalBlending);
  const actualColor = new THREE.Color().fromBufferAttribute(
    actualPoints.geometry.getAttribute('color'), 0,
  );
  const soundingColor = new THREE.Color().fromBufferAttribute(
    soundingPoints.geometry.getAttribute('color'), 0,
  );
  assert.equal(actualColor.getHex(), 0xffe45c);
  assert.equal(soundingColor.getHex(), 0xff1800);
  assert.equal(group.userData.bathymetrySoundingHits.length, 2);
});

test('map hover finds a nearby sounding in screen space', () => {
  const group = buildBathymetryMapGroup(payload);
  const camera = new THREE.OrthographicCamera(-100, 100, 100, -100, 0.1, 2000);
  camera.position.set(0, 0, 1000);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  const hit = nearestBathymetrySounding(group, camera, {
    clientX: 532,
    clientY: 476,
    width: 1000,
    height: 1000,
  });
  assert.equal(hit.sounding.recordId, '12-1-2');
  assert.ok(hit.distancePx < 16);
  assert.equal(nearestBathymetrySounding(group, camera, {
    clientX: 700,
    clientY: 700,
    width: 1000,
    height: 1000,
  }), null);
});

test('hover details show only observed and modeled depth', () => {
  const html = bathymetrySoundingTooltipHtml(payload.soundings[0]);
  assert.equal(
    html,
    'Observed: <b>125.0 m</b><br>Model: <b>102.5 m</b>',
  );
  assert.equal(
    bathymetrySoundingTooltipHtml(payload.soundings[1]),
    'Observed ≥: <b>80.0 m</b><br>Model: <b>—</b>',
  );
});

test('sounding health is white unless explicitly yellow or red', () => {
  assert.equal(soundingHealthColor(undefined).getHex(), 0xf4f4f5);
  assert.equal(soundingHealthColor('white').getHex(), 0xf4f4f5);
  assert.equal(soundingHealthColor('yellow').getHex(), 0xffe45c);
  assert.equal(soundingHealthColor('red').getHex(), 0xff1800);
});

test('red markers render over nearby white markers regardless of shape', () => {
  const group = buildBathymetryMapGroup({
    soundings: [
      { x: 0, y: 0, depthM: 40, kind: 'actual', health: 'red' },
      { x: 1, y: 1, depthM: 700, kind: 'at_least', health: 'white' },
    ],
  });
  const circle = group.children.find(
    child => child.userData.bathymetryMarkerShape === 'circle',
  );
  const square = group.children.find(
    child => child.userData.bathymetryMarkerShape === 'square',
  );
  assert.ok(circle.renderOrder > square.renderOrder);
});

test('bathymetry coverage is clipped to the requested circle', () => {
  const group = buildBathymetryMapGroup({
    coverage: [
      { bbox: [-20, -20, 20, 20] },
      { bbox: [30, 30, 40, 40] },
    ],
  }, {
    clipCircle: { x: 0, y: 0, radius: 10 },
  });
  const coverage = group.children.find(child => child.userData.isBathymetryCoverage);
  const positions = coverage.geometry.getAttribute('position');
  assert.ok(positions.count > 4);
  for (let i = 0; i < positions.count; i += 1) {
    assert.ok(
      Math.hypot(positions.getX(i), positions.getY(i)) <= 10.00001,
      `coverage vertex ${i} escaped the map circle`,
    );
  }
});

test('runtime fetches only while enabled and reports mapped counts', async () => {
  const added = [];
  const fetchedUrls = [];
  const terrainRoot = {
    add(item) { added.push(item); },
    remove() {},
  };
  const pipelineState = {
    ready: true,
    frameOffsetReady: true,
    cameraStereoX: 1010,
    cameraStereoY: 2020,
    lastFetchX: 1000,
    lastFetchY: 2000,
    originX: 900,
    originY: 1900,
    frameOffsetX: 4,
    frameOffsetY: -3,
  };
  let intervalCallback = null;
  const runtime = createTerrainBathymetryMapRuntime({
    terrainRoot,
    pipelineState,
    fetchImpl: async url => {
      fetchedUrls.push(url);
      return { ok: true, json: async () => payload };
    },
    setIntervalImpl: callback => {
      intervalCallback = callback;
      return 7;
    },
    clearIntervalImpl: () => {},
  });

  assert.equal(runtime.active, false);
  runtime.setActive(true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(runtime.active, true);
  assert.deepEqual(runtime.counts, { coverage: 1, soundings: 2 });
  assert.equal(added.length, 1);
  assert.match(fetchedUrls[0], /[?&]sx=1010(?:&|$)/);
  assert.match(fetchedUrls[0], /[?&]sy=2020(?:&|$)/);
  assert.match(fetchedUrls[0], /[?&]range=2000(?:&|$)/);
  assert.equal(typeof intervalCallback, 'function');

  // Terrain fetch coordinates remain stale while the live camera advances.
  // Movement itself must refresh from the camera coordinates without waiting
  // for the periodic overlay poll.
  pipelineState.cameraStereoX = 1400;
  pipelineState.cameraStereoY = 2600;
  await runtime.sync();
  assert.equal(added.length, 2);
  assert.match(fetchedUrls[1], /[?&]sx=1400(?:&|$)/);
  assert.match(fetchedUrls[1], /[?&]sy=2600(?:&|$)/);
});
