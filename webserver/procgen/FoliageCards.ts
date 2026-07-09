/**
 * Foliage cluster cards (the ez-tree look, zero external assets):
 * a lush twig/spray — dozens of REAL leaf/needle meshes — is rendered ONCE
 * into a per-species 2×2 variant atlas; the tree then places big alpha-tested
 * cards at its foliage anchors. One card = a whole leafy cluster at 2–4 tris,
 * which is where the crown fullness comes from. The same capture rig later
 * feeds branch cards and octahedral impostors.
 *
 * Capture detail: albedo is written sqrt-encoded (8-bit linear murders dark
 * greens), background-dilated on CPU (no dark halos in mips), and decoded in
 * the card material.
 */

import {
  DataTexture,
  DoubleSide,
  LinearFilter,
  LinearMipmapLinearFilter,
  Color,
  Matrix4,
  Mesh,
  NoColorSpace,
  OrthographicCamera,
  Quaternion,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import type { Rng } from './Seed';
import { buildLeaf, buildNeedleSpray } from './LeafMesh';
import { MeshGrower } from './TubeMesh';
import type { LeafAnchor, SpeciesParams } from './VegTypes';

export const ATLAS_RES = 1024;

const _m = new Matrix4();
const _q = new Quaternion();
const _q2 = new Quaternion();
const X = new Vector3(1, 0, 0);
const Z = new Vector3(0, 0, 1);

/** twig content for one capture tile, centered at (cx, cy), tile size 1 */
function buildTwigTile(
  g: MeshGrower,
  sp: SpeciesParams,
  rng: Rng,
  cx: number,
  cy: number,
): void {
  const fol = sp.foliage;
  if (!fol) return;
  const half = 0.46;
  if (fol.kind === 'needleSpray') {
    const brush = fol.leaf.brush > 0.5;
    const frond = fol.captureStyle === 'frond';
    // main spray growing +y from tile bottom; needle scale in tile units
    const scaleToTile = (2 * half) / (fol.scale[1] * 1.15);
    const leaf = {
      ...fol.leaf,
      len: fol.leaf.len * scaleToTile * (frond ? 1.45 : 1),
      width: fol.leaf.width * scaleToTile * 1.15,
      needleCount: Math.round(fol.leaf.needleCount * (frond ? 1.5 : brush ? 1.4 : 1.2)),
    };
    const sprayLen = fol.scale[1] * scaleToTile * (frond ? 1.3 : 1);
    const sub = frond ? 0 : brush ? 6 : 9;
    for (let i = -1; i < sub; i++) {
      const t = i < 0 ? 0 : (i + 0.6) / sub;
      const along = -half + t * sprayLen * 0.8;
      const side = i < 0 ? 0 : (i % 2 === 0 ? 1 : -1);
      const ang = i < 0 ? 0 : side * (0.75 + rng.float() * 0.65) * (brush ? 1.1 : 1);
      _q.setFromAxisAngle(Z, ang);
      _q2.setFromAxisAngle(X, -Math.PI / 2); // local +z → tile +y
      _q.multiply(_q2);
      const s = i < 0 ? 1 : (0.5 + rng.float() * 0.32) * (1.1 - t * 0.35);
      _m.compose(
        new Vector3(cx + (i < 0 ? 0 : Math.sin(ang) * 0.06), cy + along, 0),
        _q,
        new Vector3(s, s, s),
      );
      buildNeedleSpray(
        g, _m, leaf, sprayLen * (i < 0 ? 1 : s * 0.8), rng,
        rng.float() * 2 - 1, 0.5, rng.float() * 6.28,
        0.72 + rng.float() * 0.28,
      );
    }
  } else {
    // broadleaf cluster: short stem fan + 14–20 leaves facing mostly +z
    const n = 14 + rng.int(7);
    const leafScale = (2 * half) / (fol.leaf.len * 2.1);
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      // leaves arranged along a loose wide fan from bottom
      const spread = 0.5 + t * 0.6;
      const ang = (rng.float() - 0.5) * 3.0 * spread;
      const r = (0.15 + t * 0.85) * half * (0.75 + rng.float() * 0.45);
      const px = cx + Math.sin(ang) * r;
      const py = cy - half * 0.82 + (t * 1.45 + rng.float() * 0.3) * half;
      // orientation: blade up the fan direction, tilted toward camera
      _q.setFromAxisAngle(Z, ang * 0.8 + (rng.float() - 0.5) * 0.5);
      _q2.setFromAxisAngle(X, -Math.PI / 2 + 0.45 + (rng.float() - 0.3) * 0.7);
      _q.multiply(_q2);
      const s = leafScale * (0.75 + rng.float() * 0.5);
      _m.compose(new Vector3(px, py, (rng.float() - 0.5) * 0.05), _q, new Vector3(s, s, s));
      buildLeaf(
        g, _m, fol.leaf,
        rng.float() * 2 - 1, 0.5, rng.float() * 6.28,
        0.65 + rng.float() * 0.35,
      );
    }
  }
}

/**
 * Capture material: sqrt-encoded albedo, unlit. WebGL port of the demo's TSL
 * node material — same math (hue warm/cool shift, midrib + tip accents,
 * blossom threshold on hue jitter), as a plain GLSL ShaderMaterial.
 */
function captureMaterial(sp: SpeciesParams): ShaderMaterial {
  const c = sp.foliageColor;
  const bl = sp.blossom;
  return new ShaderMaterial({
    uniforms: {
      baseColor: { value: [c.r, c.g, c.b] },
      hueVar: { value: c.hueVar },
      blossomColor: { value: bl ? [bl.r, bl.g, bl.b] : [0, 0, 0] },
      blossomThresh: { value: bl ? 1 - bl.frac * 2 : 2 },
    },
    vertexShader: /* glsl */ `
      attribute vec4 vdata;
      varying vec2 vUvV;
      varying vec4 vData;
      void main() {
        vUvV = uv;
        vData = vdata;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 baseColor;
      uniform float hueVar;
      uniform vec3 blossomColor;
      uniform float blossomThresh;
      varying vec2 vUvV;
      varying vec4 vData;
      void main() {
        float k = vData.x * hueVar;
        vec3 warmed = baseColor
          * mix(vec3(1.0), vec3(1.25, 1.05, 0.5), clamp(k, 0.0, 1.0))
          * mix(vec3(1.0), vec3(0.72, 0.95, 1.2), clamp(-k, 0.0, 1.0));
        float midrib = smoothstep(0.0, 0.05, abs(vUvV.x - 0.5));
        float tipLight = mix(0.92, 1.18, vUvV.y);
        vec3 albedo = warmed * vData.w * (midrib * 0.18 + 0.82) * tipLight;
        if (vData.x > blossomThresh) {
          albedo = blossomColor * mix(0.75, 1.15, vUvV.y) * (vData.w * 0.4 + 0.6);
        }
        // sqrt-encode for 8-bit storage (decoded by squaring in the card material)
        gl_FragColor = vec4(sqrt(clamp(albedo, 0.0, 1.0)), 1.0);
      }
    `,
    side: DoubleSide,
  });
}

/** alpha-aware dilation: bleed cluster color into transparent texels */
function dilate(px: Uint8Array, res: number, passes: number): void {
  const idx = (x: number, y: number): number => (y * res + x) * 4;
  for (let p = 0; p < passes; p++) {
    const src = px.slice();
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const i = idx(x, y);
        if ((src[i + 3] as number) > 8) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= res || yy >= res) continue;
            const j = idx(xx, yy);
            if ((src[j + 3] as number) > 8) {
              r += src[j] as number; g += src[j + 1] as number; b += src[j + 2] as number;
              n++;
            }
          }
        }
        if (n > 0) {
          px[i] = Math.round(r / n);
          px[i + 1] = Math.round(g / n);
          px[i + 2] = Math.round(b / n);
          px[i + 3] = 9; // mark as filled so later passes spread further
        }
      }
    }
  }
  // dilation alpha markers must not pass the alpha test
  for (let i = 3; i < px.length; i += 4) {
    if ((px[i] as number) <= 9) px[i] = 0;
  }
}

/**
 * Render the species' twig atlas (2×2 variants) and return a mipmapped
 * texture. ~tens of ms once per species; deterministic per seed stream.
 */
export function captureFoliageAtlas(
  renderer: WebGLRenderer,
  sp: SpeciesParams,
  rng: Rng,
): DataTexture {
  const scene = new Scene();
  const g = new MeshGrower();
  for (let v = 0; v < 4; v++) {
    buildTwigTile(g, sp, rng.fork(`tile${v}`), (v % 2) - 0.5, Math.floor(v / 2) - 0.5);
  }
  const mat = captureMaterial(sp);
  const geo = g.build();
  const mesh = new Mesh(geo, mat);
  mesh.frustumCulled = false;
  scene.add(mesh);

  const cam = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  cam.position.set(0, 0, 5);
  cam.lookAt(0, 0, 0);

  const rt = new WebGLRenderTarget(ATLAS_RES, ATLAS_RES);
  rt.texture.colorSpace = NoColorSpace;

  const prevTarget = renderer.getRenderTarget();
  const prevClearAlpha = renderer.getClearAlpha();
  const prevClearColor = renderer.getClearColor(new Color());
  renderer.setClearColor(0x000000, 0);
  renderer.setRenderTarget(rt);
  renderer.clear();
  renderer.render(scene, cam);
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClearColor, prevClearAlpha);

  // WebGL readbacks are bottom-left origin — already matches UV space
  const px = new Uint8Array(ATLAS_RES * ATLAS_RES * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, ATLAS_RES, ATLAS_RES, px);
  dilate(px, ATLAS_RES, 6);
  rt.dispose();
  geo.dispose();
  mat.dispose();

  const tex = new DataTexture(px, ATLAS_RES, ATLAS_RES);
  tex.colorSpace = NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Card geometry at every anchor: length axis along the anchor's +z (texture
 * v), 'lying' plane = bough plane (normal +y), 'cross' adds a second plane
 * for volumetric read. vdata carries hue/sway/AO as usual.
 */
export function buildFoliageCards(
  g: MeshGrower,
  anchors: readonly LeafAnchor[],
  opts: { mode: 'lying' | 'cross'; sizeK: number; bend?: number },
  rng: Rng,
): void {
  const right = new Vector3();
  const upL = new Vector3();
  const out = new Vector3();
  const p = new Vector3();
  const rowPos = new Vector3();
  const dirRow = new Vector3();
  const nrmRow = new Vector3();
  const bend = opts.bend ?? 0;
  const rows = bend !== 0 ? 3 : 1; // length segments
  for (const a of anchors) {
    const tile = rng.int(4);
    const u0 = (tile % 2) * 0.5;
    const v0 = Math.floor(tile / 2) * 0.5;
    const s = a.scale * opts.sizeK;
    const roll = (rng.float() - 0.5) * 0.7;
    _q.copy(a.quat);
    _q2.setFromAxisAngle(Z, roll);
    _q.multiply(_q2);
    right.set(1, 0, 0).applyQuaternion(_q);
    upL.set(0, 1, 0).applyQuaternion(_q);
    out.set(0, 0, 1).applyQuaternion(_q);
    const flex = 0.45 + rng.float() * 0.35;
    const phase = rng.float() * Math.PI * 2;
    const planes = opts.mode === 'cross' ? 2 : 1;
    const bendJ = bend * (0.75 + rng.float() * 0.5);
    for (let pl = 0; pl < planes; pl++) {
      // plane 0: width=right, normal=upL; plane 1: width=upL, normal=right
      const w = pl === 0 ? right : upL;
      const nrm = pl === 0 ? upL : right;
      const base = g.vertCount;
      // march the card spine, bending away from the plane normal
      rowPos.copy(a.pos).addScaledVector(out, -0.08 * s);
      for (let iv = 0; iv <= rows; iv++) {
        const t = iv / rows;
        const ang = bendJ * t;
        dirRow.copy(out).multiplyScalar(Math.cos(ang)).addScaledVector(nrm, -Math.sin(ang));
        nrmRow.copy(nrm).multiplyScalar(Math.cos(ang)).addScaledVector(out, Math.sin(ang));
        for (let iu = 0; iu <= 1; iu++) {
          p.copy(rowPos).addScaledVector(w, (iu - 0.5) * s);
          g.vertex(
            p.x, p.y, p.z,
            nrmRow.x, nrmRow.y, nrmRow.z,
            u0 + iu * 0.5, v0 + t * 0.5,
            a.hue, flex, phase, 1 - a.age * 0.25,
          );
        }
        if (iv < rows) rowPos.addScaledVector(dirRow, s / rows);
      }
      for (let iv = 0; iv < rows; iv++) {
        const r0 = base + iv * 2;
        g.quad(r0, r0 + 1, r0 + 3, r0 + 2);
      }
    }
  }
}
