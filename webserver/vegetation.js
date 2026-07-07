// Procedural vegetation PoC — stable, satellite-driven scatter.
//
// Approach borrowed from the LAAS demo (~/work/fable5-world-demo): a virtual
// jittered grid over the world where each candidate cell is decided by an
// integer hash (pcg2d) of its ABSOLUTE EPSG:3413 cell coordinate. Nothing is
// stored — the same cell always produces the same plant, across reloads,
// sessions, and tile LOD changes. Density is gated by the real satellite
// texture (greenness / rockiness classification) and heightmap slope, so the
// scatter reads as sharpening the imagery rather than painting over it.
//
// Enable with ?veg=1. Tuning params: ?vegDepth=12 ?vegCell=3 ?vegSeed=1337
// ?vegDensity=1
//
// Lifecycle: self-syncing. Once per interval we scan terrainRoot for textured
// tile meshes at depth >= vegDepth, build instanced scatter for new ones
// (budgeted, nearest first), and dispose scatter whose tile mesh is gone or
// was retextured. No hooks into the tile eviction paths needed.

import * as THREE from 'three';
import { buildAssetProtos, PROTO_DIAM } from './veg_assets.js';

// --- config (set in initVegetation) ---
let _enabled = false;
let _minDepth = 12;
let _cell = 3.0;
let _seed = 1337;
let _densityScale = 1.0;
let _waterBufferM = 15;   // no-mans-land around detected water, meters
let _clumpSalt = 0;       // derived from _seed in initVegetation
let _terrainRoot = null;
let _camera = null;
let _getFrameOffset = null;

const SYNC_INTERVAL_MS = 250;
const BUILDS_PER_SYNC = 1;
const MAX_PLANTS_PER_TILE = 50000;
const MAX_STONES_PER_TILE = 20000;
const TEX_SAMPLE_RES = 256;   // canvas readback resolution per tile texture
const MIN_GROUND_Z = 0.6;     // skip ocean / sea-level (seabed is shaped below 0)
const TAU = Math.PI * 2;
// effective growing-season sun for the insolation model: due grid-south,
// 25° elevation (a season-weighted compromise for ~64°N; midsummer noon ~49°)
const SUN_EL = 25 * Math.PI / 180;
const SUN_SIN = Math.sin(SUN_EL), SUN_COS = Math.cos(SUN_EL), SUN_TAN = Math.tan(SUN_EL);
const SHADOW_MARCH_M = [8, 20, 50, 120, 300]; // southward horizon-scan taps
// parent clump field (LAAS technique): hashed clump hearts on a coarse grid;
// plant density is weighted by proximity to a heart so vegetation gathers in
// patches with sparse gaps instead of uniform speckle
const CLUMP_CELL = 24;    // parent grid pitch, meters
let CLUMP_PROB = 0.6;     // fraction of parent cells that host a clump (guide-tunable)
const CLUMP_FLOOR = 0.15; // residual density in the gaps between clumps

// ── Measured guide params (LAAS_ASSETS.md workflow) ──────────────────────────
// guide_assets.py measures Google reference tiles and publishes
// /laas_guide.json; initVegetation fetches it and overrides these. The
// defaults reproduce the hand-tuned PoC behavior when no manifest exists.
const _guide = {
  shrubPerM2Lush: null,       // bush instances per m² of lush ground
  shrubDiamP25: null,         // measured instance diameter percentiles, meters
  shrubDiamP75: null,
  heathTint: { r: 1.0, g: 0.42, b: 0.06 }, // debug orange until measured
  lushTint: null,             // measured lush swatch pulls plant tint toward it
};
let _guideReady = false;      // builds wait for the fetch so runs are deterministic

function applyGuide(m) {
  const heath = m.classes?.heath?.palette?.[0]?.srgb;
  if (heath) _guide.heathTint = { r: heath[0], g: heath[1], b: heath[2] };
  const lush = m.classes?.lush?.palette?.[0]?.srgb;
  if (lush) _guide.lushTint = { r: lush[0], g: lush[1], b: lush[2] };
  const b = m.bushes;
  if (b?.density_per_100m2_of_lush_mean) _guide.shrubPerM2Lush = b.density_per_100m2_of_lush_mean / 100;
  if (b?.diameter_m_p25_mean && b?.diameter_m_p75_mean) {
    _guide.shrubDiamP25 = b.diameter_m_p25_mean;
    _guide.shrubDiamP75 = b.diameter_m_p75_mean;
  }
  // Clark-Evans R: 1 = random, 0 = fully clumped. Fewer, denser clumps as R
  // drops — mapped onto the parent-cell occupancy probability.
  if (b?.clark_evans_R_mean) {
    CLUMP_PROB = Math.min(0.9, Math.max(0.25, 1.15 - b.clark_evans_R_mean));
  }
  console.log('[VEG] guide manifest applied:', JSON.stringify({
    shrubPerM2Lush: _guide.shrubPerM2Lush,
    diam: [_guide.shrubDiamP25, _guide.shrubDiamP75],
    clumpProb: CLUMP_PROB,
    heathTint: _guide.heathTint, lushTint: _guide.lushTint,
  }));
}

// weight ≈1 at clump hearts, CLUMP-radius falloff, 0 in gaps. Keyed to
// absolute EPSG:3413 coords like everything else → stable. `memo` caches the
// per-parent-cell hash results for the duration of one tile build.
function clumpField(ax, ay, salt, memo) {
  const bx = Math.floor(ax / CLUMP_CELL), by = Math.floor(ay / CLUMP_CELL);
  let w = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = bx + dx, cy = by + dy;
      const key = cx * 100003 + cy;
      let p = memo.get(key);
      if (p === undefined) {
        const exists = pcg2d(cx, cy, salt ^ 0x9e3779)[0] < CLUMP_PROB;
        if (exists) {
          const [h1, h2] = pcg2d(cx, cy, salt);
          p = {
            px: (cx + 0.15 + h1 * 0.7) * CLUMP_CELL,
            py: (cy + 0.15 + h2 * 0.7) * CLUMP_CELL,
            r: CLUMP_CELL * (0.5 + 0.55 * h1),
          };
        } else p = null;
        memo.set(key, p);
      }
      if (!p) continue;
      const d = Math.hypot(ax - p.px, ay - p.py);
      const k = 1 - smoothstep(p.r * 0.22, p.r, d);
      if (k > w) w = k;
    }
  }
  return w;
}

let _vegGroup = null;
const _entries = new Map();   // tileId -> { group, texUuid, meshUuid }
let _lastSync = 0;
const _texDataCache = new Map(); // texture uuid -> ImageData (LRU-ish, capped)
const TEX_DATA_CACHE_MAX = 64;

// ---------------------------------------------------------------------------
// pcg2d integer hash — same construction as the LAAS scatter (Scatter.ts).
// Stable at any cell magnitude (sin-based hashes band at large coords).
// Returns two floats in [0,1). Exported for determinism tests.
// ---------------------------------------------------------------------------
export function pcg2d(cx, cy, salt) {
  const M = 1664525;
  let a = (cx + 40000 + (salt & 0x3fff)) >>> 0;
  let b = (cy + 40000 + ((salt >> 14) & 0x3fff)) >>> 0;
  a = (Math.imul(a, M) + 1013904223) >>> 0;
  b = (Math.imul(b, M) + 1013904223) >>> 0;
  a = (a + Math.imul(b, M)) >>> 0;
  b = (b + Math.imul(a, M)) >>> 0;
  a = (a ^ (a >>> 16)) >>> 0;
  b = (b ^ (b >>> 16)) >>> 0;
  a = (a + Math.imul(b, M)) >>> 0;
  b = (b + Math.imul(a, M)) >>> 0;
  a = (a ^ (a >>> 16)) >>> 0;
  b = (b ^ (b >>> 16)) >>> 0;
  return [(a & 0xffffff) / 16777216, (b & 0xffffff) / 16777216];
}

// ---------------------------------------------------------------------------
// Shared placeholder geometry — z-up (terrain local frame is x-east, y-north,
// z-up). Shading is baked into vertex colors because tiles use unlit
// MeshBasicMaterial and the scene has no general lighting rig.
// ---------------------------------------------------------------------------
let _protoGeos = null;
let _protoMat = null;

function buildProtoGeometries() {
  if (_protoGeos) return;
  // asset prototypes live in veg_assets.js (rock-first: boulder/slab/scree
  // plus the PoC plant stand-ins), all pre-baked with vertex-color shading
  _protoGeos = buildAssetProtos();
  _protoMat = new THREE.MeshBasicMaterial({ vertexColors: true });
}

// ---------------------------------------------------------------------------
// Satellite texture readback + classification
// ---------------------------------------------------------------------------
function getTexData(tex, metersPerTexel) {
  const cached = _texDataCache.get(tex.uuid);
  if (cached) return cached;
  const img = tex.image;
  if (!img || !img.width) return null;
  const cv = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(TEX_SAMPLE_RES, TEX_SAMPLE_RES)
    : Object.assign(document.createElement('canvas'), { width: TEX_SAMPLE_RES, height: TEX_SAMPLE_RES });
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, TEX_SAMPLE_RES, TEX_SAMPLE_RES);
  const data = ctx.getImageData(0, 0, TEX_SAMPLE_RES, TEX_SAMPLE_RES).data;
  const dilateTexels = Math.max(1, Math.ceil(_waterBufferM / metersPerTexel));
  const entry = { rgba: data, water: buildWaterMask(data, dilateTexels) };
  if (_texDataCache.size >= TEX_DATA_CACHE_MAX) {
    _texDataCache.delete(_texDataCache.keys().next().value);
  }
  _texDataCache.set(tex.uuid, entry);
  return entry;
}

// Inland water (reservoirs, lakes) sits above sea level so the elevation guard
// misses it, and greenish-teal water fools the excess-green test. Water's
// reliable signature in satellite imagery is SMOOTHNESS: near-zero local
// luminance variance, usually dark. Precompute a mask: dark-and-smooth or
// dark-and-blue → water, then dilate it into a no-mans-land buffer so nothing
// grows near a shoreline (mixed water/land edge pixels classify as neither).
const WATER_MAX_STD = 3.0;    // 3×3 luminance std-dev (0..255 scale)
const WATER_MAX_LUM = 130;    // water is dark; bright smooth areas are snow
function buildWaterMask(data, dilateTexels) {
  const R = TEX_SAMPLE_RES;
  const lum = new Float32Array(R * R);
  for (let i = 0; i < R * R; i++) {
    lum[i] = (data[i * 4] + 2 * data[i * 4 + 1] + data[i * 4 + 2]) / 4;
  }
  const raw = new Uint8Array(R * R);
  for (let y = 1; y < R - 1; y++) {
    for (let x = 1; x < R - 1; x++) {
      const i = y * R + x;
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      const dark = lum[i] < WATER_MAX_LUM;
      if (!dark) continue;
      if (b > r + 8 && b > g - 6) { raw[i] = 1; continue; } // dark + blue-ish
      // smoothness path requires b >= r: water is never red-over-blue, but
      // uniform green tundra is (vegetation absorbs blue) — without this,
      // downscale-smoothed green tiles mask entirely as water
      if (b < r - 4) continue;
      let sum = 0, sq = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const l = lum[i + dy * R + dx];
          sum += l; sq += l * l;
        }
      }
      const mean = sum / 9;
      const std = Math.sqrt(Math.max(0, sq / 9 - mean * mean));
      if (std < WATER_MAX_STD) raw[i] = 1;   // dark + featureless
    }
  }
  // dilate into a no-mans-land buffer (8-neighbor passes, clamped edges)
  let src = raw;
  let dst = new Uint8Array(R * R);
  for (let pass = 0; pass < dilateTexels; pass++) {
    for (let y = 0; y < R; y++) {
      const y0 = Math.max(0, y - 1) * R, y1 = y * R, y2 = Math.min(R - 1, y + 1) * R;
      for (let x = 0; x < R; x++) {
        const x0 = Math.max(0, x - 1), x2 = Math.min(R - 1, x + 1);
        dst[y1 + x] =
          src[y0 + x0] | src[y0 + x] | src[y0 + x2] |
          src[y1 + x0] | src[y1 + x] | src[y1 + x2] |
          src[y2 + x0] | src[y2 + x] | src[y2 + x2];
      }
    }
    [src, dst] = [dst, src];
  }
  return src;
}

// classify a satellite pixel → { veg, rock, r, g, b }
// veg: probability-ish weight for plant cover, rock: for loose stones
function classifyPixel(texData, u, v) {
  const px = Math.min(TEX_SAMPLE_RES - 1, Math.max(0, (u * TEX_SAMPLE_RES) | 0));
  const py = Math.min(TEX_SAMPLE_RES - 1, Math.max(0, (v * TEX_SAMPLE_RES) | 0));
  const pi = py * TEX_SAMPLE_RES + px;
  const data = texData.rgba;
  const i = pi * 4;
  const r = data[i], g = data[i + 1], b = data[i + 2];
  // inland water (reservoirs/lakes) — precomputed smoothness+darkness mask
  if (texData.water[pi]) return { veg: 0, rock: 0, r, g, b };
  const bright = (r + g + b) / 3;
  // snow/ice: bright and unsaturated → nothing grows, nothing scatters
  const maxC = Math.max(r, g, b), minC = Math.min(r, g, b);
  const sat = maxC - minC;
  if (bright > 190 && sat < 30) return { veg: 0, rock: 0, r, g, b };
  // open water: blue-dominant → nothing
  if (b > r + 12 && b > g + 6) return { veg: 0, rock: 0, r, g, b };
  // paleness: unsaturated and bright = grey/white bedrock. The paler the
  // ground, the less plausible ANY plant (even heath) and the more plausible
  // loose stone cover.
  const paleness = Math.max(0, 1 - sat / 34) * smoothstep(60, 160, bright);
  // excess green → tundra vegetation. NO baseline floor: grey rock has
  // excessGreen ≈ 0 and must get zero plants. Dead zone at 0.06: our
  // Dataforsyningen SPOT imagery carries a green-olive cast over bare rock
  // (measured ~0.03–0.07 excess-green on Nuuk headlands — cross-checked
  // against Google tiles of the same ground), which at lower dead zones
  // blanketed rock faces in heath. Genuine heath/tundra reads above ~0.08.
  // Coverage on the reference headland tiles: 0.015 → 47%, 0.045 → 33%,
  // 0.06 → 24% (target: sparse heath on rock, dense green in drainages).
  const excessGreen = (2 * g - r - b) / 255;
  const veg = Math.min(1, Math.max(0, (excessGreen - 0.06) * 4.2))
    * (1 - 0.85 * paleness);
  // lushness: how decisively green the pixel is — gates upright shrubs/cones,
  // which only belong on genuinely green ground (weak green = tussocks only)
  const lush = smoothstep(0.10, 0.26, excessGreen);
  // grey/low-sat ground → exposed rock / scree; paleness drives it directly
  const rock = Math.min(1, paleness * 1.1 + Math.max(0, 0.25 - veg) * 0.4);
  return { veg, lush, rock, r, g, b };
}

// ---------------------------------------------------------------------------
// Heightfield sampling from the tile mesh geometry (row-major res×res grid,
// x → column, y → row, z = elevation; same layout buildMesh() emits).
// ---------------------------------------------------------------------------
function makeHeightSampler(mesh) {
  const bbox = mesh.userData.bbox;
  const pos = mesh.geometry.getAttribute('position');
  const res = Math.round(Math.sqrt(pos.count));
  if (res * res !== pos.count) return null;
  const arr = pos.array;
  const [xMin, yMin, xMax, yMax] = bbox;
  const sx = (res - 1) / (xMax - xMin);
  const sy = (res - 1) / (yMax - yMin);
  return function sampleZ(lx, ly) {
    const fc = Math.min(res - 1.001, Math.max(0, (lx - xMin) * sx));
    const fr = Math.min(res - 1.001, Math.max(0, (ly - yMin) * sy));
    const c0 = fc | 0, r0 = fr | 0;
    const tc = fc - c0, tr = fr - r0;
    const i00 = (r0 * res + c0) * 3 + 2;
    const i01 = i00 + 3;
    const i10 = i00 + res * 3;
    const z0 = arr[i00] * (1 - tc) + arr[i01] * tc;
    const z1 = arr[i10] * (1 - tc) + arr[i10 + 3] * tc;
    return z0 * (1 - tr) + z1 * tr;
  };
}

// ---------------------------------------------------------------------------
// Per-tile scatter
// ---------------------------------------------------------------------------
function buildTileVegetation(mesh) {
  const bbox = mesh.userData.bbox;
  const tex = mesh.material.map;
  const texData = getTexData(tex, (bbox[2] - bbox[0]) / TEX_SAMPLE_RES);
  if (!texData) return null;
  const sampleZ = makeHeightSampler(mesh);
  if (!sampleZ) return null;
  buildProtoGeometries();

  const off = _getFrameOffset();
  const [xMin, yMin, xMax, yMax] = bbox;
  const invW = 1 / (xMax - xMin), invH = 1 / (yMax - yMin);
  // absolute EPSG:3413 extent of this tile (frame offset removed) — the cell
  // grid lives here so placements are session- and LOD-independent
  const axMin = xMin - off.x, axMax = xMax - off.x;
  const ayMin = yMin - off.y, ayMax = yMax - off.y;
  const cx0 = Math.floor(axMin / _cell), cx1 = Math.floor(axMax / _cell);
  const cy0 = Math.floor(ayMin / _cell), cy1 = Math.floor(ayMax / _cell);

  const plants = { mats: [], cols: [] };
  const stones = { mats: [], cols: [] };
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const slopeStep = Math.max(2, _cell);
  const clumpMemo = new Map(); // per-parent-cell cache for this tile build
  let hashAccum = 0; // determinism checksum for reload verification

  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const [jx, jy] = pcg2d(cx, cy, _seed);
      const ax = (cx + jx) * _cell, ay = (cy + jy) * _cell;
      if (ax < axMin || ax >= axMax || ay < ayMin || ay >= ayMax) continue;
      const lx = ax + off.x, ly = ay + off.y;
      const u = (lx - xMin) * invW, v = (ly - yMin) * invH;

      const cls = classifyPixel(texData, u, v);
      if (cls.veg <= 0.02 && cls.rock <= 0.02) continue;

      const z = sampleZ(lx, ly);
      if (z <= MIN_GROUND_Z) continue; // ocean / shoreline

      // slope from two extra height taps (rise per meter)
      const zx = sampleZ(lx + slopeStep, ly);
      const zy = sampleZ(lx, ly + slopeStep);
      const slope = Math.hypot(zx - z, zy - z) / slopeStep;
      const slopeFade = 1 - smoothstep(0.55, 1.0, slope);
      // Greenland vegetation thins out fast with altitude
      const elevFade = 1 - smoothstep(250, 700, z);
      // insolation — this is Greenland, sun decides everything. Two parts:
      // 1) incidence: surface normal · sun, sun due (grid-)south at an
      //    effective growing-season elevation. Normalized so flat ground = 1;
      //    south tilts score >1, north tilts fall toward 0.
      const gx = (zx - z) / slopeStep, gy = (zy - z) / slopeStep;
      const nInv = 1 / Math.hypot(gx, gy, 1);
      const insol = (nInv * (gy * SUN_COS + SUN_SIN)) / SUN_SIN;
      // 2) terrain shadow: march south, find the horizon; ground behind a
      //    valley wall taller than the sun angle sits in shade. (Height taps
      //    clamp at the tile edge, so shadows cast from beyond the tile are
      //    missed — acceptable for now.)
      let horizonTan = 0;
      for (const d of SHADOW_MARCH_M) {
        const t = (sampleZ(lx, ly - d) - z - 1.0) / d;
        if (t > horizonTan) horizonTan = t;
      }
      const shade = 1 - smoothstep(SUN_TAN * 0.7, SUN_TAN * 1.3, horizonTan);
      const sun = insol * shade;
      // density: zero on shaded/steep-north ground, mild bonus on sunny south
      const sunFade = smoothstep(0.22, 0.75, sun) * (1 + 0.4 * Math.min(Math.max(sun - 1, 0), 0.8));
      // clumping: patches with sparse gaps, not uniform speckle. The ×1.35
      // roughly compensates the field's mean so overall coverage holds.
      const clump = clumpField(ax, ay, _clumpSalt, clumpMemo);
      const clumpK = (CLUMP_FLOOR + (1 - CLUMP_FLOOR) * clump) * 1.35;
      // effective lushness: cones and the green/orange tint follow the sun
      // and gather at clump hearts (the canopy analog) — the greenest
      // vegetation lives on sunlit, gentle south faces, in patches
      const lushEff = cls.lush * smoothstep(0.45, 1.0, sun) * (0.4 + 0.6 * clump);

      const pPlant = cls.veg * slopeFade * elevFade * sunFade * clumpK * _densityScale;
      const pStone = cls.rock * (1 - smoothstep(0.9, 1.4, slope)) * 0.35 * _densityScale;
      const [gate, pick] = pcg2d(cx, cy, _seed ^ 0x1234f);
      hashAccum = (hashAccum + gate) % 1000;

      let target = null, geoKind = null;
      if (gate < pPlant) {
        target = plants;
        // upright shrub cones only on decisively green, sunlit ground. With a
        // guide manifest the share is calibrated so expected shrubs per cell
        // = measured density × cell area × lushness gate; without one, fall
        // back to the hand-tuned share so sparse green gets the odd one
        const shrubProb = _guide.shrubPerM2Lush !== null
          ? Math.min(0.9, _guide.shrubPerM2Lush * _cell * _cell * lushEff / Math.max(pPlant, 1e-6))
          : 0.35 * lushEff;
        geoKind = pick < shrubProb ? 'shrub' : 'tussock';
      } else if (gate - pPlant < pStone) {
        target = stones;
        // rock asset mix by terrain context: steep pale ground sheds talus
        // (scree patches), moderate rocky ground carries erratics (boulders)
        // and fractured plates (slabs), cobbles fill the rest
        const [rockPick] = pcg2d(cx, cy, _seed ^ 0x0c4e5);
        const steep = smoothstep(0.35, 0.9, slope);
        if (rockPick < 0.12 + 0.30 * steep) geoKind = 'scree';
        else if (rockPick < 0.45 + 0.30 * steep) geoKind = 'stone';
        else if (rockPick < 0.85) geoKind = 'boulder';
        else geoKind = 'slab';
      } else continue;
      if (target.mats.length >= (target === plants ? MAX_PLANTS_PER_TILE : MAX_STONES_PER_TILE)) continue;

      const [hScale, hYaw] = pcg2d(cx, cy, _seed ^ 0x3b8d);
      let scale;
      if (geoKind === 'stone') {
        scale = 0.3 + Math.pow(hScale, 2.2) * 1.6;
      } else if (geoKind === 'boulder') {
        // heavy-tailed: mostly sub-meter erratics, the odd multi-meter block
        scale = 0.35 + Math.pow(hScale, 2.6) * 2.4;
      } else if (geoKind === 'slab') {
        scale = 0.5 + Math.pow(hScale, 1.8) * 1.6;
      } else if (geoKind === 'scree') {
        scale = 0.7 + hScale * 1.1; // patch footprint, not clast size
      } else if (geoKind === 'shrub' && _guide.shrubDiamP25 !== null) {
        // measured diameter distribution: hScale sweeps p25..p75 with soft
        // tails, converted to proto footprint scale
        const d = _guide.shrubDiamP25
          + (_guide.shrubDiamP75 - _guide.shrubDiamP25) * (hScale * 1.3 - 0.15);
        scale = Math.max(0.3, d / PROTO_DIAM.shrub);
      } else {
        scale = 0.5 + Math.pow(hScale, 1.5) * 0.9;
      }
      q.setFromAxisAngle(zAxis, hYaw * TAU);
      m4.compose(
        new THREE.Vector3(lx, ly, z - 0.05 * scale),
        q,
        new THREE.Vector3(scale, scale, scale),
      );
      target.mats.push({ m: m4.clone(), kind: geoKind });

      // tint from the satellite pixel: plants pulled toward green and
      // darkened (they sit "in" the photo), stones stay the pixel's grey.
      // Low-lushness heath anchors to the heath tint (Google-measured swatch
      // once a guide manifest is published; debug orange until then); lush
      // valley-floor veg follows the pixel, pulled toward the measured lush
      // swatch when available.
      let cr = cls.r / 255, cg = cls.g / 255, cb = cls.b / 255;
      if (target === plants) {
        const lum = 0.25 + 0.75 * (0.3 * cr + 0.5 * cg + 0.2 * cb);
        const or = _guide.heathTint.r * lum, og = _guide.heathTint.g * lum, ob = _guide.heathTint.b * lum;
        let tr = cr * 0.55, tg = cg * 0.85, tb = cb * 0.5;
        if (_guide.lushTint) {
          tr = (tr + _guide.lushTint.r) * 0.5;
          tg = (tg + _guide.lushTint.g) * 0.5;
          tb = (tb + _guide.lushTint.b) * 0.5;
        }
        cr = or + (tr - or) * lushEff;
        cg = og + (tg - og) * lushEff;
        cb = ob + (tb - ob) * lushEff;
      } else {
        cr = cr * 0.8 + 0.08; cg = cg * 0.8 + 0.08; cb = cb * 0.8 + 0.08;
      }
      target.cols.push([cr, cg, cb]);
    }
  }

  const group = new THREE.Group();
  group.renderOrder = 2;
  for (const [layer, kinds] of [
    [plants, ['shrub', 'tussock']],
    [stones, ['stone', 'boulder', 'slab', 'scree']],
  ]) {
    for (const kind of kinds) {
      const idxs = layer.mats.map((e, i) => (e.kind === kind ? i : -1)).filter(i => i >= 0);
      if (!idxs.length) continue;
      const im = new THREE.InstancedMesh(_protoGeos[kind], _protoMat, idxs.length);
      for (let k = 0; k < idxs.length; k++) {
        im.setMatrixAt(k, layer.mats[idxs[k]].m);
        const c = layer.cols[idxs[k]];
        im.setColorAt(k, new THREE.Color(c[0], c[1], c[2]));
      }
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.frustumCulled = false; // tile-sized; culling handled by tile lifecycle
      group.add(im);
    }
  }
  const nPlants = plants.mats.length, nStones = stones.mats.length;
  console.log(
    `[VEG] ${mesh.userData.tileId}: ${nPlants} plants, ${nStones} stones, checksum=${hashAccum.toFixed(4)}`,
  );
  return nPlants + nStones > 0 ? group : null;
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function initVegetation({ terrainRoot, camera, params, getFrameOffset }) {
  _enabled = params.get('veg') === '1';
  if (!_enabled) return;
  _minDepth = parseInt(params.get('vegDepth') || '', 10) || 12;
  _cell = parseFloat(params.get('vegCell') || '') || 3.0;
  _seed = parseInt(params.get('vegSeed') || '', 10) || 1337;
  _densityScale = parseFloat(params.get('vegDensity') || '') || 1.0;
  _waterBufferM = parseFloat(params.get('vegWaterBuffer') || '') || 15;
  _clumpSalt = _seed ^ 0x51f3;
  _terrainRoot = terrainRoot;
  _camera = camera;
  _getFrameOffset = getFrameOffset;
  _vegGroup = new THREE.Group();
  _vegGroup.name = 'vegetation';
  terrainRoot.add(_vegGroup);
  // measured guide params (published by guide_assets.py) — builds hold until
  // this settles so every reload scatters with the same numbers
  fetch('/laas_guide.json')
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null)
    .then(m => {
      if (m) applyGuide(m);
      else console.log('[VEG] no guide manifest — using hand-tuned PoC defaults');
    })
    .finally(() => { _guideReady = true; });
  console.log(`[VEG] enabled — depth>=${_minDepth} cell=${_cell}m seed=${_seed} density=${_densityScale}`);
}

function disposeEntry(tileId, entry) {
  _vegGroup.remove(entry.group);
  for (const child of entry.group.children) {
    if (child.isInstancedMesh) child.dispose(); // instance buffers only; geo/mat shared
  }
  _entries.delete(tileId);
}

const _camLocal = new THREE.Vector3();

export function updateVegetation(mapMode) {
  if (!_enabled || !_guideReady) return;
  _vegGroup.visible = !mapMode;
  const now = performance.now();
  if (now - _lastSync < SYNC_INTERVAL_MS) return;
  _lastSync = now;

  // current textured deep tiles
  const live = new Map(); // tileId -> mesh
  for (const child of _terrainRoot.children) {
    const tid = child.userData?.tileId;
    if (!tid || !child.isMesh) continue;
    const depth = parseInt(tid.split('-')[0], 10);
    if (!(depth >= _minDepth)) continue;
    const map = child.material?.map;
    if (!map || !map.image || !child.userData.bbox) continue;
    live.set(tid, child);
  }

  // drop veg for tiles that are gone or whose mesh/texture changed
  for (const [tid, entry] of _entries) {
    const mesh = live.get(tid);
    if (!mesh || mesh.uuid !== entry.meshUuid || mesh.material.map.uuid !== entry.texUuid) {
      disposeEntry(tid, entry);
    }
  }

  // build missing veg, nearest tiles first, budgeted per sync
  _camLocal.copy(_camera.position);
  _terrainRoot.worldToLocal(_camLocal);
  const pending = [];
  for (const [tid, mesh] of live) {
    if (_entries.has(tid)) continue;
    const b = mesh.userData.bbox;
    const dx = (b[0] + b[2]) / 2 - _camLocal.x;
    const dy = (b[1] + b[3]) / 2 - _camLocal.y;
    pending.push({ tid, mesh, d2: dx * dx + dy * dy });
  }
  pending.sort((a, b) => a.d2 - b.d2);
  for (let i = 0; i < Math.min(BUILDS_PER_SYNC, pending.length); i++) {
    const { tid, mesh } = pending[i];
    const t0 = performance.now();
    const group = buildTileVegetation(mesh);
    const entry = {
      group: group || new THREE.Group(), // empty marker so we don't rebuild every sync
      texUuid: mesh.material.map.uuid,
      meshUuid: mesh.uuid,
    };
    if (group) _vegGroup.add(group);
    _entries.set(tid, entry);
    const dt = performance.now() - t0;
    if (dt > 24) console.log(`[VEG] ${tid}: build took ${dt.toFixed(1)}ms`);
  }
}
