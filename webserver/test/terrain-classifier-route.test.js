import assert from 'node:assert/strict';
import test from 'node:test';

import { createClassifierRouteRuntime } from '../terrain-classifier-route.js';

test('classifier route serializes the initial probe and backs off a missing route', async () => {
  let clock = 100;
  let fetches = 0;
  const messages = [];
  const runtime = createClassifierRouteRuntime({
    now: () => clock,
    retryBaseMs: 1000,
    retryMaxMs: 8000,
    log: (...args) => messages.push(args),
    fetchImpl: async () => {
      fetches += 1;
      return { status: 404 };
    },
  });

  const results = await Promise.all([
    runtime.fetchResponse('/api/classifier/a.png', 'a'),
    runtime.fetchResponse('/api/classifier/b.png', 'b'),
    runtime.fetchResponse('/api/classifier/c.png', 'c'),
  ]);

  assert.equal(fetches, 1);
  assert.equal(results.every(result => result.available === false), true);
  assert.equal(messages.length, 1);
  assert.deepEqual(runtime.getStatus(), {
    available: false,
    probing: false,
    consecutiveFailures: 1,
    retryAtMs: 1100,
  });

  await runtime.fetchResponse('/api/classifier/d.png', 'd');
  assert.equal(fetches, 1);
});

test('classifier route automatically recovers when a later probe succeeds', async () => {
  let clock = 0;
  let fetches = 0;
  const runtime = createClassifierRouteRuntime({
    now: () => clock,
    retryBaseMs: 1000,
    fetchImpl: async () => {
      fetches += 1;
      return fetches === 1
        ? { status: 404 }
        : { status: 204 };
    },
  });

  assert.equal(
    (await runtime.fetchResponse('/api/classifier/a.png', 'a')).available,
    false,
  );
  clock = 1000;
  const recovered = await runtime.fetchResponse('/api/classifier/b.png', 'b');

  assert.equal(recovered.available, true);
  assert.equal(recovered.response.status, 204);
  assert.deepEqual(runtime.getStatus(), {
    available: true,
    probing: false,
    consecutiveFailures: 0,
    retryAtMs: 0,
  });
});
