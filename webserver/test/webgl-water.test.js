import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { prepareBathymetryTerrainTiles } from '../render-backends/webgl-water.js';

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
