import test from 'node:test';
import assert from 'node:assert/strict';

import { createTerrainGeometryCache } from '../terrain-geometry-cache.js';
import { createTileEvictionGate } from '../terrain-tile-eviction.js';

function fakeGeometry() {
  return { disposed: false, dispose() { this.disposed = true; } };
}

function fakeMesh(tileId, {
  heightmap = 'payload',
  bbox = [0, 0, 100, 100],
  resolution = 65,
  skirtDepth = 30,
  geometry = fakeGeometry(),
} = {}) {
  return {
    geometry,
    userData: {
      tileId,
      heightmapPayload: heightmap,
      bbox,
      resolution,
      skirtDepth,
    },
  };
}

function tileFor(mesh) {
  return {
    id: mesh.userData.tileId,
    heightmap: mesh.userData.heightmapPayload,
    bbox: mesh.userData.bbox,
    resolution: mesh.userData.resolution,
  };
}

test('revives an exact match without disposing the geometry', () => {
  const cache = createTerrainGeometryCache();
  const mesh = fakeMesh('12-1-1');
  assert.equal(cache.park(mesh), true);
  assert.equal(cache.size, 1);

  const entry = cache.take(tileFor(mesh));
  assert.ok(entry);
  assert.equal(entry.geometry, mesh.geometry);
  assert.equal(entry.skirtDepth, 30);
  assert.equal(mesh.geometry.disposed, false);
  // Taking removes it, so two live meshes can never share one grid.
  assert.equal(cache.size, 0);
});

test('revives a seam-repaired tile and flags it for an elevation refresh', () => {
  const cache = createTerrainGeometryCache();
  const mesh = fakeMesh('12-1-1', { heightmap: 'original' });
  cache.park(mesh);

  // Seam repair rewrites the payload on nearly every response; the grid shape
  // is unchanged, so it must still be reusable.
  const repaired = { ...tileFor(mesh), heightmap: 'repaired-seam' };
  const entry = cache.take(repaired);
  assert.ok(entry);
  assert.equal(entry.geometry, mesh.geometry);
  assert.equal(entry.payloadMatches, false);
  assert.equal(mesh.geometry.disposed, false);
});

test('flags an unchanged payload as needing no refresh', () => {
  const cache = createTerrainGeometryCache();
  const mesh = fakeMesh('12-1-1', { heightmap: 'identical' });
  cache.park(mesh);

  assert.equal(cache.take(tileFor(mesh)).payloadMatches, true);
});

test('rejects a tile whose bbox moved under a re-centred frame offset', () => {
  const cache = createTerrainGeometryCache();
  const mesh = fakeMesh('12-1-1', { bbox: [0, 0, 100, 100] });
  cache.park(mesh);

  const shifted = { ...tileFor(mesh), bbox: [-2600, -3600, -2500, -3500] };
  assert.equal(cache.take(shifted), null);
  assert.equal(mesh.geometry.disposed, true);
});

test('rejects a tile whose resolution changed', () => {
  const cache = createTerrainGeometryCache();
  const mesh = fakeMesh('12-1-1', { resolution: 65 });
  cache.park(mesh);

  assert.equal(cache.take({ ...tileFor(mesh), resolution: 129 }), null);
  assert.equal(mesh.geometry.disposed, true);
});

test('misses cleanly for a tile that was never parked', () => {
  const cache = createTerrainGeometryCache();
  assert.equal(cache.take({ id: '12-9-9', heightmap: 'x', bbox: [0, 0, 1, 1], resolution: 65 }), null);
  assert.equal(cache.stats().misses, 1);
});

test('re-parking a tile supersedes and disposes the previous grid', () => {
  const cache = createTerrainGeometryCache();
  const first = fakeMesh('12-1-1');
  const second = fakeMesh('12-1-1');
  cache.park(first);
  cache.park(second);

  assert.equal(first.geometry.disposed, true);
  assert.equal(second.geometry.disposed, false);
  assert.equal(cache.size, 1);
  assert.equal(cache.take(tileFor(second)).geometry, second.geometry);
});

test('evicts oldest first once the cap is reached', () => {
  const cache = createTerrainGeometryCache({ maxEntries: 2 });
  const a = fakeMesh('12-1-1');
  const b = fakeMesh('12-2-2');
  const c = fakeMesh('12-3-3');
  cache.park(a);
  cache.park(b);
  cache.park(c);

  assert.equal(cache.size, 2);
  // Overflow must release the GPU buffer, not merely forget the entry.
  assert.equal(a.geometry.disposed, true);
  assert.equal(cache.take(tileFor(a)), null);
  assert.ok(cache.take(tileFor(b)));
  assert.ok(cache.take(tileFor(c)));
  assert.equal(cache.stats().overflowDrops, 1);
});

test('the shared debug gate retains parked geometry beyond the cap', () => {
  const gate = createTileEvictionGate(false);
  const cache = createTerrainGeometryCache({ maxEntries: 1, evictionGate: gate });
  const a = fakeMesh('12-1-1');
  const b = fakeMesh('12-2-2');
  cache.park(a);
  cache.park(b);
  assert.equal(cache.size, 2);
  assert.equal(a.geometry.disposed, false);

  gate.setEnabled(true);
  assert.equal(cache.size, 1);
  assert.equal(a.geometry.disposed, true);
});

test('declines meshes missing the identity needed to revive them safely', () => {
  const cache = createTerrainGeometryCache();
  assert.equal(cache.park(null), false);
  assert.equal(cache.park({ geometry: fakeGeometry(), userData: {} }), false);
  // A non-string payload cannot be compared for seam repair.
  assert.equal(cache.park({
    geometry: fakeGeometry(),
    userData: { tileId: 'a', heightmapPayload: null, bbox: [0, 0, 1, 1] },
  }), false);
  assert.equal(cache.size, 0);
});

test('a zero cap disables parking entirely', () => {
  const cache = createTerrainGeometryCache({ maxEntries: 0 });
  const mesh = fakeMesh('12-1-1');
  assert.equal(cache.park(mesh), false);
  assert.equal(cache.size, 0);
});

test('clear() disposes everything it still holds', () => {
  const cache = createTerrainGeometryCache();
  const a = fakeMesh('12-1-1');
  const b = fakeMesh('12-2-2');
  cache.park(a);
  cache.park(b);
  cache.clear();

  assert.equal(a.geometry.disposed, true);
  assert.equal(b.geometry.disposed, true);
  assert.equal(cache.size, 0);
});

test('tracks hit rate across an oscillation', () => {
  const cache = createTerrainGeometryCache();
  const meshes = ['12-1-1', '12-2-2', '12-3-3'].map(id => fakeMesh(id));
  for (const mesh of meshes) cache.park(mesh);
  for (const mesh of meshes) assert.ok(cache.take(tileFor(mesh)));

  const stats = cache.stats();
  assert.equal(stats.hits, 3);
  assert.equal(stats.misses, 0);
  assert.equal(stats.hitRate, 1);
});

test('rejects a negative cap', () => {
  assert.throws(() => createTerrainGeometryCache({ maxEntries: -1 }), RangeError);
});
