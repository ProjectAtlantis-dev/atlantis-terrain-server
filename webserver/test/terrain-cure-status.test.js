import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTerrainCureStatusRuntime,
  terrainCureAncestorId,
} from '../terrain-cure-status.js';

test('terrain cure status maps a rendered tile to its governing cure tile', () => {
  assert.equal(terrainCureAncestorId('12-1917-64', 10), '10-479-16');
  assert.equal(terrainCureAncestorId('10-479-16', 10), '10-479-16');
  assert.equal(terrainCureAncestorId('9-239-8', 10), null);
});

test('terrain cure status reports exact inventory evidence and reuses fresh data', async () => {
  let requests = 0;
  const runtime = createTerrainCureStatusRuntime({
    now: () => 100,
    fetchImpl: async () => {
      requests += 1;
      return {
        ok: true,
        json: async () => ({
          cureDepth: 10,
          tiles: [{
            tile: '10-479-16',
            status: 'partial',
            dem: true,
            coastline: false,
            texture: 'dataforsyningen',
          }],
        }),
      };
    },
  });

  await runtime.load();
  assert.deepEqual(runtime.statusFor('12-1917-64'), {
    state: 'partial',
    cureDepth: 10,
    cureTileId: '10-479-16',
    dem: true,
    coastline: false,
    texture: 'dataforsyningen',
  });
  await runtime.load();
  assert.equal(requests, 1);
});
