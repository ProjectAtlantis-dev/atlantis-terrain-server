import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROCGEN_WINDOW_TILE_COUNT,
  canonicalTileFromSource,
  diffWindows,
  windowDescriptors,
} from './chunk-window.js';

const TILE = 2700000 / (2 ** 12);

test('LOD refinement does not change the canonical procgen tile', () => {
  const depth12 = {
    depth: 12, col: 1401, row: 828,
    xMin: 1000, yMin: 2000, xMax: 1000 + TILE, yMax: 2000 + TILE,
  };
  const depth13NorthEast = {
    depth: 13, col: 2803, row: 1657,
    xMin: 1000 + TILE / 2, yMin: 2000 + TILE / 2,
    xMax: 1000 + TILE, yMax: 2000 + TILE,
  };
  const x = 1000 + TILE * 0.75;
  const y = 2000 + TILE * 0.75;
  const coarse = canonicalTileFromSource(depth12, x, y);
  const refined = canonicalTileFromSource(depth13NorthEast, x, y);
  assert.equal(coarse.id, '12-1401-828');
  assert.equal(refined.id, coarse.id);
  assert.equal(refined.xMin, coarse.xMin);
  assert.equal(refined.yMin, coarse.yMin);
});

test('a 3x3 window has nine canonical chunks', () => {
  const center = canonicalTileFromSource({
    depth: 12, col: 1401, row: 828,
    xMin: 1000, yMin: 2000, xMax: 1000 + TILE, yMax: 2000 + TILE,
  }, 1100, 2100);
  assert.equal(windowDescriptors(center).length, PROCGEN_WINDOW_TILE_COUNT);
});

test('crossing one tile retains six and swaps only one edge', () => {
  const west = canonicalTileFromSource({
    depth: 12, col: 1401, row: 828,
    xMin: 1000, yMin: 2000, xMax: 1000 + TILE, yMax: 2000 + TILE,
  }, 1100, 2100);
  const east = {
    ...west,
    id: '12-1402-828',
    col: west.col + 1,
    xMin: west.xMin + west.width,
    xMax: west.xMax + west.width,
  };
  const diff = diffWindows(west, east);
  assert.equal(diff.retained.length, 6);
  assert.equal(diff.loaded.length, 3);
  assert.equal(diff.unloaded.length, 3);
});
