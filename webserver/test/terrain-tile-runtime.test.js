import assert from 'node:assert/strict';
import test from 'node:test';

import {
  terrainFogDistance,
  terrainHorizonDistance,
  terrainVisibilityDistance,
} from '../terrain-tile-runtime.js';


test('terrain visibility and fog share the canonical horizon calculation', () => {
  const minimumHorizon = Math.sqrt(2 * 6371000 * 25);
  assert.equal(terrainHorizonDistance(0), minimumHorizon);
  assert.equal(terrainVisibilityDistance(25), minimumHorizon);
  assert.equal(terrainFogDistance(25), 15000 + 25 * 8);
});

test('terrain distance policies retain their independent high-altitude caps', () => {
  assert.equal(terrainVisibilityDistance(1000), 30000 + 1000 * 12);
  assert.equal(terrainFogDistance(1000), 15000 + 1000 * 8);
});
