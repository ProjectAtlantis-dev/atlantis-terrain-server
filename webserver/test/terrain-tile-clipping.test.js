import assert from 'node:assert/strict';
import test from 'node:test';

import { createTerrainMeshBuilder } from '../terrain-mesh-builder.js';
import {
  recomputeTerrainResidencyClipping,
} from '../terrain-tile-clipping.js';

function tileMesh(id, resolution = 9) {
  return createTerrainMeshBuilder({
    exaggeration: 1,
    attachScatter() {},
  })({
    id,
    bbox: [0, 0, 8, 8],
    resolution,
    heightmap: id,
    samples: new Float32Array(resolution * resolution),
  });
}

test('mixed skipped-depth descendants carve a parent as an order-independent union', () => {
  const parent = tileMesh('9-10-10');
  // The depth-11 footprint occupies parent cells [0..2) x [0..2). The
  // depth-12 footprint occupies cell [4..5) x [4..5), with no depth-10 tile.
  const depth11 = tileMesh('11-40-40');
  const depth12 = tileMesh('12-84-84');

  assert.deepEqual(recomputeTerrainResidencyClipping([parent, depth12]), { failedPairs: [] });
  assert.equal(parent.userData.terrainActiveSurfaceIndexCount, 63 * 6);
  const firstSignature = parent.userData.terrainClipSignature;

  assert.deepEqual(
    recomputeTerrainResidencyClipping([depth11, parent, depth12]),
    { failedPairs: [] },
  );
  assert.equal(parent.userData.terrainActiveSurfaceIndexCount, 59 * 6);
  const unionSignature = parent.userData.terrainClipSignature;
  assert.deepEqual(
    parent.userData.terrainClippedDescendantIds,
    ['11-40-40', '12-84-84'],
  );

  // Reversing arrival/enumeration order produces the identical physical slot.
  recomputeTerrainResidencyClipping([depth12, depth11, parent]);
  assert.equal(parent.userData.terrainClipSignature, unionSignature);
  assert.notEqual(unionSignature, firstSignature);

  // Removing either descendant restores precisely its contribution.
  recomputeTerrainResidencyClipping([parent, depth12]);
  assert.equal(parent.userData.terrainActiveSurfaceIndexCount, 63 * 6);
  assert.equal(parent.userData.terrainClipSignature, firstSignature);
  recomputeTerrainResidencyClipping([parent]);
  assert.equal(parent.userData.terrainActiveSurfaceIndexCount, 64 * 6);
  assert.equal(parent.userData.terrainClipSignature, '');
  assert.equal(parent.geometry.drawRange.count, 64 * 6 + 8 * 4 * 6);
});

test('each resident ancestor is clipped directly by deeper descendants', () => {
  const depth9 = tileMesh('9-10-10');
  const depth11 = tileMesh('11-40-40');
  const depth12 = tileMesh('12-80-80');

  recomputeTerrainResidencyClipping([depth12, depth9, depth11]);

  assert.deepEqual(
    depth9.userData.terrainClippedDescendantIds,
    ['11-40-40', '12-80-80'],
  );
  assert.deepEqual(depth11.userData.terrainClippedDescendantIds, ['12-80-80']);
  assert.deepEqual(depth12.userData.terrainClippedDescendantIds, []);
});
