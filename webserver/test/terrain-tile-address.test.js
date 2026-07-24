import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TILE_GRID_ROOT_BBOX,
  formatTerrainTileId,
  isTerrainTileAncestor,
  parseTerrainTileId,
  terrainTileBbox,
  terrainTileDepth,
} from '../terrain-tile-address.js';

test('terrain tile addresses have one strict normalized representation', () => {
  assert.deepEqual(
    parseTerrainTileId(' 12-1461-786 '),
    { depth: 12, col: 1461, row: 786, id: '12-1461-786' },
  );
  assert.equal(formatTerrainTileId(12, 1461, 786), '12-1461-786');
  assert.equal(terrainTileDepth('12-1461-786'), 12);
  assert.equal(terrainTileDepth('bad'), -1);
  for (const invalid of [
    null,
    '12-1461',
    '12-1461-786-1',
    '12-4096-0',
    '12--1-0',
    '12x-1-1',
    '31-0-0',
  ]) {
    assert.equal(parseTerrainTileId(invalid), null);
  }
});

test('terrain tile ancestry shares the canonical parser', () => {
  assert.equal(isTerrainTileAncestor('12-1380-792', '13-2761-1584'), true);
  assert.equal(isTerrainTileAncestor('13-2761-1584', '13-2761-1584'), false);
});

test('terrain tile bbox uses the canonical browser root extent', () => {
  assert.deepEqual(terrainTileBbox('0-0-0'), [...TILE_GRID_ROOT_BBOX]);
  assert.deepEqual(
    terrainTileBbox('12-1461-786'),
    [-275979.9765625, -2827962.265625, -275320.796875, -2827303.0859375],
  );
  assert.equal(terrainTileBbox('invalid'), null);
});
