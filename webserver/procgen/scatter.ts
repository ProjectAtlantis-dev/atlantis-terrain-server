/**
 * scatter — per-tile deterministic placement of library assets on terrain.
 *
 * First-pass chain validation: density is gated by DEM facts only (elevation,
 * slope, southness from the tile heightmap) — the class-map (biomes.py
 * buckets) hookup comes next. Placement is seeded from the tile id, so a
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
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
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

/** flat-enough-to-stand gate (gradient magnitude, rise/run) */
const MAX_SLOPE_ALL = 1.4;

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
const CATEGORIES: CategorySpec[] = [
  { prefix: 'tree/', density: 1 / 1200, cap: 120, maxSlope: 0.6, minElev: 3 },
  { prefix: 'shrub/', density: 1 / 1500, cap: 100, maxSlope: 0.9, minElev: 2 },
  { prefix: 'fern/', density: 1 / 4000, cap: 40, maxSlope: 0.8, minElev: 2 },
  { prefix: 'flower/', density: 1 / 3000, cap: 60, maxSlope: 0.7, minElev: 2 },
  { prefix: 'grass/', density: 1 / 3000, cap: 80, maxSlope: 0.7, minElev: 2 },
  { prefix: 'log/', density: 1 / 8000, cap: 15, maxSlope: 0.5, minElev: 3 },
  { prefix: 'stump/', density: 1 / 10000, cap: 10, maxSlope: 0.5, minElev: 3 },
  { prefix: 'rock/hero/', density: 1 / 60000, cap: 4, maxSlope: 0.8, minElev: 1 },
  { prefix: 'rock/boulder/', density: 1 / 3000, cap: 80, maxSlope: 1.0, minElev: 1 },
  { prefix: 'rock/angular/', density: 1 / 6000, cap: 40, maxSlope: 1.2, minElev: 1 },
  { prefix: 'rock/slab/', density: 1 / 6000, cap: 40, maxSlope: 1.0, minElev: 1 },
  { prefix: 'rock/talus/', density: 1 / 4000, cap: 60, maxSlope: 1.4, minElev: 1, slopeBias: 2.0 },
  { prefix: 'rock/cobble/', density: 1 / 2500, cap: 120, maxSlope: 1.2, minElev: 1 },
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
}

interface Sample {
  z: number;
  slope: number;
  southness: number;
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
    return { z, slope, southness };
  };
}

const _m = new Matrix4();
const _q = new Quaternion();
const _qYaw = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _zAxis = new Vector3(0, 0, 1);
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

  const placements = new Map<AssetKind, Matrix4[]>();
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
      if (s.slope > Math.min(cat.maxSlope, MAX_SLOPE_ALL)) continue;
      if (cat.slopeBias && rng.float() > (s.slope / cat.maxSlope) * cat.slopeBias) continue;
      const kind = kinds[rng.int(kinds.length)] as AssetKind;
      // HARD RULE: nothing living on north slopes, ever
      if (kind.living && s.southness < VEG_MIN_SOUTHNESS && s.slope > 0.08) continue;
      const scale = kind.scale[0] + rng.float() * (kind.scale[1] - kind.scale[0]);
      _qYaw.setFromAxisAngle(_zAxis, rng.float() * Math.PI * 2);
      _q.copy(_qYaw).multiply(_qXup);
      // sink slightly so bases don't hover on slopes
      _p.set(x, y, (s.z - 0.12 * scale * (1 + s.slope)) * exag);
      _s.set(scale, scale, scale);
      _m.compose(_p, _q, _s);
      let arr = placements.get(kind);
      if (!arr) placements.set(kind, arr = []);
      arr.push(_m.clone());
      placed++;
      total++;
    }
  }

  if (total === 0) return null;

  const group = new Group();
  group.name = `scatter/${input.tileId}`;
  group.userData.isScatter = true;
  for (const [kind, mats] of placements) {
    for (const part of kind.parts) {
      const mesh = new InstancedMesh(part.geo, part.mat, mats.length);
      for (let i = 0; i < mats.length; i++) mesh.setMatrixAt(i, mats[i] as Matrix4);
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

/** dispose every scatter child (shared geometry/material stay alive) */
export function disposeTileScatter(tileMesh: Mesh | Group): void {
  for (const child of tileMesh.children) {
    if (!child.userData?.isScatter) continue;
    for (const m of child.children) {
      if ((m as InstancedMesh).isInstancedMesh) (m as InstancedMesh).dispose();
    }
  }
}
