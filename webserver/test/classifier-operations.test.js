import assert from 'node:assert/strict';
import test from 'node:test';

import {
  jobProgress,
  parseTileIds,
  validateLadderTileId,
} from '../public/classifier.js';

test('classifier job tile input accepts whitespace and commas without duplicates', () => {
  assert.deepEqual(
    parseTileIds('12-1-2, 12-1-3\n12-1-2'),
    ['12-1-2', '12-1-3'],
  );
});

test('classifier targets preserve every supported ladder rung', () => {
  assert.equal(validateLadderTileId('8-85-49'), '8-85-49');
  assert.equal(validateLadderTileId('11-686-392'), '11-686-392');
  assert.equal(validateLadderTileId('12-1373-784'), '12-1373-784');
  assert.equal(validateLadderTileId('14-5499-3176'), null);
  assert.equal(validateLadderTileId('7-1-2'), null);
  assert.equal(validateLadderTileId('not-a-tile'), null);
});

test('job progress is bounded and handles an idle job', () => {
  assert.equal(jobProgress({ total: 8, processed: 3 }), 38);
  assert.equal(jobProgress({ total: 2, processed: 5 }), 100);
  assert.equal(jobProgress({ total: 0, processed: 0 }), 0);
});
