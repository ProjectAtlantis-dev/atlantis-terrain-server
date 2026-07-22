import assert from 'node:assert/strict';
import test from 'node:test';

import { terrainResidencyBudgetForPass } from './terrain-fetch-executor.js';

test('preview terrain residency is bounded independently from full detail', () => {
  assert.equal(terrainResidencyBudgetForPass({
    pass: 1,
    tileBudget: 384,
    previewTileBudget: 16,
  }), 16);
  assert.equal(terrainResidencyBudgetForPass({
    pass: 2,
    tileBudget: 384,
    previewTileBudget: 16,
  }), 384);
});

test('preview terrain residency never exceeds the full safety ceiling', () => {
  assert.equal(terrainResidencyBudgetForPass({
    pass: 1,
    tileBudget: 32,
    previewTileBudget: 64,
  }), 32);
});
