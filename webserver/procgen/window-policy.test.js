import assert from 'node:assert/strict';
import test from 'node:test';

import {
  selectHystereticCenter,
  selectProcgenWindowCenter,
} from './window-policy.js';

test('procgen center does not ping-pong at an ordinary snap boundary', () => {
  assert.equal(selectHystereticCenter(289, 192), 192);
  assert.equal(selectHystereticCenter(303, 192), 192);
  assert.equal(selectHystereticCenter(305, 192), 384);
  assert.equal(selectHystereticCenter(287, 384), 384);
  assert.equal(selectHystereticCenter(273, 384), 384);
  assert.equal(selectHystereticCenter(271, 384), 192);
});

test('initial procgen center uses the canonical absolute grid', () => {
  assert.deepEqual(selectProcgenWindowCenter({ x: 358, y: 91 }), {
    centerX: 384,
    centerY: 0,
  });
});

test('invalid coordinates do not select a procgen window', () => {
  assert.equal(selectProcgenWindowCenter({ x: Number.NaN, y: 0 }), null);
  assert.equal(selectHystereticCenter(0, null, { step: 0 }), null);
});
