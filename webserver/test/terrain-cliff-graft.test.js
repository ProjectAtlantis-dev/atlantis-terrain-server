import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLIFF_GRAFT_ASSET_VERSION,
  cliffGraftsForTile,
  loadCliffGraftTexture,
} from '../terrain-cliff-graft.js';

test('cliff graft applies across detailed terrain depths', () => {
  const donors = cliffGraftsForTile('13-2761-1584');
  assert.deepEqual(
    donors.map(graft => [graft.donorTileId, graft.aspect]),
    [
      ['12-1380-786', 'south'],
    ],
  );
  assert.ok(donors.every(graft => graft.tintStrength > 0 && graft.tintStrength < 1));
  assert.equal(cliffGraftsForTile('15-11044-6336').length, 1);
  assert.deepEqual(cliffGraftsForTile('12-1380-792'), []);
  assert.deepEqual(cliffGraftsForTile('not-a-tile'), []);
});

test('graft loader consumes the shared persisted donor without local inpainting', async () => {
  let requestedUrl = null;
  let imageReads = 0;
  const headers = new Map([
    ['X-Cliff-Graft-Water-Pixels', '17'],
    ['X-Cliff-Graft-Cache', 'hit'],
  ]);
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
    spec: { donorTileId: '12-1380-786' },
    fetchImpl: async url => {
      requestedUrl = url;
      return {
        ok: true,
        status: 200,
        headers: { get: name => headers.get(name) ?? null },
        blob: async () => ({}),
      };
    },
    decodeImage: async () => bitmap,
    canvasFactory: () => canvas,
  });

  assert.equal(
    requestedUrl,
    `/api/cliff-graft/12-1380-786.png?v=${CLIFF_GRAFT_ASSET_VERSION}`,
  );
  assert.equal(imageReads, 0);
  assert.deepEqual(asset.inpaint, { waterPixels: 17, filledPixels: 17 });
  assert.equal(asset.cache, 'hit');
  asset.texture.dispose();
});
