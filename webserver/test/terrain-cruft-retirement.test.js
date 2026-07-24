import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import * as cliffGraft from '../terrain-cliff-graft.js';
import * as tileAddress from '../terrain-tile-address.js';
import * as tileSet from '../terrain-tile-set.js';


test('retired browser terrain runtimes stay absent', () => {
  assert.equal(existsSync(new URL('../terrain-roads-runtime.js', import.meta.url)), false);
  assert.equal(existsSync(new URL('../terrain-status-controller.js', import.meta.url)), false);
});

test('test-only wrappers and superseded client inpainting stay retired', () => {
  assert.equal('createTerrainTileReconciler' in tileSet, false);
  assert.equal('tileIsInSubtree' in cliffGraft, false);
  assert.equal('inpaintWaterPixels' in cliffGraft, false);
  assert.equal('terrainTileIsInSubtree' in tileAddress, false);
});

test('stale-parent no-op lifecycle plumbing stays retired', () => {
  for (const path of [
    '../terrain-tile-set.js',
    '../terrain-fetch-runtime.js',
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\bsweepStaleParents\b/);
    assert.doesNotMatch(source, /\bstaleRemoved\b/);
  }
});

test('unused procgen debris and leaf material stay retired', () => {
  const groundCover = readFileSync(
    new URL('../procgen/GroundCover.ts', import.meta.url),
    'utf8',
  );
  const library = readFileSync(
    new URL('../procgen/library.ts', import.meta.url),
    'utf8',
  );
  for (const name of [
    'twigGeometry',
    'barkChipGeometry',
    'debrisMaterial',
    'litterMaterial',
    'scatterInstances',
  ]) {
    assert.doesNotMatch(groundCover, new RegExp(`\\b${name}\\b`));
  }
  assert.doesNotMatch(library, /\bleafMeshMaterial\b/);
});
