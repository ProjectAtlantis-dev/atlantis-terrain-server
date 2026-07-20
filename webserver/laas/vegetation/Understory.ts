/**
 * Understory: shrubs ×3 (incl. the reference's pink flowering shrub),
 * ferns (frond rosettes from a captured pinnate frond), flowers ×4.
 * Shrubs are multi-stem trees grown from bush-tuned species params and
 * merged; ferns/flowers are bespoke small builders on MeshGrower.
 */

import { Matrix4, Quaternion, Vector3 } from 'three';
import type { BufferGeometry } from 'three';
import type { Rng } from '../core/Seed';
import { buildTree } from './TreeBuilder';
import { MeshGrower } from './TubeMesh';
import type { LeafAnchor, SpeciesParams } from './VegTypes';
import { buildFoliageCards } from './FoliageCards';

// ---------------------------------------------------------------------------
// Shrub species (bush-tuned growth params; same grammar)
// ---------------------------------------------------------------------------

const bushLevels = (gnarl: number): SpeciesParams['levels'] => [
  {
    density: 0, whorl: 0, childStart: 0, childEnd: 0,
    angleBase: 0, angleTip: 0, lenRatio: 0, lenJitter: 0, radRatio: 0,
    segs: 5, wander: 0.18 * gnarl, gravitropism: 0.06, droop: 0, tipCurl: 0, taper: 0.9,
  },
  {
    density: 4.5, whorl: 0, childStart: 0.2, childEnd: 1.0,
    angleBase: 1.0, angleTip: 0.5, lenRatio: 0.62, lenJitter: 0.4, radRatio: 0.55,
    segs: 4, wander: 0.16 * gnarl, gravitropism: 0.1, droop: 0.2, tipCurl: 0.1, taper: 0.85,
  },
  {
    density: 7.0, whorl: 0, childStart: 0.2, childEnd: 1.0,
    angleBase: 0.85, angleTip: 0.5, lenRatio: 0.45, lenJitter: 0.4, radRatio: 0.55,
    segs: 2, wander: 0.2 * gnarl, gravitropism: 0.05, droop: 0.15, tipCurl: 0.05, taper: 0.85,
    planar: 0.5,
  },
];

// GREENLAND: dwarf birch (Betula nana) — low, round small leaves, muted
// green with high per-instance hue variety (some yellowing). Was 'Hazel shrub'
// at 1.9–2.9 m; now a knee-high tundra shrub.
export const BUSH_HAZEL: SpeciesParams = {
  id: 'dwarfBirch',
  label: 'Dwarf birch (Betula nana)',
  kind: 'broadleaf',
  height: [0.5, 1.0],
  trunkRadiusK: 0.02,
  crown: 'dome',
  asym: 0.35,
  levels: bushLevels(1),
  foliage: {
    kind: 'leafCluster',
    anchorLevel: 2,
    spacing: 0.07,
    tStart: 0.12,
    scale: [0.06, 0.1],
    tilt: 0.9,
    clusterSize: [2, 4],
    normalBend: 0.6,
    planarLeaves: true,
    card: { mode: 'cross', sizeK: 2.3 },
    leaf: { len: 0.7, width: 0.75, shapePow: 1.1, fold: 0.25, curl: 0.15, needleCount: 0, brush: 0 },
  },
  flare: { amp: 0.2, height: 0.3, lobes: 3 },
  barkLayer: 2,
  barkRepeats: 2,
  foliageColor: { r: 0.05, g: 0.105, b: 0.035, hueVar: 0.32 },
  brokenTop: 0,
  stubChance: 0.02,
};

// GREENLAND: niviarsiaq / dwarf fireweed (Chamerion latifolium) — Greenland's
// national flower. Low herb-shrub with narrow leaves and showy magenta-pink
// blossom. Was 'Pink flowering shrub' at 1.5–2.4 m.
export const BUSH_PINKFLOWER: SpeciesParams = {
  id: 'niviarsiaq',
  label: 'Niviarsiaq (dwarf fireweed)',
  kind: 'broadleaf',
  height: [0.3, 0.6],
  trunkRadiusK: 0.018,
  crown: 'dome',
  asym: 0.3,
  levels: bushLevels(1.2),
  foliage: {
    kind: 'leafCluster',
    anchorLevel: 2,
    spacing: 0.05,
    tStart: 0.12,
    scale: [0.07, 0.11],
    tilt: 0.95,
    clusterSize: [2, 3],
    normalBend: 0.62,
    planarLeaves: true,
    card: { mode: 'cross', sizeK: 2.3 },
    leaf: { len: 1.0, width: 0.34, shapePow: 1.4, fold: 0.28, curl: 0.18, needleCount: 0, brush: 0 },
  },
  flare: { amp: 0.2, height: 0.3, lobes: 3 },
  barkLayer: 2,
  barkRepeats: 2,
  foliageColor: { r: 0.05, g: 0.1, b: 0.04, hueVar: 0.2 },
  blossom: { r: 0.64, g: 0.12, b: 0.36, frac: 0.72 },
  brokenTop: 0,
  stubChance: 0.02,
};

// GREENLAND: crowberry mat (Empetrum nigrum) — dominant Arctic dwarf shrub, a
// very low dark-green evergreen mat of needle-like leaves. The needleSpray
// foliage fits it well. Was 'Juniper mound' at 0.9–1.5 m.
export const BUSH_JUNIPER: SpeciesParams = {
  id: 'crowberry',
  label: 'Crowberry mat (Empetrum nigrum)',
  kind: 'conifer',
  height: [0.15, 0.4],
  trunkRadiusK: 0.03,
  crown: 'dome',
  asym: 0.4,
  levels: [
    {
      density: 0, whorl: 0, childStart: 0, childEnd: 0,
      angleBase: 0, angleTip: 0, lenRatio: 0, lenJitter: 0, radRatio: 0,
      segs: 4, wander: 0.3, gravitropism: -0.12, droop: 0, tipCurl: 0.05, taper: 0.8,
    },
    {
      density: 7, whorl: 0, childStart: 0.05, childEnd: 1.0,
      angleBase: 1.5, angleTip: 0.7, lenRatio: 0.85, lenJitter: 0.4, radRatio: 0.6,
      segs: 4, wander: 0.22, gravitropism: 0.12, droop: 0.25, tipCurl: 0.18, taper: 0.85,
    },
    {
      density: 8, whorl: 0, childStart: 0.2, childEnd: 1.0,
      angleBase: 0.9, angleTip: 0.5, lenRatio: 0.4, lenJitter: 0.4, radRatio: 0.55,
      segs: 2, wander: 0.2, gravitropism: 0.08, droop: 0.1, tipCurl: 0.1, taper: 0.85,
      planar: 0.6,
    },
  ],
  foliage: {
    kind: 'needleSpray',
    anchorLevel: 2,
    spacing: 0.07,
    tStart: 0.1,
    scale: [0.12, 0.2],
    tilt: 0.55,
    clusterSize: [1, 1],
    normalBend: 0.6,
    planarLeaves: true,
    card: { mode: 'lying', sizeK: 2.5 },
    leaf: { len: 0.05, width: 0.012, shapePow: 1, fold: 0, curl: 0, needleCount: 26, brush: 0 },
  },
  flare: { amp: 0.25, height: 0.25, lobes: 3 },
  barkLayer: 4,
  barkRepeats: 2,
  foliageColor: { r: 0.03, g: 0.062, b: 0.035, hueVar: 0.22 },
  brokenTop: 0,
  stubChance: 0.05,
};

// GREENLAND: bog bilberry (Vaccinium uliginosum) — low DECIDUOUS dwarf shrub,
// small oval BLUE-GREEN leaves (not needles like crowberry), dusty-blue berries,
// brilliant crimson in autumn. A distinct broad-leaf mesh from the crowberry mat.
export const BUSH_BILBERRY: SpeciesParams = {
  id: 'bilberry',
  label: 'Bog bilberry (Vaccinium uliginosum)',
  kind: 'broadleaf',
  height: [0.12, 0.28],
  trunkRadiusK: 0.02,
  crown: 'dome',
  asym: 0.42,
  levels: bushLevels(1),
  foliage: {
    kind: 'leafCluster',
    anchorLevel: 2,
    spacing: 0.055,
    tStart: 0.1,
    scale: [0.05, 0.085],
    tilt: 0.85,
    clusterSize: [2, 4],
    normalBend: 0.6,
    planarLeaves: true,
    card: { mode: 'cross', sizeK: 2.2 },
    leaf: { len: 0.62, width: 0.66, shapePow: 1.2, fold: 0.22, curl: 0.14, needleCount: 0, brush: 0 },
  },
  flare: { amp: 0.2, height: 0.3, lobes: 3 },
  barkLayer: 2,
  barkRepeats: 2,
  foliageColor: { r: 0.06, g: 0.125, b: 0.08, hueVar: 0.28 }, // blue-green
  brokenTop: 0,
  stubChance: 0.03,
};

// GREENLAND: alpine bearberry (Arctous alpina) — prostrate mat, glossy oval
// leaves that blaze SCARLET in autumn (the vivid red of the tundra fall), black
// berries. Lower and flatter than bilberry.
export const BUSH_BEARBERRY: SpeciesParams = {
  id: 'bearberry',
  label: 'Alpine bearberry (Arctous alpina)',
  kind: 'broadleaf',
  height: [0.08, 0.18],
  trunkRadiusK: 0.018,
  crown: 'dome',
  asym: 0.5,
  levels: bushLevels(1.1),
  foliage: {
    kind: 'leafCluster',
    anchorLevel: 2,
    spacing: 0.045,
    tStart: 0.08,
    scale: [0.045, 0.08],
    tilt: 0.7,
    clusterSize: [2, 5],
    normalBend: 0.62,
    planarLeaves: true,
    card: { mode: 'cross', sizeK: 2.1 },
    leaf: { len: 0.55, width: 0.6, shapePow: 1.25, fold: 0.2, curl: 0.1, needleCount: 0, brush: 0 },
  },
  flare: { amp: 0.18, height: 0.28, lobes: 3 },
  barkLayer: 2,
  barkRepeats: 2,
  foliageColor: { r: 0.075, g: 0.145, b: 0.06, hueVar: 0.26 }, // glossy green
  brokenTop: 0,
  stubChance: 0.02,
};

export const UNDERSTORY_SPECIES: readonly SpeciesParams[] = [
  BUSH_HAZEL,
  BUSH_PINKFLOWER,
  BUSH_JUNIPER,
];

/** multi-stem shrub: 3–5 leaning stems merged into one bark+foliage pair */
export function buildShrub(
  sp: SpeciesParams,
  rng: Rng,
): { bark: BufferGeometry; foliage: BufferGeometry | null; tris: number } {
  const stems = 3 + rng.int(3);
  const barkG = new MeshGrower();
  const folG = new MeshGrower();
  const m = new Matrix4();
  const q = new Quaternion();
  const p = new Vector3();
  let any = false;
  for (let i = 0; i < stems; i++) {
    const a = (i / stems) * Math.PI * 2 + rng.float();
    const lean = 0.12 + rng.float() * 0.22;
    const tree = buildTree(sp, rng.fork(`stem${i}`), {
      inst: {
        leanX: Math.cos(a) * lean,
        leanZ: Math.sin(a) * lean,
        age: 0.4 + rng.float() * 0.5,
      },
    });
    p.set(Math.cos(a) * 0.09, 0, Math.sin(a) * 0.09);
    q.identity();
    m.compose(p, q, new Vector3(1, 1, 1));
    appendGeometry(barkG, tree.bark, m);
    if (tree.foliage) {
      appendGeometry(folG, tree.foliage, m);
      any = true;
    }
  }
  const bark = barkG.build();
  const foliage = any ? folG.build() : null;
  return { bark, foliage, tris: barkG.triCount + folG.triCount };
}

/** append a built BufferGeometry into a grower (positions/normals/uv/vdata) */
function appendGeometry(g: MeshGrower, src: BufferGeometry, m: Matrix4): void {
  const pos = src.getAttribute('position');
  const nrm = src.getAttribute('normal');
  const uvA = src.getAttribute('uv');
  const dat = src.getAttribute('vdata');
  const idx = src.getIndex();
  const p = new Vector3();
  const n = new Vector3();
  const base = g.vertCount;
  for (let i = 0; i < pos.count; i++) {
    p.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m);
    n.set(nrm.getX(i), nrm.getY(i), nrm.getZ(i)).transformDirection(m);
    g.vertex(
      p.x, p.y, p.z, n.x, n.y, n.z,
      uvA ? uvA.getX(i) : 0, uvA ? uvA.getY(i) : 0,
      dat ? dat.getX(i) : 0, dat ? dat.getY(i) : 0,
      dat ? dat.getZ(i) : 0, dat ? dat.getW(i) : 1,
    );
  }
  if (idx) {
    for (let i = 0; i < idx.count; i += 3) {
      g.tri(base + idx.getX(i), base + idx.getX(i + 1), base + idx.getX(i + 2));
    }
  }
}

// ---------------------------------------------------------------------------
// Ferns
// ---------------------------------------------------------------------------

/** capture species for the fern frond atlas (pinnate comb spray) */
export const FERN_CAPTURE: SpeciesParams = {
  ...BUSH_HAZEL,
  id: 'fern',
  label: 'Fern',
  foliage: {
    kind: 'needleSpray',
    anchorLevel: 2,
    spacing: 0.1,
    tStart: 0.1,
    scale: [0.3, 0.45],
    tilt: 0.6,
    clusterSize: [1, 1],
    normalBend: 0.55,
    planarLeaves: true,
    captureStyle: 'frond',
    card: { mode: 'cross', sizeK: 2.2 },
    leaf: { len: 0.1, width: 0.032, shapePow: 1, fold: 0, curl: 0, needleCount: 30, brush: 0 },
  },
  foliageColor: { r: 0.045, g: 0.14, b: 0.028, hueVar: 0.22 },
};

/** fern plant: rosette of 6–10 frond cards rising from a center */
export function buildFern(rng: Rng): BufferGeometry {
  const g = new MeshGrower();
  const fronds = 6 + rng.int(5);
  const anchors: LeafAnchor[] = [];
  const q = new Quaternion();
  const qt = new Quaternion();
  const Y = new Vector3(0, 1, 0);
  const X = new Vector3(1, 0, 0);
  for (let i = 0; i < fronds; i++) {
    const az = (i / fronds) * Math.PI * 2 + rng.float() * 0.6;
    const pitch = 0.75 + rng.float() * 0.4; // steep at the base, arches over
    q.setFromAxisAngle(Y, az);
    qt.setFromAxisAngle(X, -(Math.PI / 2 - pitch));
    q.multiply(qt);
    anchors.push({
      pos: new Vector3(Math.cos(az) * 0.03, 0.02, Math.sin(az) * 0.03),
      quat: q.clone(),
      scale: 0.2 + rng.float() * 0.14,
      hue: rng.float() * 2 - 1,
      age: rng.float() * 0.4,
    });
  }
  buildFoliageCards(g, anchors, { mode: 'lying', sizeK: 2.4, bend: 1.0 }, rng);
  return g.build();
}

// ---------------------------------------------------------------------------
// Cushion plants (moss campion / cushion saxifrage) — the classic fell-field
// cushion: a low tight green dome studded with tiny flowers. Uses
// flowerMaterial: vdata.x = 0 → green cushion body, vdata.x = 1 → flower dots.
// ---------------------------------------------------------------------------

export function buildCushion(rng: Rng): BufferGeometry {
  const g = new MeshGrower();
  const R = 0.06 + rng.float() * 0.06; // 6–12 cm across
  const H = R * (0.4 + rng.float() * 0.25); // low dome
  const rings = 3;
  const seg = 9;
  const grid: number[][] = [];
  for (let ri = 0; ri <= rings; ri++) {
    const t = ri / rings;
    const y = Math.sin(t * (Math.PI / 2)) * H;
    const rr = Math.cos(t * (Math.PI / 2)) * R;
    const row: number[] = [];
    for (let si = 0; si <= seg; si++) {
      const a = (si / seg) * Math.PI * 2;
      const knob = 1 + (rng.float() - 0.5) * 0.22; // knobbly surface
      const x = Math.cos(a) * rr * knob;
      const z = Math.sin(a) * rr * knob;
      row.push(
        g.vertex(x, y + 0.004, z, Math.cos(a) * 0.6, 0.8, Math.sin(a) * 0.6, si / seg, t, 0, 0, 0, 1),
      );
    }
    grid.push(row);
  }
  for (let ri = 0; ri < rings; ri++) {
    const rowA = grid[ri] as number[];
    const rowB = grid[ri + 1] as number[];
    for (let si = 0; si < seg; si++) {
      g.quad(
        rowA[si] as number,
        rowA[si + 1] as number,
        rowB[si + 1] as number,
        rowB[si] as number,
      );
    }
  }
  const flowers = 10 + rng.int(12);
  for (let i = 0; i < flowers; i++) {
    const a = rng.float() * Math.PI * 2;
    const rr = Math.sqrt(rng.float()) * R * 0.92;
    const fx = Math.cos(a) * rr;
    const fz = Math.sin(a) * rr;
    const t = rr / R;
    const fy = Math.cos(t * (Math.PI / 2)) * H + 0.006;
    const fs = 0.007 + rng.float() * 0.006;
    const p0 = g.vertex(fx - fs, fy, fz - fs, 0, 1, 0, 0, 0, 1, 0, 0, 1);
    const p1 = g.vertex(fx + fs, fy, fz - fs, 0, 1, 0, 1, 0, 1, 0, 0, 1);
    const p2 = g.vertex(fx + fs, fy + fs * 0.3, fz + fs, 0, 1, 0, 1, 1, 1, 0, 0, 1);
    const p3 = g.vertex(fx - fs, fy + fs * 0.3, fz + fs, 0, 1, 0, 0, 1, 1, 0, 0, 1);
    g.quad(p0, p1, p2, p3);
  }
  return g.build();
}

/** Flat diamond/ellipse leaf. Width near length makes a willow leaf; a small
 * width makes Dryas/Labrador-tea foliage. Part 0 is foliage in the material. */
function tundraLeaf(
  g: MeshGrower,
  x: number,
  y: number,
  z: number,
  az: number,
  len: number,
  width: number,
  lift = 0,
): void {
  const dx = Math.cos(az);
  const dz = Math.sin(az);
  const sx = -dz;
  const sz = dx;
  const bx = x - dx * len * 0.18;
  const bz = z - dz * len * 0.18;
  const mx = x + dx * len * 0.32;
  const mz = z + dz * len * 0.32;
  const tx = x + dx * len;
  const tz = z + dz * len;
  const b = g.vertex(bx, y, bz, 0, 1, 0, 0.5, 0, 0, 0, 0, 0.85);
  const l = g.vertex(mx + sx * width, y + lift * 0.45, mz + sz * width, 0, 1, 0, 0, 0.5, 0, 0, 0, 1);
  const t = g.vertex(tx, y + lift, tz, 0, 1, 0, 0.5, 1, 0, 0, 0, 1);
  const r = g.vertex(mx - sx * width, y + lift * 0.45, mz - sz * width, 0, 1, 0, 1, 0.5, 0, 0, 0, 1);
  g.tri(b, l, t);
  g.tri(b, t, r);
}

function tundraStem(
  g: MeshGrower,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  width: number,
): void {
  for (let axis = 0; axis < 2; axis++) {
    const ox = axis === 0 ? width : 0;
    const oz = axis === 0 ? 0 : width;
    const a = g.vertex(x0 - ox, y0, z0 - oz, 0, 0, 1, 0, 0, 0, 0, 0, 0.75);
    const b = g.vertex(x0 + ox, y0, z0 + oz, 0, 0, 1, 1, 0, 0, 0, 0, 0.75);
    const c = g.vertex(x1 + ox * 0.65, y1, z1 + oz * 0.65, 0, 0, 1, 1, 1, 0, 0, 0, 1);
    const d = g.vertex(x1 - ox * 0.65, y1, z1 - oz * 0.65, 0, 0, 1, 0, 1, 0, 0, 0, 1);
    g.quad(a, b, c, d);
  }
}

function tundraFlower(
  g: MeshGrower,
  x: number,
  y: number,
  z: number,
  radius: number,
  petals: number,
): void {
  for (let i = 0; i < petals; i++) {
    const a = (i / petals) * Math.PI * 2;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const sx = -dz * radius * 0.23;
    const sz = dx * radius * 0.23;
    const b0 = g.vertex(x - sx, y, z - sz, 0, 1, 0, 0, 0, 1, 0, 0, 1);
    const b1 = g.vertex(x + sx, y, z + sz, 0, 1, 0, 1, 0, 1, 0, 0, 1);
    const tx = x + dx * radius;
    const tz = z + dz * radius;
    const t1 = g.vertex(tx + sx * 0.45, y + radius * 0.12, tz + sz * 0.45, 0, 1, 0, 1, 1, 1, 0, 0, 1);
    const t0 = g.vertex(tx - sx * 0.45, y + radius * 0.12, tz - sz * 0.45, 0, 1, 0, 0, 1, 1, 0, 0, 1);
    g.quad(b0, b1, t1, t0);
  }
}

/** Dryas integrifolia: a creeping evergreen mat, narrow entire leaves and
 * solitary, upward-facing eight-petalled white flowers on leafless stalks. */
export function buildMountainAvens(rng: Rng): BufferGeometry {
  const g = new MeshGrower();
  const branches = 7 + rng.int(5);
  for (let i = 0; i < branches; i++) {
    const az = (i / branches) * Math.PI * 2 + rng.float() * 0.45;
    const len = 0.12 + rng.float() * 0.12;
    tundraStem(g, 0, 0.012, 0, Math.cos(az) * len, 0.018, Math.sin(az) * len, 0.003);
    const leaves = 3 + rng.int(3);
    for (let j = 1; j <= leaves; j++) {
      const t = j / (leaves + 0.3);
      tundraLeaf(
        g,
        Math.cos(az) * len * t,
        0.02 + t * 0.004,
        Math.sin(az) * len * t,
        az + (j % 2 ? 1.05 : -1.05),
        0.025 + rng.float() * 0.014,
        0.006 + rng.float() * 0.004,
        0.005,
      );
    }
  }
  const flowers = 2 + rng.int(3);
  for (let i = 0; i < flowers; i++) {
    const az = rng.float() * Math.PI * 2;
    const rr = rng.float() * 0.11;
    const x = Math.cos(az) * rr;
    const z = Math.sin(az) * rr;
    const h = 0.08 + rng.float() * 0.07;
    tundraStem(g, x, 0.015, z, x, h, z, 0.0025);
    tundraFlower(g, x, h, z, 0.018 + rng.float() * 0.008, 8);
  }
  return g.build();
}

/** Salix arctica: woody branches hug the ground; rounded silky leaves rise
 * above them and a few short upright yellow/red catkins provide the profile. */
export function buildArcticWillow(rng: Rng): BufferGeometry {
  const g = new MeshGrower();
  const branches = 6 + rng.int(5);
  for (let i = 0; i < branches; i++) {
    const az = (i / branches) * Math.PI * 2 + rng.float() * 0.5;
    const len = 0.16 + rng.float() * 0.18;
    const ex = Math.cos(az) * len;
    const ez = Math.sin(az) * len;
    tundraStem(g, 0, 0.015, 0, ex, 0.03 + rng.float() * 0.02, ez, 0.0045);
    const leaves = 4 + rng.int(3);
    for (let j = 1; j <= leaves; j++) {
      const t = j / (leaves + 0.4);
      tundraLeaf(
        g,
        ex * t,
        0.025 + t * 0.018,
        ez * t,
        az + (j % 2 ? 0.95 : -0.95),
        0.035 + rng.float() * 0.025,
        0.018 + rng.float() * 0.011,
        0.012,
      );
    }
  }
  const catkins = 1 + rng.int(3);
  for (let i = 0; i < catkins; i++) {
    const az = rng.float() * Math.PI * 2;
    const rr = 0.04 + rng.float() * 0.1;
    const x = Math.cos(az) * rr;
    const z = Math.sin(az) * rr;
    const h = 0.075 + rng.float() * 0.05;
    tundraStem(g, x, 0.02, z, x, h, z, 0.0025);
    for (let s = 0; s < 4; s++) {
      const y = h + s * 0.012;
      const w = 0.009 * (1 - s * 0.12);
      const a = g.vertex(x - w, y, z, 0, 1, 0, 0, 0, 1, 0, 0, 1);
      const b = g.vertex(x + w, y, z, 0, 1, 0, 1, 0, 1, 0, 0, 1);
      const c = g.vertex(x + w * 0.8, y + 0.014, z, 0, 1, 0, 1, 1, 1, 0, 0, 1);
      const d = g.vertex(x - w * 0.8, y + 0.014, z, 0, 1, 0, 0, 1, 1, 0, 0, 1);
      g.quad(a, b, c, d);
    }
  }
  return g.build();
}

/** Rhododendron groenlandicum: an upright evergreen bog subshrub with narrow,
 * recurved-looking leaves and dense terminal clusters of tiny white flowers. */
export function buildLabradorTea(rng: Rng): BufferGeometry {
  const g = new MeshGrower();
  const stems = 4 + rng.int(4);
  for (let i = 0; i < stems; i++) {
    const az = (i / stems) * Math.PI * 2 + rng.float() * 0.55;
    const rr = 0.025 + rng.float() * 0.055;
    const x0 = Math.cos(az) * rr;
    const z0 = Math.sin(az) * rr;
    const h = 0.22 + rng.float() * 0.2;
    const x1 = x0 + Math.cos(az) * h * 0.18;
    const z1 = z0 + Math.sin(az) * h * 0.18;
    tundraStem(g, x0, 0.01, z0, x1, h, z1, 0.004);
    const whorls = 4 + rng.int(3);
    for (let j = 1; j <= whorls; j++) {
      const t = j / (whorls + 0.8);
      for (let k = 0; k < 3; k++) {
        const la = az + (k / 3) * Math.PI * 2 + j * 0.7;
        tundraLeaf(
          g,
          x0 + (x1 - x0) * t,
          0.025 + h * t,
          z0 + (z1 - z0) * t,
          la,
          0.045 + rng.float() * 0.025,
          0.009 + rng.float() * 0.004,
          -0.004,
        );
      }
    }
    const florets = 5 + rng.int(4);
    for (let f = 0; f < florets; f++) {
      const fa = (f / florets) * Math.PI * 2;
      const fr = f === 0 ? 0 : 0.018 + rng.float() * 0.014;
      tundraFlower(g, x1 + Math.cos(fa) * fr, h + 0.008, z1 + Math.sin(fa) * fr, 0.009, 5);
    }
  }
  return g.build();
}

/** Saxifraga oppositifolia: prostrate, extensively branched mat with minute
 * four-ranked opposite leaves and solitary five-petalled purple flowers. */
export function buildPurpleSaxifrage(rng: Rng): BufferGeometry {
  const g = new MeshGrower();
  const shoots = 8 + rng.int(6);
  for (let i = 0; i < shoots; i++) {
    const az = (i / shoots) * Math.PI * 2 + rng.float() * 0.35;
    const len = 0.07 + rng.float() * 0.1;
    const ex = Math.cos(az) * len;
    const ez = Math.sin(az) * len;
    tundraStem(g, 0, 0.01, 0, ex, 0.018, ez, 0.0025);
    for (let j = 1; j <= 5; j++) {
      const t = j / 5.5;
      for (const side of [-1, 1]) {
        tundraLeaf(g, ex * t, 0.018, ez * t, az + side * Math.PI * 0.5,
          0.009 + rng.float() * 0.004, 0.0045, 0.002);
      }
    }
  }
  const flowers = 2 + rng.int(4);
  for (let i = 0; i < flowers; i++) {
    const az = rng.float() * Math.PI * 2;
    const rr = rng.float() * 0.12;
    tundraFlower(g, Math.cos(az) * rr, 0.035 + rng.float() * 0.025,
      Math.sin(az) * rr, 0.015 + rng.float() * 0.006, 5);
  }
  return g.build();
}

/** Rhodiola rosea: fleshy blue-green leaves in tight spirals on several erect
 * succulent stems, ending in broad clusters of small yellow flowers. */
export function buildRoseroot(rng: Rng): BufferGeometry {
  const g = new MeshGrower();
  const stems = 4 + rng.int(5);
  for (let i = 0; i < stems; i++) {
    const az = (i / stems) * Math.PI * 2 + rng.float() * 0.4;
    const rr = rng.float() * 0.06;
    const x = Math.cos(az) * rr;
    const z = Math.sin(az) * rr;
    const h = 0.16 + rng.float() * 0.18;
    tundraStem(g, x, 0.01, z, x + Math.cos(az) * 0.025, h, z + Math.sin(az) * 0.025, 0.006);
    for (let j = 1; j <= 6; j++) {
      const y = h * (j / 7);
      for (let k = 0; k < 3; k++) {
        const la = az + k * Math.PI * 2 / 3 + j * 0.7;
        tundraLeaf(g, x, y, z, la, 0.035 + rng.float() * 0.018,
          0.012 + rng.float() * 0.005, 0.004);
      }
    }
    const florets = 7 + rng.int(5);
    for (let f = 0; f < florets; f++) {
      const fa = f * 2.4;
      const fr = Math.sqrt(f / florets) * 0.035;
      tundraFlower(g, x + Math.cos(fa) * fr, h, z + Math.sin(fa) * fr, 0.0065, 4);
    }
  }
  return g.build();
}

/** Equisetum arvense: clonal wet-ground colony of jointed vertical stems with
 * regular whorls of slender side branches—the diagnostic horsetail silhouette. */
export function buildHorsetail(rng: Rng): BufferGeometry {
  const g = new MeshGrower();
  const stems = 7 + rng.int(8);
  for (let i = 0; i < stems; i++) {
    const az = rng.float() * Math.PI * 2;
    const rr = Math.sqrt(rng.float()) * 0.14;
    const x = Math.cos(az) * rr;
    const z = Math.sin(az) * rr;
    const h = 0.18 + rng.float() * 0.3;
    tundraStem(g, x, 0.005, z, x, h, z, 0.0035);
    const nodes = 4 + rng.int(3);
    for (let n = 1; n <= nodes; n++) {
      const y = h * n / (nodes + 1);
      const branches = 6 + (n & 1);
      const len = 0.055 * (1 - n / (nodes + 3));
      for (let b = 0; b < branches; b++) {
        const ba = b * Math.PI * 2 / branches + n * 0.35;
        tundraStem(g, x, y, z, x + Math.cos(ba) * len, y + len * 0.18,
          z + Math.sin(ba) * len, 0.0015);
      }
    }
  }
  return g.build();
}

/** Rubus chamaemorus: rhizomatous bog patch with individual upright shoots,
 * broad lobed leaves, and conspicuous amber aggregate fruit. */
export function buildCloudberry(rng: Rng): BufferGeometry {
  const g = new MeshGrower();
  const shoots = 4 + rng.int(5);
  for (let i = 0; i < shoots; i++) {
    const az = rng.float() * Math.PI * 2;
    const rr = Math.sqrt(rng.float()) * 0.16;
    const x = Math.cos(az) * rr;
    const z = Math.sin(az) * rr;
    const h = 0.09 + rng.float() * 0.12;
    tundraStem(g, x, 0.01, z, x, h, z, 0.003);
    for (let l = 0; l < 5; l++) {
      const la = l * Math.PI * 2 / 5 + az;
      tundraLeaf(g, x, h * 0.62, z, la, 0.055 + rng.float() * 0.02,
        0.022 + rng.float() * 0.008, 0.008);
    }
    // Many shoots are vegetative; fruiting shoots carry one orange drupelet head.
    if (i < 1 + shoots / 3) tundraFlower(g, x, h + 0.018, z, 0.018, 10);
  }
  return g.build();
}

/** Oxyria digyna, mountain sorrel: a basal rosette of rounded kidney-shaped
 * leaves on short petioles with slender upright reddish flower/seed spikes —
 * moist rocky flushes and ledges; foliage flushes red in autumn. */
export function buildSorrel(rng: Rng): BufferGeometry {
  const g = new MeshGrower();
  const leaves = 5 + rng.int(4);
  for (let i = 0; i < leaves; i++) {
    const az = (i / leaves) * Math.PI * 2 + rng.float() * 0.4;
    const len = 0.045 + rng.float() * 0.04;
    // rounded leaf: width near length
    tundraLeaf(g, Math.cos(az) * 0.012, 0.02, Math.sin(az) * 0.012, az,
      len, len * 0.72, 0.02);
  }
  const spikes = 1 + rng.int(2);
  for (let i = 0; i < spikes; i++) {
    const az = rng.float() * Math.PI * 2;
    const rr = rng.float() * 0.03;
    const x = Math.cos(az) * rr;
    const z = Math.sin(az) * rr;
    const h = 0.12 + rng.float() * 0.1;
    tundraStem(g, x, 0.015, z, x, h, z, 0.0025);
    for (let f = 0; f < 5; f++) {
      tundraFlower(g, x, h * (0.5 + f * 0.1), z, 0.006, 4);
    }
  }
  return g.build();
}

/** Cassiope tetragona/hypnoides, Arctic bell-heather: a trailing evergreen mat
 * of ascending stems clad in tiny appressed scale-leaves (dense, dark), with
 * nodding white bell flowers on short stalks — snow-bed heath. */
export function buildCassiope(rng: Rng): BufferGeometry {
  const g = new MeshGrower();
  const stems = 6 + rng.int(5);
  for (let i = 0; i < stems; i++) {
    const az = (i / stems) * Math.PI * 2 + rng.float() * 0.5;
    const len = 0.08 + rng.float() * 0.1;
    const ex = Math.cos(az) * len;
    const ez = Math.sin(az) * len;
    const th = 0.04 + rng.float() * 0.04;
    tundraStem(g, 0, 0.012, 0, ex, th, ez, 0.004);
    const nodes = 5 + rng.int(3);
    for (let n = 1; n <= nodes; n++) {
      const t = n / (nodes + 0.5);
      for (const side of [-1, 1]) {
        tundraLeaf(g, ex * t, 0.018 + th * t, ez * t, az + side * 1.4,
          0.012 + rng.float() * 0.006, 0.004, 0.002);
      }
    }
  }
  const bells = 2 + rng.int(3);
  for (let i = 0; i < bells; i++) {
    const az = rng.float() * Math.PI * 2;
    const rr = 0.03 + rng.float() * 0.05;
    const x = Math.cos(az) * rr;
    const z = Math.sin(az) * rr;
    const h = 0.06 + rng.float() * 0.04;
    tundraStem(g, x, 0.02, z, x, h, z, 0.0022);
    tundraFlower(g, x, h, z, 0.01, 5);
  }
  return g.build();
}

/** Carex/sedge tussock: a dense clump of tall, thin, arching triangular blades
 * rising from a tight base — the structural graminoid of mires & fens (distinct
 * from the fine grass sward and the white-tufted cottongrass). */
export function buildSedge(rng: Rng): BufferGeometry {
  const g = new MeshGrower();
  const blades = 11 + rng.int(9);
  for (let i = 0; i < blades; i++) {
    const az = rng.float() * Math.PI * 2;
    const rr = Math.sqrt(rng.float()) * 0.045;
    const x = Math.cos(az) * rr;
    const z = Math.sin(az) * rr;
    const h = 0.22 + rng.float() * 0.34;
    // arch: the tip leans out and droops over the base
    const ax = Math.cos(az) * h * (0.35 + rng.float() * 0.35);
    const az2 = Math.sin(az) * h * (0.35 + rng.float() * 0.35);
    const midY = h * 0.72;
    tundraStem(g, x, 0.005, z, x + ax * 0.4, midY, z + az2 * 0.4, 0.004);
    tundraStem(g, x + ax * 0.4, midY, z + az2 * 0.4, x + ax, h * 0.92, z + az2, 0.0018);
  }
  return g.build();
}

/** Salix arctica, standing DEAD: bleached, leafless, wind-bent branch skeleton
 * that persists through autumn/winter (co-scattered with the live willow). */
export function buildDeadWillow(rng: Rng): BufferGeometry {
  const g = new MeshGrower();
  const branches = 5 + rng.int(4);
  for (let i = 0; i < branches; i++) {
    const az = (i / branches) * Math.PI * 2 + rng.float() * 0.6;
    const len = 0.12 + rng.float() * 0.16;
    const ex = Math.cos(az) * len;
    const ez = Math.sin(az) * len;
    const mx = Math.cos(az) * len * 0.55 + (rng.float() - 0.5) * 0.05;
    const mz = Math.sin(az) * len * 0.55 + (rng.float() - 0.5) * 0.05;
    // rise then bend back down — a dead, wind-flattened prostrate willow
    tundraStem(g, 0, 0.02, 0, mx, 0.06 + rng.float() * 0.04, mz, 0.005);
    tundraStem(g, mx, 0.06, mz, ex, 0.02 + rng.float() * 0.02, ez, 0.003);
  }
  return g.build();
}

// ---------------------------------------------------------------------------
// Flowers
// ---------------------------------------------------------------------------

export type FlowerKind = 'umbel' | 'bell' | 'daisy' | 'cotton';

/**
 * Small flowering plant: thin stem + leaves + REAL petal geometry.
 * vdata.x: 0 = stem/leaf (green), 1 = petal, 0.5 = flower center.
 */
export function buildFlower(kind: FlowerKind, rng: Rng): BufferGeometry {
  const g = new MeshGrower();
  const H =
    kind === 'umbel' || kind === 'cotton'
      ? 0.4 + rng.float() * 0.28
      : 0.28 + rng.float() * 0.2;
  const sway = (rng.float() - 0.5) * 0.25;
  // stem: 2-segment thin strip pair (cross)
  const top = new Vector3(sway * H, H, sway * H * 0.6);
  const mid = new Vector3(sway * H * 0.4, H * 0.55, 0);
  for (let pl = 0; pl < 2; pl++) {
    const w = 0.006;
    const ox = pl === 0 ? w : 0;
    const oz = pl === 0 ? 0 : w;
    const a0 = g.vertex(-ox, 0, -oz, 0, 0, 1, 0, 0, 0, 0, 0, 0.8);
    const a1 = g.vertex(ox, 0, oz, 0, 0, 1, 1, 0, 0, 0, 0, 0.8);
    const b0 = g.vertex(mid.x - ox, mid.y, mid.z - oz, 0, 0, 1, 0, 0.5, 0, 0, 0, 0.9);
    const b1 = g.vertex(mid.x + ox, mid.y, mid.z + oz, 0, 0, 1, 1, 0.5, 0, 0, 0, 0.9);
    const c0 = g.vertex(top.x - ox * 0.6, top.y, top.z - oz * 0.6, 0, 0, 1, 0, 1, 0, 0, 0, 1);
    const c1 = g.vertex(top.x + ox * 0.6, top.y, top.z + oz * 0.6, 0, 0, 1, 1, 1, 0, 0, 0, 1);
    g.quad(a0, a1, b1, b0);
    g.quad(b0, b1, c1, c0);
  }
  // 2-3 basal leaves: small bent quads
  const leaves = 2 + rng.int(2);
  for (let i = 0; i < leaves; i++) {
    const az = rng.float() * Math.PI * 2;
    const ll = 0.07 + rng.float() * 0.06;
    const lx = Math.cos(az);
    const lz = Math.sin(az);
    const y0 = 0.02 + rng.float() * H * 0.3;
    const a0 = g.vertex(lx * 0.01, y0, lz * 0.01, 0, 1, 0, 0, 0, 0, 0, 0, 0.85);
    const a1 = g.vertex(lx * 0.01 - lz * 0.012, y0 + 0.005, lz * 0.01 + lx * 0.012, 0, 1, 0, 1, 0, 0, 0, 0, 0.85);
    const b0 = g.vertex(lx * ll, y0 + ll * 0.5, lz * ll, 0, 1, 0, 0, 1, 0, 0, 0, 1);
    const b1 = g.vertex(lx * ll - lz * 0.01, y0 + ll * 0.5 + 0.005, lz * ll + lx * 0.01, 0, 1, 0, 1, 1, 0, 0, 0, 1);
    g.quad(a0, a1, b1, b0);
  }
  // head(s)
  const head = (cx: number, cy: number, cz: number, s: number): void => {
    if (kind === 'daisy') {
      const petals = 8 + rng.int(5);
      for (let i = 0; i < petals; i++) {
        const az = (i / petals) * Math.PI * 2;
        const dx = Math.cos(az);
        const dz = Math.sin(az);
        const pw = s * 0.3;
        const plen = s;
        const a0 = g.vertex(cx + dx * s * 0.18 - dz * pw * 0.5, cy, cz + dz * s * 0.18 + dx * pw * 0.5, 0, 1, 0.2, 0, 0, 1, 0, 0, 1);
        const a1 = g.vertex(cx + dx * s * 0.18 + dz * pw * 0.5, cy, cz + dz * s * 0.18 - dx * pw * 0.5, 0, 1, 0.2, 1, 0, 1, 0, 0, 1);
        const b0 = g.vertex(cx + dx * plen - dz * pw * 0.25, cy + s * 0.16, cz + dz * plen + dx * pw * 0.25, 0, 1, 0.2, 0.4, 1, 1, 0, 0, 1);
        const b1 = g.vertex(cx + dx * plen + dz * pw * 0.25, cy + s * 0.16, cz + dz * plen - dx * pw * 0.25, 0, 1, 0.2, 0.6, 1, 1, 0, 0, 1);
        g.quad(a0, a1, b1, b0);
      }
      // center disc: small fan
      const c = g.vertex(cx, cy + s * 0.08, cz, 0, 1, 0, 0.5, 0.5, 0.5, 0, 0, 1);
      const ringN = 6;
      const ring: number[] = [];
      for (let i = 0; i <= ringN; i++) {
        const az = (i / ringN) * Math.PI * 2;
        ring.push(
          g.vertex(cx + Math.cos(az) * s * 0.2, cy + s * 0.03, cz + Math.sin(az) * s * 0.2, 0, 1, 0, 0.5, 0.5, 0.5, 0, 0, 1),
        );
      }
      for (let i = 0; i < ringN; i++) g.tri(c, ring[i + 1] as number, ring[i] as number);
    } else if (kind === 'bell') {
      // drooping bell: cone of petals pointing down
      const petals = 5;
      for (let i = 0; i < petals; i++) {
        const az = (i / petals) * Math.PI * 2;
        const dx = Math.cos(az);
        const dz = Math.sin(az);
        const a0 = g.vertex(cx + dx * s * 0.12, cy, cz + dz * s * 0.12, dx, 0.3, dz, 0.4, 0, 1, 0, 0, 1);
        const a1 = g.vertex(cx + Math.cos(az + 1.25) * s * 0.12, cy, cz + Math.sin(az + 1.25) * s * 0.12, dx, 0.3, dz, 0.6, 0, 1, 0, 0, 1);
        const b0 = g.vertex(cx + dx * s * 0.3, cy - s * 0.5, cz + dz * s * 0.3, dx, 0, dz, 0.4, 1, 1, 0, 0, 1);
        const b1 = g.vertex(cx + Math.cos(az + 1.25) * s * 0.3, cy - s * 0.5, cz + Math.sin(az + 1.25) * s * 0.3, dx, 0, dz, 0.6, 1, 1, 0, 0, 1);
        g.quad(a0, a1, b1, b0);
      }
    } else if (kind === 'cotton') {
      // GREENLAND cottongrass (Eriophorum): a WISPY upward tuft of fine white
      // hairs on the stem tip — NOT a solid ball. Thin near-vertical strands
      // fan slightly outward and taper up. vdata.x = 1 → white in flowerMaterial.
      const strands = 12 + rng.int(9);
      for (let i = 0; i < strands; i++) {
        const az = rng.float() * Math.PI * 2;
        const fan = rng.float() * 0.5; // slight outward fan
        const len = s * (1.3 + rng.float() * 1.1); // tall, thin
        const w = s * 0.06; // very thin strand
        const bx = cx + Math.cos(az) * fan * s * 0.25;
        const bz = cz + Math.sin(az) * fan * s * 0.25;
        const tx = cx + Math.cos(az) * fan * s;
        const tz = cz + Math.sin(az) * fan * s;
        const a0 = g.vertex(bx - w, cy, bz, 0, 1, 0, 0, 0, 1, 0, 0, 1);
        const a1 = g.vertex(bx + w, cy, bz, 0, 1, 0, 1, 0, 1, 0, 0, 1);
        const b1 = g.vertex(tx + w * 0.4, cy + len, tz, 0, 1, 0, 1, 1, 1, 0, 0, 1);
        const b0 = g.vertex(tx - w * 0.4, cy + len, tz, 0, 1, 0, 0, 1, 1, 0, 0, 1);
        g.quad(a0, a1, b1, b0);
      }
    } else {
      // umbel: cluster of tiny 4-petal florets on a dome
      const florets = 12 + rng.int(8);
      for (let i = 0; i < florets; i++) {
        const az = rng.float() * Math.PI * 2;
        const rr = Math.sqrt(rng.float()) * s;
        const fx = cx + Math.cos(az) * rr;
        const fz = cz + Math.sin(az) * rr;
        const fy = cy + (1 - (rr / s) * (rr / s)) * s * 0.35;
        const fs = s * 0.16;
        const a0 = g.vertex(fx - fs, fy, fz - fs, 0, 1, 0, 0, 0, 1, 0, 0, 1);
        const a1 = g.vertex(fx + fs, fy, fz - fs, 0, 1, 0, 1, 0, 1, 0, 0, 1);
        const b1 = g.vertex(fx + fs, fy + fs * 0.2, fz + fs, 0, 1, 0, 1, 1, 1, 0, 0, 1);
        const b0 = g.vertex(fx - fs, fy + fs * 0.2, fz + fs, 0, 1, 0, 0, 1, 1, 0, 0, 1);
        g.quad(a0, a1, b1, b0);
      }
    }
  };
  if (kind === 'bell') {
    // several bells hanging along the stem top
    const bells = 2 + rng.int(3);
    for (let i = 0; i < bells; i++) {
      const t = 0.6 + (i / bells) * 0.4;
      head(top.x * t + 0.02 * i, H * t, top.z * t, 0.05 + rng.float() * 0.02);
    }
  } else {
    const headS =
      kind === 'umbel'
        ? 0.09 + rng.float() * 0.04
        : kind === 'cotton'
          ? 0.055 + rng.float() * 0.03
          : 0.045 + rng.float() * 0.02;
    head(top.x, H + 0.02, top.z, headS);
  }
  return g.build();
}
