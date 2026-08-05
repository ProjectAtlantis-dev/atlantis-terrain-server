import * as THREE from 'three';
import {
  parseTerrainTileId,
  terrainTileDepth,
} from './terrain-tile-address.js';

// Frequency-split ground detail (Reforger-style): the satellite texture is
// unique-but-blurry low frequency; a small tiling detail texture per surface
// class is repeated-but-sharp high frequency. Near the camera the detail
// modulates the satellite color, selected per-pixel by the server's surface
// channel mask (/api/classifier/<id>.png?raw=1 — R=rock, G=vegetation,
// B=snow, exact black=water/lake, near-black=shadow). Beyond the fade range
// the satellite texture
// stands alone, so distant terrain is untouched and repeat shimmer never
// reaches the horizon. All of it is deterministic: the detail textures come
// from an integer-hash noise with a fixed seed, and the tiling UVs are
// anchored to absolute EPSG:3413 world space via the tile id, so every
// client renders the identical ground.

// Root quadtree extent in meters — must match flaskserver/terrain_config.py
// GREENLAND_BBOX (a 2,700,000 m square).
export const TERRAIN_ROOT_WIDTH_M = 2700000;

// World meters covered by one repeat of the ROCK detail texture. At 256 px
// that is ~2.3 cm/px — grain frequency. Other surfaces tile at a relative
// multiple of the same base UV so the shader needs only one varying:
// vegetation repeats every 3 m (finer tufts), snow every 12 m (broad drift).
export const DETAIL_PERIOD_M = 6;
export const DETAIL_RELATIVE_PERIOD = { rock: 1.0, vegetation: 2.0, snow: 0.5 };
// Aerial Rocks 01 covers an 80 m square. Keep its macro albedo at capture
// scale while the separate procedural/normal detail continues at 6 m.
export const ROCK_COLOR_RELATIVE_PERIOD = DETAIL_PERIOD_M / 80;

// View-distance cross-fade for the detail layer.
export const DETAIL_FADE_START_M = 120;
export const DETAIL_FADE_END_M = 360;

// Modulation strength: 0 = satellite only, 1 = full-range multiply.
export const DETAIL_STRENGTH = 0.55;

// Live tuning: every patched material (both backends) references this ONE
// vector — x = fade start, y = fade end, z = strength — so the tuning-panel
// sliders update all tiles in place, no recompiles, no per-material walks.
export const detailParams = new THREE.Vector3(
  DETAIL_FADE_START_M, DETAIL_FADE_END_M, DETAIL_STRENGTH,
);

export function setDetailTuning({ strength, fadeEnd } = {}) {
  if (strength != null) detailParams.z = strength;
  if (fadeEnd != null) {
    detailParams.y = fadeEnd;
    detailParams.x = fadeEnd / 3;
  }
}

// Pseudo-lighting from the detail normal maps. The terrain material is
// unlit (the satellite photo carries the real sun), so grain relief is a
// directional shading term: a fixed low southern sun — Greenland's sun
// never leaves the southern half of the sky — dotted against the tiled
// normal map. Deterministic, and consistent with the imagery's own shadows.
export const DETAIL_SUN_DIR = [0, -0.819, 0.574]; // south, ~35 deg elevation
export const DETAIL_SHADE_STRENGTH = 0.85;
// Per-surface normal-map bump scale: rock crevices deep, snow nearly flat.
export const DETAIL_BUMP = { rock: 2.2, vegetation: 1.2, snow: 0.5 };

// Tiles coarser than this never fetch masks or compile the detail shader —
// they can only ever be seen from beyond the fade range.
export const DETAIL_MIN_DEPTH = 11;

export const DETAIL_TEXTURE_SIZE = 256;
export const DETAIL_SEED = 0x41544C41; // "ATLA", same seed family as the server

export function tileDepthFromTileId(tileId) {
  return terrainTileDepth(tileId);
}

export function detailMaskUrl(tileId) {
  return `/api/classifier/${tileId}.png?raw=1&res=256&v=11`;
}

// World-anchored tiling UV transform, exact from the tile id: world position
// of a uv inside tile (d, c, r) is ((c + u), (r + v)) * rootWidth / 2^d. The
// per-tile offset is reduced mod 1 in double precision so float32 uniforms
// stay accurate at depth 16, and neighbouring tiles remain seam-continuous.
export function detailUvTransform(tileId) {
  const address = parseTerrainTileId(tileId);
  if (!address) return null;
  const tileWidth = TERRAIN_ROOT_WIDTH_M / 2 ** address.depth;
  const scale = tileWidth / DETAIL_PERIOD_M;
  const fract = value => value - Math.floor(value);
  return {
    scale,
    offsetX: fract(address.col * scale),
    offsetY: fract(address.row * scale),
  };
}

// Deterministic integer hash → [-1, 1], the JS twin of the server's
// terrain_upscale._hash_noise spirit (not bit-identical — only client visuals
// depend on it, and only on itself).
function hashNoise(x, y, seed) {
  let value = (x | 0) * 0x9e3779b1 ^ (y | 0) * 0x85ebca77 ^ (seed | 0);
  value = Math.imul(value ^ (value >>> 15), 0xbf58476d);
  value = Math.imul(value ^ (value >>> 13), 0x94d049bb);
  value ^= value >>> 16;
  return ((value >>> 0) / 0xffffffff) * 2 - 1;
}

function smoothstep01(value) {
  return value * value * (3 - 2 * value);
}

// Value noise on a lattice that wraps at `cells`, so the result tiles
// exactly across the texture border.
function tilingValueNoise(u, v, cells, seed) {
  const x = u * cells;
  const y = v * cells;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothstep01(x - x0);
  const ty = smoothstep01(y - y0);
  const wrap = index => ((index % cells) + cells) % cells;
  const sw = hashNoise(wrap(x0), wrap(y0), seed);
  const se = hashNoise(wrap(x0 + 1), wrap(y0), seed);
  const nw = hashNoise(wrap(x0), wrap(y0 + 1), seed);
  const ne = hashNoise(wrap(x0 + 1), wrap(y0 + 1), seed);
  const south = sw + (se - sw) * tx;
  const north = nw + (ne - nw) * tx;
  return south + (north - south) * ty;
}

// Octaves double the lattice frequency, so tiling is preserved throughout.
function tilingFbm(u, v, baseCells, octaves, seed, persistence = 0.5) {
  let amplitude = 1;
  let total = 0;
  let sum = 0;
  let cells = baseCells;
  for (let octave = 0; octave < octaves; octave++) {
    sum += amplitude * tilingValueNoise(u, v, cells, seed + octave * 0x9e3779b9);
    total += amplitude;
    amplitude *= persistence;
    cells *= 2;
  }
  return sum / total;
}

// Procedurally built textures own their pixels before this runs; loaded ones
// do not, so they must not be marked for update yet.
function configureTilingTexture(texture, { hasPixels = true } = {}) {
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.NoColorSpace;
  if (hasPixels) texture.needsUpdate = true;
  return texture;
}

function loadTilingTexture(url, colorSpace) {
  // TextureLoader hands back an image-less texture immediately and fills it in
  // asynchronously. Marking that for update makes three.js attempt an upload
  // with nothing to upload — once per frame, per texture, until the image
  // lands — which it reports as "Texture marked for update but no image data
  // found". The loader sets needsUpdate itself once the pixels are actually
  // there, so the flag must wait for its callback.
  const texture = new THREE.TextureLoader().load(url, loaded => {
    loaded.needsUpdate = true;
  });
  configureTilingTexture(texture, { hasPixels: false });
  texture.colorSpace = colorSpace;
  return texture;
}

function buildDetailTexture(shade) {
  const size = DETAIL_TEXTURE_SIZE;
  const data = new Uint8Array(size * size);
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const u = column / size;
      const v = row / size;
      const value = Math.max(0, Math.min(1, shade(u, v)));
      data[row * size + column] = Math.round(value * 255);
    }
  }
  return configureTilingTexture(
    new THREE.DataTexture(data, size, size, THREE.RedFormat),
  );
}

// Treat a grayscale detail texture as a height field and derive its tiling
// tangent-space normal map (wrap-around finite differences, so the normals
// tile exactly like the color). Encoded 0..255 around 0.5.
function buildDetailNormalTexture(colorTexture, bumpScale) {
  const size = DETAIL_TEXTURE_SIZE;
  const height = colorTexture.image.data;
  const data = new Uint8Array(size * size * 4);
  const wrap = index => ((index % size) + size) % size;
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const west = height[row * size + wrap(column - 1)] / 255;
      const east = height[row * size + wrap(column + 1)] / 255;
      const south = height[wrap(row - 1) * size + column] / 255;
      const north = height[wrap(row + 1) * size + column] / 255;
      const nx = (west - east) * bumpScale;
      const ny = (south - north) * bumpScale;
      const inverseLength = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const offset = (row * size + column) * 4;
      data[offset] = Math.round((nx * inverseLength * 0.5 + 0.5) * 255);
      data[offset + 1] = Math.round((ny * inverseLength * 0.5 + 0.5) * 255);
      data[offset + 2] = Math.round((inverseLength * 0.5 + 0.5) * 255);
      data[offset + 3] = 255;
    }
  }
  return configureTilingTexture(
    new THREE.DataTexture(data, size, size, THREE.RGBAFormat),
  );
}

// Greenland surface details (see memory: shield rock is granite/gneiss,
// never basalt; lichen reads as blotches on rock at this scale).
export function createDetailTextures() {
  const seed = DETAIL_SEED;
  const rock = buildDetailTexture((u, v) => {
    // Ridged grain: sharp creases like fractured gneiss, plus a banded
    // large-scale drift and lichen-ish blotches brightening flat faces.
    const ridged = 1 - Math.abs(tilingFbm(u, v, 8, 4, seed ^ 0x524f434b));
    const grain = tilingFbm(u, v, 32, 3, seed ^ 0x4752414e) * 0.5;
    const blotch = tilingFbm(u, v, 4, 2, seed ^ 0x4c494348);
    const lichen = smoothstep01(Math.max(0, Math.min(1, blotch * 2.2 - 0.9)));
    return 0.45 + 0.38 * (ridged - 0.5) + grain * 0.35 + lichen * 0.18;
  });
  const vegetation = buildDetailTexture((u, v) => {
    // Fine high-frequency tufting with patchy density — grass and dwarf
    // shrub read from the frequency, not from any real silhouette.
    const tuft = tilingFbm(u, v, 48, 3, seed ^ 0x47524153);
    const patch = tilingFbm(u, v, 6, 2, seed ^ 0x50415443);
    return 0.5 + tuft * 0.32 + patch * 0.16;
  });
  const snow = buildDetailTexture((u, v) => {
    // Near-flat: wind-worked sastrugi hinting, very low contrast.
    const drift = tilingFbm(u, v, 10, 3, seed ^ 0x534e4f57);
    return 0.5 + drift * 0.12;
  });
  return {
    rock,
    // Aerial Rocks 01 is reserved for classifier-confirmed, flatter exposed
    // rock. Its albedo supplies natural color variation while the base
    // orthophoto remains the low-frequency source of truth.
    rockColor: loadTilingTexture(
      '/textures/polyhaven/aerial_rocks_01/aerial_rocks_01_diff_1k.jpg',
      THREE.SRGBColorSpace,
    ),
    vegetation,
    snow,
    rockNormal: loadTilingTexture(
      '/textures/polyhaven/aerial_rocks_01/aerial_rocks_01_nor_gl_1k.jpg',
      THREE.NoColorSpace,
    ),
    vegetationNormal: buildDetailNormalTexture(vegetation, DETAIL_BUMP.vegetation),
    snowNormal: buildDetailNormalTexture(snow, DETAIL_BUMP.snow),
  };
}
