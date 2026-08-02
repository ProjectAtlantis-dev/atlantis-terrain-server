import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as THREE from 'three';

import {
  TERRAIN_BATHYMETRY_LAYER,
  WATER_RENDER_CONTRACT,
} from '../render-backends/terrain-render-contract.js';
import {
  prepareTerrainTilesForBathymetry,
} from '../render-backends/terrain-bathymetry-tiles.js';

test('cross-backend water calibration has one immutable contract', () => {
  assert.equal(Object.isFrozen(WATER_RENDER_CONTRACT), true);
  assert.deepEqual(WATER_RENDER_CONTRACT, {
    fetchFractionScale: 3,
    shoreFoamDistanceStartM: 700,
    shoreFoamDistanceEndM: 2800,
    shoreFoamAlphaMaximum: 0.75,
    microGateMinimum: 0.22,
    microGateStart: 0.02,
    microGateEnd: 0.25,
    facetGainMaximum: 1.35,
    facetGainStartM: 300,
    facetGainEndM: 2500,
    crestExponent: 96,
    crestFilterStartM: 450,
    crestFilterEndM: 2200,
  });
});

test('water backends do not retain the retired local bathymetry constant', () => {
  for (const backend of ['webgl-water.js', 'webgpu-water.js']) {
    const source = readFileSync(
      new URL(`../render-backends/${backend}`, import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(source, /\bBATHYMETRY_LAYER\b/);
    assert.match(source, /\bTERRAIN_BATHYMETRY_LAYER\b/);
  }
});

test('shore sparkle is real sun reflection rather than procedural flashing', () => {
  for (const backend of ['webgl-water.js', 'webgpu-water.js']) {
    const source = readFileSync(
      new URL(`../render-backends/${backend}`, import.meta.url),
      'utf8',
    );
    assert.match(source, /\bshoreSunGlint\b/);
    assert.match(source, /\bggxAniso\b/);
    assert.match(source, /\bfresL\b/);
    assert.doesNotMatch(source, /\btwinkle(?:Phase|Wave)?\b/);
    assert.doesNotMatch(source, /\bsparkleFacet\b/);
  }
});

test('bathymetry tile ordering and restoration are backend-neutral', () => {
  const parent = new THREE.Mesh();
  parent.userData.tileId = '11-10-20';
  parent.layers.set(3);
  parent.renderOrder = 40;
  const child = new THREE.Mesh();
  child.userData.tileId = '12-20-40';
  child.layers.set(5);
  child.renderOrder = 2;
  const prepared = [];
  const restored = [];

  const restore = prepareTerrainTilesForBathymetry(
    { children: [child, parent] },
    {
      onPrepare: tile => prepared.push(tile.userData.tileId),
      onRestore: tile => restored.push(tile.userData.tileId),
    },
  );
  assert.equal(parent.layers.mask, 2 ** TERRAIN_BATHYMETRY_LAYER);
  assert.equal(child.layers.mask, 2 ** TERRAIN_BATHYMETRY_LAYER);
  assert.equal(parent.renderOrder, 11);
  assert.equal(child.renderOrder, 12);
  assert.deepEqual(prepared, ['12-20-40', '11-10-20']);

  restore();
  assert.equal(parent.layers.mask, 2 ** 3);
  assert.equal(child.layers.mask, 2 ** 5);
  assert.equal(parent.renderOrder, 40);
  assert.equal(child.renderOrder, 2);
  assert.deepEqual(restored, ['12-20-40', '11-10-20']);
});
