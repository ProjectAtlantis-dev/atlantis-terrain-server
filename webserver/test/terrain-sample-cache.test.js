import test from 'node:test';
import assert from 'node:assert/strict';

import { createTerrainSampleCache } from '../terrain-sample-cache.js';

test('returns samples only when the digest matches', () => {
  const cache = createTerrainSampleCache();
  cache.store('12-1-1', 'aaaa', Float32Array.from([1, 2, 3]));

  assert.deepEqual([...cache.take('12-1-1', 'aaaa')], [1, 2, 3]);
  // Seam repair changed the bytes: the held samples are stale and must not
  // be substituted for what the server would have sent.
  assert.equal(cache.take('12-1-1', 'bbbb'), null);
  assert.equal(cache.take('12-9-9', 'aaaa'), null);
});

test('copies samples so the response buffer can be released', () => {
  const cache = createTerrainSampleCache();
  const buffer = new ArrayBuffer(12);
  const view = new Float32Array(buffer);
  view.set([1, 2, 3]);
  cache.store('12-1-1', 'aaaa', view);

  // Simulate the payload being reused/overwritten after decode.
  view.set([9, 9, 9]);
  assert.deepEqual([...cache.take('12-1-1', 'aaaa')], [1, 2, 3]);
  assert.notEqual(cache.take('12-1-1', 'aaaa').buffer, buffer);
});

test('residency map reports exactly what can be reconstructed', () => {
  const cache = createTerrainSampleCache();
  cache.store('12-1-1', 'aaaa', Float32Array.from([1]));
  cache.store('12-1-2', 'bbbb', Float32Array.from([2]));

  assert.deepEqual(cache.residency(), { '12-1-1': 'aaaa', '12-1-2': 'bbbb' });
});

test('re-storing a tile supersedes its previous digest', () => {
  const cache = createTerrainSampleCache();
  cache.store('12-1-1', 'aaaa', Float32Array.from([1]));
  cache.store('12-1-1', 'bbbb', Float32Array.from([5]));

  assert.equal(cache.take('12-1-1', 'aaaa'), null);
  assert.deepEqual([...cache.take('12-1-1', 'bbbb')], [5]);
  assert.equal(cache.size, 1);
});

test('evicts least recently used once full', () => {
  const cache = createTerrainSampleCache({ maxEntries: 2 });
  cache.store('a', '1', Float32Array.from([1]));
  cache.store('b', '2', Float32Array.from([2]));
  // Touching 'a' must protect it from the next eviction.
  cache.take('a', '1');
  cache.store('c', '3', Float32Array.from([3]));

  assert.equal(cache.size, 2);
  assert.ok(cache.take('a', '1'));
  assert.equal(cache.take('b', '2'), null);
  assert.ok(cache.take('c', '3'));
});

test('a dropped tile disappears from the residency map', () => {
  const cache = createTerrainSampleCache({ maxEntries: 1 });
  cache.store('a', '1', Float32Array.from([1]));
  cache.store('b', '2', Float32Array.from([2]));

  // Claiming a tile it can no longer reconstruct would make the server
  // withhold samples the client needs.
  assert.deepEqual(cache.residency(), { b: '2' });
});

test('rejects entries it could not reconstruct from', () => {
  const cache = createTerrainSampleCache();
  assert.equal(cache.store('a', '1', [1, 2, 3]), false);
  assert.equal(cache.store('a', null, Float32Array.from([1])), false);
  assert.equal(cache.store(null, '1', Float32Array.from([1])), false);
  assert.equal(cache.size, 0);
});

test('a zero cap disables retention entirely', () => {
  const cache = createTerrainSampleCache({ maxEntries: 0 });
  assert.equal(cache.store('a', '1', Float32Array.from([1])), false);
  assert.deepEqual(cache.residency(), {});
});

test('rejects a negative cap', () => {
  assert.throws(() => createTerrainSampleCache({ maxEntries: -1 }), RangeError);
});
