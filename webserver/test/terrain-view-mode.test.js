import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveTerrainViewToggle } from '../terrain-view-mode.js';

test('H toggles directly between 3D and tile inspector', () => {
  assert.deepEqual(
    resolveTerrainViewToggle({ mapMode: false, tileInspectorActive: false }, 'inspector'),
    { accepted: true, mapMode: true, tileInspectorActive: true, seamMode: false },
  );
  assert.deepEqual(
    resolveTerrainViewToggle({ mapMode: true, tileInspectorActive: true }, 'inspector'),
    { accepted: true, mapMode: false, tileInspectorActive: false, seamMode: false },
  );
});

test('M toggles directly between 3D and regular map', () => {
  assert.deepEqual(
    resolveTerrainViewToggle({ mapMode: false, tileInspectorActive: false }, 'map'),
    { accepted: true, mapMode: true, tileInspectorActive: false, seamMode: false },
  );
  assert.deepEqual(
    resolveTerrainViewToggle({ mapMode: true, tileInspectorActive: false }, 'map'),
    { accepted: true, mapMode: false, tileInspectorActive: false, seamMode: false },
  );
});

test('map and tile inspector never switch directly into each other', () => {
  assert.deepEqual(
    resolveTerrainViewToggle({ mapMode: true, tileInspectorActive: false }, 'inspector'),
    { accepted: false, mapMode: true, tileInspectorActive: false, seamMode: false },
  );
  assert.deepEqual(
    resolveTerrainViewToggle({ mapMode: true, tileInspectorActive: true }, 'map'),
    { accepted: false, mapMode: true, tileInspectorActive: true, seamMode: false },
  );
});

test('seam view is a map presentation with a separately toggleable grid', () => {
  assert.deepEqual(
    resolveTerrainViewToggle(
      { mapMode: false, tileInspectorActive: false, seamMode: false },
      'seam',
    ),
    { accepted: true, mapMode: true, tileInspectorActive: false, seamMode: true },
  );
  assert.deepEqual(
    resolveTerrainViewToggle(
      { mapMode: true, tileInspectorActive: false, seamMode: true },
      'map',
    ),
    { accepted: true, mapMode: true, tileInspectorActive: false, seamMode: false },
  );
  assert.deepEqual(
    resolveTerrainViewToggle(
      { mapMode: true, tileInspectorActive: false, seamMode: true },
      'seam',
    ),
    { accepted: true, mapMode: false, tileInspectorActive: false, seamMode: false },
  );
});
