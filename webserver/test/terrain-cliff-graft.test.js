import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLIFF_GRAFT_ASSET_VERSION,
  CLIFF_GRAFTS,
  CLIFF_TEXTURE_WORLD_SCALE,
  cliffGraftsForTile,
  loadCliffGraftTexture,
} from '../terrain-cliff-graft.js';

test('cliff graft applies across detailed terrain depths', () => {
  const grafts = cliffGraftsForTile('13-2761-1584');
  assert.deepEqual(
    grafts.map(graft => [graft.assetId, graft.aspect]),
    [
      ['marble-rock-03', 'south'],
    ],
  );
  assert.ok(grafts.every(graft => graft.tintStrength > 0 && graft.tintStrength < 1));

  assert.equal(grafts[0].sources[0].capturePeriodM, 1.8);
  assert.equal(grafts[0].periodM, 10.8);
  assert.equal(grafts[0].sources[0].periodM, 10.8);
  assert.equal(cliffGraftsForTile('15-11044-6336').length, 1);
  assert.deepEqual(cliffGraftsForTile('12-1380-792'), []);
  assert.deepEqual(cliffGraftsForTile('not-a-tile'), []);
});

test('graft loader composes the configured Poly Haven color and normal sources', async () => {
  const requestedUrls = [];
  let imageReads = 0;
  const bitmap = { width: 4, height: 4, close() {} };
  const canvas = {
    width: 4,
    height: 4,
    getContext() {
      return {
        drawImage() {},
        getImageData() { imageReads += 1; },
      };
    },
  };

  const asset = await loadCliffGraftTexture({
    spec: CLIFF_GRAFTS[0],
    fetchImpl: async url => {
      requestedUrls.push(url);
      return {
        ok: true,
        status: 200,
        blob: async () => ({}),
      };
    },
    decodeImage: async () => bitmap,
    canvasFactory: () => canvas,
  });

  assert.equal(requestedUrls.length, 2);
  assert.ok(requestedUrls.every(url => (
    url.endsWith(`?v=${CLIFF_GRAFT_ASSET_VERSION}`)
  )));
  assert.ok(requestedUrls.some(url => url.includes('marble_rock_03_diff_1k')));
  assert.ok(requestedUrls.some(url => url.includes('marble_rock_03_nor_gl_1k')));
  assert.equal(imageReads, 0);
  assert.equal(asset.source, 'marble-rock-03');
  assert.equal(asset.layers.length, 1);
  asset.texture.dispose();
  asset.normalTexture.dispose();
});
