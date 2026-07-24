import assert from 'node:assert/strict';
import test from 'node:test';

import {
  jobProgress,
  normalizeD12TileId,
  parseTileIds,
} from '../public/classifier.js';

test('classifier job tile input accepts whitespace and commas without duplicates', () => {
  assert.deepEqual(
    parseTileIds('12-1-2, 12-1-3\n12-1-2'),
    ['12-1-2', '12-1-3'],
  );
});

test('tile menu links can normalize deep terrain tiles to their D12 ancestor', () => {
  assert.equal(normalizeD12TileId('12-1373-784'), '12-1373-784');
  assert.equal(normalizeD12TileId('14-5499-3176'), '12-1374-794');
  assert.equal(normalizeD12TileId('11-1-2'), null);
  assert.equal(normalizeD12TileId('not-a-tile'), null);
});

test('job progress is bounded and handles an idle job', () => {
  assert.equal(jobProgress({ total: 8, processed: 3 }), 38);
  assert.equal(jobProgress({ total: 2, processed: 5 }), 100);
  assert.equal(jobProgress({ total: 0, processed: 0 }), 0);
});
