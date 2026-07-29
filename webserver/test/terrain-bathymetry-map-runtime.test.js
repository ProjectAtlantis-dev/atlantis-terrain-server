import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
  buildBathymetryMapGroup,
  createTerrainBathymetryMapRuntime,
} from '../terrain-bathymetry-map-runtime.js';

const payload = {
  coverage: [{ tileId: '8-1-2', bbox: [0, 10, 20, 30] }],
  coverageCount: 1,
  soundings: [
    { id: 'actual', x: 5, y: 6, depthM: 120, kind: 'actual' },
    { id: 'bound', x: 7, y: 8, depthM: 80, kind: 'at_least' },
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
  assert.equal(coverage.material.blending, THREE.AdditiveBlending);
  assert.equal(lines.material.blending, THREE.AdditiveBlending);
  assert.equal(actualPoints.material.blending, THREE.AdditiveBlending);
  assert.equal(soundingPoints.material.blending, THREE.AdditiveBlending);
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
  const terrainRoot = {
    add(item) { added.push(item); },
    remove() {},
  };
  let intervalCallback = null;
  const runtime = createTerrainBathymetryMapRuntime({
    terrainRoot,
    pipelineState: {
      ready: true,
      frameOffsetReady: true,
      lastFetchX: 1000,
      lastFetchY: 2000,
      originX: 900,
      originY: 1900,
      frameOffsetX: 4,
      frameOffsetY: -3,
    },
    fetchImpl: async () => ({ ok: true, json: async () => payload }),
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
  assert.equal(typeof intervalCallback, 'function');
});
