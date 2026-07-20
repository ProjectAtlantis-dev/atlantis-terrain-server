import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { prepareBathymetryTerrainTiles } from '../render-backends/webgpu-water.js';

// The WebGPU capture cannot mutate a shared material per draw call the way
// the WebGL onBeforeRender uniform swap does, so prepare() publishes each
// tile's map/color through userData for the override material's per-object
// reference nodes — and must clean all of it up again.
test('webgpu bathymetry prepare orders tiles, binds userData references, and restores', () => {
  const dummyMap = new THREE.Texture();
  const fallbackColor = new THREE.Color(1, 1, 1);

  const parent = new THREE.Mesh();
  parent.userData.tileId = '11-10-20';
  parent.layers.set(3);
  parent.renderOrder = 40;
  parent.material.map = new THREE.Texture();
  parent.material.color.set(0x8090a0);

  const child = new THREE.Mesh();
  child.userData.tileId = '12-20-40';
  child.layers.set(5);
  child.renderOrder = 2;

  const unrelated = new THREE.Mesh();
  unrelated.userData.tileId = 'vehicle';
  unrelated.layers.set(7);
  unrelated.renderOrder = 9;

  const restore = prepareBathymetryTerrainTiles(
    { children: [child, unrelated, parent] },
    { dummyMap, fallbackColor },
  );

  assert.equal(parent.layers.mask, 2 ** 31);
  assert.equal(child.layers.mask, 2 ** 31);
  assert.equal(parent.renderOrder, 11);
  assert.equal(child.renderOrder, 12);
  assert.equal(unrelated.layers.mask, 2 ** 7);
  assert.equal(unrelated.renderOrder, 9);

  // textured tile: its own map/color, brightness trusted
  assert.equal(parent.userData.bathyMap, parent.material.map);
  assert.equal(parent.userData.bathyUseMap, 1);
  assert.equal(parent.userData.bathyColor, parent.material.color);

  // mapless tile: dummy binding so the per-object texture resolves,
  // brightness flagged meaningless
  assert.equal(child.userData.bathyMap, dummyMap);
  assert.equal(child.userData.bathyUseMap, 0);
  assert.equal(child.userData.bathyColor, child.material.color);

  assert.equal('bathyMap' in unrelated.userData, false);

  restore();
  assert.equal(parent.layers.mask, 2 ** 3);
  assert.equal(child.layers.mask, 2 ** 5);
  assert.equal(parent.renderOrder, 40);
  assert.equal(child.renderOrder, 2);
  for (const tile of [parent, child]) {
    assert.equal('bathyMap' in tile.userData, false);
    assert.equal('bathyUseMap' in tile.userData, false);
    assert.equal('bathyColor' in tile.userData, false);
  }
});
