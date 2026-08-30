import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
  buildOpticalWaterGeometry,
  createOpticalWaterSurfaceRuntime,
  DEFAULT_OPTICAL_WATER_DEPTH_M,
  OPTICAL_WATER_RENDER_ORDER,
} from '../water/water-optical-surface.js';
import { createTileEvictionGate } from '../terrain-tile-eviction.js';

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

test('a wet tile gets a complete flat cover so deep floor cannot leak through mask gaps', () => {
  const geometry = buildOpticalWaterGeometry(terrainTile([1, 0, 0, 0]));
  const position = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');

  assert.equal(position.count, 6);
  assert.deepEqual(
    Array.from(position.array),
    [
      0, 0, 0,
      10, 0, 0,
      0, 10, 0,
      10, 0, 0,
      10, 10, 0,
      0, 10, 0,
    ],
  );
  assert.deepEqual(
    Array.from(uv.array),
    [0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1],
  );
  assert.equal(new Set([
    position.getZ(0),
    position.getZ(1),
    position.getZ(2),
  ]).size, 1);
});

test('a full-resolution optical twin is only a two-triangle quad', () => {
  const resolution = 65;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(resolution * resolution * 3);
  const uvs = new Float32Array(resolution * resolution * 2);
  for (let row = 0; row < resolution; row += 1) {
    for (let column = 0; column < resolution; column += 1) {
      const index = row * resolution + column;
      positions[index * 3] = column;
      positions[index * 3 + 1] = row;
      positions[index * 3 + 2] = -100;
      uvs[index * 2] = column / (resolution - 1);
      uvs[index * 2 + 1] = row / (resolution - 1);
    }
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  const source = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  Object.assign(source.userData, {
    resolution,
    terrainWaterMask: new Uint8Array(resolution * resolution).fill(1),
  });

  const optical = buildOpticalWaterGeometry(source);

  assert.equal(optical.getAttribute('position').count, 6);
  assert.deepEqual(
    Array.from(optical.getAttribute('position').array),
    [
      0, 0, 0,
      64, 0, 0,
      0, 64, 0,
      64, 0, 0,
      64, 64, 0,
      0, 64, 0,
    ],
  );
});

test('a clipped fallback optical twin reuses the terrain slot instead of covering it', () => {
  const resolution = 3;
  const geometry = new THREE.BufferGeometry();
  const positions = [];
  const uvs = [];
  for (let row = 0; row < resolution; row += 1) {
    for (let column = 0; column < resolution; column += 1) {
      positions.push(column, row, -100);
      uvs.push(column / 2, row / 2);
    }
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  // Three active cells; the north-east cell is the higher-resolution slot.
  geometry.setIndex([
    0, 1, 3, 1, 4, 3,
    1, 2, 4, 2, 5, 4,
    3, 4, 6, 4, 7, 6,
  ]);
  const source = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  Object.assign(source.userData, {
    resolution,
    terrainWaterMask: new Uint8Array(9).fill(1),
    terrainClipSignature: '18:test',
    terrainActiveSurfaceIndexCount: 18,
  });

  const optical = buildOpticalWaterGeometry(source);

  assert.equal(optical.getAttribute('position').count, 9);
  assert.equal(optical.getIndex().count, 18);
  assert.deepEqual(Array.from(optical.getIndex().array), Array.from(geometry.getIndex().array));
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

test('a fully dry tile is rejected before any cover geometry is built', () => {
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

  // Rebuilding dry tiles every frame was the original half-second stall.
  let sampled = 0;
  const position = source.geometry.getAttribute('position');
  const originalGetX = position.getX.bind(position);
  position.getX = index => { sampled += 1; return originalGetX(index); };
  runtime.sync({});
  assert.equal(sampled, 0);
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

test('the default runtime covers a streaming burst in the same sync', () => {
  const terrainRoot = new THREE.Group();
  for (let index = 0; index < 100; index += 1) {
    const source = terrainTile();
    source.userData.tileId = `12-9-${index}`;
    terrainRoot.add(source);
  }
  const runtime = createOpticalWaterSurfaceRuntime({ terrainRoot });

  runtime.sync({});

  assert.equal(runtime.size, 100);
  assert.equal(runtime.pendingBuilds, 0);
});

test('optical builds are budgeted per sync instead of draining a whole burst', () => {
  const terrainRoot = new THREE.Group();
  for (let index = 0; index < 10; index += 1) {
    const source = terrainTile();
    source.userData.tileId = `12-1-${index}`;
    terrainRoot.add(source);
  }
  // This test isolates the count budget; wall-clock deadline behavior has its
  // own deterministic fake-clock coverage below.
  const runtime = createOpticalWaterSurfaceRuntime({
    terrainRoot, buildBudget: 3, buildBudgetMs: Number.POSITIVE_INFINITY,
  });

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

test('a rebuilt terrain mesh reuses its optical twin instead of rebuilding it', () => {
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

test('optical builds stop at a deadline rather than a mesh count', () => {
  const terrainRoot = new THREE.Group();
  for (let index = 0; index < 10; index += 1) {
    const source = terrainTile();
    source.userData.tileId = `12-2-${index}`;
    terrainRoot.add(source);
  }
  // Each twin copies a whole grid; simulate 2ms apiece against a 3ms budget.
  let clock = 0;
  const runtime = createOpticalWaterSurfaceRuntime({
    terrainRoot,
    buildBudgetMs: 3,
    now: () => { clock += 0; return clock; },
  });
  const originalAdd = runtime.group.add.bind(runtime.group);
  runtime.group.add = mesh => { clock += 2; return originalAdd(mesh); };

  runtime.sync({});
  // 0ms -> build, 2ms -> build, 4ms -> past deadline.
  assert.equal(runtime.size, 2);
  assert.equal(runtime.pendingBuilds, 8);
});

test('one optical twin is always built even past the deadline', () => {
  const terrainRoot = new THREE.Group();
  for (let index = 0; index < 3; index += 1) {
    const source = terrainTile();
    source.userData.tileId = `12-3-${index}`;
    terrainRoot.add(source);
  }
  const runtime = createOpticalWaterSurfaceRuntime({
    terrainRoot,
    buildBudgetMs: 0,
    now: () => 1e6,
  });

  runtime.sync({});
  assert.equal(runtime.size, 1, 'starvation guard must let the surface progress');
  assert.equal(runtime.pendingBuilds, 2);
});

test('seam repair that leaves the shoreline alone keeps the existing twin', () => {
  const terrainRoot = new THREE.Group();
  const source = terrainTile();
  source.userData.bbox = [0, 0, 10, 10];
  source.userData.heightmapPayload = 'payload-a';
  source.userData.terrainWaterMaskKey = '4:abc123';
  terrainRoot.add(source);
  const runtime = createOpticalWaterSurfaceRuntime({ terrainRoot });

  runtime.sync({});
  const twin = runtime.group.children[0];

  // Repair rewrote elevations; the water footprint is unchanged.
  source.userData.heightmapPayload = 'payload-b-repaired';
  runtime.sync({});
  assert.equal(runtime.group.children[0], twin, 'twin repainted on elevation-only change');
});

test('a shoreline change does rebuild the twin', () => {
  const terrainRoot = new THREE.Group();
  const source = terrainTile();
  source.userData.bbox = [0, 0, 10, 10];
  source.userData.terrainWaterMaskKey = '4:abc123';
  terrainRoot.add(source);
  const runtime = createOpticalWaterSurfaceRuntime({ terrainRoot });

  runtime.sync({});
  const twin = runtime.group.children[0];

  source.userData.terrainWaterMaskKey = '4:def456';
  runtime.sync({});
  assert.notEqual(runtime.group.children[0], twin, 'stale shoreline kept');
});

test('an evicted twin is parked and revived when its tile returns', () => {
  const terrainRoot = new THREE.Group();
  const source = terrainTile();
  source.userData.bbox = [0, 0, 10, 10];
  source.userData.terrainWaterMaskKey = '4:abc';
  terrainRoot.add(source);
  const runtime = createOpticalWaterSurfaceRuntime({ terrainRoot });

  runtime.sync({});
  const twin = runtime.group.children[0];
  assert.equal(runtime.stats().builds, 1);

  // LOD contraction drops the tile.
  terrainRoot.remove(source);
  runtime.sync({});
  assert.equal(runtime.size, 0);
  assert.equal(runtime.stats().dormant, 1);

  // ...and expansion brings it straight back on a fresh mesh object.
  const revived = terrainTile();
  revived.userData.bbox = [0, 0, 10, 10];
  revived.userData.terrainWaterMaskKey = '4:abc';
  terrainRoot.add(revived);
  runtime.sync({});

  assert.equal(runtime.group.children[0], twin, 'rebuilt instead of revived');
  assert.equal(runtime.stats().builds, 1, 'revival must not count as a build');
  assert.equal(runtime.stats().revivals, 1);
});

test('the shared debug gate prevents optical-water tile eviction', () => {
  const gate = createTileEvictionGate(false);
  const terrainRoot = new THREE.Group();
  const source = terrainTile();
  terrainRoot.add(source);
  const runtime = createOpticalWaterSurfaceRuntime({
    terrainRoot,
    evictionGate: gate,
  });
  runtime.sync({});
  const twin = runtime.group.children[0];

  terrainRoot.remove(source);
  runtime.sync({});
  assert.equal(runtime.size, 1);
  assert.equal(runtime.group.children[0], twin);
  assert.equal(runtime.stats().evictions, 0);

  gate.setEnabled(true);
  runtime.sync({});
  assert.equal(runtime.size, 0);
  assert.equal(runtime.stats().dormant, 1);
});

test('a parked twin whose shoreline changed is not revived', () => {
  const terrainRoot = new THREE.Group();
  const source = terrainTile();
  source.userData.bbox = [0, 0, 10, 10];
  source.userData.terrainWaterMaskKey = '4:abc';
  terrainRoot.add(source);
  const runtime = createOpticalWaterSurfaceRuntime({ terrainRoot });
  runtime.sync({});
  const twin = runtime.group.children[0];

  terrainRoot.remove(source);
  runtime.sync({});

  const changed = terrainTile();
  changed.userData.bbox = [0, 0, 10, 10];
  changed.userData.terrainWaterMaskKey = '4:different';
  terrainRoot.add(changed);
  runtime.sync({});

  assert.notEqual(runtime.group.children[0], twin, 'stale shoreline revived');
});

test('dormant twins are bounded and disposed on overflow', () => {
  const terrainRoot = new THREE.Group();
  const sources = [];
  for (let index = 0; index < 3; index += 1) {
    const source = terrainTile();
    source.userData.tileId = `12-7-${index}`;
    source.userData.bbox = [index, index, index + 1, index + 1];
    terrainRoot.add(source);
    sources.push(source);
  }
  const runtime = createOpticalWaterSurfaceRuntime({ terrainRoot, maxDormantTwins: 2 });
  runtime.sync({});
  runtime.sync({});
  runtime.sync({});
  assert.equal(runtime.size, 3);

  for (const source of sources) terrainRoot.remove(source);
  runtime.sync({});

  assert.equal(runtime.stats().dormant, 2);
  assert.equal(runtime.stats().dormantDrops, 1);
});

test('twins are built nearest-first, not in scene-graph order', () => {
  const terrainRoot = new THREE.Group();
  // Deliberately added far-to-near, which is the order that produced 21km
  // twins while 3km tiles went without.
  const offsets = [20000, 3000, 100];
  offsets.forEach((offset, index) => {
    const source = terrainTile();
    source.userData.tileId = `12-8-${index}`;
    source.userData.bbox = [offset, offset, offset + 10, offset + 10];
    terrainRoot.add(source);
  });
  const runtime = createOpticalWaterSurfaceRuntime({
    terrainRoot,
    buildBudget: 1,
    buildBudgetMs: 1000,
  });

  runtime.sync({ cameraX: 0, cameraY: 0 });
  assert.equal(runtime.size, 1);
  // The nearest tile (offset 100) must be the one that got built.
  assert.equal(runtime.group.children[0].name, 'WaterOpticalSurface.12-8-2');
});

test('an unknown camera position falls back without throwing', () => {
  const terrainRoot = new THREE.Group();
  const source = terrainTile();
  source.userData.bbox = [0, 0, 10, 10];
  terrainRoot.add(source);
  const runtime = createOpticalWaterSurfaceRuntime({ terrainRoot });

  runtime.sync({});
  assert.equal(runtime.size, 1);
  assert.equal(runtime.stats().inversions, 0);
});
