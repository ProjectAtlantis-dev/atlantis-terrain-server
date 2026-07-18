import assert from 'node:assert/strict';
import test from 'node:test';

import { sampleTriangulatedHeight } from './terrain-height-sampling.js';

test('terrain sampling follows the rendered triangle split, not a bilinear saddle', () => {
  const heights = new Float32Array([
    0, 10,
    20, 0,
  ]);

  assert.equal(sampleTriangulatedHeight(heights, 2, 0.25, 0.25), 7.5);
  assert.equal(sampleTriangulatedHeight(heights, 2, 0.75, 0.75), 7.5);
  assert.equal(sampleTriangulatedHeight(heights, 2, 0.5, 0.5), 15);
});

test('terrain sampling clamps grid edges onto the final rendered triangles', () => {
  const heights = new Float32Array([
    0, 10, 20,
    30, 40, 50,
    60, 70, 80,
  ]);

  assert.equal(sampleTriangulatedHeight(heights, 3, -2, -1), 0);
  assert.equal(sampleTriangulatedHeight(heights, 3, 2, 2), 80);
  assert.equal(sampleTriangulatedHeight(heights, 3, 1.5, 1.5), 60);
});

test('terrain sampling rejects malformed inputs', () => {
  assert.ok(Number.isNaN(sampleTriangulatedHeight([], 2, 0, 0)));
  assert.ok(Number.isNaN(sampleTriangulatedHeight(new Float32Array([1]), 1, 0, 0)));
});
