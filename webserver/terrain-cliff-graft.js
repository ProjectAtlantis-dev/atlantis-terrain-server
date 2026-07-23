import * as THREE from 'three';

export const CLIFF_GRAFT_ASSET_VERSION = 1;

// Use one known-good, low/flat terrain tile as the paint source for steep,
// south-facing terrain throughout the detailed render depths.
export const CLIFF_GRAFTS = Object.freeze([
  Object.freeze({
    donorTileId: '12-1380-786',
    minDepth: 13,
    aspect: 'south',
    // The donor covers ~659 m. Compressing it slightly gives the cliff enough
    // texture frequency without turning the orthophoto into obvious noise.
    periodM: 320,
    secondaryScale: 1.73,
    secondaryMix: 0.28,
    // slopeSignal = 1 - abs(normal.z): starts near 23°, fully grafted near 60°.
    slopeStart: 0.08,
    slopeEnd: 0.50,
    // southness = max(-normal.y / length(normal.xy), 0). This softly admits
    // southeast/southwest faces while leaving E/W/N aspects untouched.
    southStart: 0.15,
    southEnd: 0.55,
    tintStrength: 0.55,
    strength: 0.94,
    phase: [0.173, 0.419, 0.637, 0.281],
  }),
]);

export function parseTerrainTileId(tileId) {
  const parts = String(tileId).split('-').map(Number);
  if (
    parts.length !== 3
    || !parts.every(Number.isInteger)
    || parts.some(value => value < 0)
  ) {
    return null;
  }
  return { depth: parts[0], column: parts[1], row: parts[2] };
}

export function tileIsInSubtree(tileId, rootTileId) {
  const tile = parseTerrainTileId(tileId);
  const root = parseTerrainTileId(rootTileId);
  if (!tile || !root || tile.depth < root.depth) return false;
  const shift = tile.depth - root.depth;
  return (
    Math.floor(tile.column / 2 ** shift) === root.column
    && Math.floor(tile.row / 2 ** shift) === root.row
  );
}

export function cliffGraftsForTile(tileId) {
  const tile = parseTerrainTileId(tileId);
  if (!tile) return [];
  return CLIFF_GRAFTS.filter(graft => tile.depth >= graft.minDepth);
}

function validateWaterMask(water, width, height) {
  if (!(water instanceof Uint8Array)) {
    throw new TypeError('cliff graft water mask must be a Uint8Array');
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError('cliff graft water mask dimensions must be positive integers');
  }
  if (water.length !== width * height) {
    throw new RangeError('cliff graft water mask dimensions do not match its data');
  }
}

// Replace every donor-water pixel with the nearest donor-land pixel. A
// multi-source flood is linear in pixel count and avoids ever uploading the
// blue water paint to the triplanar sampler. The classifier and canvas are
// both image-oriented here (row zero = north), so their rows align directly.
export function inpaintWaterPixels(
  rgba,
  imageWidth,
  imageHeight,
  water,
  maskWidth,
  maskHeight,
) {
  if (!(rgba instanceof Uint8ClampedArray)) {
    throw new TypeError('cliff graft pixels must be a Uint8ClampedArray');
  }
  if (
    !Number.isInteger(imageWidth)
    || !Number.isInteger(imageHeight)
    || imageWidth < 1
    || imageHeight < 1
    || rgba.length !== imageWidth * imageHeight * 4
  ) {
    throw new RangeError('cliff graft image dimensions do not match its pixels');
  }
  validateWaterMask(water, maskWidth, maskHeight);

  const pixelCount = imageWidth * imageHeight;
  const nearestLand = new Int32Array(pixelCount);
  nearestLand.fill(-1);
  const queue = new Int32Array(pixelCount);
  let head = 0;
  let tail = 0;
  let waterPixels = 0;

  for (let y = 0; y < imageHeight; y++) {
    const maskY = Math.min(maskHeight - 1, Math.floor(y * maskHeight / imageHeight));
    for (let x = 0; x < imageWidth; x++) {
      const index = y * imageWidth + x;
      const maskX = Math.min(maskWidth - 1, Math.floor(x * maskWidth / imageWidth));
      if (water[maskY * maskWidth + maskX] >= 128) {
        waterPixels += 1;
        continue;
      }
      nearestLand[index] = index;
      queue[tail++] = index;
    }
  }

  if (waterPixels === 0) return { waterPixels: 0, filledPixels: 0 };
  if (tail === 0) {
    throw new Error('cliff graft donor contains no classified land pixels');
  }

  while (head < tail) {
    const index = queue[head++];
    const x = index % imageWidth;
    const y = Math.floor(index / imageWidth);
    const donor = nearestLand[index];
    const visit = next => {
      if (nearestLand[next] !== -1) return;
      nearestLand[next] = donor;
      queue[tail++] = next;
    };
    if (x > 0) visit(index - 1);
    if (x + 1 < imageWidth) visit(index + 1);
    if (y > 0) visit(index - imageWidth);
    if (y + 1 < imageHeight) visit(index + imageWidth);
  }

  // Keep an immutable source copy: some replacement pixels point at land
  // that lies later in memory than the water pixel being filled.
  const source = new Uint8ClampedArray(rgba);
  for (let index = 0; index < pixelCount; index++) {
    const donor = nearestLand[index];
    if (donor === index) continue;
    const offset = index * 4;
    const donorOffset = donor * 4;
    rgba[offset] = source[donorOffset];
    rgba[offset + 1] = source[donorOffset + 1];
    rgba[offset + 2] = source[donorOffset + 2];
    rgba[offset + 3] = source[donorOffset + 3];
  }
  return { waterPixels, filledPixels: waterPixels };
}

export async function loadCliffGraftTexture({
  spec,
  fetchImpl = (...args) => fetch(...args),
  decodeImage = (...args) => createImageBitmap(...args),
  canvasFactory = (width, height) => Object.assign(
    document.createElement('canvas'), { width, height },
  ),
} = {}) {
  if (!spec) throw new TypeError('cliff graft spec is required');

  const response = await fetchImpl(
    `/api/cliff-graft/${spec.donorTileId}.png?v=${CLIFF_GRAFT_ASSET_VERSION}`,
  );
  if (!response.ok) {
    const status = response.headers?.get?.('X-Cliff-Graft-Status');
    throw new Error(`prepared donor http ${response.status}${status ? ` (${status})` : ''}`);
  }

  const bitmap = await response.blob().then(blob => decodeImage(
    blob, { premultiplyAlpha: 'none' },
  ));
  try {
    const canvas = canvasFactory(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('could not create donor texture canvas');
    context.drawImage(bitmap, 0, 0);

    const texture = new THREE.CanvasTexture(canvas);
    // Canvas and classifier rows are north-first. Terrain UV v=0 is south,
    // so retain the same upload flip used by the surface-mask CanvasTexture.
    texture.flipY = true;
    texture.wrapS = THREE.MirroredRepeatWrapping;
    texture.wrapT = THREE.MirroredRepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    const waterPixels = Number(
      response.headers?.get?.('X-Cliff-Graft-Water-Pixels'),
    );
    return {
      texture,
      inpaint: {
        waterPixels: Number.isFinite(waterPixels) ? waterPixels : 0,
        filledPixels: Number.isFinite(waterPixels) ? waterPixels : 0,
      },
      cache: response.headers?.get?.('X-Cliff-Graft-Cache') ?? 'unknown',
    };
  } finally {
    bitmap.close?.();
  }
}
