import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
  prepareBathymetryTerrainTiles,
} from '../render-backends/webgl-water.js';
import { createWaterRuntime, DEFAULT_WATER_PARAMS } from '../water/water-runtime.js';
import {
  NORTH_CLIFF_REFLECTION_MAX_PADDING_M,
  northCliffReflectionKeepForDistance,
  northCliffReflectionPaddingForSlope,
} from '../water/water-reflection-mask.js';

test('direct sun glint has an independent full-strength control', () => {
  assert.equal(DEFAULT_WATER_PARAMS.glintStrength, 1);
  assert.ok(DEFAULT_WATER_PARAMS.glintStrength > DEFAULT_WATER_PARAMS.reflectivity);
});

test('dynamic waterline defaults half a metre above terrain-root zero', () => {
  assert.equal(DEFAULT_WATER_PARAMS.waterline, 0.5);
});

test('shore sparkle defaults to a narrow, moderate-strength bathymetry band', () => {
  assert.equal(DEFAULT_WATER_PARAMS.shoreFoamDepth, 3.5);
  assert.equal(DEFAULT_WATER_PARAMS.shoreFoamStrength, 0.7);
});

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

test('bathymetry recaptures on movement, settled texture changes, and the lazy backstop', () => {
  const originalNow = performance.now;
  let nowMs = 0;
  performance.now = () => nowMs;
  try {
    const captures = [];
    let textureVersion = 0;
    const water = {
      mesh: new THREE.Mesh(),
      setWind() {},
      update() {},
      captureBathymetry({ centerXY }) { captures.push(centerXY.clone()); },
      bathyExtent: 30000,
      dispose() {},
    };
    const runtime = createWaterRuntime({
      backend: { createWater: () => water },
      scene: new THREE.Scene(),
      terrainRoot: new THREE.Group(),
      anchorPosition: new THREE.Vector3(),
      east: new THREE.Vector3(1, 0, 0),
      north: new THREE.Vector3(0, 1, 0),
      up: new THREE.Vector3(0, 0, 1),
      getSunDirection: () => new THREE.Vector3(0, 0, 1),
      getTextureVersion: () => textureVersion,
    });
    const camera = { position: new THREE.Vector3(0, 0, 100) };
    const step = dt => { nowMs += dt; runtime.update({ dt, camera, visible: true }); };

    step(16);
    assert.equal(captures.length, 1); // initial capture

    textureVersion += 1;
    step(16);
    assert.equal(captures.length, 1); // texture change is debounced

    step(2100);
    assert.equal(captures.length, 2); // settled texture change recaptures

    step(2100);
    assert.equal(captures.length, 2); // no new version, no early recapture

    step(15100);
    assert.equal(captures.length, 3); // lazy periodic backstop

    camera.position.set(30000 * 0.13, 0, 100);
    step(16);
    assert.equal(captures.length, 4); // recentre on movement
    assert.equal(captures.at(-1).x, 30000 * 0.13);
  } finally {
    performance.now = originalNow;
  }
});

test('optical surface visibility can be gated without hiding dynamic water', () => {
  const water = {
    mesh: new THREE.Mesh(),
    setWind() {},
    update() {},
    bathyExtent: 30000,
    dispose() {},
  };
  const terrainRoot = new THREE.Group();
  const runtime = createWaterRuntime({
    backend: { createWater: () => water },
    scene: new THREE.Scene(),
    terrainRoot,
    anchorPosition: new THREE.Vector3(),
    east: new THREE.Vector3(1, 0, 0),
    north: new THREE.Vector3(0, 1, 0),
    up: new THREE.Vector3(0, 0, 1),
    getSunDirection: () => new THREE.Vector3(0, 0, 1),
  });
  const camera = { position: new THREE.Vector3(0, 0, 100) };

  runtime.update({
    dt: 0.016,
    camera,
    visible: true,
    opticalVisible: false,
  });

  assert.equal(water.mesh.visible, true);
  assert.equal(runtime.opticalSurface.visible, false);
  runtime.dispose();
});
