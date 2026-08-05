import * as THREE from 'three';
import { parseTerrainTileId } from './terrain-tile-address.js';

export { parseTerrainTileId } from './terrain-tile-address.js';

export const CLIFF_GRAFT_ASSET_VERSION = 4;

const POLYHAVEN_MARBLE_ROCK_03 =
  '/textures/polyhaven/marble_rock_03/marble_rock_03';
// Sets the graft's world period, and with it the size of the bumps its normal
// map encodes. Large values smear the map into a low-frequency gradient with
// no relief to catch the sun, so this stays near the capture scale.
export const CLIFF_TEXTURE_WORLD_SCALE = 6;

export const CLIFF_GRAFTS = Object.freeze([
  Object.freeze({
    assetId: 'marble-rock-03',
    sources: Object.freeze([
      Object.freeze({
        assetId: 'marble_rock_03',
        diffuseUrl: `${POLYHAVEN_MARBLE_ROCK_03}_diff_1k.jpg`,
        normalUrl: `${POLYHAVEN_MARBLE_ROCK_03}_nor_gl_1k.jpg`,
        capturePeriodM: 1.8,
        periodM: 1.8 * CLIFF_TEXTURE_WORLD_SCALE,
      }),
    ]),
    minDepth: 13,
    // Southern faces only. southness = -normal.y over the horizontal length,
    // so the feather runs from due-east/west (0) to due-south (1); grafting
    // starts once a face is clearly turned south and reaches full a little
    // past halfway.
    aspect: 'south',
    southStart: 0.15,
    southEnd: 0.55,
    periodM: 1.8 * CLIFF_TEXTURE_WORLD_SCALE,
    // Averaging phase-offset copies of one capture to hide its repeat is a
    // low-pass filter: measured, the three-way blend kept 60% of the diffuse's
    // contrast and 67% of its edge detail, which is most of what makes the
    // rock read as rock. Sample it once and accept the repeat. Restoring the
    // de-tiling needs a variance-preserving blend, not a plain mix.
    phaseMix: 0,
    phaseMix2: 0,
    phaseVariation: 0,
    variationPeriodM: 137,
    // slopeSignal = 1 - abs(normal.z). Reaching full graft only at 60 degrees
    // left real cliffs averaging ~16% marble against ~84% orthophoto, so the
    // photo's flatness dominated and the rock's shadows never showed. Measured
    // across real tiles, this ramp reaches ~99% on a true south wall while
    // still leaving near-horizontal ground — which has no stable uv, the
    // projection having no top-down axis — completely ungrafted.
    slopeStart: 0.06,
    slopeEnd: 0.18,
    // Pulls the rock's colour toward the surrounding orthophoto so the graft
    // sits in its landscape. Too much of it bleaches the capture's own warmth.
    tintStrength: 0.40,
    // Full chroma variation kept; the cast is corrected by greyTint instead.
    saturation: 1.0,
    // The capture's own white balance (0.852, 1.025, 1.377) times the granite
    // tint measured off a photograph of the real cliff (0.943, 1.011, 1.059).
    // Warm quarry brown at R/B 1.62 becomes blue-grey granite at 0.89, which
    // is what the real rock measures.
    greyTint: [0.803, 1.036, 1.458],
    // A ceiling below 1 leaves the orthophoto permanently mixed into even the
    // steepest face, capping how much of the rock can ever be seen.
    strength: 1.0,
    normalStrength: 0.95,
    // The material is stretched far past its capture scale, which flattens the
    // slopes its normal map encodes. Scale them back up so the rock still
    // catches and loses the sun across its own relief.
    // Measured: this capture's normals already average ~23 degrees of tilt.
    // Amplifying them saturates against z and costs contrast rather than
    // adding it, so take the map as it was authored.
    normalRelief: 1,
    // The diffuse capture already has its own occlusion baked in, so relief
    // shading only needs to add the difference the rock makes against the face
    // it sits on. Centred on 1.0 so it darkens as readily as it brightens and
    // never washes the baked contrast out.
    // reliefFloor is how dark relief shading may drive a crevice. At 0.45 the
    // deepest ones were clipped off before anything downstream saw them, which
    // no exposure change can undo — lowering the floor deepens shadows without
    // dimming the midtones the way exposure does.
    reliefContrast: 4.5,
    reliefFloor: 0.12,
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

  async function loadBitmap(url) {
    const response = await fetchImpl(`${url}?v=${CLIFF_GRAFT_ASSET_VERSION}`);
    if (!response.ok) throw new Error(`${spec.assetId} http ${response.status}`);
    return response.blob().then(blob => decodeImage(
      blob, { premultiplyAlpha: 'none' },
    ));
  }

  // Correcting the capture's colour once, here, beats carrying it as a shader
  // uniform: it costs nothing per frame and cannot be stranded by a cached
  // shader program. Multiplies in the stored sRGB values, matching how the
  // balance was measured.
  function bakeColorBalance(context, canvas, balance) {
    if (!balance) return;
    const image = context.getImageData?.(0, 0, canvas.width, canvas.height);
    const data = image?.data;
    // Test doubles and any canvas that will not read back simply skip this.
    if (!data) return;
    const [r, g, b] = balance;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = Math.min(255, data[i] * r);
      data[i + 1] = Math.min(255, data[i + 1] * g);
      data[i + 2] = Math.min(255, data[i + 2] * b);
    }
    context.putImageData?.(image, 0, 0);
  }

  async function loadTexture(source, urlKey, colorSpace) {
    const bitmap = await loadBitmap(source[urlKey]);
    try {
      const canvas = canvasFactory(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('could not create cliff texture canvas');
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      // Colour balance applies to the albedo only — a normal map's channels are
      // directions, and scaling them would tilt every normal.
      if (colorSpace === THREE.SRGBColorSpace) {
        bakeColorBalance(context, canvas, spec.greyTint);
      }

      const texture = new THREE.CanvasTexture(canvas);
      texture.flipY = false;
      // The captures are already seamless, so mirroring buys no seam hiding
      // and costs visible kaleidoscope symmetry across every repeat boundary.
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.colorSpace = colorSpace;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = true;
      texture.needsUpdate = true;
      return texture;
    } finally {
      bitmap.close?.();
    }
  }

  const layers = await Promise.all((spec.sources ?? [spec]).map(async source => {
    const [texture, normalTexture] = await Promise.all([
      loadTexture(source, 'diffuseUrl', THREE.SRGBColorSpace),
      loadTexture(source, 'normalUrl', THREE.NoColorSpace),
    ]);
    return { ...source, texture, normalTexture };
  }));
  return {
    layers,
    texture: layers[0].texture,
    normalTexture: layers[0].normalTexture,
    source: spec.assetId,
  };
}
