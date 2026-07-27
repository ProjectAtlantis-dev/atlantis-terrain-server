import * as THREE from 'three';
import { parseTerrainTileId } from './terrain-tile-address.js';

export { parseTerrainTileId } from './terrain-tile-address.js';

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

export function cliffGraftsForTile(tileId) {
  const tile = parseTerrainTileId(tileId);
  if (!tile) return [];
  return CLIFF_GRAFTS.filter(graft => tile.depth >= graft.minDepth);
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
