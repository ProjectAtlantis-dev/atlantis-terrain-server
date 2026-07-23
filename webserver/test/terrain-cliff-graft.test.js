import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLIFF_GRAFT_ASSET_VERSION,
  cliffGraftsForTile,
  inpaintWaterPixels,
  loadCliffGraftTexture,
  tileIsInSubtree,
} from '../terrain-cliff-graft.js';

test('tile subtree helper resolves exact tiles and descendants', () => {
  assert.equal(tileIsInSubtree('13-2761-1584', '13-2761-1584'), true);
  assert.equal(tileIsInSubtree('14-5522-3168', '13-2761-1584'), true);
  assert.equal(tileIsInSubtree('16-22095-12675', '13-2761-1584'), true);
  assert.equal(tileIsInSubtree('13-2760-1584', '13-2761-1584'), false);
  assert.equal(tileIsInSubtree('12-1380-792', '13-2761-1584'), false);

});

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

test('water inpaint copies nearest classified land and preserves land', () => {
  // 3x2 image: only the left column is land. All water must inherit the
  // corresponding nearest land color without modifying the land itself.
  const pixels = new Uint8ClampedArray([
    10, 20, 30, 255, 1, 2, 3, 255, 4, 5, 6, 255,
    40, 50, 60, 255, 7, 8, 9, 255, 11, 12, 13, 255,
  ]);
  const water = new Uint8Array([
    0, 255, 255,
    0, 255, 255,
  ]);

  const result = inpaintWaterPixels(pixels, 3, 2, water, 3, 2);
  assert.deepEqual(result, { waterPixels: 4, filledPixels: 4 });
  assert.deepEqual([...pixels], [
    10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255,
    40, 50, 60, 255, 40, 50, 60, 255, 40, 50, 60, 255,
  ]);
});

test('water inpaint rejects an all-water donor', () => {
  const pixels = new Uint8ClampedArray([0, 80, 160, 255]);
  const water = new Uint8Array([255]);
  assert.throws(
    () => inpaintWaterPixels(pixels, 1, 1, water, 1, 1),
    /no classified land/,
  );
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
