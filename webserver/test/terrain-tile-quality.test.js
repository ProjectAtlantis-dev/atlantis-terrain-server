import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyDemSource,
  classifyTextureTile,
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
