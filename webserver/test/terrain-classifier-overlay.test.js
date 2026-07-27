import assert from 'node:assert/strict';
import test from 'node:test';

import { createClassifierOverlay } from '../terrain-classifier-overlay.js';

const TILE_ID = '14-5499-3176';

function pendingResponse() {
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        return name === 'X-Classifier-Status' ? 'pending' : null;
      },
    },
    blob: async () => {
      throw new Error('pending overlays must not decode their placeholder body');
    },
  };
}

test('classifier overlay retries pending descendants instead of caching them', async () => {
  let fetches = 0;
  let resolver = null;
  const timers = [];
  const tileSet = {
    setTextureOverlay(next) {
      resolver = next;
    },
    refreshTextureOverlay() {
      resolver?.(TILE_ID);
    },
  };
  const overlay = createClassifierOverlay({
    tileSet,
    fetchImpl: async () => {
      fetches += 1;
      return pendingResponse();
    },
    setTimeoutImpl(callback, delay) {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl() {},
  });

  overlay.setMode('classifier');
  assert.equal(overlay.resolve(TILE_ID), null);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(fetches, 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 500);

  // Reconciliation while pending must not bypass the backoff.
  assert.equal(overlay.resolve(TILE_ID), null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetches, 1);

  timers[0].callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetches, 2);

  overlay.dispose();
});
