import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
  RETRO_WATER_CELL_M,
  RETRO_WATER_EXTENT_M,
  createRetroTileGeometry,
  createTerrainRetroRuntime,
  retroSurfaceIndexCount,
} from '../terrain-retro-mode.js';

function buildTileMesh({ tileId = '8-1-1', resolution = 5 } = {}) {
  const surfaceVertices = resolution * resolution;
  const skirtVertices = resolution * 2 * 4;
  const vertexCount = surfaceVertices + skirtVertices;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3),
  );
  geometry.setAttribute(
    'uv',
    new THREE.BufferAttribute(new Float32Array(vertexCount * 2), 2),
  );
  const indices = [];
  for (let row = 0; row < resolution - 1; row += 1) {
    for (let column = 0; column < resolution - 1; column += 1) {
      const a = row * resolution + column;
      indices.push(a, a + 1, a + resolution, a + 1, a + resolution + 1, a + resolution);
    }
  }
  // Stand-in skirt indices, so the draw range has something to exclude.
  indices.push(0, 1, 2);
  geometry.setIndex(indices);
  const material = new THREE.MeshBasicMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(geometry, material);
  Object.assign(mesh.userData, { tileId, resolution });
  return mesh;
}

test('surface index count excludes the skirts', () => {
  assert.equal(retroSurfaceIndexCount(65), 64 * 64 * 6);
  assert.equal(retroSurfaceIndexCount(5), 4 * 4 * 6);
  assert.equal(retroSurfaceIndexCount(1), 0);
  assert.equal(retroSurfaceIndexCount(NaN), 0);
});

test('retro tile geometry shares source buffers and clips skirts', () => {
  const mesh = buildTileMesh({ resolution: 5 });
  const geometry = createRetroTileGeometry(mesh.geometry, 5);

  // Same attribute instances: three.js reuses the GPU buffers, so a proxy
  // costs no vertex memory and tracks in-place heightmap rewrites.
  assert.equal(geometry.getAttribute('position'), mesh.geometry.getAttribute('position'));
  assert.equal(geometry.getAttribute('uv'), mesh.geometry.getAttribute('uv'));
  assert.equal(geometry.getIndex(), mesh.geometry.getIndex());
  assert.equal(geometry.drawRange.count, retroSurfaceIndexCount(5));
});

test('retro tile geometry refuses meshes without uv', () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  geometry.setIndex([0, 1, 2]);
  assert.equal(createRetroTileGeometry(geometry, 2), null);
});

test('runtime builds one proxy per tile only while active', () => {
  const terrainRoot = new THREE.Group();
  terrainRoot.add(buildTileMesh({ tileId: 'a' }));
  terrainRoot.add(buildTileMesh({ tileId: 'b' }));
  const retro = createTerrainRetroRuntime({ terrainRoot });

  retro.sync();
  assert.equal(retro.proxyCount, 0, 'inactive retro mode does no work');

  retro.setActive(true);
  retro.sync();
  assert.equal(retro.proxyCount, 2);

  retro.setActive(false);
  assert.equal(retro.proxyCount, 0, 'leaving retro mode releases the proxies');
  retro.dispose();
});

test('runtime tracks tiles appearing and disappearing', () => {
  const terrainRoot = new THREE.Group();
  const first = buildTileMesh({ tileId: 'a' });
  terrainRoot.add(first);
  const retro = createTerrainRetroRuntime({ terrainRoot });
  retro.setActive(true);
  retro.sync();
  assert.equal(retro.proxyCount, 1);

  terrainRoot.add(buildTileMesh({ tileId: 'b' }));
  retro.sync();
  assert.equal(retro.proxyCount, 2);

  terrainRoot.remove(first);
  retro.sync();
  assert.equal(retro.proxyCount, 1);
  retro.dispose();
});

test('runtime rebinds when a tile swaps geometry', () => {
  const terrainRoot = new THREE.Group();
  const mesh = buildTileMesh({ tileId: 'a' });
  terrainRoot.add(mesh);
  const retro = createTerrainRetroRuntime({ terrainRoot });
  retro.setActive(true);
  retro.sync();

  const replacement = buildTileMesh({ tileId: 'a' });
  mesh.geometry = replacement.geometry;
  retro.sync();

  assert.equal(retro.proxyCount, 1);
  const proxy = retro.scene.children[0].children.find(
    child => child.userData.sourceGeometry != null,
  );
  assert.equal(
    proxy.userData.sourceGeometry,
    replacement.geometry,
    'a rebuilt tile must not keep drawing its retired buffers',
  );
  retro.dispose();
});

test('proxies keep tracking their tile after the first frame', () => {
  const terrainRoot = new THREE.Group();
  const mesh = buildTileMesh({ tileId: 'a' });
  terrainRoot.add(mesh);
  const retro = createTerrainRetroRuntime({ terrainRoot });
  retro.setActive(true);

  retro.sync();
  retro.scene.updateMatrixWorld();

  // A floating-origin rebase repositions every tile; proxies must follow or
  // retro terrain sits at a stale offset from the live scene.
  mesh.position.set(5000, -2500, 300);
  retro.sync();
  retro.scene.updateMatrixWorld();

  const proxy = retro.scene.children[0].children.find(
    child => child.userData.sourceGeometry != null,
  );
  const worldPosition = new THREE.Vector3().setFromMatrixPosition(proxy.matrixWorld);
  assert.deepEqual(
    worldPosition.toArray().map(value => Math.round(value)),
    [5000, -2500, 300],
  );
  retro.dispose();
});

test('retro mode never touches the live tile materials', () => {
  const terrainRoot = new THREE.Group();
  const mesh = buildTileMesh({ tileId: 'a' });
  const originalMaterial = mesh.material;
  const texture = new THREE.Texture();
  mesh.material.map = texture;
  terrainRoot.add(mesh);

  const retro = createTerrainRetroRuntime({ terrainRoot });
  retro.setActive(true);
  retro.sync();
  retro.setActive(false);

  // The texture streamer keeps writing `.map` to the real material while retro
  // is active; normal mode must resume with nothing to repair.
  assert.equal(mesh.material, originalMaterial);
  assert.equal(mesh.material.map, texture);
  assert.equal(mesh.material.vertexColors, true);
  retro.dispose();
});

test('water grid follows the camera and sits at the waterline', () => {
  const terrainRoot = new THREE.Group();
  const retro = createTerrainRetroRuntime({ terrainRoot, getWaterline: () => 12 });
  retro.setActive(true);
  retro.sync({ cameraLocalX: 400, cameraLocalY: -250 });

  assert.deepEqual(
    retro.waterMesh.position.toArray(),
    [400, -250, 12],
    'a finite plane must ride with the camera so no edge is ever visible',
  );
  retro.dispose();
});

test('water grid cells are a fixed world-space size', () => {
  const terrainRoot = new THREE.Group();
  const retro = createTerrainRetroRuntime({ terrainRoot });
  const cells = retro.waterMesh.material.uniforms.uCells.value;
  assert.equal(cells.x, RETRO_WATER_EXTENT_M / RETRO_WATER_CELL_M);
  assert.equal(cells.y, RETRO_WATER_EXTENT_M / RETRO_WATER_CELL_M);
  retro.dispose();
});

test('toggle flips activation and reports the new state', () => {
  const terrainRoot = new THREE.Group();
  let changes = 0;
  const retro = createTerrainRetroRuntime({
    terrainRoot,
    onChanged: () => { changes += 1; },
  });
  assert.equal(retro.active, false);
  assert.equal(retro.toggle(), true);
  assert.equal(retro.active, true);
  assert.equal(retro.toggle(), false);
  assert.equal(changes, 2);
  retro.dispose();
});
