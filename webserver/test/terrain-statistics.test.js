import assert from 'node:assert/strict';
import test from 'node:test';

import { sortedPercentile } from '../terrain-statistics.js';


test('sorted percentile uses the existing nearest-rank sample contract', () => {
  const values = [1, 2, 3, 4, 5];
  assert.equal(sortedPercentile(values, 0.05), 1);
  assert.equal(sortedPercentile(values, 0.50), 3);
  assert.equal(sortedPercentile(values, 0.95), 5);
  assert.equal(sortedPercentile(values, 1), 5);
});

test('sorted percentile has one empty-sample result', () => {
  assert.equal(sortedPercentile([], 0.95), null);
});
