/**
 * World constants — the single place defining world dimensions, grid sizes,
 * vertical scale, and biome identifiers. The macro layout (where the massif,
 * valley, karst zone, and lake live) is in MacroMap.ts.
 */

/** world edge length in meters; world spans [-WORLD_HALF, +WORLD_HALF]² */
export const WORLD_SIZE = 4096;
export const WORLD_HALF = WORLD_SIZE / 2;

/** final composed heightfield resolution (1 m/texel) */
export const HEIGHT_RES = 4096;
/** erosion / hydrology simulation grid (2 m/texel) — spec floor ≥2048 */
export const SIM_RES = 2048;

/** vertical range: heights are meters above sea/datum 0 */
export const LAKE_LEVEL = 142;
export const VALLEY_FLOOR = 165;
export const KARST_PLATEAU = 380;
export const TREELINE = 950;
export const SNOWLINE_BASE = 1050;
export const SUMMIT_MAX = 1620;

/** far-shell vista ring: analytic terrain from WORLD_HALF out to FAR_RADIUS */
export const FAR_RADIUS = 14000;

/**
 * GREENLAND Arctic bioclimatic zones (CAVM-style subzones), stored quantized in
 * the classification texture r-channel. Zonation is driven by summer WARMTH =
 * f(latitude, altitude, aspect) — see BiomeSnow.ts. Numeric ids are kept from
 * the original temperate scheme so the byBiome[6] tables line up by column.
 */
export const enum Biome {
  Nival = 0, // polar-desert / snow-barren: <5% cover, permanent snow patches, frost gravel
  FellField = 1, // high-arctic barren: cushion plants, prostrate willow, poppy/avens on gravel
  DwarfShrubTundra = 2, // the matrix: crowberry / bilberry / dwarf-birch heath
  ShrubHeath = 3, // richest (low, sheltered, southern): dwarf birch + willow scrub
  Meadow = 4, // grass–sedge meadow with wildflowers
  Mire = 5, // fen / bog on wet flats: cottongrass, sedge, moss
  COUNT = 6,
}

export const BIOME_NAMES: readonly string[] = [
  'nival',
  'fell-field',
  'dwarf-shrub-tundra',
  'shrub-heath',
  'meadow',
  'mire',
];

/**
 * World latitude (°N) — Greenland spans ~60 (south, mildest) to ~84 (far north,
 * polar desert). Drives the summer-warmth base in BiomeSnow, so a southern world
 * skews to shrub-heath/meadow and a northern one to fell-field/nival. Change
 * this (or wire it to a `?lat=` param) to generate different regions.
 */
export const GREENLAND_LAT = 67;

/** July-warmth base (°C) at sea level for a given latitude (real-ish: ~11°C in
 *  the mild south fjords, ~4°C in the high north). Used by the biome classifier. */
export function warmthBaseForLat(latDeg: number): number {
  return 11.4 - (latDeg - 61) * 0.46;
}

/**
 * SEASON — Greenland's short summer flips fast to a brief, vivid autumn (the
 * tundra "fall colours": dwarf birch/bilberry/bearberry blaze rust-orange-red,
 * grasses go golden) and then a long snow-covered winter. Build-time like
 * GREENLAND_LAT — set it and regenerate. Palettes read AUTUMN / WINTER below.
 */
export const enum Season {
  Spring = 3,
  Summer = 0,
  Autumn = 1,
  Winter = 2,
}
// SEASON is a URL param (?season=spring|summer|autumn|winter), default summer, so
// all seasons are viewable by reload / by the shoot tool. Guarded for Node tool
// imports (no window). Returns the Season union (not a narrowed literal) so the
// SPRING / AUTUMN / WINTER palette comparisons below stay live.
function readSeason(): Season {
  if (typeof window !== 'undefined' && window.location) {
    const s = new URLSearchParams(window.location.search).get('season');
    if (s === 'spring') return Season.Spring;
    if (s === 'autumn') return Season.Autumn;
    if (s === 'winter') return Season.Winter;
  }
  return Season.Summer;
}
export const GREENLAND_SEASON = readSeason();
/** 1 in spring, else 0 — snowmelt: fresh vivid green + patchy lingering snow. */
export const SPRING: number = GREENLAND_SEASON === Season.Spring ? 1 : 0;
/** 1 in autumn, else 0 — palettes lerp green→rust by this. */
export const AUTUMN: number = GREENLAND_SEASON === Season.Autumn ? 1 : 0;
/** 1 in winter, else 0 — drives snow cover + dormant browns. */
export const WINTER: number = GREENLAND_SEASON === Season.Winter ? 1 : 0;

/** quality presets — smaller grids, never fewer systems */
export interface QualityConfig {
  heightRes: number;
  simRes: number;
  erosionIters: number;
  tileVerts: number; // vertices per tile edge
}

export function qualityConfig(preset: 'low' | 'high' | 'ultra'): QualityConfig {
  switch (preset) {
    case 'low':
      return { heightRes: 2048, simRes: 1024, erosionIters: 500, tileVerts: 49 };
    case 'ultra':
      return { heightRes: 4096, simRes: 2048, erosionIters: 900, tileVerts: 81 };
    case 'high':
      return { heightRes: HEIGHT_RES, simRes: SIM_RES, erosionIters: 640, tileVerts: 65 };
  }
}
