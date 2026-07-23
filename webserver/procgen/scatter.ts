/**
 * scatter — per-tile deterministic placement of library assets on terrain.
 *
 * First-pass chain validation: density is gated by DEM facts only (elevation,
 * slope and southness from the tile heightmap), with cover sampled directly
 * from the full-resolution classifier fields. Placement is seeded from the tile id, so a
 * revisit rebuilds the identical scatter.
 *
 * Frame: tile meshes are flat grids in EPSG:3413 stereo meters, z-up.
 * Library assets are built y-up, so every instance matrix bakes in an X+90°
 * rotation. The scatter Group is added as a CHILD of the tile mesh (identity
 * transform), so tile eviction carries the scatter away with it.
 *
 * HARD RULE (project): nothing living on north slopes — the aspect gate
 * beats everything else for `living` kinds (VEG_MIN_SOUTHNESS).
 */

import {
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
  type Object3D,
} from 'three';
import { hashString, Rng } from './Seed';
import type { AssetKind, AssetLibrary } from './library';

/** tiles shallower than this get no scatter (assets would be subpixel) */
export const SCATTER_MIN_DEPTH = 12;

/** north-slope veto for living kinds; southness in [-1, 1] */
const VEG_MIN_SOUTHNESS = -0.05;

interface CategorySpec {
  /** kind-id prefix in the library (`tree/`, `rock/boulder/`, ...) */
  prefix: string;
  /** instances per m² */
  density: number;
  /** per-tile cap across the category */
  cap: number;
  /** gradient magnitude ceiling */
  maxSlope: number;
  /** minimum elevation (m) — keeps assets off the ocean surface */
  minElev: number;
  /** weight boost on steeper ground (talus wants slopes) */
  slopeBias?: number;
}

// tuned for d12 tiles (~660 m, ~434k m²): budget ≈ 700 instances /
// ~700k tris per tile — the demo's per-tile-equivalent scatter budget once
// its GPU ring culling is factored out
// GREENLAND is TREELESS — no tree/, log/, stump/ (those are Estonia forest).
// Understory dwarf shrubs (dwarf birch / crowberry / niviarsiaq), grass, and
// rock only. Vegetation cover + water exclusion come from the classifier fields.
// DENSE tundra (near-field only, camera-following — so we can afford it). Densities
// are per-m²; a d12 tile is ~435k m². Understory should read as a carpet of dwarf
// shrubs, not scattered dots. (The even-denser blade-grass carpet is GroundRing — Tier 2.)
// ALL rock/* categories are REMOVED (2026-07-22, user directive): every
// attempt to gate rock placement on the classifier's "light ground" signal
// has been disputed live (rocks on dark streaks, rocks missing from bright
// ridges, rocks blanketing indiscriminately) faster than it could be
// verified against real screenshots. Rocks stay off until the light/rock
// classification channel is proven correct against real placed-instance
// coordinates vs. the actual served texture, not just code review — see
// the classification-pipeline fix in serve_flask.py (classify from the
// same pre-bake image instead of a separately-resampled parent) for the
// most recent attempt at the underlying cause.
// grass cap: patches are ~2.3k tris each and per-instance culling does not
// exist (visibility is per-InstancedMesh) — the old cap of 18000 was a
// ~40M-tri bomb that never detonated only because the veg gate starved
// grass to nothing. 1200 tinted patches ≈ 2.8M tris worst case, and the
// greenness²-weighted acceptance concentrates them into the green blobs.
const CATEGORIES: CategorySpec[] = [
  { prefix: 'shrub/', density: 1 / 12, cap: 12000, maxSlope: 0.9, minElev: 2 },
  { prefix: 'flower/', density: 1 / 60, cap: 3000, maxSlope: 0.7, minElev: 2 },
  { prefix: 'grass/', density: 1 / 24, cap: 1200, maxSlope: 0.7, minElev: 2 },
];

export interface TileScatterInput {
  tileId: string;
  bbox: [number, number, number, number];
  /** decoded heightmap, row-major, row 0 = south (y = bbox yMin) */
  hm: Float32Array | number[];
  res: number;
  lib: AssetLibrary;
  /** vertical exaggeration applied by buildMesh (EXAG) */
  exag?: number;
  /** classifier field set, decoded. Each channel is a
   *  res×res u8 grid, NORTH-UP (row 0 = yMax). When present it drives WHERE:
   *  water/beach/snow hard-exclude and cover follows veg/dark pixels. */
  fields?: TileFields;
  /** the tile's own satellite texture, decoded to pixels (NORTH-UP).
   *  Grass density follows its measured greenness (continuous — no
   *  classifier threshold cliff) and grass gets tinted with the sampled
   *  ground color, so cover reads as blobs of the imagery's own color. */
  tex?: { res: number; rgba: Uint8ClampedArray | Uint8Array };
}

export interface TileFields {
  res: number;
  chans: Partial<Record<'veg' | 'rock' | 'snow' | 'water' | 'moisture' | 'dark' | 'shore', Uint8Array>>;
}

/** smooth 0..1 taper, like GLSL smoothstep — used in place of hard
 *  boolean cutoffs so deterministic gates read as a natural thinning
 *  edge instead of a visible contour line. */
function smoothTaper(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** sample a classifier field (0..1) at a world xz. Fields are NORTH-UP
 *  (row 0 = yMax) — opposite the heightmap's row 0 = south. */
function makeFieldSampler(input: TileScatterInput): ((chan: string, x: number, y: number) => number) | null {
  const f = input.fields;
  if (!f) return null;
  const [xMin, yMin, xMax, yMax] = input.bbox;
  const res = f.res;
  return (chan: string, x: number, y: number): number => {
    const arr = (f.chans as Record<string, Uint8Array | undefined>)[chan];
    if (!arr) return 0;
    const c = Math.max(0, Math.min(res - 1, Math.round(((x - xMin) / (xMax - xMin)) * (res - 1))));
    const r = Math.max(0, Math.min(res - 1, Math.round(((yMax - y) / (yMax - yMin)) * (res - 1))));
    return (arr[r * res + c] ?? 0) / 255;
  };
}

/** sample the tile texture at a world xy → [r,g,b] in 0..1 (NORTH-UP). */
function makeTexSampler(input: TileScatterInput): ((x: number, y: number, out: number[]) => void) | null {
  const t = input.tex;
  if (!t || !t.res || !t.rgba?.length) return null;
  const [xMin, yMin, xMax, yMax] = input.bbox;
  const res = t.res;
  return (x: number, y: number, out: number[]): void => {
    const c = Math.max(0, Math.min(res - 1, Math.floor(((x - xMin) / (xMax - xMin)) * res)));
    const r = Math.max(0, Math.min(res - 1, Math.floor(((yMax - y) / (yMax - yMin)) * res)));
    const o = (r * res + c) * 4;
    out[0] = (t.rgba[o] as number) / 255;
    out[1] = (t.rgba[o + 1] as number) / 255;
    out[2] = (t.rgba[o + 2] as number) / 255;
  };
}

interface Sample {
  z: number;
  slope: number;
  southness: number;
  /** raw height gradient (for terrain-normal alignment of flat patches) */
  gx: number;
  gy: number;
}

function makeSampler(input: TileScatterInput): (x: number, y: number) => Sample {
  const [xMin, yMin, xMax, yMax] = input.bbox;
  const { hm, res } = input;
  const dx = (xMax - xMin) / (res - 1);
  const dy = (yMax - yMin) / (res - 1);
  return (x: number, y: number): Sample => {
    const fc = ((x - xMin) / (xMax - xMin)) * (res - 1);
    const fr = ((y - yMin) / (yMax - yMin)) * (res - 1);
    const c0 = Math.max(0, Math.min(res - 2, Math.floor(fc)));
    const r0 = Math.max(0, Math.min(res - 2, Math.floor(fr)));
    const tc = Math.max(0, Math.min(1, fc - c0));
    const tr = Math.max(0, Math.min(1, fr - r0));
    const i00 = r0 * res + c0;
    const h00 = hm[i00] as number;
    const h10 = hm[i00 + 1] as number;
    const h01 = hm[i00 + res] as number;
    const h11 = hm[i00 + res + 1] as number;
    const z = h00 * (1 - tc) * (1 - tr) + h10 * tc * (1 - tr)
      + h01 * (1 - tc) * tr + h11 * tc * tr;
    const gx = ((h10 - h00) * (1 - tr) + (h11 - h01) * tr) / dx;
    const gy = ((h01 - h00) * (1 - tc) + (h11 - h10) * tc) / dy;
    const slope = Math.hypot(gx, gy);
    // surface faces the -gradient direction; grid -y is "south" (canonical
    // grid orientation, no convergence correction — same convention as the
    // backend southness channel)
    const southness = slope > 1e-6 ? gy / slope : 0;
    return { z, slope, southness, gx, gy };
  };
}

const _m = new Matrix4();
const _q = new Quaternion();
const _qYaw = new Quaternion();
const _qTilt = new Quaternion();
const _normal = new Vector3();
const _p = new Vector3();
const _s = new Vector3();
const _zAxis = new Vector3(0, 0, 1);
const _c = new Color();
const _texColor: number[] = [0, 0, 0];
// y-up asset → z-up world
const _qXup = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);

/**
 * Build the scatter group for one tile, or null if the tile is too shallow
 * or nothing passed the gates. Deterministic per tile id.
 */
export function buildTileScatter(input: TileScatterInput): Group | null {
  const depth = Number.parseInt(input.tileId.split('-')[0] ?? '', 10);
  if (!Number.isFinite(depth) || depth < SCATTER_MIN_DEPTH) return null;

  const [xMin, yMin, xMax, yMax] = input.bbox;
  const area = (xMax - xMin) * (yMax - yMin);
  const exag = input.exag ?? 1;
  const sample = makeSampler(input);
  const fsample = makeFieldSampler(input);
  const tsample = makeTexSampler(input);
  const rng = new Rng(hashString(`scatter/${input.tileId}`));

  // kinds per category prefix
  const byCat = new Map<string, AssetKind[]>();
  for (const kind of input.lib.kinds.values()) {
    for (const cat of CATEGORIES) {
      if (kind.id.startsWith(cat.prefix)) {
        let arr = byCat.get(cat.prefix);
        if (!arr) byCat.set(cat.prefix, arr = []);
        arr.push(kind);
      }
    }
  }

  const placements = new Map<AssetKind, { mats: Matrix4[]; colors: number[] }>();
  let total = 0;

  for (const cat of CATEGORIES) {
    const kinds = byCat.get(cat.prefix);
    if (!kinds || kinds.length === 0) continue;
    const target = Math.min(cat.cap, Math.round(area * cat.density));
    if (target <= 0) continue;
    const attempts = target * 2;
    let placed = 0;
    for (let i = 0; i < attempts && placed < target; i++) {
      const x = xMin + rng.float() * (xMax - xMin);
      const y = yMin + rng.float() * (yMax - yMin);
      const s = sample(x, y);
      if (s.z <= cat.minElev) continue;
      // Deterministic terrain means every gate below stays a pure function
      // of (cell, seed) — but that doesn't require a hard boolean cutoff.
      // A step (slope > X) draws a visible contour line where the world
      // snaps from covered to bald; a smooth taper fed into the same rng
      // draw reproduces identically every run while reading as a natural
      // thinning edge. STEEP SLOPES CARRY NOTHING RIGHT NOW (blanket
      // ~24-32 deg taper) — the per-category maxSlope values above are
      // kept as future tuning targets, not applied until re-enabled.
      const slopeSurvival = 1 - smoothTaper(0.45, 0.62, s.slope);
      if (rng.float() > slopeSurvival) continue;
      if (cat.slopeBias && rng.float() > (s.slope / cat.maxSlope) * cat.slopeBias) continue;
      // CLASSIFIER water gate: the satellite knows where lakes/fjords are — the
      // DEM elevation floor misses them (a lake at 50 m passes minElev). Nothing
      // scatters on water. This is the fix for "trees/plants in the water".
      if (fsample && (
        fsample('water', x, y) > 0.45
        || fsample('shore', x, y) > 0.45
        || fsample('snow', x, y) > 0.45
      )) continue;
      const kind = kinds[rng.int(kinds.length)] as AssetKind;
      // HARD RULE: nothing living on north slopes, ever
      if (kind.living && s.southness < VEG_MIN_SOUTHNESS && s.slope > 0.08) continue;
      // CLASSIFIER cover keys off the ACTUAL imagery reading, not a single
      // gate two different classes had to both pass. GREEN (veg) and DARK
      // are separate classifier labels — DARK is a plain luminance read
      // (dark brown soil, moss, peat, shadow), never promoted to GREEN.
      // Gating every living kind behind the GREEN-only veg channel meant
      // dark brown ground could never spawn a bush no matter how strongly
      // it read as dark, because it isn't green — the bug that left dark
      // patches completely bare in-game. Shrubs now qualify on EITHER
      // signal: green-vegetated OR dark ground both count as "something
      // grows here", matching what the texture actually shows. Grass
      // stays green-only (fine blades don't read on bare dark dirt) and is
      // suppressed under strongly dark ground so shrubs own it there.
      //
      // Strongly-classified ground is a GUARANTEE, not a weighted coin
      // flip: a probability that merely biases toward bushes on dark
      // ground still frequently skips them on any single attempt, which
      // reads as "ignoring terrain color" even though the math is
      // correctly weighted. Past a confidence threshold the gate is
      // skipped outright — clearly dark ground gets its bush, clearly
      // light ground gets its rock, full stop; the probability only
      // still applies in the ambiguous middle.
      // rock/* categories (and their light/dark gating logic) are removed
      // above — every kind reaching this point is living (shrub/flower/
      // grass), so there is no non-living branch to gate here anymore.
      let tint: number[] | null = null;
      if (cat.prefix === 'grass/' && tsample) {
        // TEXTURE path for grass: density follows the imagery's measured
        // greenness (continuous — no classifier threshold cliff, which is
        // what starved the pale-green Malene slopes), squared so patches
        // cluster into the greenest blobs; each patch is tinted with the
        // sampled ground color so cover reads as the imagery's own color.
        tsample(x, y, _texColor);
        const excess = _texColor[1]! - 0.5 * (_texColor[0]! + _texColor[2]!);
        const greenness = Math.max(0, Math.min(1, excess * 14 + 0.2));
        if (rng.float() > greenness * greenness) continue;
        tint = [_texColor[0]!, _texColor[1]!, _texColor[2]!];
      } else if (fsample) {
        // Full-resolution classifier path preserves curved cover boundaries.
        const dark = fsample('dark', x, y);
        const veg = fsample('veg', x, y);
        if (cat.prefix === 'shrub/') {
          const cover = Math.max(veg, dark);
          if (cover < 0.55 && rng.float() > cover * 1.6) continue;
        } else {
          // grass/flower: green-only, and suppressed on strongly dark
          // ground (shrubs, not fine grass, own dark soil).
          if (rng.float() > veg * 1.6) continue;
          if (dark > 0.45 && rng.float() > (1 - dark) * 1.1 + 0.15) continue;
        }
      }
      const scale = kind.scale[0] + rng.float() * (kind.scale[1] - kind.scale[0]);
      _qYaw.setFromAxisAngle(_zAxis, rng.float() * Math.PI * 2);
      _q.copy(_qYaw).multiply(_qXup);
      if (cat.prefix === 'grass/') {
        // Flat patches must lie ON the slope: un-tilted 3 m planes sliced
        // through curved ground and read as straight blade rows. Shrubs
        // stay gravity-upright like real woody stems.
        _normal.set(-s.gx, -s.gy, 1).normalize();
        _qTilt.setFromUnitVectors(_zAxis, _normal);
        _q.copy(_qTilt).multiply(_qYaw).multiply(_qXup);
      }
      // sink slightly so bases don't hover on slopes
      _p.set(x, y, (s.z - 0.12 * scale * (1 + s.slope)) * exag);
      _s.set(scale, scale, scale);
      _m.compose(_p, _q, _s);
      let entry = placements.get(kind);
      if (!entry) placements.set(kind, entry = { mats: [], colors: [] });
      entry.mats.push(_m.clone());
      if (tint) entry.colors.push(tint[0]!, tint[1]!, tint[2]!);
      placed++;
      total++;
    }
  }

  if (total === 0) return null;

  const group = new Group();
  group.name = `scatter/${input.tileId}`;
  group.userData.isScatter = true;
  for (const [kind, { mats, colors }] of placements) {
    for (const part of kind.parts) {
      const mesh = new InstancedMesh(part.geo, part.mat, mats.length);
      for (let i = 0; i < mats.length; i++) mesh.setMatrixAt(i, mats[i] as Matrix4);
      if (colors.length === mats.length * 3) {
        for (let i = 0; i < mats.length; i++) {
          mesh.setColorAt(i, _c.setRGB(
            colors[i * 3] as number,
            colors[i * 3 + 1] as number,
            colors[i * 3 + 2] as number,
          ));
        }
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
      mesh.instanceMatrix.needsUpdate = true;
      // instance-aware bounds (three r160+) so frustum culling works per mesh
      mesh.computeBoundingSphere();
      mesh.frustumCulled = true;
      // never intercept terrain picking / vehicle raycasts
      mesh.raycast = () => {};
      mesh.userData.assetKind = kind.id;
      mesh.userData.maxDist = kind.maxDist;
      group.add(mesh);
    }
  }
  return group;
}

const _cullWp = new Vector3();
const _cullCp = new Vector3();

/**
 * Per-frame max-distance visibility (the CPU stand-in for the demo's GPU
 * ring cull): hide each scatter InstancedMesh once the camera is beyond its
 * kind's maxDist. ~a few hundred vector ops per frame.
 */
export function updateScatterVisibility(terrainRoot: Object3D, camera: Object3D): void {
  camera.getWorldPosition(_cullCp);
  for (const tile of terrainRoot.children) {
    for (const g of tile.children) {
      if (!g.userData?.isScatter) continue;
      for (const m of g.children) {
        const im = m as InstancedMesh;
        const s = im.boundingSphere;
        if (!s) continue;
        _cullWp.copy(s.center).applyMatrix4(im.matrixWorld);
        const d = _cullWp.distanceTo(_cullCp) - s.radius;
        im.visible = d < ((im.userData.maxDist as number) ?? Infinity);
      }
    }
  }
}
