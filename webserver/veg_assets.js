// Procedural ground-asset prototypes for the Greenland scatter.
// Greenland is mostly rock: the asset set is rock-first (boulders, slabs,
// scree/talus) with simple plant stand-ins. Each prototype is one merged,
// non-indexed BufferGeometry with baked vertex-color shading, cheap enough
// for tile-scale InstancedMesh use. All shapes are deterministic (fixed-seed
// PRNG) so instances are identical across sessions and reloads.
//
// Guide numbers (sizes, densities, palettes) come from the LAAS_ASSETS.md
// workflow; geometry silhouettes are validated by eye against Google refs
// like 13-2754-1574 (fractured bedrock, talus fans, perched boulders).
import * as THREE from 'three';

// footprint diameter (meters) of each prototype at scale 1 — scatter code
// converts measured real-world sizes to instance scale with these
export const PROTO_DIAM = {
  stone: 0.9,
  boulder: 1.0,
  slab: 1.1,
  scree: 1.6,
  shrub: 1.1,
  tussock: 1.0,
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function bakeShading(geo, { verticalBoost = 0, tint = null } = {}) {
  geo.computeVertexNormals();
  const nrm = geo.getAttribute('normal');
  const pos = geo.getAttribute('position');
  const n = pos.count;
  const col = new Float32Array(n * 3);
  const L = new THREE.Vector3(0.45, 0.25, 0.86).normalize(); // fake sun
  geo.computeBoundingBox();
  const zMin = geo.boundingBox.min.z, zMax = geo.boundingBox.max.z;
  const zSpan = Math.max(1e-6, zMax - zMin);
  const tr = tint ? tint[0] : 1, tg = tint ? tint[1] : 1, tb = tint ? tint[2] : 1;
  for (let i = 0; i < n; i++) {
    const d = Math.max(0, nrm.getX(i) * L.x + nrm.getY(i) * L.y + nrm.getZ(i) * L.z);
    let s = 0.55 + 0.45 * d;
    if (verticalBoost > 0) {
      const t = (pos.getZ(i) - zMin) / zSpan; // darker base, lighter tip
      s *= (1 - verticalBoost) + verticalBoost * (0.5 + 0.7 * t);
    }
    col[i * 3] = s * tr; col[i * 3 + 1] = s * tg; col[i * 3 + 2] = s * tb;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

// displace vertices radially (from centroid, xy-weighted) for lumpy/fractured
// silhouettes; shared vertices stay shared so the surface doesn't crack
function displace(geo, amp, rng) {
  const pos = geo.getAttribute('position');
  const seen = new Map(); // weld displacements across duplicated vertices
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const key = `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
    let k = seen.get(key);
    if (k === undefined) { k = 1 + (rng() * 2 - 1) * amp; seen.set(key, k); }
    pos.setXYZ(i, x * k, y * k, z * (1 + (k - 1) * 0.6));
  }
  pos.needsUpdate = true;
  return geo;
}

const nonIndexed = g => (g.index ? g.toNonIndexed() : g);

// merge non-indexed geometries by concatenating position (+color) buffers
function mergeGeos(geos) {
  const parts = geos.map(nonIndexed);
  let total = 0;
  for (const g of parts) total += g.getAttribute('position').count;
  const pos = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  let off = 0;
  for (const g of parts) {
    pos.set(g.getAttribute('position').array, off * 3);
    const c = g.getAttribute('color');
    if (c) col.set(c.array, off * 3);
    else col.fill(1, off * 3, (off + g.getAttribute('position').count) * 3);
    off += g.getAttribute('position').count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeVertexNormals();
  return out;
}

// ── rock assets ──────────────────────────────────────────────────────────────

// boulder: glacially-dumped erratic — faceted, slightly squashed, crisp faces
function buildBoulder(rng) {
  const g = nonIndexed(new THREE.IcosahedronGeometry(0.5, 1));
  displace(g, 0.22, rng);
  g.scale(1, 0.9, 0.72);
  g.translate(0, 0, 0.28); // bedded: bottom third sits in the ground
  return bakeShading(g, {});
}

// slab: fractured bedrock block, tilted like shed roof plates on the refs
function buildSlab(rng) {
  const g = nonIndexed(new THREE.BoxGeometry(1.0, 0.62, 0.2, 2, 1, 1));
  displace(g, 0.09, rng);
  g.rotateY(0.28 + rng() * 0.2);   // resting tilt
  g.rotateZ(rng() * 0.4);
  g.translate(0, 0, 0.16);
  return bakeShading(g, {});
}

// scree: talus patch — a handful of sharp clasts strewn in a ~1.6 m disc,
// rendered as ONE instance so a patch costs one matrix, not fourteen
function buildScree(rng) {
  const parts = [];
  const n = 14;
  for (let i = 0; i < n; i++) {
    const s = nonIndexed(new THREE.IcosahedronGeometry(0.05 + rng() * 0.09, 0));
    displace(s, 0.25, rng);
    s.scale(1, 0.9, 0.55 + rng() * 0.25); // clasts lie flat-ish
    const a = rng() * Math.PI * 2;
    const r = 0.12 + Math.sqrt(rng()) * 0.68; // denser toward patch heart
    s.rotateZ(rng() * Math.PI);
    s.translate(Math.cos(a) * r, Math.sin(a) * r, 0.03 + rng() * 0.02);
    bakeShading(s, { tint: [0.9 + rng() * 0.25, 0.9 + rng() * 0.22, 0.9 + rng() * 0.2] });
    parts.push(s);
  }
  return mergeGeos(parts);
}

// stone: single small cobble (the original PoC rock)
function buildStone() {
  const g = new THREE.IcosahedronGeometry(0.45, 0);
  g.scale(1, 0.8, 0.62);
  return bakeShading(g, {});
}

// ── plant stand-ins (unchanged silhouettes; real work is rocks first) ────────

function buildShrub() {
  const g = new THREE.ConeGeometry(0.55, 1.2, 6);
  g.translate(0, 0.6, 0);
  g.rotateX(Math.PI / 2);
  return bakeShading(g, { verticalBoost: 0.6 });
}

function buildTussock() {
  const g = new THREE.SphereGeometry(0.5, 6, 4);
  g.scale(1, 1, 0.45);
  return bakeShading(g, { verticalBoost: 0.5 });
}

export function buildAssetProtos() {
  // one fixed-seed stream per asset so adding/reordering assets never
  // reshuffles another one's shape
  return {
    stone: buildStone(),
    boulder: buildBoulder(mulberry32(0xa5eed01)),
    slab: buildSlab(mulberry32(0xa5eed02)),
    scree: buildScree(mulberry32(0xa5eed03)),
    shrub: buildShrub(),
    tussock: buildTussock(),
  };
}
