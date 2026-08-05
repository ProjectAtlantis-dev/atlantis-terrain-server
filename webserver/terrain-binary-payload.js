export const TERRAIN_BINARY_FORMAT = 'binary-v1';

const HEADER_LENGTH_BYTES = 4;
const FLOAT32_BYTES = 4;

/**
 * Decode the length-prefixed terrain payload into the shape the JSON path
 * produced, with elevations exposed as views rather than strings.
 *
 * Layout: [uint32 LE header length][header JSON + pad][float32 blocks].
 *
 * Base64 inside JSON cost twice — a third more bytes on the wire, and a
 * main-thread parse proportional to the whole payload before a single tile
 * could be built. Here only the small header is parsed; each tile's samples
 * become a Float32Array view over the original buffer, with no copy.
 *
 * `tile.heightmap` carries a digest of the bytes rather than the bytes
 * themselves. Geometry reuse and seam-repair detection compare that field for
 * equality, so it stays a cheap comparable string on both transports.
 */
export function decodeTerrainBinaryPayload(buffer) {
  if (!(buffer instanceof ArrayBuffer)) {
    throw new TypeError('terrain binary payload must be an ArrayBuffer');
  }
  if (buffer.byteLength < HEADER_LENGTH_BYTES) {
    throw new RangeError('terrain binary payload is truncated');
  }
  const headerLength = new DataView(buffer).getUint32(0, true);
  const samplesStart = HEADER_LENGTH_BYTES + headerLength;
  if (samplesStart > buffer.byteLength) {
    throw new RangeError('terrain binary header exceeds payload length');
  }
  const header = JSON.parse(
    new TextDecoder().decode(
      new Uint8Array(buffer, HEADER_LENGTH_BYTES, headerLength),
    ),
  );

  let offset = samplesStart;
  for (const tile of header.tiles ?? []) {
    const byteLength = tile.heightmapBytes;
    if (!Number.isInteger(byteLength) || byteLength <= 0) continue;
    if (offset + byteLength > buffer.byteLength) {
      throw new RangeError(`terrain samples truncated for tile ${tile.id}`);
    }
    // The server pads the header so this offset is always float-aligned; a
    // misaligned view would throw rather than silently misread.
    tile.samples = new Float32Array(
      buffer, offset, byteLength / FLOAT32_BYTES,
    );
    offset += byteLength;
  }

  // Footprint rings follow the tile samples, in header order. As JSON they
  // were the single largest thing the main thread parsed each poll; here the
  // ring becomes a flat xyz view over the response with no copy.
  for (const building of header.buildings ?? []) {
    const byteLength = building.ringBytes;
    if (!Number.isInteger(byteLength) || byteLength <= 0) continue;
    if (offset + byteLength > buffer.byteLength) {
      throw new RangeError(`building ring truncated for ${building.id}`);
    }
    building.ringXYZ = new Float32Array(
      buffer, offset, byteLength / FLOAT32_BYTES,
    );
    offset += byteLength;
  }
  return header;
}

/** True when a response carries the binary terrain layout. */
export function isTerrainBinaryResponse(response) {
  const format = response?.headers?.get?.('X-Terrain-Format');
  if (format === TERRAIN_BINARY_FORMAT) return true;
  const type = response?.headers?.get?.('Content-Type') ?? '';
  return type.startsWith('application/octet-stream');
}
