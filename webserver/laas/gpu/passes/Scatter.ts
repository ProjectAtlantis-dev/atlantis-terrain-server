/**
 * Scatter — GPU vegetation/rock placement (spec §3.5), boot-time.
 *
 * Clustered Poisson, fully parallel: a jittered child grid (one thread per
 * candidate cell) is gated by per-class density functions (biome, slope,
 * altitude/treeline, moisture, snow, rock exposure, water) × a parent clump
 * field (hashed parent points per coarse cell → light-competition clumping;
 * the SAME parent field feeds the understory pass as a canopy proxy: ferns
 * gather under tree clumps, flowers in gaps, pink shrubs at clump edges).
 * Ecotones: the biome id is read through a low-frequency warp so boundaries
 * interdigitate instead of tracing classification isolines.
 *
 * Accepted instances are atomically appended into storage buffers — instance
 * data never touches the CPU (only the final counts are read back once for
 * HUD/draw bookkeeping). Deterministic: all randomness is pcg2d(cell, salt),
 * an integer hash — sin-based hashes band at 4-digit cell coordinates.
 *
 * Instance layout (two vec4 buffers):
 *   A = (x, y, z, scale)
 *   B = (yaw, leanX, leanZ, idF)   idF = class·8 + variant  (exact in f32)
 */

import type { Renderer } from 'three/webgpu';
import { StorageTexture, type StorageBufferNode } from 'three/webgpu';
import {
  Fn,
  If,
  Return,
  atomicAdd,
  atomicLoad,
  float,
  instanceIndex,
  instancedArray,
  int,
  smoothstep,
  texture,
  textureStore,
  uint,
  uvec2,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { WorldSeed } from '../../core/Seed';
import type { Heightfield } from '../../world/Heightfield';
import { LAKE_LEVEL, TREELINE, WORLD_SIZE } from '../../world/WorldConst';
import { fbm3 } from '../noise/NoiseTSL';
import { GREENLAND_FLORA, type FloraSpecies } from '../../vegetation/GreenlandFlora';
import type { NF, NI, NU, NV2, NV4 } from '../TSLTypes';

/** geometry-pool class ids (variant index lives in the low 3 bits of idF) */
export const enum VegClass {
  // trees — order matches TREE_SPECIES
  Spruce = 0,
  Pine = 1,
  Beech = 2,
  Birch = 3,
  KarstGnarl = 4,
  Snag = 5,
  // understory
  BushHazel = 8,
  BushPink = 9,
  Juniper = 10,
  Fern = 11,
  FlowerUmbel = 12,
  FlowerBell = 13,
  FlowerDaisy = 14,
  FlowerCotton = 15, // GREENLAND cottongrass — white seedhead tufts (mire/fen)
  // ground extras
  Log = 16,
  Stump = 17,
  Boulder = 18,
  Slab = 19,
  // size-stratified ground solids (the "no bare ground" layer): each class
  // draws to the range where it still covers >~2 px — constant screen-space
  // granularity, the aggregate equivalent of nanite cluster selection
  StoneL = 20, // 0.6–2.2 m → 900 m
  StoneM = 21, // 0.2–0.6 m → 280 m
  StoneS = 22, // 6–20 cm → 90 m
  Branch = 23, // fallen branches on forest floors → 230 m
  // extended Greenland understory (24–31 reserved by Forests group layout)
  CushionCampion = 24,
  MountainAvens = 25,
  ArcticWillow = 26,
  LabradorTea = 27,
  PurpleSaxifrage = 28,
  Roseroot = 29,
  Horsetail = 30,
  Cloudberry = 31,
}

/** structural variants baked per tree species (geometry reuse, D5) */
export const TREE_VARIANTS = 4;

export interface ScatterLayer {
  bufA: StorageBufferNode<'vec4'>;
  bufB: StorageBufferNode<'vec4'>;
  cap: number;
  /** accepted instances (clamped to cap) — read back once at boot */
  count: number;
}

export interface ScatterResult {
  trees: ScatterLayer;
  understory: ScatterLayer;
  extras: ScatterLayer;
  /** stones (3 size classes) + fallen branches — ground-solid coverage */
  stones: ScatterLayer;
}

// child-grid cell sizes (m) — jitter spans the full cell, so no grid reads
const TREE_CELL = 3.4;
const UNDER_CELL = 2.4;
const EXTRA_CELL = 5.5;
const STONE_CELL = 2.1;
const TREE_CAP = 600_000;
const UNDER_CAP = 700_000;
const EXTRA_CAP = 180_000;
const STONE_CAP = 1_500_000;

// parent clump field (shared by trees + understory — canopy correlation)
const PARENT_CELL = 26;
const PARENT_PROB = 0.62;

const TAU = 6.2831853;

// ---------------------------------------------------------------------------
// integer hash: pcg2d over (cell + salt) — stable at any cell magnitude
// ---------------------------------------------------------------------------

function pcg2d(p: NV2, salt: number): NV2 {
  // PURE expression chain — no toVar/assign, so it works in material node
  // graphs too (assign needs a Fn() stack). +40000 keeps negative ring cell
  // coords positive before the uint cast (world cells span ±~10k).
  const M = uint(1664525);
  const C = uint(1013904223);
  const a0 = p.x.add(40000 + (salt & 0x3fff)).toUint();
  const b0 = p.y.add(40000 + ((salt >> 14) & 0x3fff)).toUint();
  const a1 = a0.mul(M).add(C);
  const b1 = b0.mul(M).add(C);
  const a2 = a1.add(b1.mul(M));
  const b2 = b1.add(a2.mul(M));
  const a3 = a2.bitXor(a2.shiftRight(uint(16)));
  const b3 = b2.bitXor(b2.shiftRight(uint(16)));
  const a4 = a3.add(b3.mul(M));
  const b4 = b3.add(a4.mul(M));
  const a5 = a4.bitXor(a4.shiftRight(uint(16)));
  const b5 = b4.bitXor(b4.shiftRight(uint(16)));
  const inv = 1 / 16777216;
  return vec2(
    float(a5.bitAnd(uint(0xffffff))).mul(inv),
    float(b5.bitAnd(uint(0xffffff))).mul(inv),
  );
}

export function cellHash2(cell: NV2, salt: number): NV2 {
  return pcg2d(cell, salt);
}

export function cellHash(cell: NV2, salt: number): NF {
  return pcg2d(cell, salt).x;
}

// ---------------------------------------------------------------------------

/** per-biome value tables → TSL select chain (biome ids 0..5) */
function byBiome(bioId: NI, vals: readonly number[]): NF {
  let e: NF = float(vals[5] ?? 0);
  for (let b = 4; b >= 0; b--) {
    e = bioId.equal(int(b)).select(float(vals[b] ?? 0), e) as NF;
  }
  return e;
}

/**
 * Parent clump field: hashed parent points on a coarse grid; weight = max
 * kernel over the 3×3 neighborhood. ~1 at clump hearts, 0 in gaps.
 */
function clumpField(wpos: NV2, salt: number): NF {
  const base = wpos.div(PARENT_CELL).floor();
  const w = float(0).toVar();
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const c = base.add(vec2(dx, dy)).add(8192); // parents span negatives
      const h2 = cellHash2(c, salt);
      const exists = cellHash(c, salt ^ 0x9e3779).lessThan(PARENT_PROB);
      const ppos = c.sub(8192).add(0.15).add(h2.mul(0.7)).mul(PARENT_CELL);
      const r = float(PARENT_CELL).mul(h2.x.mul(0.55).add(0.5));
      const d = wpos.sub(ppos).length();
      const k = float(1)
        .sub(smoothstep(r.mul(0.22), r, d))
        .mul(exists.select(float(1), float(0)));
      w.assign(w.max(k));
    }
  }
  return w;
}

interface SiteSamples {
  h: NF;
  slope: NF;
  bioId: NI; // ecotone-warped biome id
  snow: NF;
  vegDens: NF;
  rockExp: NF;
  moisture: NF;
  riverDepth: NF;
  flow: NF; // flow accumulation / stream power — erosion channels & gully floors
  standing: NF; // W − h (standing-water depth)
  nrmXZ: NV2;
}

function sampleSite(hf: Heightfield, wpos: NV2): SiteSamples {
  const uv = wpos.div(hf.worldSize).add(0.5);
  const h = hf.sampleHeight(wpos);
  const ns = texture(hf.normalTex, uv, 0) as unknown as NV4;
  // ecotone warp: read the biome classification through a ±26 m wobble
  const warp = vec2(
    fbm3(vec3(wpos.x.mul(0.011), 3.7, wpos.y.mul(0.011)), 2),
    fbm3(vec3(wpos.x.mul(0.011), 91.2, wpos.y.mul(0.011)), 2),
  ).mul(26);
  const uvW = wpos.add(warp).div(hf.worldSize).add(0.5);
  const bio = texture(
    hf.biomeTex as NonNullable<typeof hf.biomeTex>,
    uvW,
    0,
  ) as unknown as NV4;
  const bioExact = texture(
    hf.biomeTex as NonNullable<typeof hf.biomeTex>,
    uv,
    0,
  ) as unknown as NV4;
  const fields = texture(
    hf.fieldsTex as NonNullable<typeof hf.fieldsTex>,
    uv,
    0,
  ) as unknown as NV4;
  return {
    h,
    slope: ns.w,
    bioId: bio.x.mul(8).add(0.5).floor().toInt(),
    snow: bioExact.y, // snow/veg-density/rock read unwarped (physical fields)
    vegDens: bioExact.z,
    rockExp: bioExact.w,
    moisture: fields.x,
    riverDepth: fields.z,
    flow: fields.y,
    standing: fields.w.sub(h),
    nrmXZ: vec2(ns.x, ns.z),
  };
}

// ---------------------------------------------------------------------------
// Understory composition — data-driven from the GreenlandFlora roster.
// COVER (how many plants) is decided by the biome-density accept gate in the
// understory kernel; these helpers only choose WHICH species fills an already-
// accepted site, so a niche mismatch changes the mix but can never subtract
// from total vegetation. (This replaces the earlier multiplicative-suitability
// experiment, whose `productivity` term multiplied into the accept gate and
// crushed cover from ~425k to ~118k.)
// ---------------------------------------------------------------------------

/** bell-shaped niche response in [0,1]: 1 at the optimum, 0 past either edge. */
function niche(x: NF, lo: number, opt: number, hi: number): NF {
  return smoothstep(lo, opt, x).mul(smoothstep(hi, opt, x));
}

/** species colony field: soft multi-octave patches at the plant's clone scale
 * with a sparse-founder floor, so cushions / mats / scrub cluster into colonies
 * instead of independent white-noise speckle. */
function colonyField(
  wpos: NV2,
  colonyM: number,
  salt: number,
  floor: number,
): NF {
  const n = fbm3(vec3(wpos.x.div(colonyM), salt, wpos.y.div(colonyM)), 3)
    .mul(0.5)
    .add(0.5);
  // low floor → bare gaps between dense patches (drifts); high floor → smooth
  // broad cover. Caller sets floor from abundance so rare flowers drift.
  return smoothstep(0.4, 0.7, n).mul(1 - floor).add(floor);
}

/** Composition weight for one roster species at this site: per-zone abundance
 * scaled by bounded (~0..1) field responses (moisture / rock / flow / snow /
 * slope) and the species colony field. Weak niches lose the weighted draw but
 * never reduce cover — that gate is separate. */
function speciesWeight(
  s: SiteSamples,
  wpos: NV2,
  sp: FloraSpecies,
  salt: number,
): NF {
  // abundance = research base rate ÷6000 (data-driven prominence, not hardcoded)
  const base = byBiome(s.bioId, sp.biome).mul(sp.abundance);
  const moist = niche(s.moisture, sp.moisture[0], sp.moisture[1], sp.moisture[2]);
  // accumulated stream power + channel depth → streamside vs dry-divide response
  const flowInf = s.flow.mul(0.75).add(s.riverDepth.mul(1.5)).clamp(0, 1);
  const rockMod = float(1)
    .add(s.rockExp.sub(0.4).mul(sp.rockAffinity * 2))
    .clamp(0.15, 1.8);
  const flowMod = float(1)
    .add(flowInf.sub(0.25).mul(sp.flowAffinity * 2.4))
    .clamp(0.15, 2.2);
  const snowMod = smoothstep(sp.snowTol, sp.snowTol * 0.4, s.snow);
  const slopeMod = smoothstep(sp.maxSlope, sp.maxSlope * 0.6, s.slope);
  // rare showy species (low abundance) drift into dense patches with bare gaps;
  // abundant matrix shrubs spread as smooth broad cover.
  const floor = Math.min(0.1 + 0.28 * sp.abundance, 0.42);
  return base
    .mul(moist)
    .mul(rockMod)
    .mul(flowMod)
    .mul(snowMod)
    .mul(slopeMod)
    .mul(colonyField(wpos, sp.colonyM, salt, floor));
}

type AtomicCounter = ReturnType<StorageBufferNode<'uint'>['toAtomic']>;

/** append helper: idx = old counter value; write when under cap */
function append(
  counter: AtomicCounter,
  cap: number,
  bufA: StorageBufferNode<'vec4'>,
  bufB: StorageBufferNode<'vec4'>,
  a: NV4,
  b: NV4,
): void {
  const idx = atomicAdd(counter.element(0), uint(1)) as unknown as NU;
  If(idx.lessThan(uint(cap)), () => {
    bufA.element(idx).assign(a);
    bufB.element(idx).assign(b);
  });
}

async function readCount(
  renderer: Renderer,
  counter: AtomicCounter,
  cap: number,
): Promise<number> {
  const attr = (counter as unknown as { value: unknown }).value;
  const ab = await renderer.getArrayBufferAsync(
    attr as Parameters<Renderer['getArrayBufferAsync']>[0],
  );
  const n = new Uint32Array(ab)[0] ?? 0;
  return Math.min(n, cap);
}

/**
 * Canopy occlusion map: tree crowns splatted into a world-space coverage
 * texture (4 m/texel). Lighting uses it to pull probe ambient DOWN under
 * canopy (probes ray-march only the heightfield, so without this the forest
 * interior glows with full open-sky irradiance and every sun shadow washes
 * out to an AO-like smudge). Doubles as the spec's canopy-shadow density
 * field for later passes.
 */
export const CANOPY_RES = 1024;

export async function buildCanopyMap(
  renderer: Renderer,
  trees: ScatterLayer,
): Promise<StorageTexture> {
  const accum = instancedArray(CANOPY_RES * CANOPY_RES, 'uint').toAtomic();
  const texel = WORLD_SIZE / CANOPY_RES; // 4 m

  // crown radius (m at scale 1) and skylight opacity per tree class
  const crownR = [2.9, 2.7, 3.8, 2.7, 3.2, 0.9];
  const opacity = [0.85, 0.7, 0.9, 0.65, 0.8, 0.12];

  const splatK = Fn(() => {
    const i = instanceIndex;
    If(i.greaterThanEqual(uint(Math.max(trees.count, 1))), () => {
      Return();
    });
    const A = trees.bufA.element(i) as unknown as NV4;
    const B = trees.bufB.element(i) as unknown as NV4;
    const cls = B.w.div(8).floor().toInt();
    const r = byBiome(cls, crownR).mul(A.w).clamp(1, 11);
    const op = byBiome(cls, opacity);
    const gx = A.x.div(WORLD_SIZE).add(0.5).mul(CANOPY_RES);
    const gy = A.z.div(WORLD_SIZE).add(0.5).mul(CANOPY_RES);
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const tx = gx.add(dx).floor();
        const ty = gy.add(dy).floor();
        const inB = tx.greaterThanEqual(0)
          .and(tx.lessThan(CANOPY_RES))
          .and(ty.greaterThanEqual(0))
          .and(ty.lessThan(CANOPY_RES));
        const d = vec2(tx.add(0.5).sub(gx), ty.add(0.5).sub(gy)).length().mul(texel);
        const w = float(1).sub(d.div(r)).max(0).pow(1.5).mul(op).mul(255);
        If(inB.and(w.greaterThan(1)), () => {
          atomicAdd(
            accum.element(ty.toInt().mul(CANOPY_RES).add(tx.toInt())),
            w.toUint(),
          );
        });
      }
    }
  })().compute(Math.max(trees.count, 1));
  splatK.setName('canopySplat');
  await renderer.computeAsync(splatK);

  const tex = new StorageTexture(CANOPY_RES, CANOPY_RES);
  tex.generateMipmaps = false;
  const packK = Fn(() => {
    const i = instanceIndex;
    If(i.greaterThanEqual(CANOPY_RES * CANOPY_RES), () => {
      Return();
    });
    const x = i.mod(CANOPY_RES);
    const y = i.div(CANOPY_RES);
    // 3×3 box blur of the fixed-point accumulation → soft canopy field
    const sum = float(0).toVar();
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = float(x).add(dx).clamp(0, CANOPY_RES - 1).toInt();
        const yy = float(y).add(dy).clamp(0, CANOPY_RES - 1).toInt();
        sum.addAssign(
          float(
            atomicLoad(
              accum.element(yy.mul(CANOPY_RES).add(xx)),
            ) as unknown as NU,
          ),
        );
      }
    }
    const cov = sum.div(9 * 255).div(1.6).clamp(0, 1).pow(0.75);
    textureStore(tex, uvec2(x.toUint(), y.toUint()), vec4(cov, cov, cov, 1)).toWriteOnly();
  })().compute(CANOPY_RES * CANOPY_RES);
  packK.setName('canopyPack');
  await renderer.computeAsync(packK);
  return tex;
}

/** sample the canopy coverage field at a world xz (filtered) */
export function canopyAt(tex: StorageTexture, wxz: NV2): NF {
  const uv = wxz.div(WORLD_SIZE).add(0.5);
  return (texture(tex, uv) as unknown as NV4).x;
}

export async function runScatter(
  renderer: Renderer,
  hf: Heightfield,
  seed: WorldSeed,
): Promise<ScatterResult> {
  const worldSize = hf.worldSize;
  const sT = seed.sub('scatter/trees') & 0x7fffffff;
  const sU = seed.sub('scatter/understory') & 0x7fffffff;
  const sE = seed.sub('scatter/extras') & 0x7fffffff;

  // ---------------------------------------------------------------- trees --
  const treeG = Math.round(worldSize / TREE_CELL);
  const treeA = instancedArray(TREE_CAP, 'vec4');
  const treeB = instancedArray(TREE_CAP, 'vec4');
  const treeCount = instancedArray(1, 'uint').toAtomic();

  const treeK = Fn(() => {
    const i = instanceIndex;
    If(i.greaterThanEqual(treeG * treeG), () => {
      Return();
    });
    const cell = vec2(float(i.mod(treeG)), float(i.div(treeG)));
    const jit = cellHash2(cell, sT);
    const wpos = cell.add(jit).div(treeG).sub(0.5).mul(worldSize);
    const s = sampleSite(hf, wpos);

    // hard exclusions: open/standing water, river channels, lake shelf
    If(s.h.lessThan(LAKE_LEVEL + 0.4), () => {
      Return();
    });
    If(s.riverDepth.greaterThan(0.22).or(s.standing.greaterThan(0.3)), () => {
      Return();
    });

    const clump = clumpField(wpos, sT ^ 0x51f3);
    // GREENLAND: treeless for now — Greenland is largely unforested. Zeroing
    // the per-biome tree density rejects every tree candidate while leaving the
    // understory/grass/rock layers untouched. Restore the original table
    // ([0, 0.22, 0.8, 0.85, 0.06, 0.26]) to bring trees back (e.g. south scrub).
    const dens = byBiome(s.bioId, [0, 0, 0, 0, 0, 0]);
    const clumpFloor = byBiome(s.bioId, [0, 0.15, 0.3, 0.35, 0.04, 0.12]);
    const slopeFade = float(1).sub(smoothstep(0.5, 0.95, s.slope));
    const treelineFade = float(1).sub(
      smoothstep(TREELINE - 110, TREELINE + 50, s.h),
    );
    const snowFade = float(1).sub(s.snow.mul(0.85));
    const accept = dens
      .mul(clumpFloor.add(float(1).sub(clumpFloor).mul(clump)))
      .mul(slopeFade)
      .mul(treelineFade)
      .mul(snowFade)
      .mul(s.vegDens.mul(0.85).add(0.15))
      .mul(float(1).sub(s.rockExp.mul(0.65)));
    If(cellHash(cell, sT ^ 0x1234f).greaterThanEqual(accept), () => {
      Return();
    });

    // species weights: per-biome table × moisture response
    const m = s.moisture;
    const w0 = byBiome(s.bioId, [0, 0.6, 0.58, 0.07, 0.05, 0.12]) // spruce
      .mul(m.mul(0.5).add(0.75));
    const w1 = byBiome(s.bioId, [0, 0.22, 0.27, 0.02, 0.15, 0]) // pine
      .mul(float(1.45).sub(m.mul(0.9)));
    const w2 = byBiome(s.bioId, [0, 0, 0.02, 0.5, 0.42, 0.05]) // beech
      .mul(m.mul(0.9).add(0.55));
    const w3 = byBiome(s.bioId, [0, 0.03, 0.08, 0.16, 0.3, 0.55]) // birch
      .mul(m.mul(0.6).add(0.7));
    const w4 = byBiome(s.bioId, [0, 0, 0, 0.2, 0, 0]) // karst gnarl
      .mul(s.rockExp.mul(1.6).add(0.4));
    const w5 = byBiome(s.bioId, [0, 0.15, 0.05, 0.05, 0.08, 0.28]); // snag

    const r = cellHash(cell, sT ^ 0x77e1).mul(
      w0.add(w1).add(w2).add(w3).add(w4).add(w5),
    );
    const sp = int(0).toVar();
    const acc = w0.toVar();
    If(r.greaterThan(acc), () => {
      sp.assign(1);
      acc.addAssign(w1);
      If(r.greaterThan(acc), () => {
        sp.assign(2);
        acc.addAssign(w2);
        If(r.greaterThan(acc), () => {
          sp.assign(3);
          acc.addAssign(w3);
          If(r.greaterThan(acc), () => {
            sp.assign(4);
            acc.addAssign(w4);
            If(r.greaterThan(acc), () => {
              sp.assign(5);
            });
          });
        });
      });
    });

    // size: power-biased jitter; krummholz shrink toward the treeline;
    // subalpine biome additionally stunted
    const h2 = cellHash2(cell, sT ^ 0x3b8d);
    const krumm = smoothstep(TREELINE - 170, TREELINE + 10, s.h);
    const stunt = s.bioId.equal(int(1)).select(float(0.72), float(1));
    const scale = h2.x
      .pow(1.6)
      .mul(0.85)
      .add(0.62)
      .mul(float(1).sub(krumm.mul(0.55)))
      .mul(stunt);

    const yaw = h2.y.mul(TAU);
    const leanR = cellHash2(cell, sT ^ 0x6c2f).sub(0.5).mul(0.12);
    const lean = s.nrmXZ.mul(0.18).add(leanR);
    const variant = cellHash(cell, sT ^ 0x49a1)
      .mul(TREE_VARIANTS)
      .floor()
      .min(TREE_VARIANTS - 1);
    const idF = float(sp).mul(8).add(variant);
    const y = s.h.sub(scale.mul(0.12)); // sink — root flare covers the seam

    append(
      treeCount,
      TREE_CAP,
      treeA,
      treeB,
      vec4(wpos.x, y, wpos.y, scale) as unknown as NV4,
      vec4(yaw, lean.x, lean.y, idF) as unknown as NV4,
    );
  })().compute(treeG * treeG);
  treeK.setName('scatterTrees');
  await renderer.computeAsync(treeK);

  // ----------------------------------------------------------- understory --
  const underG = Math.round(worldSize / UNDER_CELL);
  const underA = instancedArray(UNDER_CAP, 'vec4');
  const underB = instancedArray(UNDER_CAP, 'vec4');
  const underCount = instancedArray(1, 'uint').toAtomic();

  const underK = Fn(() => {
    const i = instanceIndex;
    If(i.greaterThanEqual(underG * underG), () => {
      Return();
    });
    const cell = vec2(float(i.mod(underG)), float(i.div(underG)));
    const jit = cellHash2(cell, sU);
    const wpos = cell.add(jit).div(underG).sub(0.5).mul(worldSize);
    const s = sampleSite(hf, wpos);

    If(s.h.lessThan(LAKE_LEVEL + 0.35), () => {
      Return();
    });
    If(s.riverDepth.greaterThan(0.2).or(s.standing.greaterThan(0.3)), () => {
      Return();
    });

    // COVER gate: biome carrying-capacity base × physical laws (high-density,
    // clean). Biomes decide how much vegetation a zone holds; the multipliers
    // are shelter / snow / rock / aspect laws. Species identity is chosen AFTER
    // acceptance, so no composition term can thin the vegetation layer.
    // [0 nival, 1 fell, 2 dwarf-shrub tundra, 3 shrub-heath, 4 meadow, 5 mire]
    const dens = byBiome(s.bioId, [0.05, 0.45, 0.92, 1.0, 0.78, 0.9]);
    // dense scrub fills in on moist, gentle, sheltered ground (streamside willow)
    const thicket = smoothstep(0.34, 0.72, s.moisture)
      .mul(smoothstep(0.5, 0.18, s.slope))
      .mul(1.3)
      .add(1);
    const slopeFade = float(1).sub(smoothstep(0.55, 0.9, s.slope));
    const treelineFade = float(1).sub(
      smoothstep(TREELINE - 40, TREELINE + 140, s.h),
    );
    // GREENLAND north-aspect bareness: steep north-facing slopes get almost no
    // sun (N hemisphere) and are essentially bare (user, from maps). Scaled by
    // slope so flat ground is unaffected; world SOUTH ≈ (0.826,0.564) in XZ
    // (SunSky noon azimuth). aspectU → ~0 on steep north faces, 1 elsewhere.
    // (mix(1, aspectG, slopeAmt) written as 1 − slopeAmt·(1−aspectG).)
    const slopeAmtU = smoothstep(0.14, 0.5, s.slope);
    const sunnyU = s.nrmXZ.dot(vec2(0.826, 0.564)).mul(0.5).add(0.5);
    const aspectU = float(1).sub(
      slopeAmtU.mul(float(1).sub(smoothstep(0.32, 0.6, sunnyU))),
    );
    // GREENLAND: plants grow in tight GROUPS where seeds fell / a parent spread,
    // not evenly spaced (user). A fine ~3 m clump field concentrates candidates
    // into patches with barer ground between; small floor keeps a few singles.
    const seedClump = smoothstep(
      0.42,
      0.66,
      fbm3(vec3(wpos.x.mul(0.33), 7, wpos.y.mul(0.33)), 2).mul(0.5).add(0.5),
    );
    // moist thickets fill in (dense scrub) rather than thinning into clumps
    const clumpK = seedClump.max(smoothstep(0.4, 0.75, s.moisture)).mul(0.6).add(0.4);
    // GREENLAND law — CHASMOPHYTES: bare rock/bedrock sheds most plants EXCEPT
    // cracks, joints & hollows, where soil + moisture + shelter collect and
    // plants root (user). A fine fissure field (ridged high-freq noise) plus
    // moist hollows marks the cracks; rock only suppresses veg AWAY from them.
    const fissure = float(1).sub(
      fbm3(vec3(wpos.x.mul(0.8), 3, wpos.y.mul(0.8)), 3).mul(0.5).add(0.5).sub(0.5).abs().mul(2),
    );
    const crack = smoothstep(0.55, 0.85, fissure).max(
      smoothstep(0.4, 0.72, s.moisture).mul(0.75),
    );
    const rockShed = float(1).sub(s.rockExp.mul(0.85).mul(float(1).sub(crack)));
    const accept = dens
      .mul(slopeFade)
      .mul(treelineFade)
      .mul(float(1).sub(s.snow.mul(0.9)))
      .mul(s.vegDens.mul(0.9).add(0.1))
      .mul(rockShed)
      .mul(aspectU)
      .mul(clumpK)
      .mul(thicket);
    If(cellHash(cell, sU ^ 0x2477).greaterThanEqual(accept), () => {
      Return();
    });

    // COMPOSITION: data-driven weighted draw over the GreenlandFlora roster.
    // Each species' weight is its per-zone abundance × bounded niche responses ×
    // its colony field — all generated from the typed table, so adding a plant
    // is a data-row edit, not another hand-nested shader branch.
    const wts = GREENLAND_FLORA.map((sp, i) =>
      speciesWeight(s, wpos, sp, 11 + i * 13.7),
    );
    let sum: NF = wts[0] as NF;
    for (let i = 1; i < wts.length; i++) sum = sum.add(wts[i] as NF);
    const r = cellHash(cell, sU ^ 0x59d3).mul(sum);
    // flat CDF walk: advance the class while r has passed the running total.
    // The WINNING species also carries its variant range [lo,hi], so variant-
    // packed species (bilberry v3, bearberry v2) place in their own mesh slot —
    // weighted by their own habitat, not a blind uniform split over the class.
    const sp0 = GREENLAND_FLORA[0] as FloraSpecies;
    const cls = int(sp0.cls).toVar();
    const vLo = float(sp0.variant?.[0] ?? 0).toVar();
    const vHi = float(sp0.variant?.[1] ?? 3).toVar();
    const acc = (wts[0] as NF).toVar();
    for (let i = 1; i < GREENLAND_FLORA.length; i++) {
      const sp = GREENLAND_FLORA[i] as FloraSpecies;
      If(r.greaterThanEqual(acc), () => {
        cls.assign(int(sp.cls));
        vLo.assign(sp.variant?.[0] ?? 0);
        vHi.assign(sp.variant?.[1] ?? 3);
        acc.addAssign(wts[i] as NF);
      });
    }

    const h2 = cellHash2(cell, sU ^ 0x71c9);
    const scale = h2.x.pow(1.4).mul(0.7).add(0.6);
    const yaw = h2.y.mul(TAU);
    // variant drawn from the species' own [lo,hi] slot range
    const variant = cellHash(cell, sU ^ 0x1ee7)
      .mul(vHi.sub(vLo).add(1))
      .floor()
      .add(vLo)
      .min(vHi);
    const idF = float(cls).mul(8).add(variant);

    append(
      underCount,
      UNDER_CAP,
      underA,
      underB,
      vec4(wpos.x, s.h.sub(0.03), wpos.y, scale) as unknown as NV4,
      vec4(yaw, 0, 0, idF) as unknown as NV4,
    );
  })().compute(underG * underG);
  underK.setName('scatterUnderstory');
  await renderer.computeAsync(underK);

  // --------------------------------------------------------------- extras --
  const extraG = Math.round(worldSize / EXTRA_CELL);
  const extraA = instancedArray(EXTRA_CAP, 'vec4');
  const extraB = instancedArray(EXTRA_CAP, 'vec4');
  const extraCount = instancedArray(1, 'uint').toAtomic();

  // GREENLAND toggle: forest-floor deadwood density (logs + stumps). 0 =
  // treeless tundra (current); 1 = original forest amount. Adjust freely.
  const DEADWOOD_SCALE = 0;
  const extraK = Fn(() => {
    const i = instanceIndex;
    If(i.greaterThanEqual(extraG * extraG), () => {
      Return();
    });
    const cell = vec2(float(i.mod(extraG)), float(i.div(extraG)));
    const jit = cellHash2(cell, sE);
    const wpos = cell.add(jit).div(extraG).sub(0.5).mul(worldSize);
    const s = sampleSite(hf, wpos);

    If(s.h.lessThan(LAKE_LEVEL + 0.3), () => {
      Return();
    });
    If(s.riverDepth.greaterThan(0.3).or(s.standing.greaterThan(0.35)), () => {
      Return();
    });

    const canopy = clumpField(wpos, sT ^ 0x51f3);
    const forestK = byBiome(s.bioId, [0, 0.3, 1, 1, 0.25, 0.6]).mul(
      canopy.mul(0.7).add(0.3),
    );
    const m = s.moisture;
    // GREENLAND: forest deadwood (fallen logs + stumps) scaled by DEADWOOD_SCALE
    // (defined above extraK). Treeless tundra → 0 for now; raise toward 1 to
    // bring forest-floor deadwood back (e.g. south Greenland scrub / planted
    // stands). Kept fully wired so it's a one-number adjustment, not a rewrite.
    const w0 = forestK.mul(0.3).mul(m.mul(0.6).add(0.4)).mul(DEADWOOD_SCALE); // log
    const w1 = forestK.mul(0.12).mul(DEADWOOD_SCALE); // stump
    const w2 = s.rockExp.mul(1.1).add(0.12).mul(0.42); // boulder
    const w3 = s.rockExp.mul(0.9).mul(0.2); // slab

    // boulders/slabs per Arctic zone — most rock exposed in barren nival/fell,
    // least in vegetated meadow [nival,fell,tundra,heath,meadow,mire]
    const dens = byBiome(s.bioId, [0.6, 0.6, 0.4, 0.3, 0.18, 0.28]);
    const slopeFade = float(1).sub(smoothstep(0.55, 1.1, s.slope));
    const wSum = w0.add(w1).add(w2).add(w3);
    const accept = dens.mul(slopeFade).mul(wSum.min(1));
    If(cellHash(cell, sE ^ 0x3f21).greaterThanEqual(accept), () => {
      Return();
    });

    const r = cellHash(cell, sE ^ 0x6d05).mul(wSum);
    const cls = int(VegClass.Log).toVar();
    const acc = w0.toVar();
    If(r.greaterThan(acc), () => {
      cls.assign(int(VegClass.Stump));
      acc.addAssign(w1);
      If(r.greaterThan(acc), () => {
        cls.assign(int(VegClass.Boulder));
        acc.addAssign(w2);
        If(r.greaterThan(acc), () => {
          cls.assign(int(VegClass.Slab));
        });
      });
    });

    // logs slide off steep ground; decay class follows moisture
    If(cls.equal(int(VegClass.Log)).and(s.slope.greaterThan(0.5)), () => {
      Return();
    });
    const h2 = cellHash2(cell, sE ^ 0x15bd);
    const mJit = m.add(h2.x.mul(0.3).sub(0.15));
    const decay = mJit
      .greaterThan(0.62)
      .select(float(2), mJit.greaterThan(0.35).select(float(1), float(0)));
    const isRock = cls.greaterThanEqual(int(VegClass.Boulder));
    // boulder/slab variants are context-keyed like StoneL: 0/1 pale bedrock
    // blocks on exposed rock, scree slopes, or dry pale soil (everywhere
    // the splat is pale — they must match the ground), 2/3 dark mossy
    // forest rocks
    const paleCtx = s.rockExp
      .greaterThan(0.35)
      .or(s.slope.greaterThan(0.42))
      .or(s.moisture.lessThan(0.32));
    const rockV = cellHash(cell, sE ^ 0x44d7)
      .mul(2)
      .floor()
      .min(1)
      .add(paleCtx.select(float(0), float(2)));
    const variant = cls
      .equal(int(VegClass.Log))
      .select(
        decay,
        isRock.select(rockV, cellHash(cell, sE ^ 0x44d7).mul(4).floor().min(3)),
      );

    const scale = isRock.select(
      h2.y.pow(2).mul(1.9).add(0.5),
      h2.y.mul(0.6).add(0.7),
    );
    // rocks bed deeper on slopes — a perched block on an incline floats
    const bed = s.slope.mul(0.9).add(1);
    const sink = isRock.select(scale.mul(0.28).mul(bed), float(0.08));
    const yaw = cellHash(cell, sE ^ 0x2a6b).mul(TAU);
    const idF = float(cls).mul(8).add(variant);

    append(
      extraCount,
      EXTRA_CAP,
      extraA,
      extraB,
      vec4(wpos.x, s.h.sub(sink), wpos.y, scale) as unknown as NV4,
      vec4(yaw, s.nrmXZ.x.mul(0.3), s.nrmXZ.y.mul(0.3), idF) as unknown as NV4,
    );
  })().compute(extraG * extraG);
  extraK.setName('scatterExtras');
  await renderer.computeAsync(extraK);

  // ------------------------------------------------- stones + branches --
  // size-stratified ground solids: stones everywhere geology says so
  // (scree slopes, rock exposure, streambeds, talus under cliffs) plus a
  // light scatter on all soil; fallen branches on forest floors. This is
  // the "no bare ground" layer — references show ground GEOMETRY at every
  // distance, never naked splat.
  const stoneG = Math.round(worldSize / STONE_CELL);
  const stoneA = instancedArray(STONE_CAP, 'vec4');
  const stoneB = instancedArray(STONE_CAP, 'vec4');
  const stoneCount = instancedArray(1, 'uint').toAtomic();
  const sS = seed.sub('scatter/stones') & 0x7fffffff;

  const stoneK = Fn(() => {
    const i = instanceIndex;
    If(i.greaterThanEqual(stoneG * stoneG), () => {
      Return();
    });
    const cell = vec2(float(i.mod(stoneG)), float(i.div(stoneG)));
    const jit = cellHash2(cell, sS);
    const wpos = cell.add(jit).div(stoneG).sub(0.5).mul(worldSize);
    const s = sampleSite(hf, wpos);
    If(s.h.lessThan(LAKE_LEVEL + 0.25), () => {
      Return();
    });
    // GREENLAND: exclude DEEP standing water (lakes), but keep stones IN stream
    // channels — the bed packs with a visible cobble field even under shallow
    // flow (ref photo: stones IN the stream, not just around it). riverDepth
    // marks a channel, so a channel never gets water-excluded.
    If(s.standing.greaterThan(1.2).and(s.riverDepth.lessThan(0.15)), () => {
      Return();
    });

    const canopy = clumpField(wpos, sT ^ 0x51f3);
    const streamK = smoothstep(0.05, 0.3, s.riverDepth);
    // angle of repose: loose rock can't rest above ~42° — anything clinging
    // to steeper faces reads as stuck-on blobs (user feedback: "random
    // protruding circles along cliffs")
    const repose = float(1).sub(smoothstep(0.72, 0.98, s.slope));
    // talus: march uphill — steep ground above sheds rock onto this site,
    // so stones concentrate in fans BELOW cliffs rather than on them
    const upLen = s.nrmXZ.length().max(0.02);
    const up = s.nrmXZ.div(upLen).negate();
    const h8 = hf.sampleHeight(wpos.add(up.mul(8)));
    const h18 = hf.sampleHeight(wpos.add(up.mul(18)));
    const riseNear = h8.sub(s.h).div(8);
    const riseFar = h18.sub(h8).div(10);
    const cliffAbove = smoothstep(0.7, 1.3, riseNear.max(riseFar));
    // shared rockiness clumps: one field gates ALL size classes, so big
    // blocks sit inside aprons of smaller fragments with bare gaps between
    // (real scree is patchy and size-mixed, never uniform speckle)
    const patch = clumpField(wpos, sS ^ 0x77aa).mul(0.78).add(0.22);
    // SCREE / TALUS: loose rock blankets mid-steep slopes (kicks in earlier and
    // packs denser than before, so scree slopes read as real fields of debris,
    // not a light sprinkle). repose (below) still culls it off cliff faces.
    const scree = smoothstep(0.34, 0.7, s.slope);
    const stoneBase = byBiome(s.bioId, [0.55, 0.4, 0.26, 0.32, 0.14, 0.18])
      .mul(
        s.rockExp
          .mul(0.85)
          .add(scree.mul(1.7))
          .add(streamK.mul(1.8))
          // GREENLAND: gravel accumulates in erosion channels / gully floors
          // (flow accumulation) — glacial outwash & stream bars
          .add(smoothstep(0.12, 0.7, s.flow).mul(1.5))
          .add(cliffAbove.mul(1.15))
          .add(0.16),
      )
      .mul(patch)
      .mul(repose)
      .mul(float(1).sub(s.snow.mul(0.85)));
    // branches need ground that holds them — steep bare slopes grew
    // floating white sticks (user-visible artifact)
    const branchFlat = float(1).sub(smoothstep(0.45, 0.75, s.slope));
    // GREENLAND: no fallen tree branches on treeless tundra (these were the
    // stray "sticks" — `canopy` is a phantom tree-clump field that survives
    // trees being off). Scaled by DEADWOOD_SCALE (0) so it restores with trees.
    // Original: canopy.mul(0.6).mul(byBiome(...,[0,0.2,1,1,0.3,0.7])).mul(branchFlat)
    const branchW = canopy
      .mul(0.6)
      .mul(byBiome(s.bioId, [0, 0.2, 1, 1, 0.3, 0.7]))
      .mul(branchFlat)
      .mul(DEADWOOD_SCALE);
    // GREENLAND: streams & erosion channels pack DENSELY with stones of all
    // sizes regardless of the (low) meadow/mire biome base — the channel is a
    // rock bed (ref photo). streambed overrides the biome-scaled stoneBase.
    const streambed = streamK
      .max(smoothstep(0.1, 0.6, s.flow))
      .mul(patch)
      .mul(repose)
      .mul(0.95);
    const accept = stoneBase.add(branchW).max(streambed).min(1);
    If(cellHash(cell, sS ^ 0x71f1).greaterThanEqual(accept), () => {
      Return();
    });

    // class pick: branch vs stone, stones split L/M/S by size budget.
    // Stones embed deeper on slopes (a perched sphere on an incline reads
    // as a stuck-on blob; a bedded one reads as an outcrop).
    const bed = s.slope.mul(0.9).add(1);
    const r = cellHash(cell, sS ^ 0x2e2e).mul(stoneBase.add(branchW));
    const h2 = cellHash2(cell, sS ^ 0x6b6b);
    const cls = int(VegClass.Branch).toVar();
    const scale = float(1).toVar();
    const sink = float(0.05).toVar();
    const variant = cellHash(cell, sS ^ 0x5c5c).mul(4).floor().min(3).toVar();
    If(r.lessThan(stoneBase), () => {
      // GREENLAND: far more BIG stones (was 13% large → 30%), wider range, and
      // streams skew large hard (gravel bars + boulders; streamK ×0.16 → ×0.3).
      const sr = h2.x.sub(streamK.mul(0.3));
      If(sr.lessThan(0.3), () => {
        cls.assign(int(VegClass.StoneL));
        scale.assign(h2.y.pow(1.5).mul(2.1).add(0.6)); // 0.6–2.7 m
        sink.assign(scale.mul(0.3).mul(bed));
        // variant by context: 0/1 pale faceted talus on scree/exposed rock/
        // dry pale soil (matches the pale splat), 2/3 dark rounded stones
        // in streambeds and on moist mossy forest floor
        const paleCtx = s.rockExp
          .greaterThan(0.35)
          .or(s.slope.greaterThan(0.42))
          .or(s.moisture.lessThan(0.32))
          .and(streamK.lessThan(0.35));
        const vr = cellHash(cell, sS ^ 0x1d2d).mul(2).floor().min(1);
        variant.assign(vr.add(paleCtx.select(float(0), float(2))));
      }).Else(() => {
        If(sr.lessThan(0.72), () => {
          cls.assign(int(VegClass.StoneM));
          scale.assign(h2.y.mul(1.05).add(0.35)); // 0.35–1.4 m (fills the mid gap)
          sink.assign(scale.mul(0.26).mul(bed));
        }).Else(() => {
          cls.assign(int(VegClass.StoneS));
          scale.assign(h2.y.mul(0.14).add(0.06)); // 6–20 cm
          sink.assign(scale.mul(0.22).mul(bed));
        });
      });
    }).Else(() => {
      scale.assign(h2.y.mul(0.8).add(0.6));
      sink.assign(0.04);
    });

    const yaw = cellHash(cell, sS ^ 0x3d3d).mul(TAU);
    const idF = float(cls).mul(8).add(variant);
    append(
      stoneCount,
      STONE_CAP,
      stoneA,
      stoneB,
      vec4(wpos.x, s.h.sub(sink), wpos.y, scale) as unknown as NV4,
      vec4(yaw, s.nrmXZ.x.mul(0.4), s.nrmXZ.y.mul(0.4), idF) as unknown as NV4,
    );
  })().compute(stoneG * stoneG);
  stoneK.setName('scatterStones');
  await renderer.computeAsync(stoneK);

  // ---- counts (single boot-time readback; instance data stays on GPU) ----
  const [tc, uc, ec, sc] = await Promise.all([
    readCount(renderer, treeCount, TREE_CAP),
    readCount(renderer, underCount, UNDER_CAP),
    readCount(renderer, extraCount, EXTRA_CAP),
    readCount(renderer, stoneCount, STONE_CAP),
  ]);

  return {
    trees: { bufA: treeA, bufB: treeB, cap: TREE_CAP, count: tc },
    understory: { bufA: underA, bufB: underB, cap: UNDER_CAP, count: uc },
    extras: { bufA: extraA, bufB: extraB, cap: EXTRA_CAP, count: ec },
    stones: { bufA: stoneA, bufB: stoneB, cap: STONE_CAP, count: sc },
  };
}
