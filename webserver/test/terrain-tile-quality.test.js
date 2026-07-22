import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyDemSource,
  classifyTextureTile,
  mergeTerrainTilesAgainstCurrentTileSet,
  retryableSyntheticDemCount,
} from '../terrain-tile-quality.js';
import { terrainPipelineStatus } from '../terrain-tile-fetch.js';

test('browser normalizes raw synthetic terrain flavors', () => {
  for (const source of [
    'parent_resampled', 'unmasked_parent_resampled', 'clobbered_parent_resampled',
  ]) {
    assert.deepEqual(
      classifyDemSource(source),
      {
        kind: 'parent_dem', synthetic: true, retryable: true,
        terminal: false, retryState: 'ready', source,
      },
    );
  }
  assert.equal(classifyDemSource('arcticdem_10m').synthetic, false);
  assert.equal(classifyDemSource('procedural').retryable, false);
});

test('browser distinguishes synthetic image fallback from final imagery', () => {
  assert.equal(classifyTextureTile({ texStatus: 'ancestor_fallback' }).synthetic, true);
  assert.equal(classifyTextureTile({ texStatus: 'ready' }).synthetic, false);
});

test('retryable synthetic heightmaps keep browser reconciliation polling alive', () => {
  const tiles = [{ source: 'parent_resampled' }, { source: 'arcticdem_10m' }];
  assert.equal(retryableSyntheticDemCount(tiles), 1);
  assert.equal(
    terrainPipelineStatus({ tiles, missing: [], downloading: [] }, false, 2).nextAction,
    'poll',
  );
});

test('late terrain data upgrades exact resident tiles without changing topology', () => {
  const current = [
    {
      id: '10-381-194', source: 'arcticdem_10m', heightmap: 'current-parent',
      texStatus: 'ready', hasTexture: true,
    },
    {
      id: '11-763-389', source: 'parent_resampled', heightmap: 'synthetic',
      texStatus: 'ancestor_fallback', texIsPlaceholder: true,
    },
  ];
  const result = mergeTerrainTilesAgainstCurrentTileSet(current, [
    {
      id: '12-1525-779', source: 'arcticdem_10m', heightmap: 'late-child',
      texStatus: 'ready', hasTexture: true,
    },
    {
      id: '11-763-389', source: 'arcticdem_10m', heightmap: 'real',
      texStatus: 'ready', hasTexture: true, texIsPlaceholder: false,
    },
  ]);

  assert.deepEqual(result.tiles.map(tile => tile.id), ['10-381-194', '11-763-389']);
  assert.equal(result.tiles[0].heightmap, 'current-parent');
  assert.equal(result.tiles[1].heightmap, 'real');
  assert.equal(result.tiles[1].texStatus, 'ready');
  assert.deepEqual(result.acceptedTileIds, ['11-763-389']);
  assert.deepEqual(result.rejectedTileIds, ['12-1525-779']);
  assert.equal(result.demUpgraded, 1);
  assert.equal(result.textureUpgraded, 1);
});

test('late DEM upgrade cannot regress an exact tile ready texture', () => {
  const result = mergeTerrainTilesAgainstCurrentTileSet([
    {
      id: '11-763-389', source: 'parent_resampled', heightmap: 'synthetic',
      texStatus: 'ready', hasTexture: true,
    },
  ], [
    {
      id: '11-763-389', source: 'arcticdem_10m', heightmap: 'real',
      texStatus: 'ancestor_fallback', texIsPlaceholder: true,
    },
  ]);

  assert.equal(result.tiles[0].heightmap, 'real');
  assert.equal(result.tiles[0].texStatus, 'ready');
  assert.equal(result.textureUpgraded, 0);
});
