import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoverageResource, mergeCoverageInventory } from '../coverage-cache.js';

const cured = { tile: '10-479-16', depth: 10, status: 'cured', dem: true, coastline: true };
const inventory = tiles => ({ cureDepth: 10, tiles });
const response = data => ({ ok: true, json: async () => data });

test('cures survive missing or provisional rows while new cures and partial updates arrive', () => {
  const previous = inventory([cured, { ...cured, tile: '10-480-16' }]);
  const incoming = inventory([
    { ...cured, status: 'partial', coastline: false },
    { ...cured, tile: '10-481-16' },
    { tile: '10-482-16', depth: 10, status: 'partial' },
    { tile: '9-239-8', depth: 9, status: 'partial' },
  ]);
  const merged = mergeCoverageInventory(previous, incoming);
  assert.deepEqual(merged.tiles.find(tile => tile.tile === cured.tile), cured);
  assert.deepEqual(merged.summary, { cured: 3, partial: 1, coarse: 1 });
  assert.equal(incoming.tiles.length, 4);
  assert.deepEqual(mergeCoverageInventory(merged, inventory([])).summary,
    { cured: 3, partial: 0, coarse: 0 });
});

test('a changed cure depth starts a separate inventory', () => {
  const merged = mergeCoverageInventory(inventory([cured]), { cureDepth: 11, tiles: [] });
  assert.deepEqual(merged.tiles, []);
});

test('restores saved coverage before a slow refresh, coalesces requests, and persists new cures', async () => {
  let finishFetch;
  let requests = 0;
  let stored = { updatedAt: 0, data: inventory([cured]) };
  const published = [];
  const resource = createCoverageResource({
    url: '/api/coverage/cure.json',
    merge: mergeCoverageInventory,
    now: () => 60_000,
    read: async () => stored,
    write: async (_url, value) => { stored = value; },
    onData: (data, metadata) => published.push({ data, ...metadata }),
    fetchImpl: () => {
      requests++;
      return new Promise(resolve => { finishFetch = resolve; });
    },
  });
  const loading = resource.load();
  assert.equal(resource.load(), loading);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(published.length, 1);
  assert.equal(published[0].cached, true);
  assert.equal(published[0].data.summary.cured, 1);
  finishFetch(response(inventory([{ ...cured, tile: '10-480-16' }])));
  await loading;
  assert.equal(published[1].cached, false);
  assert.equal(stored.data.summary.cured, 2);
  assert.equal(stored.updatedAt, 60_000);
  await resource.load();
  assert.equal(requests, 1);

  const reopened = createCoverageResource({
    url: '/api/coverage/cure.json',
    merge: mergeCoverageInventory,
    now: () => 60_001,
    read: async () => stored,
    onData: data => assert.equal(data.summary.cured, 2),
    fetchImpl: () => assert.fail('fresh saved coverage should avoid another request'),
  });
  await reopened.load();
});

test('failed refresh retains saved cures and can be retried', async () => {
  let requests = 0;
  let data;
  const resource = createCoverageResource({
    url: '/coverage',
    merge: mergeCoverageInventory,
    now: () => 60_000,
    read: async () => ({ updatedAt: 0, data: inventory([cured]) }),
    write: async () => {},
    onData: value => { data = value; },
    fetchImpl: async () => ++requests === 1
      ? { ok: false, status: 503 }
      : response(inventory([])),
  });
  await assert.rejects(resource.load(), /503/);
  assert.equal(data.summary.cured, 1);
  await resource.load();
  assert.equal(data.summary.cured, 1);
  assert.equal(requests, 2);
});

test('manual refresh bypasses freshness and revalidates HTTP caches', async () => {
  let requests = 0;
  const resource = createCoverageResource({
    url: '/coastline',
    maxAge: 3_600_000,
    now: () => 1_000,
    read: async () => ({ updatedAt: 500, data: { lines: [] } }),
    write: async () => {},
    onData: () => {},
    fetchImpl: async (_url, options) => {
      requests++;
      assert.equal(options.cache, 'no-cache');
      assert.ok(options.signal instanceof AbortSignal);
      return response({ lines: [] });
    },
  });
  await resource.load();
  assert.equal(requests, 0);
  await resource.load({ force: true });
  assert.equal(requests, 1);
});

test('blocked persistent storage does not prevent loading or memory caching', async () => {
  let requests = 0;
  let data;
  const denied = async () => { throw new Error('Storage denied'); };
  const resource = createCoverageResource({
    url: '/coverage',
    read: denied,
    write: denied,
    onData: value => { data = value; },
    fetchImpl: async () => { requests++; return response(inventory([cured])); },
  });
  await resource.load();
  await resource.load();
  assert.equal(data.tiles.length, 1);
  assert.equal(requests, 1);
});

test('invalid saved inventory is replaced and invalid network responses are never persisted', async () => {
  let writes = 0;
  let valid = true;
  const resource = createCoverageResource({
    url: '/coverage',
    merge: mergeCoverageInventory,
    read: async () => ({ updatedAt: 100, data: {} }),
    write: async () => { writes++; },
    onData: data => assert.equal(data.summary.cured, 1),
    fetchImpl: async () => response(valid ? inventory([cured]) : {}),
  });
  await resource.load();
  valid = false;
  await assert.rejects(resource.load({ force: true }), /Invalid coverage inventory/);
  assert.equal(writes, 1);
});
