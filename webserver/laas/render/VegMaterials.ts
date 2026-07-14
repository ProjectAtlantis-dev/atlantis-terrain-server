/**
 * Vegetation materials (v1: structure-review shading; TexSynth bark/leaf
 * detail + translucency land with the texture milestone).
 *
 * All vegetation geometry carries a `vdata` vec4 attribute:
 *   x hue jitter (−1..1) · y sway flexibility · z sway phase · w baked AO.
 * Hue/AO are consumed here; sway feeds the Phase-6 wind field.
 */

import { Color, DoubleSide, type DirectionalLight, type Texture, Vector3 } from 'three';
import { MeshPhysicalNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import {
  attribute,
  cameraPosition,
  clamp,
  float,
  mix,
  normalMap,
  normalWorld,
  positionWorld,
  smoothstep,
  texture,
  transformNormalToView,
  uv,
  varying,
  vec2,
  vec3,
} from 'three/tsl';
import { fbm3, valueNoise3 } from '../gpu/noise/NoiseTSL';
import type { NF, NV3, NV4 } from '../gpu/TSLTypes';
import { applyCaustics } from './Caustics';
import { runiform } from '../gpu/RenderUniform';
import { seasonFlower, seasonFoliageTint } from './Season';
import type { RockTextures } from '../gpu/passes/RockSynth';

/**
 * Shared sun uniforms for the foliage translucency term (D-2). Updated by
 * the scene on init + time-of-day changes.
 */
export const sunU = {
  dir: runiform(new Vector3(0, 1, 0)),
  color: runiform(new Color(1, 1, 1)),
  intensity: runiform(0),
};

export function updateSunUniforms(sun: DirectionalLight): void {
  sunU.dir.value.copy(sun.position).normalize();
  sunU.color.value.copy(sun.color);
  sunU.intensity.value = sun.intensity;
}

/**
 * Back-lit transmission glow: light through the blade toward a camera that
 * faces the sun. Thin-surface approximation; modest k since it is not
 * shadow-gated yet (full gating with Phase-5/6 light queries).
 */
function translucency(albedo: NV3, k: number): NV3 {
  const viewDir = positionWorld.sub(cameraPosition).normalize();
  const toward = clamp(viewDir.dot(vec3(sunU.dir).negate()), 0, 1);
  const glow = toward.pow(5).mul(sunU.intensity).mul(k);
  const sunCol = sunU.color as unknown as NV3;
  return albedo.mul(sunCol).mul(glow).mul(vec3(0.9, 1.05, 0.55));
}

/** grass variant: transmission strengthens toward the blade tip */
export function grassTranslucency(albedo: NV3, tipT: NF): NV3 {
  return translucency(albedo, 0.09).mul(tipT);
}

function vdata(): NV4 {
  return attribute('vdata', 'vec4') as unknown as NV4;
}

/** hue jitter: rotate albedo toward yellow (+) / blue-green (−) */
function hueShift(base: NV3, hue: NF, amount: number): NV3 {
  const k = hue.mul(amount);
  const warm = vec3(1.18, 1.0, 0.55);
  const cool = vec3(0.7, 0.95, 1.25);
  const shifted = base
    .mul(warm)
    .mul(clamp(k, 0, 1))
    .add(base.mul(cool).mul(clamp(k.negate(), 0, 1)))
    .add(base.mul(float(1).sub(k.abs())));
  return shifted;
}

export interface BarkMatParams {
  color: { r: number; g: number; b: number };
  roughness?: number;
}

export function barkMaterial(p: BarkMatParams): MeshStandardNodeMaterial {
  const mat = new MeshPhysicalNodeMaterial();
  mat.specularIntensity = 0.45;
  const d = vdata();
  const base = vec3(p.color.r, p.color.g, p.color.b);
  mat.colorNode = hueShift(base, d.x, 0.18).mul(d.w.mul(0.75).add(0.25));
  mat.roughness = p.roughness ?? 0.93;
  mat.metalness = 0;
  return mat;
}

/**
 * Synthesized bark material: tileable albedo/cavity + normal/rough/height.
 * Cavity feeds `aoNode` — AO on indirect light only (DEVIATIONS D-1 close).
 */
export function barkTexturedMaterial(tex: {
  texA: Texture;
  texB: Texture;
}): MeshStandardNodeMaterial {
  const mat = new MeshPhysicalNodeMaterial();
  mat.specularIntensity = 0.45;
  const d = vdata();
  const a = texture(tex.texA, uv() as never) as unknown as NV4;
  const b = texture(tex.texB, uv() as never) as unknown as NV4;
  const albedo = a.rgb.mul(a.rgb); // sqrt-encoded at bake
  mat.colorNode = hueShift(albedo, d.x, 0.14).mul(d.w.mul(0.45).add(0.55));
  mat.normalNode = normalMap(vec3(b.x, b.y, 1));
  mat.aoNode = a.w;
  mat.roughnessNode = b.z;
  mat.metalness = 0;
  // tubes are closed — DoubleSide costs ~nothing and guarantees a trunk can
  // never read hollow regardless of LOD/dither state ("inside-out" report)
  mat.side = DoubleSide;
  return mat;
}

/**
 * Procedural rock shading (no UVs): strata banding from vdata.y, lichen
 * spots + dust on open faces, moss by upness (dressing rule), cavity AO via
 * aoNode. Geometric normals carry the meso detail (displaced mesh).
 */
export function rockMaterial(opts?: {
  moss?: number;
  /** base albedo of the lit rock — talus must match the pale cliff that
   *  shed it; the default dark tone is for mossy forest boulders */
  tone?: { r: number; g: number; b: number };
  /** baked RockSynth detail (voronoi-crackle relief). Applied triplanar as a
   *  DETAIL layer, so the per-type tone + lichen/moss stay intact. */
  tex?: RockTextures;
}): MeshStandardNodeMaterial {
  const mat = new MeshPhysicalNodeMaterial();
  mat.specularIntensity = 0.4;
  const d = vdata();
  const wp = positionWorld;
  const strataT = d.y;
  const upness = normalWorld.y.max(0);
  // band tint: alternating warm/cool sediment layers + grain
  const bandTint = valueNoise3(vec3(float(0), strataT.mul(7.3), float(0)).add(wp.mul(0.02)));
  const grain = fbm3(wp.mul(2.1), 3).mul(0.5).add(0.5);
  // mid-gray default: the old near-black tone (0.21/0.165/0.12 peak) was
  // darker than ANY ground splat — boulders read as alien dark blobs on
  // pale dry soil (user feedback). Moss + canopy shade still darken
  // forest rocks; lit field rock is mid-gray in every reference.
  const tone = opts?.tone ?? { r: 0.285, g: 0.255, b: 0.215 };
  let albedo = mix(
    vec3(tone.r * 0.42, tone.g * 0.44, tone.b * 0.55),
    vec3(tone.r, tone.g, tone.b),
    bandTint.mul(0.55).add(grain.mul(0.45)).clamp(0, 1),
  ) as unknown as NV3;
  // GREENLAND: vivid multi-species lichen crusts on exposed rock — a defining
  // Arctic look. Xanthoria orange + Rhizocarpon map-lichen yellow-green + grey
  // crustose, each keyed off a different noise band. d.z = RockBuilder's
  // upper-face openness. (Original: single pale grey-green at 0.55.)
  // Lichen grows in SCATTERED colonies on exposed rock — most stone is bare
  // (user: coverage too uniform). expose concentrates it on up-faces (d.z =
  // RockBuilder openness), and ALL three species are gated to the same coarse
  // colony patches so there are large bare gaps between crusts. Grey crustose
  // dominant, khaki map-lichen sparse, orange Xanthoria rare flecks —
  // desaturated (vivid green reads as mould).
  // lichen favours exposed, PROUD faces (high d.z openness, high d.w = not a
  // cavity) — leaving the hollows to moss and the smooth mid-faces bare.
  const expose = d.z.mul(0.9).add(0.1).mul(d.w.mul(0.55).add(0.45));
  // per-rock gate: a LOW-freq field (~7 m period) is ~constant across one
  // boulder but decorrelates between them, so many rocks are wholly bare and
  // only some carry lichen — natural randomness, not lichen on every rock
  // (user). Multiplied into the colony patch mask below.
  const rockGate = smoothstep(0.4, 0.6, valueNoise3(wp.mul(0.15).add(51)));
  // North/shaded aspect: in the N hemisphere, north-facing rock gets little
  // direct sun and stays almost bare (user). World SOUTH ≈ (0.826, 0.564) in
  // XZ (noon sun azimuth from SunSky.sunDirection). sunny → 1 on south faces,
  // → 0 on north faces; aspectK drops lichen to ~15% on shaded aspects.
  const faceH = vec2(normalWorld.x, normalWorld.z);
  const sunny = faceH.dot(vec2(0.826, 0.564)).mul(0.5).add(0.5);
  const aspectK = smoothstep(0.3, 0.7, sunny).mul(0.96).add(0.04);
  const patchMask = smoothstep(0.5, 0.74, valueNoise3(wp.mul(0.85).add(5)))
    .mul(rockGate)
    .mul(aspectK);
  const lGrey = smoothstep(0.55, 0.8, valueNoise3(wp.mul(10).add(31)))
    .mul(expose).mul(patchMask);
  const lMap = smoothstep(0.78, 0.93, valueNoise3(wp.mul(9.3).add(11)))
    .mul(expose).mul(patchMask);
  const lOrange = smoothstep(0.87, 0.96, valueNoise3(wp.mul(13).add(3)))
    .mul(expose).mul(patchMask);
  albedo = mix(albedo, vec3(0.2, 0.205, 0.17), lGrey.mul(0.34)) as unknown as NV3;
  albedo = mix(albedo, vec3(0.24, 0.255, 0.13), lMap.mul(0.4)) as unknown as NV3;
  albedo = mix(albedo, vec3(0.5, 0.24, 0.05), lOrange.mul(0.5)) as unknown as NV3;
  const lich = lGrey.max(lMap).max(lOrange); // drives roughness below
  // dust settles on up-faces
  albedo = mix(albedo, vec3(0.17, 0.15, 0.12), upness.pow(2).mul(0.3)) as unknown as NV3;
  // dirt streaks bleeding down steep faces (dressing rule)
  const steep = float(1).sub(upness);
  const streakN = valueNoise3(vec3(wp.x.mul(2.6), wp.y.mul(0.22), wp.z.mul(2.6)));
  const streak = smoothstep(0.55, 0.82, streakN)
    .mul(smoothstep(0.45, 0.8, steep))
    .mul(0.55);
  albedo = mix(albedo, albedo.mul(vec3(0.5, 0.46, 0.4)), streak) as unknown as NV3;
  // moss in shaded concaves/cracks (up-ish + moss-noise patch); most rock stays
  // bare stone. Computed here so it feeds both albedo and roughness below.
  const mossAmt = opts?.moss ?? 0.25;
  const mossN = smoothstep(0.52, 0.82, fbm3(wp.mul(1.7), 3).mul(0.5).add(0.5));
  const moss = (mossAmt > 0
    ? smoothstep(0.25, 0.8, upness)
        .mul(mossN)
        .mul(smoothstep(0.12, 0.55, float(1).sub(d.w)))
        .mul(mossAmt * 1.7)
        .clamp(0, 1)
    : float(0)) as unknown as NF;
  albedo = mix(albedo, vec3(0.045, 0.085, 0.03), moss) as unknown as NV3;

  // ---- baked ROCK-SYNTH detail, TRIPLANAR (voronoi-crackle bake) -------------
  // Grayscale DETAIL layer: modulates the per-type tone + keeps lichen/moss.
  // Per-rock UV offset → each rock samples a different tile region (no clones).
  const tex = opts?.tex;
  if (tex) {
    // tile ≈ 1.25 m world → fracture blocks ~0.4 m, real boulder-joint scale
    // (1.3 gave ~20 cm cells = paving-stone look, user rejected)
    const freq = 0.8;
    const roff = valueNoise3(wp.mul(0.12).add(7)).mul(9.3);
    const p = wp.mul(freq).add(roff);
    const nAbs = normalWorld.abs();
    const wsum = nAbs.x.add(nAbs.y).add(nAbs.z).max(1e-4);
    const wx = nAbs.x.div(wsum);
    const wy = nAbs.y.div(wsum);
    const wz = nAbs.z.div(wsum);
    const aX = texture(tex.texA, p.zy) as unknown as NV4;
    const aY = texture(tex.texA, p.xz) as unknown as NV4;
    const aZ = texture(tex.texA, p.xy) as unknown as NV4;
    const bX = texture(tex.texB, p.zy) as unknown as NV4;
    const bY = texture(tex.texB, p.xz) as unknown as NV4;
    const bZ = texture(tex.texB, p.xy) as unknown as NV4;
    // albedo detail: sqrt-decode + normalise around mid → modulates the tone
    // (0.45 ≈ the new bake's mean gneiss albedo, so detail averages 1.0)
    const albEnc = aX.rgb.mul(wx).add(aY.rgb.mul(wy)).add(aZ.rgb.mul(wz));
    const detail = albEnc.mul(albEnc).div(0.45).clamp(0.3, 1.8);
    albedo = albedo.mul(detail) as unknown as NV3;
    // cavity AO (dark cracks) + roughness from the bake, blended with moss
    const bakedCav = aX.a.mul(wx).add(aY.a.mul(wy)).add(aZ.a.mul(wz));
    mat.aoNode = d.w.mul(bakedCav);
    const bakedRough = bX.b.mul(wx).add(bY.b.mul(wy)).add(bZ.b.mul(wz));
    mat.roughnessNode = mix(bakedRough, float(1), moss).sub(lich.mul(0.06)).clamp(0.35, 1);
    // triplanar NORMAL (UDN blend): baked tangent xy per plane → world perturb
    const tnX = bX.xy.mul(2).sub(1);
    const tnY = bY.xy.mul(2).sub(1);
    const tnZ = bZ.xy.mul(2).sub(1);
    const pert = vec3(0, tnX.y, tnX.x)
      .mul(wx)
      .add(vec3(tnY.x, 0, tnY.y).mul(wy))
      .add(vec3(tnZ.x, tnZ.y, 0).mul(wz));
    const bumped = normalWorld.add(pert.mul(1.3)).normalize();
    mat.normalNode = transformNormalToView(bumped) as unknown as typeof mat.normalNode;
  } else {
    mat.aoNode = d.w;
    mat.roughnessNode = mix(float(0.93), float(1), moss).sub(lich.mul(0.06));
  }
  mat.colorNode = albedo.mul(d.w.mul(0.35).add(0.65));
  mat.metalness = 0;
  // submerged boulders / streambed cobbles dance with the water caustics
  applyCaustics(mat);
  return mat;
}

/** deadfall wood: bark textures + moss carpet on the up-side by vdata.z */
export function deadwoodMaterial(
  tex: {
    texA: Texture;
    texB: Texture;
  },
  /** albedo multiplier — branches use the pale snag bark and blow out white
   *  at noon without a dry-wood darkening */
  dim?: { r: number; g: number; b: number },
): MeshStandardNodeMaterial {
  const mat = new MeshPhysicalNodeMaterial();
  mat.specularIntensity = 0.45;
  const d = vdata();
  const a = texture(tex.texA, uv() as never) as unknown as NV4;
  const b = texture(tex.texB, uv() as never) as unknown as NV4;
  let albedo = a.rgb.mul(a.rgb) as unknown as NV3;
  if (dim) albedo = albedo.mul(vec3(dim.r, dim.g, dim.b)) as unknown as NV3;
  const mossN = smoothstep(0.24, 0.58, fbm3(positionWorld.mul(2.6), 3).mul(0.5).add(0.5));
  const moss = smoothstep(0.05, 0.65, normalWorld.y).mul(d.z).mul(mossN).clamp(0, 1);
  albedo = mix(albedo, vec3(0.05, 0.1, 0.032), moss) as unknown as NV3;
  // rot darkening for heavily decayed wood
  albedo = albedo.mul(float(1).sub(d.z.mul(0.25))) as unknown as NV3;
  mat.colorNode = hueShift(albedo, d.x, 0.1);
  // logs lying across streams sit in the caustic band
  applyCaustics(mat);
  mat.normalNode = normalMap(vec3(b.x, b.y, 1));
  mat.aoNode = a.w;
  mat.roughnessNode = mix(b.z, float(1), moss);
  mat.metalness = 0;
  // same crossfade insurance as bark: a dither hole in a FrontSide closed
  // tube shows clean through (interior wall is a back face)
  mat.side = DoubleSide;
  return mat;
}

/**
 * Flower shading by vdata.x part id: 0 stem/leaf, 0.5 flower center, 1 petal.
 */
export function flowerMaterial(petal: {
  r: number;
  g: number;
  b: number;
}): MeshStandardNodeMaterial {
  const mat = new MeshStandardNodeMaterial();
  const d = vdata();
  // stem/leaf follows the season live; the bloom (centre + petals) only shows in
  // its season and otherwise fades to the dormant leaf colour — no winter flowers
  const dormant = vec3(0.045, 0.1, 0.03) as unknown as NV3;
  const stem = seasonFoliageTint(dormant);
  const center = seasonFlower(vec3(0.5, 0.32, 0.045) as unknown as NV3, dormant);
  const petalC = seasonFlower(vec3(petal.r, petal.g, petal.b) as unknown as NV3, dormant);
  const centerK = smoothstep(0.12, 0.02, d.x.sub(0.5).abs());
  const petalK = smoothstep(0.85, 0.95, d.x);
  let albedo = mix(stem, center, centerK) as unknown as NV3;
  albedo = mix(albedo, petalC, petalK) as unknown as NV3;
  mat.colorNode = albedo.mul(d.w.mul(0.5).add(0.5));
  // (the flower-head GEOMETRY is collapsed out of bloom in VegInstance via
  // bloomCollapse — so petals vanish in autumn/winter, not just recolour)
  mat.roughness = 0.7;
  mat.metalness = 0;
  mat.side = DoubleSide;
  return mat;
}

/** Small tundra plants share part IDs with flowers but need species-specific
 * foliage tones: Dryas is olive, Arctic willow fresh green, Labrador tea a
 * deep evergreen. Part 1 is flower/catkin and part 0 is leaf/stem. */
export function tundraPlantMaterial(p: {
  leaf: { r: number; g: number; b: number };
  flower: { r: number; g: number; b: number };
}): MeshStandardNodeMaterial {
  const mat = new MeshStandardNodeMaterial();
  const d = vdata();
  // leaf/stem follows the season live; the flower/catkin blooms only in season
  // and otherwise fades to the dormant leaf colour (no winter flowers)
  const leafBase = vec3(p.leaf.r, p.leaf.g, p.leaf.b) as unknown as NV3;
  const leaf = seasonFoliageTint(leafBase);
  const flower = seasonFlower(vec3(p.flower.r, p.flower.g, p.flower.b) as unknown as NV3, leafBase);
  mat.colorNode = mix(leaf, flower, smoothstep(0.85, 0.95, d.x)).mul(
    d.w.mul(0.45).add(0.55),
  );
  // (the flower/catkin GEOMETRY is collapsed out of bloom in VegInstance via
  // bloomCollapse — so it vanishes in autumn/winter, not just recolour)
  mat.roughness = 0.78;
  mat.metalness = 0;
  mat.side = DoubleSide;
  return mat;
}

/** mushroom shading by vdata.x part id: 0 stem, 0.5 gills, 1 cap */
export function mushroomMaterial(): MeshStandardNodeMaterial {
  const mat = new MeshStandardNodeMaterial();
  const d = vdata();
  const stem = vec3(0.32, 0.29, 0.24);
  const gills = vec3(0.42, 0.37, 0.28);
  const cap = vec3(0.23, 0.12, 0.05);
  const gillK = smoothstep(0.12, 0.02, d.x.sub(0.5).abs());
  const capK = smoothstep(0.85, 0.95, d.x);
  let albedo = mix(stem, gills, gillK) as unknown as NV3;
  albedo = mix(albedo, cap, capK) as unknown as NV3;
  mat.colorNode = albedo.mul(d.w);
  mat.roughness = 0.62;
  mat.metalness = 0;
  return mat;
}

export interface FoliageMatParams {
  color: { r: number; g: number; b: number; hueVar: number };
}

export function foliageMaterial(p: FoliageMatParams): MeshStandardNodeMaterial {
  // Physical variant for specularIntensity: white dielectric F0 0.04 at
  // glancing sun desaturates sunlit leaves to SILVER (user) — real leaves
  // read color-first; translucency + diffuse carry the lit look
  const mat = new MeshPhysicalNodeMaterial();
  mat.specularIntensity = 0.3;
  const d = vdata();
  const base = vec3(p.color.r, p.color.g, p.color.b);
  const tinted = hueShift(base, d.x, p.color.hueVar).mul(d.w.mul(0.8).add(0.2));
  // vertex-stage hoist: hue/age are flat per leaf, glow smooth at leaf scale
  mat.colorNode = varying(
    tinted as unknown as Parameters<typeof varying>[0],
  ) as unknown as typeof mat.colorNode;
  mat.emissiveNode = varying(
    translucency(tinted as unknown as NV3, 0.032) as unknown as Parameters<typeof varying>[0],
  ) as unknown as typeof mat.emissiveNode;
  mat.roughness = 0.8; // real leaves keep a little sheen, far less than default
  mat.metalness = 0;
  mat.side = DoubleSide;
  return mat;
}

/** captured cluster-card material: sqrt-decoded atlas albedo, alpha-tested */
export function foliageCardMaterial(
  atlas: Texture,
  p: FoliageMatParams,
): MeshStandardNodeMaterial {
  // see foliageMaterial: cards are worse — ONE flat normal per card means
  // the sheen paints whole cards silver coherently. Near-diffuse.
  const mat = new MeshPhysicalNodeMaterial();
  mat.specularIntensity = 0.18;
  const d = vdata();
  const t = texture(atlas, uv() as never) as unknown as NV4;
  const albedo = t.rgb.mul(t.rgb); // sqrt-encoded at capture
  // vertex-stage hoist (Phase 7 perf): hueShift is LINEAR in its base color
  // (per-channel factor) and vdata is flat per card — fold hue + age into
  // one varying factor and multiply the atlas read by it per fragment.
  // Translucency glow likewise (view/sun terms are smooth at card scale).
  const tintF = varying(
    hueShift(vec3(1, 1, 1), d.x, p.color.hueVar * 0.8).mul(
      d.w.mul(0.75).add(0.25),
    ) as unknown as Parameters<typeof varying>[0],
  ) as unknown as NV3;
  mat.colorNode = seasonFoliageTint(albedo.mul(tintF) as unknown as NV3);
  mat.emissiveNode = albedo.mul(
    varying(
      translucency(tintF, 0.06) as unknown as Parameters<typeof varying>[0],
    ) as unknown as NV3,
  );
  // edge-on fade: a card whose plane is parallel to the view ray shows as a
  // bare dark sheet at close range (DELTA #5 — they read as floating slabs).
  // Fade those out within ~70 m; cross-plane cards keep crown coverage via
  // their perpendicular plane, and beyond 70 m a card is a few px anyway.
  // (flat card normal + ≤2 m extent → vertex eval is identical)
  const viewDir = cameraPosition.sub(positionWorld).normalize();
  const ndv = normalWorld.normalize().dot(viewDir).abs();
  const camDist = positionWorld.sub(cameraPosition).length();
  const edgeFade = varying(
    mix(
      smoothstep(0.06, 0.2, ndv),
      float(1),
      smoothstep(35, 70, camDist),
    ) as unknown as Parameters<typeof varying>[0],
  ) as unknown as NF;
  mat.opacityNode = t.w.mul(edgeFade);
  mat.alphaTest = 0.32;
  // near-diffuse: one flat normal per card means any real specular paints
  // the WHOLE card with a uniform silver sheen at glancing sun angles —
  // big cards then read as slate slabs (user: "sun lights some leaves up")
  mat.roughness = 0.92;
  mat.metalness = 0;
  mat.side = DoubleSide;
  return mat;
}
