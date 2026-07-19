import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveTerrainViewToggle } from '../terrain-view-mode.js';

test('H toggles directly between 3D and heatmap', () => {
  assert.deepEqual(
    resolveTerrainViewToggle({ mapMode: false, heatmapActive: false }, 'heatmap'),
    { accepted: true, mapMode: true, heatmapActive: true, seamMode: false },
  );
  assert.deepEqual(
    resolveTerrainViewToggle({ mapMode: true, heatmapActive: true }, 'heatmap'),
    { accepted: true, mapMode: false, heatmapActive: false, seamMode: false },
  );
});

test('M toggles directly between 3D and regular map', () => {
  assert.deepEqual(
    resolveTerrainViewToggle({ mapMode: false, heatmapActive: false }, 'map'),
    { accepted: true, mapMode: true, heatmapActive: false, seamMode: false },
  );
  assert.deepEqual(
    resolveTerrainViewToggle({ mapMode: true, heatmapActive: false }, 'map'),
    { accepted: true, mapMode: false, heatmapActive: false, seamMode: false },
  );
});

test('map and heatmap never switch directly into each other', () => {
  assert.deepEqual(
    resolveTerrainViewToggle({ mapMode: true, heatmapActive: false }, 'heatmap'),
    { accepted: false, mapMode: true, heatmapActive: false, seamMode: false },
  );
  assert.deepEqual(
    resolveTerrainViewToggle({ mapMode: true, heatmapActive: true }, 'map'),
    { accepted: false, mapMode: true, heatmapActive: true, seamMode: false },
  );
});

test('seam view is a map presentation with a separately toggleable grid', () => {
  assert.deepEqual(
    resolveTerrainViewToggle(
      { mapMode: false, heatmapActive: false, seamMode: false },
      'seam',
    ),
    { accepted: true, mapMode: true, heatmapActive: false, seamMode: true },
  );
  assert.deepEqual(
    resolveTerrainViewToggle(
      { mapMode: true, heatmapActive: false, seamMode: true },
      'map',
    ),
    { accepted: true, mapMode: true, heatmapActive: false, seamMode: false },
  );
  assert.deepEqual(
    resolveTerrainViewToggle(
      { mapMode: true, heatmapActive: false, seamMode: true },
      'seam',
    ),
    { accepted: true, mapMode: false, heatmapActive: false, seamMode: false },
  );
});
