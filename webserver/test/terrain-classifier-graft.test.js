import assert from 'node:assert/strict';
import test from 'node:test';

import { createTerrainTileSet } from '../terrain-tile-set.js';

test('classifier overlay preserves grafts and tints them from base imagery', () => {
  const baseTexture = { name: 'satellite' };
  const classifierTexture = { name: 'classifier' };
  const detailCalls = [];
  const mesh = {
    isMesh: true,
    userData: {
      tileId: '13-2761-1584',
      terrainBaseTexture: baseTexture,
    },
    material: {
      map: baseTexture,
      colorNode: {},
      userData: { terrainDetail: true },
      color: { set() {} },
      vertexColors: false,
      needsUpdate: false,
    },
  };
  const terrainRoot = {
    children: [mesh],
    add(child) { this.children.push(child); },
    remove(child) {
      this.children = this.children.filter(candidate => candidate !== child);
    },
  };
  const tile = {
    id: mesh.userData.tileId,
    bbox: [0, 0, 1, 1],
  };
  const tileSet = createTerrainTileSet({
    terrainRoot,
    textureStreamer: {
      texCache: new Map([[tile.id, baseTexture]]),
      texSource: new Map(),
      pump() {},
    },
    terrain: {},
    renderBackend: {
      kind: 'webgpu',
      prepareUntexturedTerrain() {},
    },
    view: { controls: { mapMode: false } },
    log() {},
    testOverrides: {
      terrainDetail: {
        apply(target, options) { detailCalls.push({ target, options }); },
      },
      priorityForTile: () => 0,
      getVisibilityDistance: () => 1000,
    },
  });

  tileSet.setTextureOverlay(() => classifierTexture);
  assert.equal(mesh.material.map, classifierTexture);
  assert.equal(detailCalls.length, 1);
  assert.equal(detailCalls[0].target, mesh);
  assert.deepEqual(detailCalls[0].options, {
    graftOnly: true,
    tintMap: baseTexture,
  });

  // The once-per-second streaming maintenance pass sees the cached satellite
  // texture while material.map holds the classifier overlay. That is not a
  // texture change and must not repaint the material or graft node.
  tileSet.updateTextures([tile]);
  tileSet.updateTextures([tile]);
  assert.equal(mesh.material.map, classifierTexture);
  assert.equal(detailCalls.length, 1);

  tileSet.setTextureOverlay(null);
  assert.equal(mesh.material.map, baseTexture);
  assert.equal(detailCalls.length, 2);
  assert.deepEqual(detailCalls[1].options, {
    graftOnly: false,
    tintMap: baseTexture,
  });
});
