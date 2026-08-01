import assert from 'node:assert/strict';
import test from 'node:test';

import { createTextureStreamer } from '../terrain-texture-streamer.js';
import { createTileEvictionGate } from '../terrain-tile-eviction.js';

function seedRequestState(streamer, tileId, texture) {
  let aborts = 0;
  streamer.texInflight.set(tileId, { abort() { aborts += 1; } });
  streamer.texFetching.add(tileId);
  streamer.texRetryAtMs.set(tileId, 10);
  streamer.texRetryCount.set(tileId, 2);
  streamer.texCache.set(tileId, texture);
  streamer.texSource.set(tileId, 'test');
  return () => aborts;
}

test('texture release modes share request cleanup but preserve cache policy', () => {
  const streamer = createTextureStreamer({ log() {} });
  const retained = { dispose() { throw new Error('demand release disposed cache'); } };
  const retainedAborts = seedRequestState(streamer, '12-1-1', retained);

  streamer.releaseTileDemand('12-1-1');
  assert.equal(retainedAborts(), 1);
  assert.equal(streamer.texInflight.has('12-1-1'), false);
  assert.equal(streamer.texFetching.has('12-1-1'), false);
  assert.equal(streamer.texRetryAtMs.has('12-1-1'), false);
  assert.equal(streamer.texRetryCount.has('12-1-1'), false);
  assert.equal(streamer.texCache.get('12-1-1'), retained);
  assert.equal(streamer.texSource.get('12-1-1'), 'test');
  assert.equal(streamer.dormantTextures.get('12-1-1'), retained);

  let disposals = 0;
  const released = { dispose() { disposals += 1; } };
  seedRequestState(streamer, '12-1-2', released);
  assert.equal(streamer.discardTexture('12-1-2', released), true);
  assert.equal(disposals, 1);
  assert.equal(streamer.texCache.has('12-1-2'), false);
  assert.equal(streamer.texSource.has('12-1-2'), false);
});

test('dormant paint uses a bounded LRU and claimed tiles become active', () => {
  const streamer = createTextureStreamer({ log() {}, maxDormant: 2 });
  const disposed = [];
  for (const tileId of ['a', 'b', 'c']) {
    const texture = { dispose() { disposed.push(tileId); } };
    streamer.texCache.set(tileId, texture);
    streamer.releaseTileDemand(tileId);
  }

  assert.deepEqual([...streamer.dormantTextures.keys()], ['b', 'c']);
  assert.deepEqual(disposed, ['a']);
  assert.equal(streamer.texCache.has('a'), false);

  streamer.claimTile('b');
  assert.equal(streamer.dormantTextures.has('b'), false);
  assert.equal(streamer.texCache.has('b'), true);
});

test('the shared debug gate retains dormant and late-arriving textures', () => {
  const gate = createTileEvictionGate(false);
  const streamer = createTextureStreamer({
    log() {}, maxDormant: 1, evictionGate: gate,
  });
  const disposed = [];
  for (const tileId of ['a', 'b']) {
    const texture = { dispose() { disposed.push(tileId); } };
    streamer.texCache.set(tileId, texture);
    streamer.releaseTileDemand(tileId);
  }
  assert.equal(streamer.dormantTextures.size, 2);
  assert.equal(streamer.discardTexture('a'), true);
  assert.equal(streamer.texCache.has('a'), true);
  assert.deepEqual(disposed, []);

  gate.setEnabled(true);
  assert.deepEqual([...streamer.dormantTextures.keys()], ['b']);
  assert.deepEqual(disposed, ['a']);
});

test('re-enabling eviction trims a late texture retained outside demand', () => {
  const gate = createTileEvictionGate(false);
  const streamer = createTextureStreamer({
    log() {}, maxDormant: 0, evictionGate: gate,
  });
  let disposals = 0;
  const texture = { dispose() { disposals += 1; } };
  streamer.texCache.set('late', texture);
  streamer.texSource.set('late', 'test');

  assert.equal(streamer.discardTexture('late', texture), true);
  assert.equal(disposals, 0, 'gate must retain the late texture');
  gate.setEnabled(true);

  assert.equal(streamer.texCache.has('late'), false);
  assert.equal(disposals, 1);
});

test('re-enabling eviction disposes a stale texture released behind the gate', () => {
  const gate = createTileEvictionGate(false);
  const streamer = createTextureStreamer({ log() {}, evictionGate: gate });
  let disposals = 0;
  const texture = { dispose() { disposals += 1; } };
  streamer.texCache.set('12-1-1', texture);

  streamer.setRoadDebug(true);
  assert.equal(streamer.releaseStaleTexture(texture), true);
  assert.equal(disposals, 0, 'gate must retain the released stale texture');
  gate.setEnabled(true);

  assert.equal(disposals, 1);
  assert.equal(streamer.releaseStaleTexture(texture), false);
});

test('all debug variants use the same cache invalidation path', () => {
  const streamer = createTextureStreamer({ log() {} });
  for (const [setter, property, tileId] of [
    ['setRoadDebug', 'roadDebug', '12-2-1'],
    ['setWaterDebug', 'waterDebug', '12-2-2'],
    ['setHydroDebug', 'hydroDebug', '12-2-3'],
  ]) {
    let disposals = 0;
    const texture = { dispose() { disposals += 1; } };
    streamer.texCache.set(tileId, texture);
    streamer.texSource.set(tileId, 'test');

    assert.equal(streamer[setter](true), true);
    assert.equal(streamer[property], true);
    assert.equal(streamer.texCache.size, 0);
    assert.equal(streamer.texSource.size, 0);
    assert.equal(streamer.releaseStaleTexture(texture), true);
    assert.equal(disposals, 1);
    assert.equal(streamer.releaseStaleTexture(texture), false);
  }
});

test('debug invalidation immediately disposes dormant paint', () => {
  let disposals = 0;
  const texture = { dispose() { disposals += 1; } };
  const streamer = createTextureStreamer({ log() {} });
  streamer.texCache.set('12-4-5', texture);
  streamer.releaseTileDemand('12-4-5');

  streamer.setRoadDebug(true);

  assert.equal(disposals, 1);
  assert.equal(streamer.releaseStaleTexture(texture), false);
});
