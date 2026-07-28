import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
  buildOpticalWaterGeometry,
  createOpticalWaterSurfaceRuntime,
  DEFAULT_OPTICAL_WATER_DEPTH_M,
  OPTICAL_WATER_RENDER_ORDER,
} from '../water/water-optical-surface.js';

function terrainTile(mask = [1, 1, 1, 1]) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, -100,
    10, 0, -80,
    0, 10, 20,
    10, 10, 30,
  ], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([
    0, 0,
    1, 0,
    0, 1,
    1, 1,
  ], 2));
  const texture = new THREE.Texture();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: texture }));
  Object.assign(mesh.userData, {
    tileId: '12-1-2',
    resolution: 2,
    terrainWaterMask: Uint8Array.from(mask),
    terrainBaseTexture: texture,
  });
  return mesh;
}

test('optical water geometry is flat and clipped halfway across coastline cells', () => {
  const geometry = buildOpticalWaterGeometry(terrainTile([1, 0, 0, 0]));
  const position = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');

  assert.equal(position.count, 3);
  assert.deepEqual(
    Array.from(position.array),
    [5, 0, 0, 0, 5, 0, 0, 0, 0],
  );
  assert.deepEqual(
    Array.from(uv.array),
    [0.5, 0, 0, 0.5, 0, 0],
  );
  assert.equal(new Set([
    position.getZ(0),
    position.getZ(1),
    position.getZ(2),
  ]).size, 1);
});

test('optical water owns visual depth only, is non-interactive, and follows waterline', () => {
  const terrainRoot = new THREE.Group();
  const source = terrainTile();
  terrainRoot.add(source);
  const runtime = createOpticalWaterSurfaceRuntime({ terrainRoot });

  runtime.sync({ visible: true, waterline: 12 });

  assert.equal(runtime.group.position.z, 12 - DEFAULT_OPTICAL_WATER_DEPTH_M);
  assert.equal(runtime.group.userData.visualDepthProxy, true);
  assert.equal(runtime.size, 1);
  assert.equal(runtime.group.children.length, 1);
  const optical = runtime.group.children[0];
  assert.equal(optical.material.map, source.userData.terrainBaseTexture);
  assert.equal(optical.material.depthTest, true);
  assert.equal(optical.material.depthWrite, true);
  assert.equal(optical.material.transparent, false);
  assert.equal(optical.renderOrder, OPTICAL_WATER_RENDER_ORDER);
  assert.equal(optical.castShadow, false);
  assert.equal(optical.receiveShadow, false);
  assert.equal(optical.userData.tileId, undefined);
  const sceneLayers = new THREE.Layers();
  const bathymetryLayers = new THREE.Layers();
  bathymetryLayers.set(31);
  assert.equal(optical.layers.test(sceneLayers), true);
  assert.equal(optical.layers.test(bathymetryLayers), false);

  const raycaster = new THREE.Raycaster(
    new THREE.Vector3(5, 5, 100),
    new THREE.Vector3(0, 0, -1),
  );
  assert.deepEqual(raycaster.intersectObject(optical), []);

  const replacement = new THREE.Texture();
  source.userData.terrainBaseTexture = replacement;
  runtime.sync({ visible: true, waterline: 13 });
  assert.equal(optical.material.map, replacement);
  assert.equal(runtime.group.position.z, 13 - DEFAULT_OPTICAL_WATER_DEPTH_M);

  terrainRoot.remove(source);
  runtime.sync();
  assert.equal(runtime.size, 0);
  runtime.dispose();
  assert.equal(terrainRoot.children.includes(runtime.group), false);
});
