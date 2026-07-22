/**
 * Foliage geometry — REAL meshes, no alpha cards at LOD0 (cards come from
 * captures of these meshes at LOD1+). A leaf is a folded/curled strip with a
 * parametric outline; a needle spray is a stem with dozens of single-quad
 * needles in comb or brush arrangement. Everything appends into a MeshGrower
 * in the anchor's local frame (+z outward, +y up) via a supplied transform.
 *
 * vdata: x hue, y sway flex, z sway phase, w AO (crown depth applied later).
 */

import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Rng } from '../core/Seed';
import type { MeshGrower } from './TubeMesh';
import type { LeafAnchor, LeafShapeParams } from './VegTypes';

const _p = new Vector3();
const _n = new Vector3();
const _m = new Matrix4();
const _q = new Quaternion();

function pushXf(
  g: MeshGrower,
  m: Matrix4,
  px: number, py: number, pz: number,
  nx: number, ny: number, nz: number,
  u: number, v: number,
  d0: number, d1: number, d2: number, d3: number,
): number {
  _p.set(px, py, pz).applyMatrix4(m);
  _n.set(nx, ny, nz).transformDirection(m);
  return g.vertex(_p.x, _p.y, _p.z, _n.x, _n.y, _n.z, u, v, d0, d1, d2, d3);
}

/**
 * One leaf: 4-row strip along +z, 3 verts per row (−w, mid, +w), folded along
 * the midrib and curled toward the tip. ~18 tris. Local: base at origin,
 * blade along +z, face up +y.
 */
export function buildLeaf(
  g: MeshGrower,
  m: Matrix4,
  shape: LeafShapeParams,
  hue: number,
  flex: number,
  phase: number,
  ao: number,
): void {
  const ROWS = 4;
  const L = shape.len;
  const W = shape.width;
  const rows: number[][] = [];
  // tiny petiole
  const stem = L * 0.14;
  for (let i = 0; i <= ROWS; i++) {
    const s = i / ROWS;
    const w = W * Math.pow(Math.sin(Math.PI * Math.min(1, s * 0.86 + 0.07)), shape.shapePow);
    const z = stem + s * (L - stem);
    const curlY = -shape.curl * s * s * L;
    const foldY = shape.fold * w;
    // normal tilts with fold; rough but cheap (verts re-lit by bendNormals)
    const r: number[] = [];
    r.push(pushXf(g, m, -w, curlY + foldY * 0.0 - foldY, z, -shape.fold * 0.8, 1, 0, 0, s, hue, flex, phase, ao * 0.92));
    r.push(pushXf(g, m, 0, curlY + foldY * 0.35, z, 0, 1, shape.curl * s, 0.5, s, hue, flex, phase, ao));
    r.push(pushXf(g, m, w, curlY - foldY, z, shape.fold * 0.8, 1, 0, 1, s, hue, flex, phase, ao * 0.92));
    rows.push(r);
  }
  for (let i = 0; i < ROWS; i++) {
    const a = rows[i] as number[];
    const b = rows[i + 1] as number[];
    g.quad(a[0] as number, b[0] as number, b[1] as number, a[1] as number);
    g.quad(a[1] as number, b[1] as number, b[2] as number, a[2] as number);
  }
  // petiole quad
  const p0 = pushXf(g, m, -W * 0.06, 0, 0, 0, 1, 0, 0.45, 0, hue, flex * 0.7, phase, ao);
  const p1 = pushXf(g, m, W * 0.06, 0, 0, 0, 1, 0, 0.55, 0, hue, flex * 0.7, phase, ao);
  const r0 = rows[0] as number[];
  g.quad(p0, r0[0] as number, r0[1] as number, p1);
  g.tri(p1, r0[1] as number, r0[2] as number);
}

/**
 * Needle spray: drooping stem polyline + `needleCount` single-quad needles,
 * comb (flat, ±row) or brush (radial) arrangement. Local: along +z.
 */
export function buildNeedleSpray(
  g: MeshGrower,
  m: Matrix4,
  shape: LeafShapeParams,
  scale: number,
  rng: Rng,
  hue: number,
  flex: number,
  phase: number,
  ao: number,
): void {
  const SEGS = 4;
  const L = scale;
  // stem: thin two-sided strip (cheaper than a tube, reads as twig)
  const stemPts: Vector3[] = [];
  let dz = 1;
  let dy = 0;
  let z = 0;
  let y = 0;
  for (let i = 0; i <= SEGS; i++) {
    stemPts.push(new Vector3(0, y, z));
    const step = L / SEGS;
    dy -= 0.16 * (i / SEGS); // sag
    const dl = Math.hypot(dy, dz);
    z += (dz / dl) * step;
    y += (dy / dl) * step;
  }
  const sw = L * 0.012 + 0.002;
  const stemRows: number[][] = [];
  for (let i = 0; i <= SEGS; i++) {
    const p = stemPts[i] as Vector3;
    const w = sw * (1 - (i / SEGS) * 0.7);
    stemRows.push([
      pushXf(g, m, p.x - w, p.y, p.z, 0, 1, 0, 0.48, i / SEGS, hue, flex, phase, ao * 0.85),
      pushXf(g, m, p.x + w, p.y, p.z, 0, 1, 0, 0.52, i / SEGS, hue, flex, phase, ao * 0.85),
    ]);
  }
  for (let i = 0; i < SEGS; i++) {
    const a = stemRows[i] as number[];
    const b = stemRows[i + 1] as number[];
    g.quad(a[0] as number, b[0] as number, b[1] as number, a[1] as number);
  }

  // needles
  const count = shape.needleCount;
  const nl = shape.len;
  const nw = shape.width;
  for (let i = 0; i < count; i++) {
    const s = (i + 0.5) / count;
    const idxF = s * SEGS;
    const i0 = Math.min(SEGS - 1, Math.floor(idxF));
    const f = idxF - i0;
    const base = _p
      .copy(stemPts[i0] as Vector3)
      .lerp(stemPts[i0 + 1] as Vector3, f)
      .clone();
    // comb: two layered rows ±x (fills the bough plane); brush: radial
    const side = i % 2 === 0 ? 1 : -1;
    const layer = i % 4 < 2 ? 1 : 0;
    const az = shape.brush > 0.5
      ? rng.float() * Math.PI * 2
      : side * (1.05 + (rng.float() - 0.5) * 0.85);
    const elev = shape.brush > 0.5
      ? (rng.float() - 0.2) * 1.1
      : (layer === 1 ? 0.42 : 0.02) + (rng.float() - 0.5) * 0.3;
    const swing = (rng.float() - 0.5) * 0.3 + s * 0.55; // sweep toward tip
    const dir = new Vector3(
      Math.sin(az) * Math.cos(elev),
      Math.sin(elev),
      Math.cos(az) * Math.cos(elev) * 0.35 + swing,
    ).normalize();
    const lenJ = nl * (0.75 + rng.float() * 0.5) * (0.65 + 0.35 * Math.sin(Math.PI * Math.min(1, s * 1.18)));
    const tip = base.clone().addScaledVector(dir, lenJ);
    // quad across the needle, normal ≈ up-out blend
    const acrossDir = new Vector3(-dir.z, 0, dir.x).normalize().multiplyScalar(nw * 0.5);
    const nrm = new Vector3(0, 1, 0).addScaledVector(dir, -0.25).normalize();
    const hueN = hue + (rng.float() - 0.5) * 0.5;
    const a0 = pushXf(g, m, base.x - acrossDir.x, base.y, base.z - acrossDir.z, nrm.x, nrm.y, nrm.z, 0, 0, hueN, flex, phase, ao * 0.9);
    const a1 = pushXf(g, m, base.x + acrossDir.x, base.y, base.z + acrossDir.z, nrm.x, nrm.y, nrm.z, 1, 0, hueN, flex, phase, ao * 0.9);
    const b0 = pushXf(g, m, tip.x - acrossDir.x * 0.25, tip.y, tip.z - acrossDir.z * 0.25, nrm.x, nrm.y, nrm.z, 0.4, 1, hueN, flex * 1.15, phase, ao);
    const b1 = pushXf(g, m, tip.x + acrossDir.x * 0.25, tip.y, tip.z + acrossDir.z * 0.25, nrm.x, nrm.y, nrm.z, 0.6, 1, hueN, flex * 1.15, phase, ao);
    g.quad(a0, b0, b1, a1);
  }
}

/** leaf cluster: `n` leaves fanned around the anchor's +z */
export function buildLeafCluster(
  g: MeshGrower,
  anchor: LeafAnchor,
  shape: LeafShapeParams,
  clusterSize: [number, number],
  rng: Rng,
): void {
  const n = Math.round(clusterSize[0] + rng.float() * (clusterSize[1] - clusterSize[0]));
  const flex = 0.55 + rng.float() * 0.3;
  for (let i = 0; i < n; i++) {
    const az = (i / n) * Math.PI * 2 + rng.float() * 0.9;
    const pitch = -0.5 - rng.float() * 0.6; // droop down-out
    _q.setFromAxisAngle(new Vector3(0, 1, 0), az);
    const qp = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -pitch);
    const qr = anchor.quat.clone().multiply(_q).multiply(qp);
    const s = anchor.scale * (0.8 + rng.float() * 0.45);
    _m.compose(anchor.pos, qr, new Vector3(s, s, s));
    buildLeaf(
      g, _m, shape,
      anchor.hue + (rng.float() - 0.5) * 0.4,
      flex,
      rng.float() * Math.PI * 2,
      1,
    );
  }
}

/** needle spray at an anchor */
export function buildSprayAt(
  g: MeshGrower,
  anchor: LeafAnchor,
  shape: LeafShapeParams,
  rng: Rng,
): void {
  _m.compose(anchor.pos, anchor.quat, new Vector3(1, 1, 1));
  buildNeedleSpray(
    g, _m, shape, anchor.scale, rng,
    anchor.hue, 0.5 + rng.float() * 0.3, rng.float() * Math.PI * 2, 1,
  );
}
