import assert from 'node:assert/strict';
import test from 'node:test';

import { createTerrainMeshBuilder } from '../terrain-mesh-builder.js';
import { createTerrainGeometryCache } from '../terrain-geometry-cache.js';
import { buildOpticalWaterGeometry } from '../water/water-optical-surface.js';
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

function quarterDescendants(bits) {
  return Array.from({ length: 16 }, (_, index) => (
    bits & (1 << index)
      ? tileMesh(`11-${40 + index % 4}-${40 + Math.floor(index / 4)}`, 65)
      : null
  )).filter(Boolean);
}

function assertSurfaceCoverage(mesh, cutouts) {
  const cells = new Uint8Array(64 * 64);
  const indices = mesh.geometry.getIndex().array;
  for (let offset = 0; offset < mesh.userData.terrainActiveSurfaceIndexCount; offset += 6) {
    const a = indices[offset];
    const row = Math.floor(a / 65);
    const column = a % 65;
    assert.deepEqual(Array.from(indices.subarray(offset, offset + 6)), [
      a, a + 1, a + 65, a + 1, a + 66, a + 65,
    ]);
    cells[row * 64 + column] += 1;
  }
  let wrongCells = 0;
  for (let row = 0; row < 64; row += 1) {
    for (let column = 0; column < 64; column += 1) {
      const quarter = Math.floor(row / 16) * 4 + Math.floor(column / 16);
      const expected = cutouts & (1 << quarter) ? 0 : 1;
      if (cells[row * 64 + column] !== expected) wrongCells += 1;
    }
  }
  assert.equal(wrongCells, 0, `${wrongCells} surface cells have missing or overlapping coverage`);
}

test('equal-area child changes replace the actual triangles despite the old hash collision', () => {
  const parent = tileMesh('9-10-10', 65);
  // These disjoint four-child arrangements both hashed to 18432:cabe21c5
  // on the production 65-vertex grid, including the same skirt index count.
  recomputeTerrainResidencyClipping([parent, ...quarterDescendants(105)]);
  assertSurfaceCoverage(parent, 105);
  const previousSignature = parent.userData.terrainClipSignature;
  const previousDrawCount = parent.geometry.drawRange.count;
  recomputeTerrainResidencyClipping([parent, ...quarterDescendants(150)]);
  assertSurfaceCoverage(parent, 150);
  assert.notEqual(parent.userData.terrainClipSignature, previousSignature);
  assert.equal(parent.geometry.drawRange.count, previousDrawCount);

  // Water consumers key their own geometry by the same signature.
  parent.userData.terrainWaterMask.fill(1);
  const optical = buildOpticalWaterGeometry(parent);
  assert.deepEqual(Array.from(optical.getIndex().array), Array.from(
    parent.geometry.getIndex().array.subarray(0, parent.userData.terrainActiveSurfaceIndexCount),
  ));
  optical.dispose();

  recomputeTerrainResidencyClipping([parent]);
  assertSurfaceCoverage(parent, 0);
});

test('revived clipped geometry takes the current child footprints instead of cached holes', () => {
  const cache = createTerrainGeometryCache();
  const build = createTerrainMeshBuilder({ exaggeration: 1, attachScatter() {}, geometryCache: cache });
  const tile = {
    id: '9-10-10', bbox: [0, 0, 64, 64], resolution: 65,
    heightmap: 'measured', samples: new Float32Array(65 * 65).fill(100),
  };
  const original = build(tile);
  recomputeTerrainResidencyClipping([original, ...quarterDescendants(105)]);
  assert.equal(cache.park(original), true);
  const revived = build(tile);
  assert.equal(revived.geometry, original.geometry);
  recomputeTerrainResidencyClipping([revived, ...quarterDescendants(150)]);
  assertSurfaceCoverage(revived, 150);
});

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

test('reports clip application and complete restoration with index evidence', () => {
  const parent = tileMesh('9-10-10');
  const child = tileMesh('11-40-40');
  const diagnostics = [];

  recomputeTerrainResidencyClipping([parent, child], {
    onDiagnostic: details => diagnostics.push(details),
  });
  recomputeTerrainResidencyClipping([parent], {
    onDiagnostic: details => diagnostics.push(details),
  });

  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics[0].kind, 'apply');
  assert.equal(diagnostics[0].tileId, '9-10-10');
  assert.deepEqual(diagnostics[0].descendantIds, ['11-40-40']);
  assert.ok(diagnostics[0].activeIndexCount < diagnostics[0].fullIndexCount);
  assert.equal(diagnostics[1].kind, 'restore');
  assert.equal(diagnostics[1].priorSignature, diagnostics[0].nextSignature);
  assert.equal(diagnostics[1].nextSignature, '');
  assert.equal(diagnostics[1].activeIndexCount, diagnostics[1].fullIndexCount);
  assert.equal(diagnostics[1].drawRangeAfter, diagnostics[1].fullIndexCount);
});

test('reports a draw-range mismatch hidden behind an unchanged clip signature', () => {
  const parent = tileMesh('9-10-10');
  const child = tileMesh('11-40-40');
  recomputeTerrainResidencyClipping([parent, child]);
  parent.geometry.setDrawRange(0, 6);
  const diagnostics = [];

  recomputeTerrainResidencyClipping([parent, child], {
    onDiagnostic: details => diagnostics.push(details),
  });

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].kind, 'state-mismatch');
  assert.equal(diagnostics[0].reason, 'matching-signature-wrong-draw-range');
  assert.equal(diagnostics[0].drawRangeBefore, 6);
});
