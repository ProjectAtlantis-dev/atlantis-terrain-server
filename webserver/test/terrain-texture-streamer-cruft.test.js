import assert from 'node:assert/strict';
import test from 'node:test';

import { createTextureStreamer } from '../terrain-texture-streamer.js';

function seedRequestState(streamer, tileId, texture) {
  let aborts = 0;
  streamer.texInflight.set(tileId, { abort() { aborts += 1; } });
  streamer.texFetching.add(tileId);
  streamer.texRetryAtMs.set(tileId, 10);
  streamer.texRetryCount.set(tileId, 2);
  streamer.ancestorLogged.add(tileId);
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
  assert.equal(streamer.ancestorLogged.has('12-1-1'), false);
  assert.equal(streamer.texCache.get('12-1-1'), retained);
  assert.equal(streamer.texSource.get('12-1-1'), 'test');

  let disposals = 0;
  const released = { dispose() { disposals += 1; } };
  seedRequestState(streamer, '12-1-2', released);
  assert.equal(streamer.releaseTile('12-1-2'), true);
  assert.equal(disposals, 1);
  assert.equal(streamer.texCache.has('12-1-2'), false);
  assert.equal(streamer.texSource.has('12-1-2'), false);
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

