import assert from 'node:assert/strict';
import test from 'node:test';

import {
  absoluteCandidateCell,
  absoluteScatterGrid,
  candidateInsideGridWindow,
  candidateLocalPosition,
} from './procgen-absolute-grid.js';

function visibleCandidates(centerX) {
  const grid = absoluteScatterGrid({
    centerX,
    centerZ: 2_300_000,
    worldSize: 768,
    cellSize: 5.5,
  });
  const result = new Map();
  for (let row = 0; row < grid.gridCount; row += 1) {
    for (let column = 0; column < grid.gridCount; column += 1) {
      const cell = absoluteCandidateCell(grid, column, row);
      const local = candidateLocalPosition(grid, cell, 0.37, 0.61);
      if (!candidateInsideGridWindow(grid, local)) continue;
      result.set(`${cell.x}:${cell.z}`, {
        worldX: local.x + centerX,
        worldZ: local.z + 2_300_000,
      });
    }
  }
  return result;
}

test('adjacent procedural windows agree exactly on overlapping candidate cells', () => {
  const a = visibleCandidates(-500_000);
  const b = visibleCandidates(-499_808);
  const overlap = [...a.keys()].filter(key => b.has(key));
  assert.ok(overlap.length > 1000);
  for (const key of overlap) assert.deepEqual(a.get(key), b.get(key));
});

test('absolute grid uses bounded guard candidates at Greenland magnitudes', () => {
  const grid = absoluteScatterGrid({
    centerX: -500_000,
    centerZ: 2_300_000,
    worldSize: 768,
    cellSize: 2.1,
  });
  assert.equal(grid.gridCount, Math.ceil(768 / 2.1) + 2);
  // floor phase plus one explicit guard cell: [half+cell, half+2*cell).
  assert.ok(Math.abs(grid.localOffsetX) >= 386.1);
  assert.ok(Math.abs(grid.localOffsetX) < 388.2);
});

test('absolute grid rejects invalid dimensions', () => {
  assert.throws(() => absoluteScatterGrid({
    centerX: 0, centerZ: 0, worldSize: 768, cellSize: 0,
  }), RangeError);
});
