/**
 * Ground cover: grass blades with instanced, clumped placement.
 *
 * Grass instancing: per-instance vec4 `idata` (hue, dryness, swayPhase,
 * height) on an InstancedBufferAttribute; the blade geometry itself carries
 * uv.y for the base→tip ramp.
 */

import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { Rng } from './Seed';

/**
 * WebGL port note: the demo's TSL node materials (lit, caustics, translucency)
 * are rewritten as unlit GLSL — the Greenland scene renders terrain with
 * MeshBasicMaterial and has no general scene lights, so shading is baked into
 * the colors instead.
 */
const INSTANCE_CHUNK = /* glsl */ `
  vec4 mvPos = vec4(position, 1.0);
  #ifdef USE_INSTANCING
    mvPos = instanceMatrix * mvPos;
  #endif
  mvPos = modelViewMatrix * mvPos;
  gl_Position = projectionMatrix * mvPos;
  #include <logdepthbuf_vertex>
`;

// The renderer runs a logarithmic depth buffer; raw ShaderMaterials must
// emit log fragment depth or they lose the depth test against the terrain
// (assets degrade to ghost outlines). No-ops when log depth is off.
const LOGDEPTH_VERT_PARS = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
`;
const LOGDEPTH_FRAG_PARS = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
`;

/** single grass blade: tapered 4-segment strip with a built-in bend */
export function grassBladeGeometry(SEG = 4): BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uvA: number[] = [];
  const idx: number[] = [];
  // Tundra sedge reads as wide flat tufts, not lawn filaments — and wide
  // blades are the cheap way to CARPET: ground-hiding coverage scales with
  // blade area, not blade count.
  const W = 0.030;
  const H = 1; // unit height; instance scales
  // rounded cross-section normals (Ghost of Tsushima): edge verts tilt
  // ±38° around the blade axis so the strip shades like a half-cylinder
  // instead of a flat card — interpolation does the curving per-pixel
  const SN = 0.616;
  const CS = 0.788;
  let bendZ = 0;
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    const w = W * (1 - t * 0.85);
    bendZ = t * t * 0.28;
    const y = t * H * (1 - t * t * 0.06);
    if (i < SEG) {
      pos.push(-w, y, bendZ, w, y, bendZ);
      nrm.push(-SN, 0.25, -CS, SN, 0.25, -CS);
      uvA.push(0, t, 1, t);
    } else {
      pos.push(0, y, bendZ);
      nrm.push(0, 0.25, -1);
      uvA.push(0.5, 1);
    }
  }
  for (let i = 0; i < SEG; i++) {
    const a = i * 2;
    if (i < SEG - 1) idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    else idx.push(a, a + 1, a + 2);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvA), 2));
  g.setIndex(idx);
  return g;
}

export function grassMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: /* glsl */ `
      ${LOGDEPTH_VERT_PARS}
      attribute vec4 idata;
      varying float vT;
      varying vec4 vId;
      varying vec3 vTint;
      void main() {
        vT = uv.y;
        vId = idata;
        // Per-instance ground tint (scatter samples the tile's satellite
        // texture at the placement point) — grass reads as blobs of the
        // imagery's own color instead of one synthetic green everywhere.
        #ifdef USE_INSTANCING_COLOR
          vTint = instanceColor;
        #else
          vTint = vec3(-1.0);
        #endif
        ${INSTANCE_CHUNK}
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      ${LOGDEPTH_FRAG_PARS}
      varying float vT;
      varying vec4 vId;
      varying vec3 vTint;
      void main() {
        #include <logdepthbuf_fragment>
        vec3 fresh = mix(vec3(0.026, 0.06, 0.012), vec3(0.1, 0.16, 0.035), vT * vT);
        vec3 dry = mix(vec3(0.07, 0.055, 0.02), vec3(0.21, 0.16, 0.07), vT);
        vec3 albedo = mix(fresh, dry, vId.y) * (vId.x * 0.16 + 1.0);
        // baked light: base AO ramp + a fixed sky term standing in for the
        // demo's lit material (unlit scene)
        float ao = smoothstep(0.0, 0.55, vT) * 0.55 + 0.45;
        vec3 base = albedo * ao * 2.4;
        if (vTint.x >= 0.0) {
          // Pull strongly toward the sampled ground color, keeping the
          // base->tip ramp so blades still read as blades up close.
          base = mix(base, vTint * (0.55 + 0.55 * vT), 0.62);
        }
        gl_FragColor = vec4(base, 1.0);
      }
    `,
    side: DoubleSide,
  });
}

/**
 * Clumped grass patch: parent clump points + child blades (light-competition
 * clumping per spec §3.5). Returns an InstancedMesh ready to place.
 */
export function grassPatch(
  rng: Rng,
  count: number,
  size: number,
  opts?: { dryBase?: number },
): InstancedMesh {
  const geo = grassBladeGeometry();
  const mesh = new InstancedMesh(geo, grassMaterial(), count);
  const idata = new Float32Array(count * 4);
  const m = new Matrix4();
  const q = new Quaternion();
  const p = new Vector3();
  const s = new Vector3();
  const clumps: { x: number; z: number; h: number; dry: number }[] = [];
  const nClumps = Math.max(3, Math.round((size * size) / 1.1));
  for (let i = 0; i < nClumps; i++) {
    clumps.push({
      x: (rng.float() - 0.5) * size,
      z: (rng.float() - 0.5) * size,
      h: 0.55 + rng.float() * 0.75,
      dry: rng.float(),
    });
  }
  const axis = new Vector3(0, 1, 0);
  for (let i = 0; i < count; i++) {
    const c = clumps[rng.int(nClumps)] as { x: number; z: number; h: number; dry: number };
    const rr = Math.sqrt(rng.float()) * 0.62;
    const aa = rng.float() * Math.PI * 2;
    const x = c.x + Math.cos(aa) * rr;
    const z = c.z + Math.sin(aa) * rr;
    if (Math.abs(x) > size / 2 || Math.abs(z) > size / 2) {
      // recycle out-of-bounds onto a uniform filler
      p.set((rng.float() - 0.5) * size, 0, (rng.float() - 0.5) * size);
    } else {
      p.set(x, 0, z);
    }
    q.setFromAxisAngle(axis, rng.float() * Math.PI * 2);
    const h = c.h * (0.55 + rng.float() * 0.7) * 0.42;
    s.set(1 + rng.float() * 0.5, h, 1);
    m.compose(p, q, s);
    mesh.setMatrixAt(i, m);
    idata[i * 4] = rng.float() * 2 - 1;
    idata[i * 4 + 1] = Math.min(1, c.dry * 0.55 + rng.float() * 0.3 + (opts?.dryBase ?? 0));
    idata[i * 4 + 2] = rng.float() * Math.PI * 2;
    idata[i * 4 + 3] = h;
  }
  geo.setAttribute('idata', new InstancedBufferAttribute(idata, 4));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
