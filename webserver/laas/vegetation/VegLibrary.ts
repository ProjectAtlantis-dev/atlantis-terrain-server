/**
 * VegLibrary — boot-time geometry/material pools for the planted world.
 *
 * K=4 structural variants per species (decision D5): each variant grows its
 * own skeleton (own lean/bias/age GrowthInstance), and every LOD ring of a
 * variant derives from the SAME skeleton (seed.rng(label) is stateless per
 * label) — so a ring transition changes triangle cost, never the tree.
 *
 * Pools carry geometry + a material FACTORY (each indirect draw needs its own
 * material instance for its group-offset uniform); Forests wires instancing,
 * GI, and dither fades on top.
 */

import { BufferAttribute, BufferGeometry, type DataTexture } from 'three';
import type { MeshStandardNodeMaterial, Renderer } from 'three/webgpu';
import type { Rng, WorldSeed } from '../core/Seed';
import { bakeBarkTextures, type BarkTextures } from '../gpu/passes/BarkSynth';
import { bakeRockTexture, type RockTextures } from '../gpu/passes/RockSynth';
import { TREE_VARIANTS, VegClass } from '../gpu/passes/Scatter';
import { AUTUMN } from '../world/WorldConst';
import {
  barkTexturedMaterial,
  deadwoodMaterial,
  flowerMaterial,
  foliageCardMaterial,
  foliageMaterial,
  rockMaterial,
  tundraPlantMaterial,
} from '../render/VegMaterials';
import { buildLog, buildStump, type DecayState } from './Deadfall';
import { buildMushroom } from './Dressing';
import { captureFoliageAtlas } from './FoliageCards';
import { twigGeometry } from './GroundCover';
import { captureImpostor, type ImpostorAtlas, type ImpostorPart } from './Impostors';
import { buildRock, type RockPreset } from './RockBuilder';
import { TREE_SPECIES } from './Species';
import { buildTree, type HeroDiet } from './TreeBuilder';
import {
  buildFern,
  buildFlower,
  buildArcticWillow,
  buildCushion,
  buildCloudberry,
  buildHorsetail,
  buildLabradorTea,
  buildMountainAvens,
  buildPurpleSaxifrage,
  buildRoseroot,
  buildSorrel,
  buildCassiope,
  buildSedge,
  buildDeadWillow,
  buildShrub,
  BUSH_BILBERRY,
  BUSH_BEARBERRY,
  FERN_CAPTURE,
  UNDERSTORY_SPECIES,
  type FlowerKind,
} from './Understory';
import type { GrowthInstance, SpeciesParams } from './VegTypes';

export interface PoolPart {
  geo: BufferGeometry;
  tris: number;
  make: () => MeshStandardNodeMaterial;
  castShadow: boolean;
}

export interface VegPool {
  cls: number;
  variant: number;
  /** hero ring (trees only): full bark + cards + real mesh leaves, ≤26 m */
  r0?: PoolPart[] | null;
  r1: PoolPart[] | null;
  r2: PoolPart[] | null;
  trisR1: number;
  trisR2: number;
  /** cull-sphere data (from geometry bounds, conservative over parts) */
  height: number;
  radius: number;
}

/**
 * Deterministic aggregate LOD for small Greenland plants. These meshes are
 * mostly repeated leaves/cards/stems, so retaining an evenly distributed
 * triangle subset preserves the silhouette better than collapsing topology
 * (and, critically, preserves custom `vdata` used by flowers and wind).
 */
function subsetGeometry(source: BufferGeometry, ratio: number): BufferGeometry {
  const flat = source.index ? source.toNonIndexed() : source.clone();
  const position = flat.getAttribute('position');
  const triangleCount = Math.floor((position?.count ?? 0) / 3);
  if (triangleCount <= 1) return flat;
  const keep = Math.max(1, Math.min(triangleCount, Math.round(triangleCount * ratio)));
  const selected = Array.from({ length: keep }, (_, i) =>
    Math.min(triangleCount - 1, Math.floor(((i + 0.5) * triangleCount) / keep)),
  );
  const result = new BufferGeometry();
  for (const [name, attribute] of Object.entries(flat.attributes)) {
    const src = attribute as BufferAttribute;
    const ArrayType = src.array.constructor as new (length: number) => typeof src.array;
    const dst = new ArrayType(keep * 3 * src.itemSize);
    let out = 0;
    for (const triangle of selected) {
      const begin = triangle * 3 * src.itemSize;
      const end = begin + 3 * src.itemSize;
      for (let at = begin; at < end; at++) dst[out++] = src.array[at] ?? 0;
    }
    result.setAttribute(name, new BufferAttribute(dst, src.itemSize, src.normalized));
  }
  result.computeBoundingBox();
  result.computeBoundingSphere();
  return result;
}

function lodParts(parts: PoolPart[], ratio: number): PoolPart[] {
  return parts.map(part => {
    const geo = subsetGeometry(part.geo, ratio);
    return {
      ...part,
      geo,
      tris: geo.getAttribute('position').count / 3,
    };
  });
}

/**
 * Hero-ring tri budgets per species (spec floor: hero tree ≥100k tris for the
 * canopy species — karst gnarl and snags are small/leafless by nature).
 * Measured by tools/herotris.ts; mesh leaves carry the detail, bark radial
 * segs dieted where twig tube counts explode (beech: 24k anchors).
 */
export const HERO_DIETS: Record<string, HeroDiet> = {
  // cards stay UNTHINNED at hero range: thinning enlarges the survivors
  // (sqrt-coverage rule) and a 1.65×-size card 4 m away is a giant flat
  // sheet — full-count original-size cards + mesh leaves is the gallery look
  spruce: { meshAnchorTarget: 850, barkK: 0.8 },
  pine: { meshAnchorTarget: 350, barkK: 0.8 },
  beech: { meshAnchorTarget: 2200, barkK: 0.5 },
  birch: { meshAnchorTarget: 4000, barkK: 1 },
  karst: { meshAnchorTarget: 4000, barkK: 1.1 },
  snag: { barkK: 1.3 },
};

export interface VegLib {
  pools: VegPool[];
  /** tree species cls → octahedral impostor atlas (captured from variant 0) */
  impostors: Map<number, ImpostorAtlas>;
  /** per-class cull data, indexed by VegClass (length 32) */
  clsHeight: number[];
  clsRadius: number[];
  clsMaxDist: number[];
  atlases: Map<string, DataTexture>;
  barks: Map<number, BarkTextures>;
}

// GREENLAND Arctic wildflowers (was cream / purple / yellow):
//   umbel → mountain avens / white saxifrage (white 8-petal clusters)
//   bell  → Arctic harebell (Campanula gieseckeana), blue-violet nodding bells
//   daisy → Arctic poppy (Papaver radicatum), bright yellow
const FLOWER_COLOR: Record<FlowerKind, { r: number; g: number; b: number }> = {
  umbel: { r: 0.86, g: 0.85, b: 0.78 },
  bell: { r: 0.34, g: 0.3, b: 0.62 },
  daisy: { r: 0.92, g: 0.72, b: 0.1 },
  cotton: { r: 0.95, g: 0.96, b: 0.97 }, // cottongrass seedhead: white
};

// GREENLAND: each flower KIND has 4 variants — make each a different real
// species so the tundra shows ~12 distinct wildflowers, not 4 (scatter picks a
// variant per instance). Colours are real Greenland flora.
const FLOWER_VARIANTS: Record<FlowerKind, { r: number; g: number; b: number }[]> = {
  // radial-petal flowers
  daisy: [
    { r: 0.92, g: 0.72, b: 0.1 }, // arctic poppy (yellow)
    { r: 0.95, g: 0.85, b: 0.12 }, // tundra buttercup (bright yellow)
    { r: 0.9, g: 0.9, b: 0.85 }, // arctic mouse-ear / daisy (white)
    { r: 0.86, g: 0.5, b: 0.07 }, // arctic poppy (deep orange form)
  ],
  // nodding bells
  bell: [
    { r: 0.34, g: 0.3, b: 0.62 }, // harebell (blue-violet)
    { r: 0.9, g: 0.9, b: 0.86 }, // arctic bell-heather / cassiope (white)
    { r: 0.62, g: 0.2, b: 0.42 }, // Lapland rosebay (magenta-pink)
    { r: 0.3, g: 0.45, b: 0.72 }, // alpine forget-me-not (blue)
  ],
  // floret clusters / cushions
  umbel: [
    { r: 0.86, g: 0.85, b: 0.78 }, // mountain avens (white)
    { r: 0.72, g: 0.28, b: 0.5 }, // purple saxifrage (magenta)
    { r: 0.85, g: 0.78, b: 0.2 }, // roseroot (yellow-green)
    { r: 0.9, g: 0.86, b: 0.8 }, // scurvygrass / whitlow-grass (white)
  ],
  // cottongrass seedhead — always white
  cotton: [
    { r: 0.95, g: 0.96, b: 0.97 },
    { r: 0.94, g: 0.95, b: 0.96 },
    { r: 0.93, g: 0.94, b: 0.95 },
    { r: 0.96, g: 0.97, b: 0.98 },
  ],
};

function bounds(geos: BufferGeometry[]): { height: number; radius: number } {
  let height = 0.5;
  let radius = 0.5;
  for (const g of geos) {
    g.computeBoundingBox();
    g.computeBoundingSphere();
    const bb = g.boundingBox;
    const bs = g.boundingSphere;
    if (bb) height = Math.max(height, bb.max.y);
    if (bs) radius = Math.max(radius, bs.center.length() + bs.radius);
  }
  return { height, radius };
}

function variantInstance(seed: WorldSeed, id: string, v: number): Partial<GrowthInstance> {
  const vr = seed.rng(`veginst/${id}/${v}`);
  return {
    leanX: (vr.float() - 0.5) * 0.14,
    leanZ: (vr.float() - 0.5) * 0.14,
    biasX: (vr.float() - 0.5) * 1.6,
    biasZ: (vr.float() - 0.5) * 1.6,
    age: 0.7 + vr.float() * 0.3,
  };
}

export async function buildVegLibrary(
  renderer: Renderer,
  seed: WorldSeed,
  progress: (p: number, msg: string) => void = () => {},
  options: { treeless?: boolean } = {},
): Promise<VegLib> {
  const treeless = options.treeless === true;
  // ---- shared captures -------------------------------------------------------
  progress(0, 'veg: capturing foliage atlases');
  const atlases = new Map<string, DataTexture>();
  for (const sp of [
    ...(treeless ? [] : TREE_SPECIES),
    ...UNDERSTORY_SPECIES,
    BUSH_BILBERRY,
    BUSH_BEARBERRY,
    FERN_CAPTURE,
  ]) {
    if (!sp.foliage || atlases.has(sp.id)) continue;
    atlases.set(sp.id, await captureFoliageAtlas(renderer, sp, seed.rng(`cards/${sp.id}`)));
  }
  progress(0.2, 'veg: baking bark textures');
  const barks = new Map<number, BarkTextures>();
  const layers = new Set<number>([
    ...(treeless ? [] : TREE_SPECIES.map((s) => s.barkLayer)),
    2,
    5,
  ]);
  for (const layer of layers) {
    barks.set(layer, await bakeBarkTextures(renderer, layer, seed.sub(`bark/${layer}`) % 977));
  }
  // one-time tileable rock-surface bake (voronoi-crackle relief), shared by all
  // rock/stone pools as a triplanar DETAIL layer (per-type tone stays intact)
  const rockTex: RockTextures = await bakeRockTexture(
    renderer,
    seed.sub('rocksynth') % 977,
  );
  const barkOf = (layer: number): BarkTextures => {
    const b = barks.get(layer);
    if (!b) throw new Error(`bark layer ${layer} not baked`);
    return b;
  };

  const pools: VegPool[] = [];
  const clsHeight = new Array<number>(32).fill(1);
  const clsRadius = new Array<number>(32).fill(1);
  const clsMaxDist = new Array<number>(32).fill(150);
  const trackCls = (cls: number, h: number, r: number): void => {
    clsHeight[cls] = Math.max(clsHeight[cls] ?? 1, h);
    clsRadius[cls] = Math.max(clsRadius[cls] ?? 1, r);
  };

  // ---- trees: 6 species × 4 variants × (R1 cards, R2 branch-cards) ----------
  progress(0.3, 'veg: growing tree variant pools');
  const treeParts = (sp: SpeciesParams, t: ReturnType<typeof buildTree>): PoolPart[] => {
    const parts: PoolPart[] = [
      {
        geo: t.bark,
        tris: t.bark.index ? t.bark.index.count / 3 : 0,
        make: () => barkTexturedMaterial(barkOf(sp.barkLayer)),
        castShadow: true,
      },
    ];
    const atlas = atlases.get(sp.id);
    if (t.foliage && atlas) {
      parts.push({
        geo: t.foliage,
        tris: t.foliage.index ? t.foliage.index.count / 3 : 0,
        make: () => foliageCardMaterial(atlas, { color: sp.foliageColor }),
        castShadow: true,
      });
    }
    return parts;
  };

  for (let ci = 0; ci < (treeless ? 0 : TREE_SPECIES.length); ci++) {
    const sp = TREE_SPECIES[ci] as SpeciesParams;
    for (let v = 0; v < TREE_VARIANTS; v++) {
      const label = `veg/${sp.id}/${v}`;
      const inst = variantInstance(seed, sp.id, v);
      // hero ring: full tube hierarchy + thinned cards + REAL mesh leaves.
      // Cards stay in the hero so the R0↔R1 swap only adds leaf geometry —
      // the painted silhouette never changes (no pop).
      const t0 = buildTree(sp, seed.rng(label), {
        lod: 0,
        inst,
        foliageMode: 'hybrid',
        hero: HERO_DIETS[sp.id] ?? { cardTarget: 1500, meshAnchorTarget: 1200 },
      });
      const t1 = buildTree(sp, seed.rng(label), { lod: 1, inst });
      const t2 = buildTree(sp, seed.rng(label), { lod: 2, inst });
      const r0 = treeParts(sp, t0);
      if (t0.foliageMesh) {
        r0.push({
          geo: t0.foliageMesh,
          tris: t0.foliageMesh.index ? t0.foliageMesh.index.count / 3 : 0,
          make: () => foliageMaterial({ color: sp.foliageColor }),
          // cards already cast equivalent crown coverage — mesh-leaf shadow
          // casting would double the caster load for no visible gain
          castShadow: false,
        });
      }
      const r1 = treeParts(sp, t1);
      const r2 = treeParts(sp, t2);
      const b = bounds(r1.map((p) => p.geo));
      trackCls(ci, b.height, b.radius);
      pools.push({
        cls: ci,
        variant: v,
        r0,
        r1,
        r2,
        trisR1: t1.stats.tris,
        trisR2: t2.stats.tris,
        height: b.height,
        radius: b.radius,
      });
    }
    clsMaxDist[ci] = 1e8; // trees continue as impostors
    progress(0.3 + 0.25 * ((ci + 1) / TREE_SPECIES.length), `veg: ${sp.id} pool`);
  }

  // ---- tree impostors (variant 0 R1 geometry, relightable octahedral) -------
  progress(0.56, 'veg: capturing octahedral impostors');
  const impostors = new Map<number, ImpostorAtlas>();
  for (let ci = 0; ci < (treeless ? 0 : TREE_SPECIES.length); ci++) {
    const sp = TREE_SPECIES[ci] as SpeciesParams;
    const t = buildTree(sp, seed.rng(`veg/${sp.id}/0`), {
      lod: 1,
      inst: variantInstance(seed, sp.id, 0),
    });
    const parts: ImpostorPart[] = [
      { geometry: t.bark, kind: 'bark', barkTex: barkOf(sp.barkLayer) },
    ];
    const atlas = atlases.get(sp.id);
    if (t.foliage && atlas) parts.push({ geometry: t.foliage, kind: 'cards', atlas });
    const radius = Math.max(
      t.stats.height * 0.55,
      t.skeleton.crownRadius * 1.4,
      2,
    );
    impostors.set(
      ci,
      await captureImpostor(renderer, parts, { centerY: t.stats.height * 0.5, radius }),
    );
    progress(0.56 + 0.18 * ((ci + 1) / TREE_SPECIES.length), `veg: impostor ${sp.id}`);
  }

  // ---- understory: shrubs / fern / flowers (R1 only) -------------------------
  progress(0.76, 'veg: understory pools');
  const underSpecies = [
    { cls: VegClass.BushHazel, sp: UNDERSTORY_SPECIES[0] as SpeciesParams },
    { cls: VegClass.BushPink, sp: UNDERSTORY_SPECIES[1] as SpeciesParams },
    { cls: VegClass.Juniper, sp: UNDERSTORY_SPECIES[2] as SpeciesParams },
  ];
  for (const { cls, sp } of underSpecies) {
    for (let v = 0; v < 4; v++) {
      // crowberry class packs DISTINCT species per variant: v0/1 crowberry
      // (needle mat), v2 alpine bearberry, v3 bog bilberry (broad-leaf mats).
      // Together they are the autumn heath MOSAIC (green in summer → scarlet /
      // crimson / deep-red in autumn). Other classes reuse their one species.
      const vSp =
        cls === VegClass.Juniper && v === 2
          ? BUSH_BEARBERRY
          : cls === VegClass.Juniper && v === 3
            ? BUSH_BILBERRY
            : sp;
      const rng = seed.rng(`veg/${vSp.id}/${v}`);
      const shrub = buildShrub(vSp, rng);
      const atlas = atlases.get(vSp.id);
      const summerCol = vSp.foliageColor;
      // AUTUMN blaze: dwarf birch → orange, crowberry → deep red, bearberry →
      // scarlet, bilberry → crimson (ref image 2). Lerp summer→autumn by AUTUMN.
      const autumnCol =
        cls === VegClass.BushHazel
          ? { r: 0.55, g: 0.24, b: 0.03, hueVar: 0.35 } // dwarf birch orange
          : cls === VegClass.Juniper
            ? v === 2
              ? { r: 0.5, g: 0.06, b: 0.02, hueVar: 0.3 } // bearberry scarlet
              : v === 3
                ? { r: 0.42, g: 0.04, b: 0.05, hueVar: 0.3 } // bilberry crimson
                : { r: 0.15, g: 0.055, b: 0.035, hueVar: 0.25 } // crowberry deep red
            : summerCol;
      const folColor = {
        r: summerCol.r + (autumnCol.r - summerCol.r) * AUTUMN,
        g: summerCol.g + (autumnCol.g - summerCol.g) * AUTUMN,
        b: summerCol.b + (autumnCol.b - summerCol.b) * AUTUMN,
        hueVar: summerCol.hueVar,
      };
      const parts: PoolPart[] = [
        {
          geo: shrub.bark,
          tris: shrub.bark.index ? shrub.bark.index.count / 3 : 0,
          make: () => barkTexturedMaterial(barkOf(2)),
          castShadow: true,
        },
      ];
      if (shrub.foliage && atlas) {
        parts.push({
          geo: shrub.foliage,
          tris: shrub.foliage.index ? shrub.foliage.index.count / 3 : 0,
          make: () => foliageCardMaterial(atlas, { color: folColor }),
          castShadow: true,
        });
      }
      const b = bounds(parts.map((p) => p.geo));
      trackCls(cls, b.height, b.radius);
      pools.push({
        cls,
        variant: v,
        r1: parts,
        r2: null,
        trisR1: shrub.tris,
        trisR2: 0,
        height: b.height,
        radius: b.radius,
      });
    }
    clsMaxDist[cls] = 170;
  }
  // ferns
  const fernAtlas = atlases.get('fern');
  for (let v = 0; v < 4; v++) {
    const geo = buildFern(seed.rng(`veg/fern/${v}`));
    const tris = geo.index ? geo.index.count / 3 : 0;
    const b = bounds([geo]);
    trackCls(VegClass.Fern, b.height, b.radius);
    pools.push({
      cls: VegClass.Fern,
      variant: v,
      r1: fernAtlas
        ? [
            {
              geo,
              tris,
              make: () =>
                foliageCardMaterial(fernAtlas, { color: FERN_CAPTURE.foliageColor }),
              castShadow: false,
            },
          ]
        : null,
      r2: null,
      trisR1: tris,
      trisR2: 0,
      height: b.height,
      radius: b.radius,
    });
  }
  clsMaxDist[VegClass.Fern] = 140;
  // Morphology-specific Greenland plants. These are real meshes rather than
  // color aliases: cushion dome, creeping Dryas mat, prostrate willow, and
  // upright evergreen Labrador tea each retain their diagnostic silhouette.
  // `alt` packs a SECOND species into variant slots 2/3 (own mesh + colours),
  // weighted by its own habitat via the GreenlandFlora `variant` slot.
  type TRgb = { r: number; g: number; b: number };
  type TundraPlant = {
    cls: number;
    id: string;
    build: (rng: Rng) => BufferGeometry;
    leaf: TRgb;
    flower: TRgb;
    maxDist: number;
    alt?: { id: string; build: (rng: Rng) => BufferGeometry; leaf: TRgb; flower: TRgb };
  };
  const tundraPlants: TundraPlant[] = [
    {
      cls: VegClass.CushionCampion,
      id: 'moss-campion',
      build: buildCushion,
      leaf: { r: 0.035, g: 0.105, b: 0.035 },
      flower: { r: 0.78, g: 0.16, b: 0.42 },
      maxDist: 75,
    },
    {
      cls: VegClass.MountainAvens,
      id: 'mountain-avens',
      build: buildMountainAvens,
      leaf: { r: 0.075, g: 0.13, b: 0.045 },
      flower: { r: 0.9, g: 0.89, b: 0.82 },
      maxDist: 95,
    },
    {
      cls: VegClass.ArcticWillow,
      id: 'arctic-willow',
      build: buildArcticWillow,
      leaf: { r: 0.075, g: 0.15, b: 0.055 },
      flower: { r: 0.72, g: 0.56, b: 0.12 },
      maxDist: 120,
      alt: {
        id: 'dead-willow',
        build: buildDeadWillow,
        leaf: { r: 0.33, g: 0.31, b: 0.27 }, // bleached grey deadwood
        flower: { r: 0.36, g: 0.34, b: 0.3 },
      },
    },
    {
      cls: VegClass.LabradorTea,
      id: 'labrador-tea',
      build: buildLabradorTea,
      leaf: { r: 0.035, g: 0.095, b: 0.035 },
      flower: { r: 0.91, g: 0.9, b: 0.84 },
      maxDist: 125,
      alt: {
        id: 'cassiope',
        build: buildCassiope,
        leaf: { r: 0.03, g: 0.075, b: 0.035 }, // dark evergreen mat
        flower: { r: 0.93, g: 0.92, b: 0.9 }, // white nodding bells
      },
    },
    {
      cls: VegClass.PurpleSaxifrage,
      id: 'purple-saxifrage',
      build: buildPurpleSaxifrage,
      leaf: { r: 0.055, g: 0.1, b: 0.035 },
      flower: { r: 0.62, g: 0.08, b: 0.42 },
      maxDist: 85,
    },
    {
      cls: VegClass.Roseroot,
      id: 'roseroot',
      build: buildRoseroot,
      leaf: { r: 0.09, g: 0.16, b: 0.095 },
      flower: { r: 0.82, g: 0.68, b: 0.12 },
      maxDist: 105,
      alt: {
        id: 'mountain-sorrel',
        build: buildSorrel,
        leaf: { r: 0.11, g: 0.17, b: 0.08 }, // fresh green (reddens in autumn)
        flower: { r: 0.5, g: 0.12, b: 0.09 }, // reddish nutlet spike
      },
    },
    {
      cls: VegClass.Horsetail,
      id: 'field-horsetail',
      build: buildHorsetail,
      leaf: { r: 0.035, g: 0.115, b: 0.045 },
      flower: { r: 0.22, g: 0.19, b: 0.1 },
      maxDist: 105,
      alt: {
        id: 'sedge',
        build: buildSedge,
        leaf: { r: 0.09, g: 0.135, b: 0.06 }, // blue-green sedge blades
        flower: { r: 0.12, g: 0.15, b: 0.07 },
      },
    },
    {
      cls: VegClass.Cloudberry,
      id: 'cloudberry',
      build: buildCloudberry,
      leaf: { r: 0.055, g: 0.135, b: 0.04 },
      flower: { r: 0.92, g: 0.46, b: 0.06 },
      maxDist: 105,
      alt: {
        id: 'tundra-mushroom',
        build: (rng: Rng) => buildMushroom(rng, 'cap'),
        leaf: { r: 0.5, g: 0.44, b: 0.36 }, // pale stem + gills
        flower: { r: 0.55, g: 0.16, b: 0.08 }, // red-brown cap (vdata.x=1)
      },
    },
  ];
  for (const plant of tundraPlants) {
    for (let v = 0; v < 4; v++) {
      // variant slots 2/3 render the packed `alt` species when present
      const src = v >= 2 && plant.alt ? plant.alt : plant;
      const geo = src.build(seed.rng(`veg/${src.id}/${v}`));
      const tris = geo.index ? geo.index.count / 3 : 0;
      const b = bounds([geo]);
      trackCls(plant.cls, b.height, b.radius);
      pools.push({
        cls: plant.cls,
        variant: v,
        r1: [
          {
            geo,
            tris,
            make: () => tundraPlantMaterial({ leaf: src.leaf, flower: src.flower }),
            castShadow: false,
          },
        ],
        r2: null,
        trisR1: tris,
        trisR2: 0,
        height: b.height,
        radius: b.radius,
      });
    }
    clsMaxDist[plant.cls] = plant.maxDist;
  }
  // flowers
  const flowerKinds: { cls: number; kind: FlowerKind }[] = [
    { cls: VegClass.FlowerUmbel, kind: 'umbel' },
    { cls: VegClass.FlowerBell, kind: 'bell' },
    { cls: VegClass.FlowerDaisy, kind: 'daisy' },
    { cls: VegClass.FlowerCotton, kind: 'cotton' },
  ];
  for (const { cls, kind } of flowerKinds) {
    for (let v = 0; v < 4; v++) {
      const geo = buildFlower(kind, seed.rng(`veg/flower/${kind}/${v}`));
      const tris = geo.index ? geo.index.count / 3 : 0;
      const b = bounds([geo]);
      trackCls(cls, b.height, b.radius);
      pools.push({
        cls,
        variant: v,
        r1: [
          {
            geo,
            tris,
            make: () => flowerMaterial(FLOWER_VARIANTS[kind][v] ?? FLOWER_COLOR[kind]),
            castShadow: false,
          },
        ],
        r2: null,
        trisR1: tris,
        trisR2: 0,
        height: b.height,
        radius: b.radius,
      });
    }
    clsMaxDist[cls] = 90;
  }

  // ---- extras: deadfall + boulders/slabs -------------------------------------
  progress(0.86, 'veg: deadfall + boulder pools');
  const deadTex = barkOf(5);
  // weathered-wood darkening: the snag bark bake is pale gray and logs read
  // as glowing white slivers in noon sun without it
  const logDim = { r: 0.6, g: 0.52, b: 0.44 };
  const decayOf: DecayState[] = ['fresh', 'mossy', 'rotten', 'mossy'];
  for (let v = 0; v < 4; v++) {
    const log = buildLog(seed.rng(`veg/log/${v}`), decayOf[v] as DecayState);
    const b = bounds([log.geometry]);
    trackCls(VegClass.Log, b.height, b.radius);
    pools.push({
      cls: VegClass.Log,
      variant: v,
      r1: [
        {
          geo: log.geometry,
          tris: log.tris,
          make: () => deadwoodMaterial(deadTex, logDim),
          castShadow: true,
        },
      ],
      r2: null,
      trisR1: log.tris,
      trisR2: 0,
      height: b.height,
      radius: b.radius,
    });
  }
  clsMaxDist[VegClass.Log] = 220;
  for (let v = 0; v < 4; v++) {
    const stump = buildStump(seed.rng(`veg/stump/${v}`));
    const b = bounds([stump.geometry]);
    trackCls(VegClass.Stump, b.height, b.radius);
    pools.push({
      cls: VegClass.Stump,
      variant: v,
      r1: [
        {
          geo: stump.geometry,
          tris: stump.tris,
          make: () => deadwoodMaterial(deadTex, logDim),
          castShadow: true,
        },
      ],
      r2: null,
      trisR1: stump.tris,
      trisR2: 0,
      height: b.height,
      radius: b.radius,
    });
  }
  clsMaxDist[VegClass.Stump] = 170;

  const rockPools: { cls: number; preset: 'boulder' | 'slab'; moss: number }[] = [
    { cls: VegClass.Boulder, preset: 'boulder', moss: 0.3 },
    { cls: VegClass.Slab, preset: 'slab', moss: 0.12 },
  ];
  // GREENLAND rock types — one per variant, so the scatter (which picks a
  // variant per instance) sprinkles a natural MIX of boulder types across the
  // field: pale banded gneiss, pink-grey granite, dark basalt, weathered grey.
  // Real Greenland is gneiss country — stones are mostly LIGHT GREY (ref photo),
  // wet-darkened by the material where submerged. Dominant light grey, warm
  // granite, mid blue-grey, and only occasional dark basalt.
  const rockTones = [
    { tone: { r: 0.42, g: 0.42, b: 0.41 }, vMoss: 0.05 }, // light grey gneiss (dominant)
    { tone: { r: 0.44, g: 0.4, b: 0.37 }, vMoss: 0.05 }, // pale warm granite
    { tone: { r: 0.33, g: 0.335, b: 0.34 }, vMoss: 0.12 }, // mid blue-grey gneiss
    { tone: { r: 0.17, g: 0.165, b: 0.16 }, vMoss: 0.18 }, // dark basalt (occasional)
  ] as const;
  for (const { cls, preset } of rockPools) {
    for (let v = 0; v < 4; v++) {
      const { tone, vMoss } = rockTones[v] as (typeof rockTones)[number];
      const hi = buildRock(preset, seed.rng(`veg/${preset}/${v}`), 4);
      const lo = buildRock(preset, seed.rng(`veg/${preset}/${v}`), 3);
      const b = bounds([hi.geometry]);
      trackCls(cls, b.height, b.radius);
      pools.push({
        cls,
        variant: v,
        r1: [
          {
            geo: hi.geometry,
            tris: hi.stats.tris,
            make: () => rockMaterial({ moss: vMoss, tone, tex: rockTex }),
            castShadow: true,
          },
        ],
        r2: [
          {
            geo: lo.geometry,
            tris: lo.stats.tris,
            make: () => rockMaterial({ moss: vMoss, tone, tex: rockTex }),
            castShadow: true,
          },
        ],
        trisR1: hi.stats.tris,
        trisR2: lo.stats.tris,
        height: b.height,
        radius: b.radius,
      });
    }
    clsMaxDist[cls] = 700;
  }

  // ---- size-stratified stones + fallen branches (no-bare-ground layer) ------
  progress(0.93, 'veg: stone/branch pools');
  const stoneClasses: {
    cls: number;
    preset: 'boulder' | 'cobble';
    d1: number;
    d2: number | null;
    moss: number;
    maxDist: number;
  }[] = [
    { cls: VegClass.StoneL, preset: 'boulder', d1: 3, d2: 2, moss: 0.22, maxDist: 900 },
    { cls: VegClass.StoneM, preset: 'cobble', d1: 3, d2: 2, moss: 0.12, maxDist: 420 },
    { cls: VegClass.StoneS, preset: 'cobble', d1: 1, d2: null, moss: 0.06, maxDist: 90 },
  ];
  for (const sc of stoneClasses) {
    for (let v = 0; v < 4; v++) {
      // StoneL variants are context-keyed by the scatter kernel: 0/1 spawn
      // on dry scree (pale faceted talus matching the cliff that shed it),
      // 2/3 in streambeds (dark water-rounded, mossy) — scree stops reading
      // as smooth dark blobs
      // GREENLAND: 4 stone SHAPES per variant across ALL sizes (rounded cobble /
      // angular / flat slab / faceted talus) so scree & gravel are a real jumble
      // of shapes, not one blob. Detail is bumped (stoneClasses above) so the
      // fracture facets actually read on the bigger stones.
      const stoneShapes = ['cobble', 'angular', 'slab', 'talus'] as const;
      const preset: RockPreset = stoneShapes[v];
      // GREENLAND rock-type variety per variant (gneiss/granite/basalt/weathered)
      // — ground stones are no longer one uniform tone. Streambed StoneL (v≥2)
      // stays extra-mossy; sc.moss floors the small dry stones.
      const rt = rockTones[v] as (typeof rockTones)[number];
      const tone = rt.tone;
      const moss =
        sc.cls === VegClass.StoneL && v >= 2 ? 0.3 : Math.max(sc.moss, rt.vMoss);
      const hi = buildRock(preset, seed.rng(`veg/stone${sc.cls}/${v}`), sc.d1);
      const lo =
        sc.d2 !== null
          ? buildRock(preset, seed.rng(`veg/stone${sc.cls}/${v}`), sc.d2)
          : null;
      const b = bounds([hi.geometry]);
      trackCls(sc.cls, b.height, b.radius);
      pools.push({
        cls: sc.cls,
        variant: v,
        r1: [
          {
            geo: hi.geometry,
            tris: hi.stats.tris,
            make: () => rockMaterial({ moss, tone, tex: rockTex }),
            castShadow: sc.cls !== VegClass.StoneS,
          },
        ],
        r2: lo
          ? [
              {
                geo: lo.geometry,
                tris: lo.stats.tris,
                make: () => rockMaterial({ moss, tone, tex: rockTex }),
                castShadow: sc.cls === VegClass.StoneL,
              },
            ]
          : null,
        trisR1: hi.stats.tris,
        trisR2: lo ? lo.stats.tris : 0,
        height: b.height,
        radius: b.radius,
      });
    }
    clsMaxDist[sc.cls] = sc.maxDist;
  }
  // fallen branches: scaled twig tubes, deadwood-shaded. Dimmed hard: the
  // snag-bark albedo is pale gray and read as glowing white sticks at noon.
  const branchDim = { r: 0.5, g: 0.42, b: 0.34 };
  for (let v = 0; v < 4; v++) {
    const geo = twigGeometry(seed.rng(`veg/branch/${v}`));
    geo.scale(6.5, 5, 6.5);
    const tris = geo.index ? geo.index.count / 3 : 0;
    const b = bounds([geo]);
    trackCls(VegClass.Branch, b.height, b.radius);
    pools.push({
      cls: VegClass.Branch,
      variant: v,
      r1: [
        {
          geo,
          tris,
          make: () => deadwoodMaterial(deadTex, branchDim),
          castShadow: false,
        },
      ],
      // clone: a geometry holds ONE indirect slot — sharing it across draws
      // would overwrite the first draw's offset
      r2: [
        {
          geo: geo.clone(),
          tris,
          make: () => deadwoodMaterial(deadTex, branchDim),
          castShadow: false,
        },
      ],
      trisR1: tris,
      trisR2: tris,
      height: b.height,
      radius: b.radius,
    });
  }
  clsMaxDist[VegClass.Branch] = 230;

  // Greenland is treeless, but it still needs the renderer architecture that
  // made LAAS affordable. Every understory species gets three real geometry
  // rings: full silhouette near, distributed 45% aggregate mid, 15% far.
  // TerrainMaterial owns the final ground-scale representation after r2.
  for (const pool of pools) {
    const understory =
      (pool.cls >= VegClass.BushHazel && pool.cls <= VegClass.FlowerCotton) ||
      (pool.cls >= VegClass.CushionCampion && pool.cls <= VegClass.Cloudberry);
    if (!understory || !pool.r1?.length) continue;
    const full = pool.r1;
    pool.r0 = full;
    pool.r1 = lodParts(full, 0.45);
    pool.r2 = lodParts(full, 0.15);
    pool.trisR1 = pool.r1.reduce((sum, part) => sum + part.tris, 0);
    pool.trisR2 = pool.r2.reduce((sum, part) => sum + part.tris, 0);
  }

  progress(1, 'veg: pools ready');
  return { pools, impostors, clsHeight, clsRadius, clsMaxDist, atlases, barks };
}
