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

test('a fully dry tile is rejected before any triangle clipping', () => {
  assert.equal(buildOpticalWaterGeometry(terrainTile([0, 0, 0, 0])), null);
  // A single wet sample must still produce geometry.
  assert.ok(buildOpticalWaterGeometry(terrainTile([1, 0, 0, 0])));
});

test('a waterless tile is only evaluated once while it stays resident', () => {
  const terrainRoot = new THREE.Group();
  const source = terrainTile([0, 0, 0, 0]);
  source.userData.heightmapPayload = 'payload-a';
  terrainRoot.add(source);
  const runtime = createOpticalWaterSurfaceRuntime({ terrainRoot });

  runtime.sync({});
  assert.equal(runtime.size, 0);
  assert.equal(runtime.waterlessSize, 1);

  // Re-clipping dry tiles every frame was the original half-second stall.
  let clipped = 0;
  const position = source.geometry.getAttribute('position');
  const originalGetX = position.getX.bind(position);
  position.getX = index => { clipped += 1; return originalGetX(index); };
  runtime.sync({});
  assert.equal(clipped, 0);
});

test('a seam repair that adds water re-evaluates a previously dry tile', () => {
  const terrainRoot = new THREE.Group();
  const source = terrainTile([0, 0, 0, 0]);
  source.userData.heightmapPayload = 'payload-a';
  terrainRoot.add(source);
  const runtime = createOpticalWaterSurfaceRuntime({ terrainRoot });

  runtime.sync({});
  assert.equal(runtime.size, 0);

  source.userData.terrainWaterMask = Uint8Array.from([1, 1, 1, 1]);
  source.userData.heightmapPayload = 'payload-b';
  runtime.sync({});
  assert.equal(runtime.size, 1);
});

test('optical builds are budgeted per sync instead of draining a whole burst', () => {
  const terrainRoot = new THREE.Group();
  for (let index = 0; index < 10; index += 1) {
    const source = terrainTile();
    source.userData.tileId = `12-1-${index}`;
    terrainRoot.add(source);
  }
  const runtime = createOpticalWaterSurfaceRuntime({ terrainRoot, buildBudget: 3 });

  runtime.sync({});
  assert.equal(runtime.size, 3);
  assert.equal(runtime.pendingBuilds, 7);

  runtime.sync({});
  assert.equal(runtime.size, 6);

  runtime.sync({});
  runtime.sync({});
  assert.equal(runtime.size, 10);
  assert.equal(runtime.pendingBuilds, 0);
});

test('waterless bookkeeping is released when a tile leaves residency', () => {
  const terrainRoot = new THREE.Group();
  const source = terrainTile([0, 0, 0, 0]);
  terrainRoot.add(source);
  const runtime = createOpticalWaterSurfaceRuntime({ terrainRoot });

  runtime.sync({});
  assert.equal(runtime.waterlessSize, 1);

  terrainRoot.remove(source);
  runtime.sync({});
  assert.equal(runtime.waterlessSize, 0);
});

test('a rebuilt terrain mesh reuses its optical twin instead of re-clipping', () => {
  const terrainRoot = new THREE.Group();
  const first = terrainTile();
  first.userData.heightmapPayload = 'payload-a';
  first.userData.bbox = [0, 0, 10, 10];
  terrainRoot.add(first);
  const runtime = createOpticalWaterSurfaceRuntime({ terrainRoot });

  runtime.sync({});
  assert.equal(runtime.size, 1);
  const twin = runtime.group.children[0];

  // Reconciliation rebuilds the tile: same id, same grid, new mesh object.
  terrainRoot.remove(first);
  const revived = terrainTile();
  revived.userData.heightmapPayload = 'payload-a';
  revived.userData.bbox = [0, 0, 10, 10];
  terrainRoot.add(revived);

  runtime.sync({});
  assert.equal(runtime.size, 1);
  assert.equal(runtime.group.children[0], twin, 'optical twin was rebuilt');
  assert.equal(twin.userData.sourceTerrainMesh, revived, 'twin still points at the old mesh');
});

test('a re-centred frame offset rebuilds the twin at the new bbox', () => {
  const terrainRoot = new THREE.Group();
  const source = terrainTile();
  source.userData.heightmapPayload = 'payload-a';
  source.userData.bbox = [0, 0, 10, 10];
  terrainRoot.add(source);
  const runtime = createOpticalWaterSurfaceRuntime({ terrainRoot });

  runtime.sync({});
  const twin = runtime.group.children[0];

  source.userData.bbox = [-2600, -3600, -2590, -3590];
  runtime.sync({});
  assert.notEqual(runtime.group.children[0], twin, 'stale twin kept at the old bbox');
});
