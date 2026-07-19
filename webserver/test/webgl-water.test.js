import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
  prepareBathymetryTerrainTiles,
} from '../render-backends/webgl-water.js';
import {
  NORTH_CLIFF_REFLECTION_MAX_PADDING_M,
  northCliffReflectionKeepForDistance,
  northCliffReflectionPaddingForSlope,
} from '../water/water-reflection-mask.js';

test('north-cliff reflection padding is negligible on flat shores and proportional to slope', () => {
  assert.equal(northCliffReflectionPaddingForSlope(0), 0);
  assert.equal(northCliffReflectionPaddingForSlope(0.12), 0);

  const moderate = northCliffReflectionPaddingForSlope(0.35);
  const steep = northCliffReflectionPaddingForSlope(0.55);
  assert.ok(moderate > 0 && moderate < steep);
  assert.ok(steep < NORTH_CLIFF_REFLECTION_MAX_PADDING_M);
  assert.equal(
    northCliffReflectionPaddingForSlope(0.7),
    NORTH_CLIFF_REFLECTION_MAX_PADDING_M,
  );
});

test('north-cliff reflection influence fades across the full padding distance', () => {
  assert.equal(northCliffReflectionKeepForDistance(0, 0), 1);
  assert.equal(northCliffReflectionKeepForDistance(0.7, 0), 0);

  const quarter = northCliffReflectionKeepForDistance(0.7, 187.5);
  const halfway = northCliffReflectionKeepForDistance(0.7, 375);
  const threeQuarter = northCliffReflectionKeepForDistance(0.7, 562.5);
  assert.ok(quarter < halfway && halfway < threeQuarter);
  assert.equal(halfway, 0.5);
  assert.equal(northCliffReflectionKeepForDistance(0.7, 750), 1);
});

test('bathymetry capture composites terrain coarse-to-fine and restores scene state', () => {
  const parent = new THREE.Mesh();
  parent.userData.tileId = '11-10-20';
  parent.layers.set(3);
  parent.renderOrder = 40;
  const child = new THREE.Mesh();
  child.userData.tileId = '12-20-40';
  child.layers.set(5);
  child.renderOrder = 2;
  const unrelated = new THREE.Mesh();
  unrelated.userData.tileId = 'vehicle';
  unrelated.layers.set(7);
  unrelated.renderOrder = 9;

  const restore = prepareBathymetryTerrainTiles({ children: [child, unrelated, parent] });

  assert.equal(parent.layers.mask, 2 ** 31);
  assert.equal(child.layers.mask, 2 ** 31);
  assert.equal(parent.renderOrder, 11);
  assert.equal(child.renderOrder, 12);
  assert.equal(unrelated.layers.mask, 2 ** 7);
  assert.equal(unrelated.renderOrder, 9);

  restore();
  assert.equal(parent.layers.mask, 2 ** 3);
  assert.equal(child.layers.mask, 2 ** 5);
  assert.equal(parent.renderOrder, 40);
  assert.equal(child.renderOrder, 2);
});
