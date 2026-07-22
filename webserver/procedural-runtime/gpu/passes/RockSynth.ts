/**
 * RockSynth — one-time GPU bake of a tileable rock surface modelled on REAL
 * Greenland bedrock: glacially-rounded Precambrian gneiss. CLEAN-ROOM and
 * self-contained: its own copy of the periodic noise math, no dependency on
 * BarkSynth.
 *
 *   texA = albedo.rgb (sqrt-encoded) + cavity AO (a)
 *   texB = tangent normal.xy (0..1) + roughness (b) + height (a)
 *
 * What real Greenland boulders look like (photo refs): mostly SMOOTH ice-
 * polished faces — not all-over crackle — with (a) sparse open joints whose
 * width varies and whose shoulders are rounded by weathering, (b) gentle
 * foliation banding (pale quartzofeldspathic vs dark amphibolite, occasional
 * pinkish feldspar), (c) mm-scale crystalline grain + mica/quartz glints,
 * (d) shallow weathering pits, (e) rusty iron staining seeping from cracks.
 * The height field encodes those and the normal is derived at full strength
 * (the previous bake's normalK≈2.4 × 1.5px step gave ~0.3% slope = flat).
 */

import { LinearMipmapLinearFilter, RepeatWrapping, Vector2 } from 'three';
import { StorageTexture, type Renderer } from 'three/webgpu';
import {
  Fn,
  float,
  instanceIndex,
  int,
  ivec2,
  mix,
  sqrt,
  textureStore,
  uint,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { hash12 } from '../noise/NoiseTSL';
import type { NF, NV2, NV3 } from '../TSLTypes';

export const ROCK_RES = 1024;

function sqrtV3(v: NV3): NV3 {
  return sqrt(v as unknown as NF) as unknown as NV3;
}

// --- self-contained PERIODIC noise (tiles at `periodX/periodY` cells) -------
function pnoise(p: NV2, periodX: number, periodY: number, seedK: number): NF {
  const cell = p.floor();
  const f = p.fract();
  const u = f.mul(f).mul(f.negate().mul(2).add(3));
  const wrap = (c: NV2): NV2 =>
    vec2(
      c.x.sub(c.x.div(periodX).floor().mul(periodX)),
      c.y.sub(c.y.div(periodY).floor().mul(periodY)),
    );
  const h = (ox: number, oy: number): NF =>
    hash12(wrap(cell.add(vec2(ox, oy))).add(seedK * 17.17));
  const a = h(0, 0);
  const b = h(1, 0);
  const c = h(0, 1);
  const d = h(1, 1);
  return a
    .add(b.sub(a).mul(u.x))
    .add(c.sub(a).mul(u.y))
    .add(a.sub(b).sub(c).add(d).mul(u.x).mul(u.y));
}

function pfbm(p: NV2, octaves: number, period: number, seedK: number): NF {
  let sum: NF = float(0);
  let amp = 0.5;
  let scale = 1;
  for (let i = 0; i < octaves; i++) {
    sum = sum.add(
      pnoise(p.mul(scale), period * scale, period * scale, seedK + i * 7).mul(amp),
    );
    amp *= 0.5;
    scale *= 2;
  }
  return sum;
}

/** periodic worley: F1 (nearest), edge (F2−F1 → ~0 at boundaries = crack) and
 *  id (hash of the winning cell → per-block variation) */
function pworley(
  p: NV2,
  period: Vector2,
  seedK: number,
): { f1: NF; edge: NF; id: NF } {
  const cell = p.floor();
  const f = p.fract();
  const wrapX = (v: NF): NF => v.sub(v.div(period.x).floor().mul(period.x));
  const wrapY = (v: NF): NF => v.sub(v.div(period.y).floor().mul(period.y));
  const dists: NF[] = [];
  const ids: NF[] = [];
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = cell.x.add(ox);
      const cy = cell.y.add(oy);
      const hx = hash12(vec2(wrapX(cx), wrapY(cy)).add(seedK * 31.7));
      const hy = hash12(vec2(wrapX(cx), wrapY(cy)).add(seedK * 31.7 + 911.3));
      const feat = vec2(float(ox).add(hx), float(oy).add(hy));
      const d = feat.sub(f);
      dists.push(d.dot(d));
      ids.push(hash12(vec2(wrapX(cx), wrapY(cy)).add(seedK * 31.7 + 477.7)));
    }
  }
  let f1: NF = dists[0] as NF;
  let id: NF = ids[0] as NF;
  for (let i = 1; i < 9; i++) {
    const di = dists[i] as NF;
    const closer = di.lessThan(f1);
    id = closer.select(ids[i] as NF, id);
    f1 = f1.min(di);
  }
  let f2: NF = float(9);
  for (let i = 0; i < 9; i++) {
    const di = dists[i] as NF;
    f2 = f2.min(di.add(di.lessThanEqual(f1.add(1e-5)).select(float(10), float(0))));
  }
  const f1s = f1.sqrt();
  return { f1: f1s, edge: f2.sqrt().sub(f1s), id };
}

/** everything the surface model produces at one point. Height drives the
 *  normal; the masks drive albedo/roughness so colour and relief agree. */
interface RockPoint {
  h: NF;
  /** deep open-joint slot (1 = inside the crack) */
  slot: NF;
  /** rounded crack shoulder (bevel zone, excludes the slot) */
  shoulder: NF;
  /** weathering-pit depression */
  pits: NF;
  /** foliation band phase 0..1 (dark amphibolite ↔ pale felsic) */
  band: NF;
  /** per-fracture-block random 0..1 (subtle tone shifts between blocks) */
  blockId: NF;
}

function rockPoint(uvN: NV2, seedK: number): RockPoint {
  // strong multi-scale domain warp — real joints wander, they are not
  // straight polygon edges (the old 0.08 warp is what made hexagons)
  const warpA = vec2(
    pfbm(uvN.mul(2), 3, 2, seedK + 13).sub(0.5),
    pfbm(uvN.mul(2), 3, 2, seedK + 61).sub(0.5),
  ).mul(0.22);
  const warpB = vec2(
    pnoise(uvN.mul(9), 9, 9, seedK + 23).sub(0.5),
    pnoise(uvN.mul(9), 9, 9, seedK + 71).sub(0.5),
  ).mul(0.045);
  const q = uvN.add(warpA).add(warpB);

  // fracture networks. KEY REALISM RULE: most of the surface is UNBROKEN —
  // cracks only open inside sparse fracture zones (gated), and macro/meso
  // zones differ so the two networks don't outline the same cells.
  const macro = pworley(q.mul(3), new Vector2(3, 3), seedK);
  const meso = pworley(q.mul(7), new Vector2(7, 7), seedK + 7);
  const fracZone = pfbm(uvN.mul(2), 2, 2, seedK + 111);
  const macroGate = fracZone.smoothstep(0.32, 0.55);
  const mesoGate = pfbm(uvN.mul(3).add(4.7), 2, 3, seedK + 131).smoothstep(0.45, 0.68);

  // crack profile: wide soft weathered shoulder + narrow deep slot. Width is
  // modulated along the crack so joints pinch and swell like real ones.
  const widthMod = pnoise(q.mul(13), 13, 13, seedK + 151).mul(0.7).add(0.65);
  const mShoulder = float(1)
    .sub(macro.edge.div(float(0.34).mul(widthMod)).clamp(0, 1))
    .pow(2);
  const mSlot = float(1).sub(macro.edge.div(float(0.07).mul(widthMod)).clamp(0, 1));
  const sShoulder = float(1)
    .sub(meso.edge.div(float(0.2).mul(widthMod)).clamp(0, 1))
    .pow(2);
  const sSlot = float(1).sub(meso.edge.div(float(0.05).mul(widthMod)).clamp(0, 1));
  const crackM = mShoulder.mul(0.2).add(mSlot.mul(0.3)).mul(macroGate);
  const crackS = sShoulder.mul(0.08).add(sSlot.mul(0.17)).mul(mesoGate);
  const slot = mSlot.mul(macroGate).max(sSlot.mul(mesoGate));
  const shoulder = mShoulder
    .mul(macroGate)
    .max(sShoulder.mul(mesoGate))
    .mul(float(1).sub(slot));

  // glacial dome rounding: each block bulges gently toward its centre
  const dome = macro.f1.mul(0.16);

  // weathering pits: sparse shallow rounded hollows on otherwise smooth faces
  const pitW = pworley(q.mul(5).add(31.7), new Vector2(5, 5), seedK + 29);
  const pitZone = pnoise(uvN.mul(3), 3, 3, seedK + 77).smoothstep(0.55, 0.78);
  const pits = float(1)
    .sub(pitW.f1.div(0.4).clamp(0, 1))
    .pow(1.6)
    .mul(pitZone);

  // gneiss foliation: banding warped by the same domain warp so it flows
  // around blocks. Kept LOW relief — it's mostly a colour feature.
  const bandRaw = pnoise(q.mul(vec2(2, 8)), 2, 8, seedK + 41)
    .mul(0.72)
    .add(pnoise(q.mul(vec2(4, 16)), 4, 16, seedK + 43).mul(0.28));
  const band = bandRaw;

  // mm-scale crystalline grain
  const grain = pfbm(uvN.mul(48), 4, 48, seedK + 91).sub(0.5);

  const h = float(0.58)
    .add(dome)
    .add(band.sub(0.5).mul(0.06))
    .add(grain.mul(0.09))
    .sub(crackM)
    .sub(crackS)
    .sub(pits.mul(0.13));

  return { h, slot, shoulder, pits, band, blockId: macro.id };
}

/** height only — re-evaluated at offsets to derive the normal */
function rockHeight(uvN: NV2, seedK: number): NF {
  return rockPoint(uvN, seedK).h;
}

export interface RockTextures {
  texA: StorageTexture;
  texB: StorageTexture;
}

export async function bakeRockTexture(
  renderer: Renderer,
  seedK: number,
): Promise<RockTextures> {
  const mk = (): StorageTexture => {
    const t = new StorageTexture(ROCK_RES, ROCK_RES);
    t.wrapS = RepeatWrapping;
    t.wrapT = RepeatWrapping;
    t.generateMipmaps = true;
    t.minFilter = LinearMipmapLinearFilter;
    t.anisotropy = 4;
    return t;
  };
  const texA = mk();
  const texB = mk();

  const kernel = Fn(() => {
    const id = instanceIndex;
    const xi = id.mod(uint(ROCK_RES));
    const yi = id.div(uint(ROCK_RES));
    const uvN = vec2(float(xi).add(0.5), float(yi).add(0.5)).div(ROCK_RES);

    const pt = rockPoint(uvN, seedK);
    const h = pt.h.toVar();

    // normal: finite differences at ~2px. normalK is calibrated for REAL
    // relief — tile ≈ 1.8 m world, height amplitude ≈ 8 cm → slope factor
    // e·K must be ≈ 0.1 (old bake had 0.0035 → invisible).
    const e = 2 / ROCK_RES;
    const hx0 = rockHeight(uvN.add(vec2(-e, 0)), seedK);
    const hx1 = rockHeight(uvN.add(vec2(e, 0)), seedK);
    const hy0 = rockHeight(uvN.add(vec2(0, -e)), seedK);
    const hy1 = rockHeight(uvN.add(vec2(0, e)), seedK);
    const normalK = 70;
    const n = vec3(
      hx0.sub(hx1).mul(normalK * 0.5),
      hy0.sub(hy1).mul(normalK * 0.5),
      float(1),
    ).normalize();

    // ---- ALBEDO: banded grey gneiss ---------------------------------------
    // pale quartzofeldspathic vs dark amphibolite foliation, pinkish feldspar
    // in some pale bands, per-block tone shift, mm crystal speckle, rust
    // seeping from joints, dark crack interiors.
    const dark = vec3(0.25, 0.245, 0.23); // amphibolite band
    const pale = vec3(0.6, 0.585, 0.56); // felsic band
    let albedo: NV3 = mix(dark, pale, pt.band.smoothstep(0.25, 0.75)) as unknown as NV3;
    // crystalline grain shows in the colour too, not just relief
    const grainC = pfbm(uvN.mul(48), 4, 48, seedK + 91).sub(0.5);
    albedo = albedo.mul(grainC.mul(0.5).add(1)) as unknown as NV3;
    // pinkish K-feldspar veins inside SOME pale bands
    const pinkZone = pnoise(uvN.mul(vec2(2, 5)), 2, 5, seedK + 171).smoothstep(0.62, 0.8);
    albedo = mix(
      albedo,
      vec3(0.58, 0.47, 0.4),
      pinkZone.mul(pt.band.smoothstep(0.55, 0.85)).mul(0.65),
    ) as unknown as NV3;
    // per-block tone: fractured blocks weather at different rates
    albedo = albedo.mul(pt.blockId.sub(0.5).mul(0.14).add(1)) as unknown as NV3;
    // large-scale weathering mottle
    const mott = pfbm(uvN.mul(2).add(9.1), 3, 2, seedK + 201).sub(0.5).mul(0.36);
    albedo = albedo.mul(mott.add(1)) as unknown as NV3;
    // crystal speckle: bright quartz + dark biotite flecks (mm scale)
    const spq = pfbm(uvN.mul(96), 2, 96, seedK + 303);
    const spb = pfbm(uvN.mul(88).add(3.3), 2, 88, seedK + 313);
    albedo = mix(albedo, vec3(0.7, 0.69, 0.67), spq.smoothstep(0.72, 0.92).mul(0.45)) as unknown as NV3;
    albedo = mix(albedo, vec3(0.14, 0.13, 0.12), spb.smoothstep(0.74, 0.94).mul(0.5)) as unknown as NV3;
    // iron staining: rusty wash in patches, strongest at crack shoulders
    const rustZone = pfbm(uvN.mul(3).add(17.3), 2, 3, seedK + 401).smoothstep(0.55, 0.8);
    const rust = rustZone.mul(pt.shoulder.mul(0.7).add(0.3)).clamp(0, 1);
    albedo = mix(albedo, vec3(0.34, 0.22, 0.13), rust.mul(0.55)) as unknown as NV3;
    // crack interiors: dark, slightly cool (shadowed, damp)
    albedo = mix(albedo, vec3(0.11, 0.11, 0.115), pt.slot.mul(0.75)) as unknown as NV3;
    // weathering pits collect grime
    albedo = albedo.mul(float(1).sub(pt.pits.mul(0.2))) as unknown as NV3;
    // chipped edge wear: crack shoulders read slightly pale/fresh
    albedo = mix(
      albedo,
      vec3(0.62, 0.6, 0.57),
      pt.shoulder.mul(float(1).sub(rust)).mul(0.18),
    ) as unknown as NV3;

    // cavity AO: cracks + pits, NOT the banding
    const cavity = float(1)
      .sub(pt.slot.mul(0.5))
      .sub(pt.shoulder.mul(0.18))
      .sub(pt.pits.mul(0.25))
      .clamp(0.35, 1);

    // roughness: ice-polished proud faces keep a subtle sheen; cracks/pits
    // rough; quartz specks glint
    const rough = float(0.86)
      .add(pt.slot.mul(0.1))
      .add(pt.pits.mul(0.08))
      .sub(spq.smoothstep(0.72, 0.92).mul(0.25))
      .sub(pt.band.smoothstep(0.25, 0.75).mul(0.06));

    const albEnc = sqrtV3(albedo.clamp(0, 1) as unknown as NV3);
    textureStore(texA, ivec2(int(xi), int(yi)), vec4(albEnc, cavity));
    textureStore(
      texB,
      ivec2(int(xi), int(yi)),
      vec4(n.xy.mul(0.5).add(0.5), rough.clamp(0.4, 1), h.clamp(0, 1)),
    );
  })().compute(ROCK_RES * ROCK_RES);
  kernel.setName('rockSynth');

  await renderer.computeAsync(kernel);
  return { texA, texB };
}
