import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
  RETRO_CELL_M,
  RETRO_MODE_STORAGE_KEY,
  createRetroTileGeometry,
  createTerrainRetroRuntime,
  retroSurfaceIndexCount,
} from '../terrain-retro-mode.js';

function fakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    values,
  };
}

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
  assert.equal(geometry.getIndex(), mesh.geometry.getIndex());
  assert.equal(geometry.drawRange.count, retroSurfaceIndexCount(5));
  // The grid comes from world metres, so uv must not be bound at all.
  assert.equal(geometry.getAttribute('uv'), undefined);
});

test('retro tile geometry refuses meshes without position or index', () => {
  const noIndex = new THREE.BufferGeometry();
  noIndex.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  assert.equal(createRetroTileGeometry(noIndex, 2), null);

  const noPosition = new THREE.BufferGeometry();
  noPosition.setIndex([0, 1, 2]);
  assert.equal(createRetroTileGeometry(noPosition, 2), null);
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

test('water grid stays pinned to the world as the plane follows the camera', () => {
  const terrainRoot = new THREE.Group();
  const retro = createTerrainRetroRuntime({ terrainRoot });
  retro.setActive(true);

  // The plane rides with the camera; the shader offset must cancel that motion
  // exactly, or the sea grid slides along underneath instead of standing still.
  retro.sync({ cameraLocalX: 1234, cameraLocalY: -567 });
  const offset = retro.waterMesh.material.uniforms.uGridOffset.value;
  assert.equal(offset.x, retro.waterMesh.position.x);
  assert.equal(offset.y, retro.waterMesh.position.y);
  retro.dispose();
});

test('terrain and water share one fixed cell size', () => {
  const terrainRoot = new THREE.Group();
  const retro = createTerrainRetroRuntime({ terrainRoot });
  assert.equal(retro.terrainMaterial.uniforms.uCellSizeM.value, RETRO_CELL_M);
  assert.equal(retro.waterMesh.material.uniforms.uCellSizeM.value, RETRO_CELL_M);
  retro.dispose();
});

test('grid spacing does not depend on tile resolution', () => {
  const terrainRoot = new THREE.Group();
  terrainRoot.add(buildTileMesh({ tileId: 'coarse', resolution: 5 }));
  terrainRoot.add(buildTileMesh({ tileId: 'fine', resolution: 9 }));
  const retro = createTerrainRetroRuntime({ terrainRoot });
  retro.setActive(true);
  retro.sync();

  // Tiles of different LOD must not carry different cell sizes, or granularity
  // repops as the LOD under the camera changes while flying.
  const proxies = retro.scene.children[0].children.filter(
    child => child.userData.sourceGeometry != null,
  );
  assert.equal(proxies.length, 2);
  for (const proxy of proxies) {
    assert.equal(proxy.userData.cells, undefined);
  }
  assert.equal(retro.terrainMaterial.uniforms.uCellSizeM.value, RETRO_CELL_M);
  retro.dispose();
});

test('retro mode is restored from storage on reload', () => {
  const terrainRoot = new THREE.Group();
  const storage = fakeStorage({ [RETRO_MODE_STORAGE_KEY]: '1' });
  const retro = createTerrainRetroRuntime({ terrainRoot, storage });

  // Active before the first frame, so a reload left in retro renders retro
  // immediately rather than flashing the composited scene.
  assert.equal(retro.active, true);
  retro.dispose();
});

test('toggling persists the preference', () => {
  const terrainRoot = new THREE.Group();
  const storage = fakeStorage();
  const retro = createTerrainRetroRuntime({ terrainRoot, storage });
  assert.equal(retro.active, false);

  retro.toggle();
  assert.equal(storage.getItem(RETRO_MODE_STORAGE_KEY), '1');
  retro.toggle();
  assert.equal(storage.getItem(RETRO_MODE_STORAGE_KEY), '0');
  retro.dispose();
});

test('a throwing storage never breaks the toggle', () => {
  const terrainRoot = new THREE.Group();
  const hostile = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
  };
  const retro = createTerrainRetroRuntime({ terrainRoot, storage: hostile });
  assert.equal(retro.active, false);
  assert.equal(retro.toggle(), true);
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
