import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifierSourceCandidates,
  classifierSourcesCoverBounds,
} from './classifier-source.js';

test('classifier candidates start at the best render tile then walk ancestors', () => {
  const southwest = classifierSourceCandidates({
    depth: 13, col: 20, row: 30,
    xMin: 1000, yMin: 2000, xMax: 1330, yMax: 2330,
  });
  const northeast = classifierSourceCandidates({
    depth: 13, col: 21, row: 31,
    xMin: 1330, yMin: 2330, xMax: 1660, yMax: 2660,
  });

  assert.deepEqual(southwest[0], {
    id: '13-20-30', depth: 13, col: 20, row: 30,
    xMin: 1000, yMin: 2000, xMax: 1330, yMax: 2330,
  });
  assert.deepEqual(southwest[1], {
    id: '12-10-15', depth: 12, col: 10, row: 15,
    xMin: 1000, yMin: 2000, xMax: 1660, yMax: 2660,
  });
  assert.deepEqual(northeast[1], southwest[1]);
  assert.equal(southwest.at(-1).id, '0-0-0');
});

test('coarser render tiles retain their own classifier address', () => {
  assert.deepEqual(classifierSourceCandidates({
    depth: 11, col: 4, row: 7,
    xMin: -10, yMin: 20, xMax: 30, yMax: 60,
  })[0], {
    id: '11-4-7', depth: 11, col: 4, row: 7,
    xMin: -10, yMin: 20, xMax: 30, yMax: 60,
  });
});

test('classifier coverage accepts a fine mosaic and rejects a gap', () => {
  const fields = { res: 64 };
  const west = { xMin: 0, yMin: 0, xMax: 5, yMax: 10, fields };
  const east = { xMin: 5, yMin: 0, xMax: 10, yMax: 10, fields };
  const bounds = { xMin: 0, yMin: 0, xMax: 10, yMax: 10 };
  assert.equal(classifierSourcesCoverBounds([west, east], bounds), true);
  assert.equal(classifierSourcesCoverBounds([west], bounds), false);
});
