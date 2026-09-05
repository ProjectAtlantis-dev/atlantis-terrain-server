import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
  terrainMeshSurfaceStats,
  terrainMeshWaterDiagnostics,
} from '../terrain-debug-runtime.js';
import {
  createTerrainMeshBuilder,
  updateTerrainMeshHeightmap,
} from '../terrain-mesh-builder.js';

const tile = samples => ({
  id: '12-1962-97',
  bbox: [0, 0, 1, 1],
  source: 'arcticdem_10m',
  resolution: 2,
  heightmap: 'digest-a',
  samples: Float32Array.from(samples),
  dem: {
    verticalDatum: 'EGM2008',
    water: {
      coastline: 'ready', coastlineWaterCount: 0,
      hydrography: 'ready', hydrographyWaterCount: 2,
      tidalConnectivity: 'ready', tidalConnectivityWaterCount: 1,
    },
    heightmap: {
      maskSource: 'ready_water_snapshot',
      waterCount: 1,
      bathymetryFound: false,
      bathymetryVertices: 0,
      verticalDatum: 'EGM2008',
    },
  },
});

test('zero-clipped terrain is excluded from the rendered water mask', () => {
  const build = createTerrainMeshBuilder({
    exaggeration: 2,
    attachScatter() {},
  });
  const mesh = build(tile([0, -5, 2, 4]));

  assert.deepEqual([...mesh.userData.terrainWaterMask], [0, 1, 0, 0]);
  assert.equal(mesh.userData.terrainPublishedWaterCount, 1);
  assert.equal(mesh.userData.terrainMaskSource, 'ready_water_snapshot');
  assert.deepEqual(mesh.userData.terrainWaterStatus, {
    coastline: 'ready', coastlineWaterCount: 0,
    hydrography: 'ready', hydrographyWaterCount: 2,
    tidalConnectivity: 'ready', tidalConnectivityWaterCount: 1,
  });
});

test('gridline water diagnostics expose zero plate and cursor separation', () => {
  const build = createTerrainMeshBuilder({
    exaggeration: 2,
    attachScatter() {},
  });
  const mesh = build(tile([0, -5, 2, 4]));
  const diagnostics = terrainMeshWaterDiagnostics(mesh, {
    localPoint: new THREE.Vector3(0, 0, 0),
    waterline: 0.5,
  });

  assert.deepEqual(terrainMeshSurfaceStats(mesh), {
    finiteCount: 4,
    minimum: -5,
    maximum: 4,
    zeroCount: 1,
    negativeCount: 1,
  });
  assert.equal(diagnostics.pointElevation, 0);
  assert.equal(diagnostics.waterSeparation, 0.5);
  assert.equal(diagnostics.bathymetryFound, false);
  assert.equal(diagnostics.renderedWaterCount, 1);
});

test('water metadata and strict mask refresh with a replacement heightmap', () => {
  const build = createTerrainMeshBuilder({
    exaggeration: 1,
    attachScatter() {},
  });
  const mesh = build(tile([0, -5, 2, 4]));
  const replacement = tile([-6, 0, 3, 5]);
  replacement.heightmap = 'digest-b';
  replacement.dem.heightmap.waterCount = 1;
  replacement.dem.heightmap.bathymetryFound = true;
  replacement.dem.heightmap.bathymetryVertices = 1;

  assert.equal(updateTerrainMeshHeightmap(mesh, replacement), true);
  assert.deepEqual([...mesh.userData.terrainWaterMask], [1, 0, 0, 0]);
  assert.equal(mesh.userData.terrainBathymetryFound, true);
  assert.equal(mesh.userData.terrainBathymetryVertices, 1);
});
