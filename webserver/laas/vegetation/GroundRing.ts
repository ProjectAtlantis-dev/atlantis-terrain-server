/**
 * GroundRing — camera-following near-field carpets: GRASS (≥800k blades,
 * spec floor) and DEBRIS (≥80k: cobbles/pebbles/twigs/bark chips/litter).
 *
 * Streaming without uploads: each instance slot maps to the unique world
 * cell congruent to it (mod GRID) nearest the camera — the classic clipmap
 * wrap. All per-instance parameters re-derive from pcg(worldCell), so a
 * slot's content changes only when its world cell does. A per-frame cull
 * compute samples biome/water/canopy fields, thins density toward the ring
 * edge, frustum-tests, picks the LOD band, and appends (cell, groundY) into
 * compact lists → indirect draws.
 *
 * Grass LODs: 4-seg blade ≤26 m → 2-seg ≤60 m → wide tuft cross beyond
 * (dither-crossfaded). Debris types: cobbles/pebbles bias toward stream beds
 * (flowStrength — "water-rounded near streams"), litter/twigs/chips under
 * canopy, pebbles on rocky ground.
 */

import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  Vector3,
} from 'three';
import type { DataTexture, PerspectiveCamera } from 'three';
import {
  IndirectStorageBufferAttribute,
  IrradianceNode,
  MeshStandardNodeMaterial,
  StorageBufferAttribute,
  type Renderer,
  type StorageBufferNode,
  type StorageTexture,
} from 'three/webgpu';
import {
  Fn,
  If,
  Return,
  atomicAdd,
  atomicLoad,
  atomicStore,
  float,
  instanceIndex,
  instancedArray,
  int,
  mix,
  normalLocal,
  positionLocal,
  positionWorld,
  smoothstep,
  storage,
  texture,
  time,
  transformNormalToView,
  uint,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
} from 'three/tsl';
import { canopyAt, cellHash, cellHash2 } from '../gpu/passes/Scatter';
import { valueNoise2 } from '../gpu/noise/NoiseTSL';
import { grassTranslucency, rockMaterial } from '../render/VegMaterials';
import { depthPrepassTwin } from '../render/VegPrepass';
import { gustAt, windContext, windExposure, windU } from '../render/Wind';
import { trampleOffset } from '../render/Trample';
import type { NB, NF, NI, NU, NV2, NV3, NV4 } from '../gpu/TSLTypes';
import type { Heightfield } from '../world/Heightfield';
import type { ProbeGI } from '../gpu/passes/ProbeGI';
import { seasonU } from '../render/Season';
import { vegViewPos } from '../render/VegInstance';
import {
  barkChipGeometry,
  debrisMaterial,
  grassBladeGeometry,
  litterMaterial,
  twigGeometry,
} from './GroundCover';
import { buildRock } from './RockBuilder';
import type { WorldSeed } from '../core/Seed';
import { runiform } from '../gpu/RenderUniform';
import { bootQuery } from '../core/BootQuery';

const GRASS_GRID = 1536;
const GRASS_CELL = 0.21; // m → ±161 m ring, ~23 five-blade clumps/m²
const GRASS_BASE_WIDEN = GRASS_CELL / 0.105;
const GRASS_R = 155;
const G_NEAR = 30;
const G_MID = 70;
/** crossfade half-width — cull overlap and material fade MUST share it */
const G_BAND = 12;
// Vehicle suspension/camera smoothing can move the view by tiny sub-frame
// amounts even when traversal speed is zero. Re-running the append-buffer cull
// for that noise both burns the GPU and can reshuffle borderline instances.
const CULL_FOCUS_EPSILON_SQ = 0.25;
// The LAAS heightfield is a resampled representation of the rendered DEM.
// Keep blade roots just above the triangle surface so tiny interpolation
// differences cannot bury most of a short tundra blade at grazing angles.
const GRASS_ROOT_LIFT = 0.08;
const GRASS_CAPS = [524288, 1048576, 1835008]; // near/mid/far compact regions

/**
 * Continuous distance thinning, conserved by blade widening (1/√thin in the
 * vertex stage). thin(0..~40 m) = 1; ~0.45 at 100 m; ~0.16 at 155 m.
 * Beyond ~120 m an extra collapse folds coverage into ever-wider
 * super-tufts so the band reaches GRASS_R without a vertex explosion
 * (feedback 2.8: grass should render much farther, cheaply).
 */
function grassThin(dist: NF): NF {
  const base = float(58).div(dist.max(1).add(42)).min(1).pow(1.15);
  const far = float(120).div(dist.max(120)).pow(1.6);
  return base.mul(far);
}

const DEB_GRID = 512;
const DEB_CELL = 0.3; // ±77 m ring
const DEB_R = 74;
// cobble / pebble / twig / chip / litter
const DEB_CAPS = [24576, 49152, 49152, 32768, 65536];

// far super-tuft layer (g3, feedback 2.8): its own COARSE toroidal grid —
// the fine grid physically ends at ±161 m. Wide merged tufts carry the
// meadow silhouette 150→265 m; beyond that the terrain splat owns it.
const FAR_GRID = 768;
const FAR_CELL = 0.7; // ±269 m ring, ~2 slots/m²
const FAR_R0 = 150;
const FAR_R = 265;
const FAR_CAP = 196608;

interface RingBind {
  cells: StorageBufferNode<'uint'>;
  heights: StorageBufferNode<'float'>;
  base: number;
  cell: number;
  salt: number;
}

/** world cells span ±~10k — bias before the 16-bit pack */
const CELL_BIAS = 20000;

/** vertex-stage fetch: packed world cell + ground height for this instance */
function fetchRing(bind: RingBind): { wc: NV2; y: NF; wpos: NV2 } {
  const at = instanceIndex.add(runiform(uint(bind.base)) as unknown as NU);
  const packed = bind.cells.element(at) as unknown as NU;
  const wc = vec2(
    float(packed.shiftRight(uint(16))).sub(CELL_BIAS),
    float(packed.bitAnd(uint(0xffff))).sub(CELL_BIAS),
  );
  const y = bind.heights.element(at) as unknown as NF;
  const jit = cellHash2(wc, bind.salt);
  return { wc, y, wpos: wc.add(jit).mul(bind.cell) };
}

/**
 * Dithered band crossfade by camera distance. COMPLEMENTARY partition (same
 * scheme as VegInstance.applyDitherFade): the outgoing layer draws where
 * IGN < fadeOut, the incoming one where IGN >= 1 − fadeIn — with the shared
 * band width the two layers split the pixel set exactly, so blade density
 * stays constant through the band. Same-comparison dithering halved the
 * drawn pixels at every grass-layer boundary (visible thin rings).
 */
function bandFade(
  mat: MeshStandardNodeMaterial,
  dist: NF,
  fadeIn: number | null,
  fadeOut: number | null,
  band: number,
  stableNoise: NF,
): void {
  const inV =
    fadeIn !== null
      ? varying(smoothstep(fadeIn - band, fadeIn + band, dist))
      : null;
  const outV =
    fadeOut !== null
      ? varying(float(1).sub(smoothstep(fadeOut - band, fadeOut + band, dist)))
      : null;
  if (!inV && !outV) return;
  // maskNode (not colorNode Discards) so the depth-prepass twin can share
  // the EXACT same draw condition — a depth-vs-color discard mismatch
  // punches holes at the fade bands. Main pass only (carpets cast no
  // shadows, so maskShadowNode never consults this).
  let cond: NB | null = null;
  if (inV) cond = stableNoise.greaterThanEqual(float(1).sub(inV)) as unknown as NB;
  if (outV) {
    const c2 = stableNoise.lessThan(outV) as unknown as NB;
    cond = cond ? ((cond as unknown as { and(o: NB): NB }).and(c2)) : c2;
  }
  mat.maskNode = cond as unknown as typeof mat.maskNode;
}

/** simple flat litter quad (5×7 cm), uv 0..1, normal up */
function litterQuad(): BufferGeometry {
  const g = new BufferGeometry();
  const w = 0.038;
  const l = 0.05;
  g.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([-w, 0, -l, w, 0, -l, w, 0, l, -w, 0, l]), 3),
  );
  g.setAttribute(
    'normal',
    new BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), 3),
  );
  g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  g.setIndex([0, 2, 1, 0, 3, 2]);
  return g;
}

/**
 * N-blade clump in one instance — the SOTA near-grass move: per-pixel blade
 * overlap is what reads as "lush", and single thin blades can't do it at
 * walking distance no matter the density. Deterministic mini-rng; per-cell
 * variety still comes from the instance transform/hash.
 */
function bladeClump(blades: number, segs: number): BufferGeometry {
  let s = 1234567 + blades * 77 + segs * 13;
  const rnd = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const pos: number[] = [];
  const nrm: number[] = [];
  const uvA: number[] = [];
  const idx: number[] = [];
  for (let b = 0; b < blades; b++) {
    const base = grassBladeGeometry(segs);
    const yaw = rnd() * Math.PI * 2;
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const ox = (rnd() - 0.5) * 0.16;
    const oz = (rnd() - 0.5) * 0.16;
    const hk = 0.62 + rnd() * 0.65;
    const lean = (rnd() - 0.5) * 0.42;
    const p = base.attributes.position as BufferAttribute;
    const nA = base.attributes.normal as BufferAttribute;
    const uA = base.attributes.uv as BufferAttribute;
    const v0 = pos.length / 3;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) * 1.25;
      const y = p.getY(i) * hk;
      const z = p.getZ(i);
      pos.push(x * c + z * sn + ox + lean * y * c, y, z * c - x * sn + oz + lean * y * sn);
      nrm.push(nA.getX(i) * c + nA.getZ(i) * sn, nA.getY(i), nA.getZ(i) * c - nA.getX(i) * sn);
      uvA.push(uA.getX(i), uA.getY(i));
    }
    const ix = base.index as BufferAttribute;
    for (let i = 0; i < ix.count; i++) idx.push(v0 + ix.getX(i));
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvA), 2));
  g.setIndex(idx);
  return g;
}

/** three crossed wide blades — far-band tuft (≈ a small clump in one card) */
function tuftGeometry(W = 0.04): BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uvA: number[] = [];
  const idx: number[] = [];
  for (let k = 0; k < 3; k++) {
    const a = k * 1.92 + 0.4;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const base = pos.length / 3;
    for (const [u, v] of [
      [-W, 0],
      [W, 0],
      [W * 0.55, 1],
      [-W * 0.55, 1],
    ] as const) {
      pos.push(u * c, v, u * s);
      // rounded cross-section (see grassBladeGeometry): edges tilt ±38°
      // toward the width axis (c,0,s)
      const sgn = u < 0 ? -1 : 1;
      nrm.push(
        -s * 0.97 * 0.788 + sgn * 0.616 * c,
        0.25,
        c * 0.97 * 0.788 + sgn * 0.616 * s,
      );
      uvA.push(u < 0 ? 0 : 1, v);
    }
    idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvA), 2));
  g.setIndex(idx);
  return g;
}

export class GroundRing {
  readonly group = new Group();
  /** depth twins render before color draws (renderOrder; grouped) */
  private prepassGroup = new Group();
  private kernels: object[] = [];
  private camU = uniform(new Vector3());
  private lastCullFocus = new Vector3();
  private cullValid = false;
  private cullSubmits = 0;
  private cullSkips = 0;
  private hud: Record<string, number> = {};
  private reading = false;
  private frame = 0;
  private counters!: ReturnType<StorageBufferNode<'uint'>['toAtomic']>;
  private caps: number[] = [...GRASS_CAPS, ...DEB_CAPS, FAR_CAP];

  constructor(
    private hf: Heightfield,
    private canopyTex: StorageTexture,
    private seed: WorldSeed,
    private gi: ProbeGI | null = null,
    private useDepthPrepass = true,
  ) {}

  /**
   * Probe ambient for the carpets (same field as terrain/veg — without it
   * the grass keeps the dimmed hemisphere and reads as a pale glowing mat
   * inside canopy-shadowed interiors). Up-normal: a carpet integrates the
   * down-welling irradiance.
   */
  private patchGI(mat: MeshStandardNodeMaterial): void {
    const gi = this.gi;
    if (!gi) return;
    let irr = gi.irradiance(
      positionWorld as unknown as NV3,
      vec3(0, 1, 0) as unknown as NV3,
    );
    irr = irr.mul(
      canopyAt(this.canopyTex, (positionWorld as unknown as NV3).xz)
        .mul(0.12)
        .oneMinus(),
    ) as typeof irr;
    // probe field varies at ≥1.5 m — vertex-stage eval on ≤0.3 m carpet
    // geometry is identical, and skips 4 texture fetches per overdrawn px
    const irrV = varying(irr as unknown as Parameters<typeof varying>[0]);
    (mat as unknown as { setupLightMap: () => unknown }).setupLightMap = () =>
      new IrradianceNode(irrV as unknown as ConstructorParameters<typeof IrradianceNode>[0]);
  }

  init(beechAtlas: DataTexture | null): void {
    this.group.add(this.prepassGroup);
    const hf = this.hf;
    const salt = this.seed.sub('groundring') & 0x7fffffff;
    const camU = this.camU;
    const canopyTex = this.canopyTex;

    const offsets: number[] = [];
    let off = 0;
    for (const cap of this.caps) {
      offsets.push(off);
      off += cap;
    }
    const cells = instancedArray(off, 'uint');
    const heights = instancedArray(off, 'float');
    this.counters = instancedArray(this.caps.length, 'uint').toAtomic();
    const counters = this.counters;
    const capBuf = storage(
      new StorageBufferAttribute(new Uint32Array(this.caps), 1),
      'uint',
      this.caps.length,
    );
    const offBuf = storage(
      new StorageBufferAttribute(new Uint32Array(offsets), 1),
      'uint',
      this.caps.length,
    );

    const clearK = Fn(() => {
      const i = instanceIndex;
      If(i.greaterThanEqual(this.caps.length), () => {
        Return();
      });
      atomicStore(counters.element(i), uint(0));
    })().compute(this.caps.length);
    clearK.setName('ringClear');

    /** toroidal slot → nearest congruent world cell */
    const worldCell = (sx: NF, sy: NF, grid: number, cell: number): NV2 => {
      const camC = vec2(camU.x, camU.z).div(cell);
      const wx = camC.x.sub(sx).div(grid).round().mul(grid).add(sx);
      const wy = camC.y.sub(sy).div(grid).round().mul(grid).add(sy);
      return vec2(wx, wy);
    };

    const byBio = (b: NI, vals: number[]): NF => {
      let e: NF = float(vals[5] ?? 0);
      for (let i = 4; i >= 0; i--) {
        e = b.equal(float(i).toInt()).select(float(vals[i] ?? 0), e) as NF;
      }
      return e;
    };

    const appendRing = (g: NI, wc: NV2, y: NF): void => {
      const idx = atomicAdd(counters.element(g), uint(1)) as unknown as NU;
      If(idx.lessThan(capBuf.element(g) as unknown as NU), () => {
        const at = (offBuf.element(g) as unknown as NU).add(idx);
        // pack biased cell coords 16|16 (cells span ±~10k)
        cells.element(at).assign(
          wc.x.add(CELL_BIAS).toUint().shiftLeft(uint(16)).bitOr(wc.y.add(CELL_BIAS).toUint()),
        );
        heights.element(at).assign(y);
      });
    };

    // ---------------- grass cull -----------------------------------------------
    const grassK = Fn(() => {
      const i = instanceIndex;
      If(i.greaterThanEqual(GRASS_GRID * GRASS_GRID), () => {
        Return();
      });
      const sx = float(i.mod(GRASS_GRID));
      const sy = float(i.div(GRASS_GRID));
      const wc = worldCell(sx, sy, GRASS_GRID, GRASS_CELL);
      const jit = cellHash2(wc, salt);
      const wpos = wc.add(jit).mul(GRASS_CELL);
      const dist = wpos.sub(vec2(camU.x, camU.z)).length();
      If(dist.greaterThan(GRASS_R), () => {
        Return();
      });
      const uvW = wpos.div(hf.worldSize).add(0.5);
      const bio = texture(
        hf.biomeTex as NonNullable<typeof hf.biomeTex>,
        uvW,
        0,
      ) as unknown as NV4;
      const fl = texture(
        hf.fieldsTex as NonNullable<typeof hf.fieldsTex>,
        uvW,
        0,
      ) as unknown as NV4;
      const ns = texture(hf.normalTex, uvW, 0) as unknown as NV4;
      const bioId = bio.x.mul(8).add(0.5).floor().toInt();
      const h = hf.sampleHeight(wpos);
      // gate on the ACTUAL water surface, not the carve apron: riverDepth
      // is widen-blurred and flags whole gorge floors as "river" — grass
      // vanished from every dry bank (scene1 banks are green to the line)
      const above = h.sub(hf.sampleWaterYNearest(wpos));
      If(above.lessThan(0.04), () => {
        Return();
      });
      const canopy = canopyAt(canopyTex, wpos);
      // soft bank margin: full grass from ~0.5 m above the waterline. The
      // channel scar (deep riverDepth) thins hard — the debris ring's
      // cobbles take over there (scene1: cobbled floor with grassy banks,
      // not a meadow blanket to the waterline) — but never zeroes, so
      // tufts still break the gravel.
      const bank = smoothstep(0.06, 0.5, above).mul(
        float(1).sub(smoothstep(0.2, 1.1, fl.z).mul(0.78)),
      );
      // GREENLAND: real tundra is mostly bare rock/gravel/moss with grass only
      // in SPARSE patches — not a meadow blanket. Densities cut hard (esp.
      // meadow/subalpine) and multiplied by a two-octave clump field so blades
      // gather in tussocks with barer gaps between. Wet hollows (wetland) keep
      // the most sedge. Originals: byBio [0.18,0.7,0.62,0.7,1.5,1.1], floor 0.3.
      const clumpN = valueNoise2(wpos.mul(0.55))
        .mul(0.62)
        .add(valueNoise2(wpos.mul(1.7).add(9)).mul(0.38));
      const clump = smoothstep(0.4, 0.7, clumpN);
      // grass/sedge per Arctic zone [nival,fell,tundra,heath,meadow,mire] —
      // GREENLAND is dwarf-shrub HEATH, not grassland: grass is sparse on
      // fell/tundra/heath (dwarf-shrub mats + gravel dominate there, rust in
      // autumn) and thick only in grass-sedge meadow and wet mire (cottongrass).
      let dens = byBio(bioId, [0.05, 0.42, 0.78, 0.88, 0.85, 1.0])
        .mul(bank)
        .mul(bio.z.mul(0.85).add(0.15))
        .mul(float(1).sub(bio.w.mul(0.55)))
        .mul(float(1).sub(canopy.mul(0.45)))
        .mul(fl.x.mul(0.35).add(0.75))
        .mul(clump.mul(0.9).add(0.1));
      // near-field floor keeps a FEW thin blades close up, but CLUMPED — no
      // guaranteed carpet; Greenland ground is often bare between tussocks. The
      // floor is biome-scaled so fell/tundra/heath foregrounds stay shrub+gravel
      // (not a grass fringe), while meadow/mire keep a close-up grass floor.
      dens = dens.max(
        byBio(bioId, [0.03, 0.14, 0.28, 0.32, 0.12, 0.14])
          .mul(clump)
          .mul(float(1).sub(smoothstep(8, 14, dist)))
          .mul(bank),
      );
      // GREENLAND north-aspect bareness: steep north-facing slopes get almost
      // no sun and grow essentially no grass (user). Slope-scaled so flat
      // ground is unaffected; world SOUTH ≈ (0.826,0.564) in XZ.
      const slopeAmtG = smoothstep(0.14, 0.5, ns.w);
      const sunnyG = vec2(ns.x, ns.z).dot(vec2(0.826, 0.564)).mul(0.5).add(0.5);
      const aspectG = float(1).sub(
        slopeAmtG.mul(float(1).sub(smoothstep(0.32, 0.6, sunnyG))),
      );
      dens = dens.mul(aspectG);
      dens = dens
        .mul(float(1).sub(bio.y.mul(0.95)))
        .mul(float(1).sub(smoothstep(0.55, 0.95, ns.w)))
        // WINTER (live uniform): most blades are buried under snow — thin the
        // sward hard so only sparse dead tufts poke through the blanket.
        .mul(float(1).sub(seasonU.winter.mul(0.75)));
      // coverage-conserving continuous LOD ("cheap nanite for aggregates"):
      // accept thins SMOOTHLY with distance — survivors widen by 1/sqrt(thin)
      // in the vertex stage, so screen coverage stays constant and there are
      // no density bands; the ring then dissolves into the field-matched
      // terrain splat instead of ending at an edge.
      const thin = grassThin(dist);
      const edge = float(1).sub(smoothstep(GRASS_R * 0.9, GRASS_R, dist));
      If(cellHash(wc, salt ^ 0x77a1).greaterThanEqual(dens.mul(edge).mul(thin)), () => {
        Return();
      });
      // Boundary-band cells append to BOTH adjacent layers — the
      // complementary dither in grassMaterial then draws each pixel from
      // exactly one layer, holding blade density constant through the band.
      // Single-list assignment + dither halved density at every boundary
      // (the visible "transparent rings" around the camera).
      If(dist.lessThan(G_NEAR + G_BAND), () => {
        appendRing(int(0), wc, h);
      });
      If(
        dist.greaterThanEqual(G_NEAR - G_BAND).and(dist.lessThan(G_MID + G_BAND)),
        () => {
          appendRing(int(1), wc, h);
        },
      );
      If(dist.greaterThanEqual(G_MID - G_BAND), () => {
        appendRing(int(2), wc, h);
      });
    })().compute(GRASS_GRID * GRASS_GRID);
    grassK.setName('grassRingCull');

    // ---------------- debris cull ------------------------------------------------
    const debrisK = Fn(() => {
      const i = instanceIndex;
      If(i.greaterThanEqual(DEB_GRID * DEB_GRID), () => {
        Return();
      });
      const sx = float(i.mod(DEB_GRID));
      const sy = float(i.div(DEB_GRID));
      const wc = worldCell(sx, sy, DEB_GRID, DEB_CELL);
      const jit = cellHash2(wc, salt ^ 0x5dd5);
      const wpos = wc.add(jit).mul(DEB_CELL);
      const dist = wpos.sub(vec2(camU.x, camU.z)).length();
      If(dist.greaterThan(DEB_R), () => {
        Return();
      });
      const uvW = wpos.div(hf.worldSize).add(0.5);
      const bio = texture(
        hf.biomeTex as NonNullable<typeof hf.biomeTex>,
        uvW,
        0,
      ) as unknown as NV4;
      const fl = texture(
        hf.fieldsTex as NonNullable<typeof hf.fieldsTex>,
        uvW,
        0,
      ) as unknown as NV4;
      const ns = texture(hf.normalTex, uvW, 0) as unknown as NV4;
      const bioId = bio.x.mul(8).add(0.5).floor().toInt();
      const h = hf.sampleHeight(wpos);
      // cobbles stay visible THROUGH shallow water (scene1: the trickle
      // runs over them) — only drop debris under genuinely deep water
      const submergedBy = hf.sampleWaterYNearest(wpos).sub(h);
      If(submergedBy.greaterThan(0.55), () => {
        Return();
      });
      const canopy = canopyAt(canopyTex, wpos);
      const streamK = smoothstep(0.32, 0.7, fl.y).max(smoothstep(0.02, 0.2, fl.z));
      // bank margin: too shallow for the bed override, too wet for grass —
      // gravel it or it reads as a bare strip along every wash
      const marginK = smoothstep(0.005, 0.06, fl.z).mul(float(1).sub(streamK));
      // organic debris floats off — submerged cells keep only stone classes
      const dry = smoothstep(0.05, -0.02, submergedBy);
      // channel core (deep scar or submerged) leans hard into cobbles —
      // scene1's bed is packed rounded stone, not occasional rocks
      const coreK = smoothstep(0.25, 1.0, fl.z).max(smoothstep(-0.05, 0.15, submergedBy));
      const wCobble = streamK
        .mul(2.2)
        .add(marginK.mul(1.4))
        .add(bio.w.mul(0.3))
        .add(coreK.mul(2.6))
        .mul(0.5);
      // GREENLAND: pebbles concentrate on rocky ground / stream margins, not a
      // blanket over the whole tundra (was +0.15 everywhere → 0.05).
      const wPebble = bio.w.mul(0.9).add(streamK).add(marginK.mul(1.4)).add(0.05).mul(0.6);
      // GREENLAND: twigs/bark/leaf-litter are forest-floor debris — treeless
      // tundra has none, so drop the everywhere-bases (0.12 twig / 0.08 litter)
      // that seeded stray sticks on open ground. Canopy-gated → ~0 when treeless.
      const wTwig = canopy.mul(1.8).mul(float(1).sub(streamK)).mul(dry);
      const wChip = canopy.mul(0.8).mul(float(1).sub(streamK)).mul(dry);
      const wLitter = canopy.mul(3.0).mul(float(1).sub(streamK.mul(0.8))).mul(dry);
      const wSum = wCobble.add(wPebble).add(wTwig).add(wChip).add(wLitter);
      // streambeds are FULLY cobbled geometry (spec §9) — override biome density
      const dens = byBio(bioId, [0.4, 0.6, 1.0, 1.0, 0.6, 0.75])
        .mul(float(1).sub(bio.y.mul(0.9)))
        .mul(wSum.mul(0.5).min(1))
        .max(streamK.mul(0.95))
        .max(marginK.mul(0.85))
        .mul(float(1).sub(smoothstep(0.7, 1.05, ns.w)));
      const edge = float(1).sub(smoothstep(DEB_R * 0.72, DEB_R, dist));
      If(cellHash(wc, salt ^ 0x132f).greaterThanEqual(dens.mul(edge)), () => {
        Return();
      });
      const r = cellHash(wc, salt ^ 0x4c11).mul(wSum);
      const ty = float(0).toVar();
      const acc = wCobble.toVar();
      If(r.greaterThan(acc), () => {
        ty.assign(1);
        acc.addAssign(wPebble);
        If(r.greaterThan(acc), () => {
          ty.assign(2);
          acc.addAssign(wTwig);
          If(r.greaterThan(acc), () => {
            ty.assign(3);
            acc.addAssign(wChip);
            If(r.greaterThan(acc), () => {
              ty.assign(4);
            });
          });
        });
      });
      appendRing(ty.add(3).toInt(), wc, h);
    })().compute(DEB_GRID * DEB_GRID);
    debrisK.setName('debrisRingCull');

    // ---------------- far super-tuft cull (g3) -----------------------------------
    const farK = Fn(() => {
      const i = instanceIndex;
      If(i.greaterThanEqual(FAR_GRID * FAR_GRID), () => {
        Return();
      });
      const sx = float(i.mod(FAR_GRID));
      const sy = float(i.div(FAR_GRID));
      const wc = worldCell(sx, sy, FAR_GRID, FAR_CELL);
      const jit = cellHash2(wc, salt ^ 0x6f21);
      const wpos = wc.add(jit).mul(FAR_CELL);
      const dist = wpos.sub(vec2(camU.x, camU.z)).length();
      If(dist.lessThan(FAR_R0 - 16).or(dist.greaterThan(FAR_R)), () => {
        Return();
      });
      const uvW = wpos.div(hf.worldSize).add(0.5);
      const bio = texture(
        hf.biomeTex as NonNullable<typeof hf.biomeTex>,
        uvW,
        0,
      ) as unknown as NV4;
      const fl = texture(
        hf.fieldsTex as NonNullable<typeof hf.fieldsTex>,
        uvW,
        0,
      ) as unknown as NV4;
      const ns = texture(hf.normalTex, uvW, 0) as unknown as NV4;
      const bioId = bio.x.mul(8).add(0.5).floor().toInt();
      const h = hf.sampleHeight(wpos);
      const above = h.sub(hf.sampleWaterYNearest(wpos));
      If(above.lessThan(0.06), () => {
        Return();
      });
      const canopy = canopyAt(canopyTex, wpos);
      const bank = smoothstep(0.06, 0.5, above).mul(
        float(1).sub(smoothstep(0.2, 1.1, fl.z).mul(0.78)),
      );
      // far/secondary grass — same Arctic zonation as the near ring so distant
      // fields don't read as a lush temperate carpet [nival,fell,tundra,heath,meadow,mire]
      const dens = byBio(bioId, [0.05, 0.42, 0.78, 0.88, 0.9, 1.1])
        .mul(bank)
        .mul(bio.z.mul(0.85).add(0.15))
        .mul(float(1).sub(bio.w.mul(0.55)))
        .mul(float(1).sub(canopy.mul(0.45)))
        .mul(float(1).sub(bio.y.mul(0.95)))
        .mul(float(1).sub(smoothstep(0.55, 0.95, ns.w)));
      // ramp IN over the fine band's dissolve, OUT at the splat handoff
      const fadeIn = smoothstep(FAR_R0 - 16, FAR_R0 + 14, dist);
      const edge = float(1).sub(smoothstep(FAR_R * 0.93, FAR_R, dist));
      If(
        cellHash(wc, salt ^ 0x55aa).greaterThanEqual(
          dens.mul(fadeIn).mul(edge).mul(0.55),
        ),
        () => {
          Return();
        },
      );
      appendRing(int(8), wc, h);
    })().compute(FAR_GRID * FAR_GRID);
    farK.setName('farTuftCull');

    // ---------------- draws -------------------------------------------------------
    const draws: { geo: BufferGeometry; mat: MeshStandardNodeMaterial; g: number }[] = [];

    const grassGeos = [bladeClump(5, 4), bladeClump(3, 2), tuftGeometry()];
    const grassFades: [number | null, number | null][] = [
      [null, G_NEAR],
      [G_NEAR, G_MID],
      [G_MID, null],
    ];
    for (let l = 0; l < 3; l++) {
      const bindL: RingBind = {
        cells,
        heights,
        base: offsets[l] ?? 0,
        cell: GRASS_CELL,
        salt,
      };
      const mat = this.grassMaterial(bindL, grassFades[l] ?? [null, null], l === 2);
      this.patchGI(mat);
      draws.push({ geo: grassGeos[l] as BufferGeometry, mat, g: l });
    }

    // far super-tufts: one draw on the coarse list, wide cards, full
    // terrain-normal shading (mode 'far' in grassMaterial)
    {
      const bindF: RingBind = {
        cells,
        heights,
        base: offsets[8] ?? 0,
        cell: FAR_CELL,
        salt: salt ^ 0x6f21,
      };
      const matF = this.grassMaterial(bindF, [null, null], true, true);
      this.patchGI(matF);
      draws.push({ geo: tuftGeometry(0.21), mat: matF, g: 8 });
    }

    const rng = this.seed.rng('groundring/geo');
    const debrisGeos: BufferGeometry[] = [
      buildRock('cobble', rng.fork('cobble'), 2).geometry,
      buildRock('cobble', rng.fork('pebble'), 1).geometry,
      twigGeometry(rng.fork('twig')),
      barkChipGeometry(rng.fork('chip')),
      litterQuad(),
    ];
    const debrisScale = [0.16, 0.05, 1, 1, 1];
    for (let t = 0; t < 5; t++) {
      let mat: MeshStandardNodeMaterial;
      if (t === 4 && beechAtlas) mat = litterMaterial(beechAtlas);
      else if (t === 2) mat = debrisMaterial('twig');
      else if (t === 3) mat = debrisMaterial('chip');
      // GREENLAND: cobbles/pebbles were the default mid-grey — tiny + sunlit
      // they read as bright white marbles. Give them a dark, wet gravel tone.
      else
        mat = rockMaterial({
          moss: t === 0 ? 0.2 : 0.08,
          tone: t === 0 ? { r: 0.16, g: 0.155, b: 0.15 } : { r: 0.12, g: 0.125, b: 0.13 },
        });
      const bindD: RingBind = {
        cells,
        heights,
        base: offsets[3 + t] ?? 0,
        cell: DEB_CELL,
        salt: salt ^ 0x5dd5,
      };
      this.debrisTransform(mat, bindD, debrisScale[t] ?? 1);
      this.patchGI(mat);
      draws.push({ geo: debrisGeos[t] as BufferGeometry, mat, g: 3 + t });
    }

    const D = draws.length;
    const indirectData = new Uint32Array(D * 5);
    const drawGroups = new Uint32Array(D);
    const indirectAttr = new IndirectStorageBufferAttribute(indirectData, 5);
    for (let d = 0; d < D; d++) {
      const spec = draws[d];
      if (!spec) continue;
      const geo = spec.geo;
      indirectData[d * 5] = geo.index ? geo.index.count : geo.attributes.position?.count ?? 0;
      drawGroups[d] = spec.g;
      geo.setIndirect(indirectAttr, d * 20);
      const mesh = new Mesh(geo, spec.mat);
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      // grass layers shade 2-8x per pixel without a prepass (random draw
      // order defeats early-Z); twin shares geometry = same indirect slot
      const noPrepass =
        bootQuery().get('prepass') === '0';
      if (this.useDepthPrepass && !noPrepass && (spec.g <= 2 || spec.g === 8)) {
        const matS = spec.mat as unknown as { positionNode: unknown; maskNode: unknown };
        this.prepassGroup.add(
          depthPrepassTwin(mesh, {
            positionNode: matS.positionNode,
            maskNode: matS.maskNode ?? undefined,
            side: DoubleSide,
          }),
        );
      }
    }
    const indirectStore = storage(indirectAttr, 'uint', D * 5);
    const drawGroupBuf = storage(new StorageBufferAttribute(drawGroups, 1), 'uint', D);

    const indirectK = Fn(() => {
      const i = instanceIndex;
      If(i.greaterThanEqual(D), () => {
        Return();
      });
      const g = drawGroupBuf.element(i) as unknown as NU;
      const raw = atomicLoad(counters.element(g)) as unknown as NU;
      const cap = capBuf.element(g) as unknown as NU;
      indirectStore.element(i.mul(5).add(1)).assign(raw.greaterThan(cap).select(cap, raw));
    })().compute(D);
    indirectK.setName('ringIndirect');

    this.kernels = [clearK, grassK, debrisK, farK, indirectK];
  }

  /** blade/tuft material — color matched to the terrain grass palette */
  private grassMaterial(
    bind: RingBind,
    fades: [number | null, number | null],
    tuft: boolean,
    far = false,
  ): MeshStandardNodeMaterial {
    const mat = new MeshStandardNodeMaterial();
    const { wc, y, wpos } = fetchRing(bind);
    const h2 = cellHash2(wc, bind.salt ^ 0x9191);
    // patch-level (≈1.6 m) dryness/hue so meadows read as drifts, not noise
    const patch = cellHash2(wc.mul(0.125).floor(), bind.salt ^ 0x3333);
    // GREENLAND: coarse (~20 m) drift hash → which grass TYPE dominates here
    // (drives both colour below and blade height, so tussock drifts stand
    // taller than short sedge/moss-grass drifts).
    const drift = cellHash2(wc.mul(0.05).floor(), bind.salt ^ 0x7777);
    const tilt = cellHash2(wc, bind.salt ^ 0x4545).sub(0.5).mul(0.5);
    // GroundRing can live under a rotation/translation island in the Greenland
    // client. `cameraPosition` is then ECEF while `wpos` is LAAS-local, which
    // pushes every near/mid fade past its cutoff and leaves only the unfaded
    // outer tuft ring visible. Forests already publishes the main proxy-camera
    // position through vegViewPos; keep every vegetation LOD in that one frame.
    const dist = wpos.sub(vec2(vegViewPos.x, vegViewPos.z)).length();
    // width compensation for the continuous thinning — coverage conserved.
    // far mode: coarse-grid super-tufts have their own fixed footprint
    const widen = far
      ? h2.y.mul(0.8).add(1.6)
      : float(GRASS_BASE_WIDEN).div(grassThin(dist).sqrt()).clamp(GRASS_BASE_WIDEN, 5);
    // GREENLAND: heath/tundra/fell are dwarf-shrub + MOSS ground — a low dense
    // MAT, not tall grass. Sample the zone and shorten the sward hard there so
    // it reads as tundra ground-cover; meadow & mire keep tall grass/sedge.
    // [0 nival, 1 fell, 2 tundra, 3 heath, 4 meadow, 5 mire]
    const bioIdG = (
      texture(
        this.hf.biomeTex as NonNullable<typeof this.hf.biomeTex>,
        wpos.div(this.hf.worldSize).add(0.5),
      ) as unknown as NV4
    ).x
      .mul(8)
      .add(0.5)
      .floor()
      .toInt();
    const matH = bioIdG.equal(int(4)).select(
      float(1.0),
      bioIdG.equal(int(5)).select(
        float(0.95),
        bioIdG.equal(int(3)).select(
          float(0.5),
          bioIdG.equal(int(2)).select(
            float(0.45),
            bioIdG.equal(int(1)).select(float(0.4), float(0.35)),
          ),
        ),
      ),
    ) as unknown as NF;
    const bladeH = h2.x
      .pow(1.3)
      .mul(far ? 0.42 : 0.3)
      .add(far ? 0.34 : 0.2)
      .mul(tuft && !far ? 2.0 : 1)
      .mul(widen.sub(1).mul(0.3).add(1))
      // GREENLAND: per-drift height variety (short sedge ↔ taller tussock)
      .mul(drift.y.mul(0.6).add(0.68))
      .mul(matH);
    const yawA = h2.y.mul(6.2831853);
    const c = yawA.cos();
    const s = yawA.sin();
    const ls = positionLocal.mul(
      vec3(widen.mul(tuft ? 1.5 : 1.15), bladeH, 1),
    );
    const rx = ls.x.mul(c).add(ls.z.mul(s));
    const rz = ls.z.mul(c).sub(ls.x.mul(s));
    // wind: cantilever bend (tip²) riding the traveling gust field + a fine
    // per-blade shimmer; tips dip as they deflect. Same field as the trees
    // (Wind.ts) so meadow waves and canopy surges line up.
    let dx: NF = float(0);
    let dy: NF = float(0);
    let dz: NF = float(0);
    if (windContext()) {
      const wd = vec2(windU.dir as unknown as NV2);
      const tN = positionLocal.y; // 0..1 along the blade
      const st = windU.strength as unknown as NF;
      const amp = st
        .mul(gustAt(wpos).mul(0.9).add(0.3))
        .mul(windExposure(wpos));
      // lean² rule (matches the tree rework): strong wind flattens the
      // sward — deflection grows superlinearly, the tempo doesn't change
      const bend = amp
        .mul(st.mul(0.55).add(0.6))
        .mul(tN.mul(tN))
        .mul(bladeH.mul(0.42));
      const flut = far
        ? (float(0) as NF)
        : time
            .mul(5.2)
            .add(h2.x.mul(6.2832))
            .add(wpos.x.add(wpos.y).mul(0.9))
            .sin()
            .mul(tN)
            .mul(amp)
            .mul(0.05);
      dx = wd.x.mul(bend).sub(wd.y.mul(flut));
      dz = wd.y.mul(bend).add(wd.x.mul(flut));
      dy = bend.mul(tN).mul(-0.4);
    }
    // player trample: blades shear away from the walker's legs (base stays
    // planted). Near ring only — the effect radius is ~1 m, far ring starts
    // way beyond it.
    if (!far) {
      const tr = trampleOffset(
        wpos as unknown as NV2,
        y as unknown as NF,
        ls.y as unknown as NF,
      );
      dx = dx.add(tr.x);
      dy = dy.add(tr.y);
      dz = dz.add(tr.z);
    }
    // random lean (shear) — vertical uniform blades read as planted corn
    mat.positionNode = vec3(
      rx.add(tilt.x.mul(ls.y)).add(dx).add(wpos.x),
      ls.y.add(y).add(GRASS_ROOT_LIFT).add(dy),
      rz.add(tilt.y.mul(ls.y)).add(dz).add(wpos.y),
    );
    // Blade shading normal (feedback 2.7+2.9): yaw-rotate the baked rounded
    // normal, then pull it toward the TERRAIN normal — a sward lights like
    // the hillside it grows on (the GoT move; per-blade card normals made
    // meadows sparkle gray). Harder pull with distance: near keeps blade
    // curvature, far converges on the splat so the g2 band dissolves clean.
    const nR = vec3(
      normalLocal.x.mul(c).add(normalLocal.z.mul(s)),
      normalLocal.y,
      normalLocal.z.mul(c).sub(normalLocal.x.mul(s)),
    );
    const tNrm = (
      texture(
        this.hf.normalTex,
        wpos.div(this.hf.worldSize).add(0.5),
        0,
      ) as unknown as NV4
    ).xyz.normalize();
    const upK = far
      ? (float(1) as NF)
      : smoothstep(8, 70, dist).mul(0.35).add(0.5);
    // VERTEX-stage shading hoist (Phase 7 perf): every term below varies at
    // ≥ blade scale (per-cell hashes, 1.5 m+ probe/canopy/heightfield
    // fields) — evaluating them per fragment re-ran the ring storage reads,
    // 4 hashes and 2 texture fetches for every overdrawn pixel of a 1–4 px
    // blade. varying() moves them to the vertex stage; interpolation across
    // a few-cm triangle is sub-quantization (verified by pixel diff).
    const nBlendV = varying(
      mix(nR.normalize(), tNrm, upK) as unknown as Parameters<typeof varying>[0],
    ) as unknown as NV3;
    mat.normalNode = transformNormalToView(
      nBlendV.normalize() as unknown as NV3,
    ) as unknown as typeof mat.normalNode;

    const t = uv().y as unknown as NF;
    // GREENLAND summer tundra: NOT a uniform lawn — a mosaic of grass types in
    // coarse drifts. `gtype` (per ~20 m drift) blends between deep green sedge
    // (0) and pale yellow-green tussock (1); a second axis pushes some drifts
    // toward grey-green. Original temperate palette was a single green:
    // fresh (0.02,0.062,0.011)→(0.065,0.148,0.028).
    const gtype = smoothstep(0.25, 0.85, drift.x) as unknown as NF;
    const freshBase = mix(
      vec3(0.022, 0.05, 0.015),
      vec3(0.05, 0.056, 0.022),
      gtype,
    ) as unknown as NV3;
    const freshTip = mix(
      vec3(0.07, 0.152, 0.04), // green sedge tip
      vec3(0.17, 0.182, 0.062), // pale yellow-green tussock tip
      gtype,
    ) as unknown as NV3;
    // grey-green drifts (older sward): desaturate a fraction of patches
    const greyK = smoothstep(0.6, 0.95, drift.y).mul(0.4) as unknown as NF;
    const fresh = mix(
      mix(freshBase, freshTip, t.mul(t)) as unknown as NV3,
      vec3(0.075, 0.09, 0.06),
      greyK,
    ) as unknown as NV3;
    const dry = mix(
      vec3(0.1, 0.085, 0.032),
      vec3(0.235, 0.19, 0.09),
      t,
    ) as unknown as NV3;
    // shade-grown grass: under crowns the sward stays deep cool green (dry
    // straw patches are a full-sun phenomenon) — without this the carpet
    // reads as a pale glowing mat inside forest interiors
    const cov = canopyAt(this.canopyTex, wpos);
    // GREENLAND: more tan/senescent drifts for tundra variety (was 0.7..0.95)
    const dryK = smoothstep(0.5, 0.92, patch.x).mul(
      float(1).sub(cov.mul(0.85)),
    );
    let albedo = mix(fresh, dry, dryK) as unknown as NV3;
    albedo = albedo.mul(patch.y.sub(0.5).mul(0.3).add(1)) as unknown as NV3;
    albedo = mix(albedo, vec3(0.018, 0.052, 0.014), cov.mul(0.55)) as unknown as NV3;
    // GREENLAND: on tundra/heath/mire the low sward reads as MOSS ground-cover —
    // deep dark green in patches (the moss-tuft catalog type folded into the
    // carpet). Patch-hashed so it mottles with the sedge/grass drifts.
    const mossZone = bioIdG.equal(int(2)).or(bioIdG.equal(int(3))).or(bioIdG.equal(int(5)));
    const mossK = mossZone.select(smoothstep(0.35, 0.75, patch.y).mul(0.6), float(0));
    albedo = mix(albedo, vec3(0.035, 0.082, 0.045), mossK as unknown as NF) as unknown as NV3;
    // SPRING (live uniform): fresh vivid snowmelt green; AUTUMN turns the sward
    // golden-tan; WINTER frosts it to pale dormant straw (snow buries most of it
    // via the terrain snow blanket).
    albedo = mix(albedo, vec3(0.05, 0.16, 0.03), seasonU.spring.mul(0.55)) as unknown as NV3;
    albedo = mix(albedo, vec3(0.26, 0.17, 0.05), seasonU.autumn.mul(0.6)) as unknown as NV3;
    albedo = mix(albedo, vec3(0.5, 0.47, 0.4), seasonU.winter.mul(0.7)) as unknown as NV3;
    mat.colorNode = varying(
      albedo as unknown as Parameters<typeof varying>[0],
    ) as unknown as typeof mat.colorNode;
    mat.emissiveNode = varying(
      grassTranslucency(albedo, t) as unknown as Parameters<typeof varying>[0],
    ) as unknown as typeof mat.emissiveNode;
    mat.aoNode = varying(
      smoothstep(0.0, 0.55, t).mul(0.55).add(0.45) as unknown as Parameters<typeof varying>[0],
    ) as unknown as typeof mat.aoNode;
    mat.roughness = 0.88;
    mat.metalness = 0;
    mat.side = DoubleSide;
    // Use the same world-cell threshold for every grass LOD. A screen-space
    // threshold changed as the camera pitched, making an otherwise unchanged
    // carpet disappear even while the GPU draw counts remained constant.
    bandFade(mat, dist, fades[0], fades[1], G_BAND, h2.x);
    return mat;
  }

  /** cobbles/pebbles/twigs/chips/litter placement (yaw + scale + sink) */
  private debrisTransform(
    mat: MeshStandardNodeMaterial,
    bind: RingBind,
    scaleK: number,
  ): void {
    const { wc, y, wpos } = fetchRing(bind);
    const h2 = cellHash2(wc, bind.salt ^ 0x7777);
    const scl = h2.x.mul(0.9).add(0.55).mul(scaleK);
    const yawA = h2.y.mul(6.2831853);
    const c = yawA.cos();
    const s = yawA.sin();
    const ls = positionLocal.mul(scl);
    const rx = ls.x.mul(c).add(ls.z.mul(s));
    const rz = ls.z.mul(c).sub(ls.x.mul(s));
    const sink = scl.mul(0.22);
    mat.positionNode = Fn(() => {
      const n = vec3(
        normalLocal.x.mul(c).add(normalLocal.z.mul(s)),
        normalLocal.y,
        normalLocal.z.mul(c).sub(normalLocal.x.mul(s)),
      ).toVar();
      normalLocal.assign(n);
      return vec3(rx.add(wpos.x), ls.y.add(y).sub(sink), rz.add(wpos.y));
    })();
    const dist = wpos.sub(vec2(vegViewPos.x, vegViewPos.z)).length();
    bandFade(mat, dist, null, DEB_R - 6, 5, h2.x);
  }

  update(
    renderer: Renderer,
    camera: PerspectiveCamera,
    residencyFocus: Vector3 = camera.position,
  ): void {
    this.camU.value.copy(residencyFocus);
    this.frame++;
    if (this.cullValid
        && this.lastCullFocus.distanceToSquared(residencyFocus) <= CULL_FOCUS_EPSILON_SQ) {
      this.cullSkips++;
      if (this.frame % 90 === 30 && !this.reading) {
        this.reading = true;
        void this.readStats(renderer);
      }
      return;
    }
    for (const k of this.kernels) {
      renderer.compute(k as Parameters<Renderer['compute']>[0]);
    }
    this.lastCullFocus.copy(residencyFocus);
    this.cullValid = true;
    this.cullSubmits++;
    if (this.frame % 90 === 30 && !this.reading) {
      this.reading = true;
      void this.readStats(renderer);
    }
  }

  counterSnapshot(): Record<string, number> {
    return {
      ...this.hud,
      'veg.groundCullSubmits': this.cullSubmits,
      'veg.groundCullSkips': this.cullSkips,
    };
  }

  invalidateVisibility(): void {
    this.cullValid = false;
  }

  private async readStats(renderer: Renderer): Promise<void> {
    try {
      const attr = (this.counters as unknown as { value: unknown }).value;
      const ab = await renderer.getArrayBufferAsync(
        attr as Parameters<Renderer['getArrayBufferAsync']>[0],
      );
      const c = new Uint32Array(ab);
      const n = (g: number): number => Math.min(c[g] ?? 0, this.caps[g] ?? 0);
      this.hud = {
        'veg.grass': n(0) + n(1) + n(2) + n(8),
        'veg.g0': n(0),
        'veg.g1': n(1),
        'veg.g2': n(2),
        'veg.g3': n(8),
        'veg.debris': n(3) + n(4) + n(5) + n(6) + n(7),
      };
    } finally {
      this.reading = false;
    }
  }
}
