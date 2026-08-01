import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeTerrainBinaryPayload,
  isTerrainBinaryResponse,
} from '../terrain-binary-payload.js';

function encodePayload(header, blocks) {
  let headerBytes = new TextEncoder().encode(JSON.stringify(header));
  // Mirror the server's alignment padding.
  const pad = (-(headerBytes.length + 4) % 4 + 4) % 4;
  if (pad > 0) {
    const padded = new Uint8Array(headerBytes.length + pad);
    padded.set(headerBytes);
    padded.fill(0x20, headerBytes.length);
    headerBytes = padded;
  }
  const samples = blocks.flatMap(block => [...block]);
  const buffer = new ArrayBuffer(4 + headerBytes.length + samples.length * 4);
  new DataView(buffer).setUint32(0, headerBytes.length, true);
  new Uint8Array(buffer, 4, headerBytes.length).set(headerBytes);
  new Float32Array(buffer, 4 + headerBytes.length, samples.length).set(samples);
  return buffer;
}

test('decodes tiles into float views without copying', () => {
  const buffer = encodePayload({
    qx: 1,
    tiles: [
      { id: '12-1-1', heightmap: 'aaaa1111', heightmapBytes: 12 },
      { id: '12-1-2', heightmap: 'bbbb2222', heightmapBytes: 8 },
    ],
  }, [[1, 2, 3], [4, 5]]);

  const header = decodeTerrainBinaryPayload(buffer);
  assert.equal(header.qx, 1);
  assert.deepEqual([...header.tiles[0].samples], [1, 2, 3]);
  assert.deepEqual([...header.tiles[1].samples], [4, 5]);
  // Views, not copies: they must alias the original buffer.
  assert.equal(header.tiles[0].samples.buffer, buffer);
});

test('keeps the digest as the comparable heightmap identity', () => {
  const buffer = encodePayload({
    tiles: [{ id: '12-1-1', heightmap: 'deadbeef', heightmapBytes: 4 }],
  }, [[7]]);

  const header = decodeTerrainBinaryPayload(buffer);
  // Seam-repair detection and geometry reuse compare this field for equality.
  assert.equal(header.tiles[0].heightmap, 'deadbeef');
});

test('tolerates tiles that carry no samples', () => {
  const buffer = encodePayload({
    tiles: [
      { id: '12-1-1', heightmap: 'x', heightmapBytes: null },
      { id: '12-1-2', heightmap: 'y', heightmapBytes: 4 },
    ],
  }, [[9]]);

  const header = decodeTerrainBinaryPayload(buffer);
  assert.equal(header.tiles[0].samples, undefined);
  assert.deepEqual([...header.tiles[1].samples], [9]);
});

test('rejects a payload whose header overruns the buffer', () => {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setUint32(0, 999, true);
  assert.throws(() => decodeTerrainBinaryPayload(buffer), RangeError);
});

test('rejects a payload whose samples are truncated', () => {
  const header = { tiles: [{ id: '12-1-1', heightmap: 'x', heightmapBytes: 64 }] };
  const buffer = encodePayload(header, [[1]]);
  assert.throws(() => decodeTerrainBinaryPayload(buffer), RangeError);
});

test('rejects a non-buffer payload', () => {
  assert.throws(() => decodeTerrainBinaryPayload('not-a-buffer'), TypeError);
});

test('detects the binary transport from response headers', () => {
  const headers = value => ({ get: name => (name === 'X-Terrain-Format' ? value : null) });
  assert.equal(isTerrainBinaryResponse({ headers: headers('binary-v1') }), true);
  assert.equal(isTerrainBinaryResponse({ headers: headers(null) }), false);
  assert.equal(isTerrainBinaryResponse({
    headers: { get: name => (name === 'Content-Type' ? 'application/octet-stream' : null) },
  }), true);
  assert.equal(isTerrainBinaryResponse({
    headers: { get: () => 'application/json' },
  }), false);
});
