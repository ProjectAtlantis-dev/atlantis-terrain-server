/**
 * library — boot-time geometry/material pools of the fable5-world-demo asset
 * set, ported to the Greenland WebGL app. One entry per asset kind; the
 * scatter stage instances each kind's parts per terrain tile.
 *
 * Rendering contract (differs from the demo): the scene has no general
 * lights (terrain is MeshBasicMaterial), so every material here is unlit
 * GLSL with a fixed-sun lambert + baked AO (vdata.w) standing in for the
 * demo's lit node materials. The world frame is EPSG:3413 stereo meters,
 * z-up — the SUN uniform lives in that frame; assets are built y-up and the
 * scatter stage bakes the X+90° into each instance matrix.
 */

import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  ShaderMaterial,
  Vector3,
  type WebGLRenderer,
} from 'three';
import { Rng, WorldSeed } from './Seed';
import type { SpeciesParams } from './VegTypes';
import { TREE_SPECIES } from './Species';
import { UNDERSTORY_SPECIES, buildShrub, buildFern, buildFlower, FERN_CAPTURE, type FlowerKind } from './Understory';
import { buildTree } from './TreeBuilder';
import { captureFoliageAtlas } from './FoliageCards';
import { buildLog, buildStump } from './Deadfall';
import { buildRock, type RockPreset } from './RockBuilder';
import { grassPatch } from './GroundCover';

// sun in world (stereo z-up) space; -y ≈ the app's "south" convention
const SUN = [0.33, -0.5, 0.8];
const SUN_LEN = Math.hypot(SUN[0]!, SUN[1]!, SUN[2]!);
const SUN_N = [SUN[0]! / SUN_LEN, SUN[1]! / SUN_LEN, SUN[2]! / SUN_LEN];

// The renderer runs a logarithmic depth buffer. Built-in materials get the
// log-depth chunks automatically, but a raw ShaderMaterial does NOT — and a
// standard-z fragment depth-tested against logarithmic terrain depth loses
// almost everywhere (assets render as ghost outlines). The chunk includes
// are no-ops when USE_LOGDEPTHBUF is off, so this stays portable.
const VERT_COMMON = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec4 vdata;
  varying vec4 vData;
  varying vec2 vUvV;
  varying vec3 vWorldN;
  void main() {
    vData = vdata;
    vUvV = uv;
    vec3 n = normal;
    vec4 p = vec4(position, 1.0);
    #ifdef USE_INSTANCING
      p = instanceMatrix * p;
      n = mat3(instanceMatrix) * n;
    #endif
    // shade in tile-local space (EPSG:3413 stereo, z-up) — terrainRoot may
    // carry an ECEF orientation, so modelMatrix must NOT touch the normal
    vWorldN = normalize(n);
    gl_Position = projectionMatrix * modelViewMatrix * p;
    #include <logdepthbuf_vertex>
  }
`;

const LAMBERT_FN = /* glsl */ `
  uniform vec3 sunDir;
  float lambert(vec3 n) {
    float d = max(dot(normalize(n), sunDir), 0.0);
    // two-sided foliage/cards: light the back face too, dimmer
    float back = max(dot(normalize(-n), sunDir), 0.0);
    return 0.42 + 0.62 * max(d, back * 0.55);
  }
`;

function unlitMaterial(fragBody: string, uniforms: Record<string, { value: unknown }>, opts?: { doubleSide?: boolean }): ShaderMaterial {
  // Every material main() must emit logarithmic fragment depth to match the
  // rest of the scene (see VERT_COMMON note); inject the chunk so each
  // fragBody stays plain GLSL.
  const bodyWithLogDepth = fragBody.replace(
    'void main() {',
    'void main() {\n      #include <logdepthbuf_fragment>',
  );
  const mat = new ShaderMaterial({
    uniforms: { sunDir: { value: SUN_N }, ...uniforms },
    vertexShader: VERT_COMMON,
    fragmentShader: /* glsl */ `
      precision highp float;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      varying vec4 vData;
      varying vec2 vUvV;
      varying vec3 vWorldN;
      ${LAMBERT_FN}
      ${bodyWithLogDepth}
    `,
  });
  if (opts?.doubleSide) mat.side = DoubleSide;
  return mat;
}

function barkMaterial(color: [number, number, number]): ShaderMaterial {
  return unlitMaterial(/* glsl */ `
    uniform vec3 baseColor;
    void main() {
      vec3 albedo = baseColor * (vData.x * 0.18 + 1.0) * vData.w;
      gl_FragColor = vec4(albedo * lambert(vWorldN) * 2.0, 1.0);
    }
  `, { baseColor: { value: color } });
}

/** card foliage: sqrt-encoded atlas, per-card hue tint + AO */
function cardMaterial(atlas: DataTexture): ShaderMaterial {
  return unlitMaterial(/* glsl */ `
    uniform sampler2D atlas;
    void main() {
      vec4 t = texture2D(atlas, vUvV);
      if (t.a < 0.32) discard;
      vec3 albedo = t.rgb * t.rgb; // decode
      float k = vData.x * 0.14;
      albedo *= mix(vec3(1.0), vec3(1.2, 1.06, 0.6), clamp(k, 0.0, 1.0))
              * mix(vec3(1.0), vec3(0.78, 0.96, 1.15), clamp(-k, 0.0, 1.0));
      gl_FragColor = vec4(albedo * vData.w * lambert(vWorldN) * 2.4, 1.0);
    }
  `, { atlas: { value: atlas } }, { doubleSide: true });
}

/** real mesh leaves (shrub/hero foliage): capture-material albedo math, lit */
function leafMeshMaterial(sp: SpeciesParams): ShaderMaterial {
  const c = sp.foliageColor;
  const bl = sp.blossom;
  return unlitMaterial(/* glsl */ `
    uniform vec3 baseColor;
    uniform float hueVar;
    uniform vec3 blossomColor;
    uniform float blossomThresh;
    void main() {
      float k = vData.x * hueVar;
      vec3 albedo = baseColor
        * mix(vec3(1.0), vec3(1.25, 1.05, 0.5), clamp(k, 0.0, 1.0))
        * mix(vec3(1.0), vec3(0.72, 0.95, 1.2), clamp(-k, 0.0, 1.0));
      albedo *= (smoothstep(0.0, 0.05, abs(vUvV.x - 0.5)) * 0.18 + 0.82)
              * mix(0.92, 1.18, vUvV.y);
      if (vData.x > blossomThresh) {
        albedo = blossomColor * mix(0.75, 1.15, vUvV.y);
      }
      gl_FragColor = vec4(albedo * vData.w * lambert(vWorldN) * 2.4, 1.0);
    }
  `, {
    baseColor: { value: [c.r, c.g, c.b] },
    hueVar: { value: c.hueVar },
    blossomColor: { value: bl ? [bl.r, bl.g, bl.b] : [0, 0, 0] },
    blossomThresh: { value: bl ? 1 - bl.frac * 2 : 2 },
  }, { doubleSide: true });
}

/** rock: grey base, strata banding (vdata.y), lichen tint on open faces
 * (vdata.z), cavity AO (vdata.w) */
function rockMaterial(): ShaderMaterial {
  return unlitMaterial(/* glsl */ `
    void main() {
      vec3 base = vec3(0.44, 0.425, 0.40);
      // strata banding: alternate slightly warm/dark bands
      float band = sin(vData.y * 6.2831853);
      base *= 1.0 + band * 0.07;
      base = mix(base, vec3(0.38, 0.30, 0.24), smoothstep(0.6, 1.0, vData.y) * 0.25);
      // lichen/moss tint on upward-open faces
      base = mix(base, vec3(0.35, 0.38, 0.22), smoothstep(0.55, 1.0, vData.z) * 0.30);
      gl_FragColor = vec4(base * vData.w * lambert(vWorldN) * 1.9, 1.0);
    }
  `, {});
}

/** deadfall: brown wood, vdata.z mossiness → green shift */
function deadfallMaterial(): ShaderMaterial {
  return unlitMaterial(/* glsl */ `
    void main() {
      vec3 wood = vec3(0.16, 0.115, 0.075) * (vData.x * 0.2 + 1.0);
      vec3 albedo = mix(wood, vec3(0.10, 0.16, 0.05), clamp(vData.z, 0.0, 1.0) * 0.75);
      gl_FragColor = vec4(albedo * vData.w * lambert(vWorldN) * 2.0, 1.0);
    }
  `, {});
}

/** flowers: vdata.x flags 0 stem/leaf, 1 petal, 0.5 center */
function flowerMaterial(petal: [number, number, number]): ShaderMaterial {
  return unlitMaterial(/* glsl */ `
    uniform vec3 petalColor;
    void main() {
      vec3 albedo = vec3(0.05, 0.11, 0.03);
      if (vData.x > 0.75) albedo = petalColor;
      else if (vData.x > 0.25) albedo = vec3(0.75, 0.62, 0.14);
      gl_FragColor = vec4(albedo * vData.w * lambert(vWorldN) * 2.2, 1.0);
    }
  `, { petalColor: { value: petal } }, { doubleSide: true });
}

// ---------------------------------------------------------------------------

export interface AssetPart {
  geo: BufferGeometry;
  mat: ShaderMaterial;
}

export interface AssetKind {
  id: string;
  parts: AssetPart[];
  /** max draw distance (m), per demo Forests ring/maxDist tuning */
  maxDist: number;
  /** instance uniform-scale jitter range */
  scale: [number, number];
  height: number;
  radius: number;
  /** vegetation obeys the aspect gate in the scatter stage */
  living: boolean;
}

export interface AssetLibrary {
  kinds: Map<string, AssetKind>;
  stats: { kinds: number; tris: number; buildMs: number };
}

function bounds(geos: BufferGeometry[]): { height: number; radius: number } {
  let height = 0.5;
  let radius = 0.5;
  for (const g of geos) {
    g.computeBoundingBox();
    g.computeBoundingSphere();
    if (g.boundingBox) height = Math.max(height, g.boundingBox.max.y);
    if (g.boundingSphere) {
      radius = Math.max(radius, g.boundingSphere.center.length() + g.boundingSphere.radius);
    }
  }
  return { height, radius };
}

function triCount(geos: BufferGeometry[]): number {
  let t = 0;
  for (const g of geos) t += (g.getIndex()?.count ?? g.getAttribute('position').count) / 3;
  return t;
}

/** bake an InstancedMesh (blade geometry + idata) into one merged geometry */
function bakeInstanced(mesh: InstancedMesh): BufferGeometry {
  const src = mesh.geometry;
  const pos = src.getAttribute('position');
  const nrm = src.getAttribute('normal');
  const uvA = src.getAttribute('uv');
  const idata = src.getAttribute('idata') as InstancedBufferAttribute;
  const idx = src.getIndex();
  const n = mesh.count;
  const vPer = pos.count;
  const outPos = new Float32Array(n * vPer * 3);
  const outNrm = new Float32Array(n * vPer * 3);
  const outUv = new Float32Array(n * vPer * 2);
  const outDat = new Float32Array(n * vPer * 4);
  const outIdx: number[] = [];
  const m = new Matrix4();
  const p = new Vector3();
  const v = new Vector3();
  for (let i = 0; i < n; i++) {
    mesh.getMatrixAt(i, m);
    for (let j = 0; j < vPer; j++) {
      const o = i * vPer + j;
      p.set(pos.getX(j), pos.getY(j), pos.getZ(j)).applyMatrix4(m);
      v.set(nrm.getX(j), nrm.getY(j), nrm.getZ(j)).transformDirection(m);
      outPos[o * 3] = p.x; outPos[o * 3 + 1] = p.y; outPos[o * 3 + 2] = p.z;
      outNrm[o * 3] = v.x; outNrm[o * 3 + 1] = v.y; outNrm[o * 3 + 2] = v.z;
      outUv[o * 2] = uvA.getX(j); outUv[o * 2 + 1] = uvA.getY(j);
      outDat[o * 4] = idata.getX(i); outDat[o * 4 + 1] = idata.getY(i);
      outDat[o * 4 + 2] = idata.getZ(i); outDat[o * 4 + 3] = idata.getW(i);
    }
    if (idx) {
      for (let k = 0; k < idx.count; k++) outIdx.push(i * vPer + idx.getX(k));
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(outPos, 3));
  g.setAttribute('normal', new BufferAttribute(outNrm, 3));
  g.setAttribute('uv', new BufferAttribute(outUv, 2));
  g.setAttribute('idata', new BufferAttribute(outDat, 4));
  g.setIndex(outIdx);
  return g;
}

/**
 * Build every pool. Synchronous, boot-time; ~1–2 s of geometry growing.
 * Deterministic per seed.
 */
export function buildAssetLibrary(renderer: WebGLRenderer, seedN = 1337): AssetLibrary {
  const t0 = performance.now();
  const seed = new WorldSeed(seedN);
  const kinds = new Map<string, AssetKind>();
  let tris = 0;

  const add = (
    id: string,
    parts: AssetPart[],
    maxDist: number,
    scale: [number, number],
    living: boolean,
  ): void => {
    const geos = parts.map(p => p.geo);
    const b = bounds(geos);
    tris += triCount(geos);
    kinds.set(id, { id, parts, maxDist, scale, height: b.height, radius: b.radius, living });
  };

  // ---- atlases (one capture per foliaged species; ~ms each) ---------------
  const atlases = new Map<string, DataTexture>();
  const atlasFor = (sp: SpeciesParams): DataTexture => {
    let tex = atlases.get(sp.id);
    if (!tex) {
      tex = captureFoliageAtlas(renderer, sp, seed.rng(`atlas/${sp.id}`));
      atlases.set(sp.id, tex);
    }
    return tex;
  };

  // ---- trees: 6 species × 2 variants at ring-1 detail ---------------------
  const BARK_COLORS: Record<string, [number, number, number]> = {
    spruce: [0.16, 0.125, 0.10],
    pine: [0.25, 0.16, 0.09],
    beech: [0.36, 0.34, 0.31],
    birch: [0.56, 0.54, 0.50],
    karst: [0.30, 0.28, 0.25],
    snag: [0.42, 0.40, 0.36],
  };
  for (const sp of TREE_SPECIES) {
    for (let v = 0; v < 2; v++) {
      const rng = seed.rng(`tree/${sp.id}/${v}`);
      const inst = {
        leanX: (rng.float() - 0.5) * 0.14,
        leanZ: (rng.float() - 0.5) * 0.14,
        biasX: (rng.float() - 0.5) * 1.6,
        biasZ: (rng.float() - 0.5) * 1.6,
        age: 0.55 + rng.float() * 0.45,
      };
      // lod 2 (distant-ring detail): scattered trees are 100s per tile — the
      // demo's lod-1 pool (2600 cards) is for a GPU-culled near ring we don't
      // have; lod 2 is ~1.5k tris and reads fine beyond ~30 m
      const t = buildTree(sp, rng.fork('grow'), { lod: 2, inst });
      const parts: AssetPart[] = [
        { geo: t.bark, mat: barkMaterial(BARK_COLORS[sp.id] ?? [0.3, 0.27, 0.24]) },
      ];
      if (t.foliage) parts.push({ geo: t.foliage, mat: cardMaterial(atlasFor(sp)) });
      add(`tree/${sp.id}/${v}`, parts, 700, [0.8, 1.3], true);
    }
  }

  // ---- shrubs: 3 species × 2 variants (multi-stem, card foliage) ----------
  for (const sp of UNDERSTORY_SPECIES) {
    for (let v = 0; v < 2; v++) {
      const s = buildShrub(sp, seed.rng(`shrub/${sp.id}/${v}`), { lod: 2 });
      const parts: AssetPart[] = [
        { geo: s.bark, mat: barkMaterial(BARK_COLORS[sp.kind === 'conifer' ? 'spruce' : 'beech'] ?? [0.3, 0.27, 0.24]) },
      ];
      if (s.foliage) parts.push({ geo: s.foliage, mat: cardMaterial(atlasFor(sp)) });
      add(`shrub/${sp.id}/${v}`, parts, 170, [0.7, 1.25], true);
    }
  }

  // ---- ferns + flowers -----------------------------------------------------
  const fernAtlas = atlasFor(FERN_CAPTURE);
  for (let v = 0; v < 2; v++) {
    const geo = buildFern(seed.rng(`fern/${v}`));
    add(`fern/${v}`, [{ geo, mat: cardMaterial(fernAtlas) }], 140, [0.8, 1.4], true);
  }
  const FLOWER_COLOR: Record<FlowerKind, [number, number, number]> = {
    umbel: [0.75, 0.75, 0.7],
    bell: [0.28, 0.14, 0.5],
    daisy: [0.85, 0.72, 0.12],
  };
  for (const kind of ['umbel', 'bell', 'daisy'] as FlowerKind[]) {
    for (let v = 0; v < 2; v++) {
      const geo = buildFlower(kind, seed.rng(`flower/${kind}/${v}`));
      add(`flower/${kind}/${v}`, [{ geo, mat: flowerMaterial(FLOWER_COLOR[kind]) }], 90, [0.8, 1.3], true);
    }
  }

  // ---- deadfall -------------------------------------------------------------
  for (const decay of ['fresh', 'mossy', 'rotten'] as const) {
    const log = buildLog(seed.rng(`log/${decay}`), decay);
    add(`log/${decay}`, [{ geo: log.geometry, mat: deadfallMaterial() }], 220, [0.8, 1.3], false);
  }
  for (let v = 0; v < 2; v++) {
    const st = buildStump(seed.rng(`stump/${v}`));
    add(`stump/${v}`, [{ geo: st.geometry, mat: deadfallMaterial() }], 170, [0.8, 1.3], false);
  }

  // ---- rocks: preset × detail per demo VegLibrary/Forests tuning -----------
  // details follow the demo's SCATTER tuning (Forests stones d1=3/d2=2), not
  // its gallery-hero detail — a scattered boulder at subdiv 5 is 20k tris
  const rocks: { preset: RockPreset; detail: number; maxDist: number; scale: [number, number]; n: number }[] = [
    { preset: 'hero', detail: 5, maxDist: 1400, scale: [0.6, 1.4], n: 2 },
    { preset: 'boulder', detail: 3, maxDist: 900, scale: [0.6, 1.5], n: 3 },
    { preset: 'angular', detail: 3, maxDist: 500, scale: [0.7, 1.4], n: 2 },
    { preset: 'slab', detail: 3, maxDist: 600, scale: [0.7, 1.4], n: 2 },
    { preset: 'talus', detail: 3, maxDist: 400, scale: [0.6, 1.3], n: 2 },
    { preset: 'cobble', detail: 2, maxDist: 280, scale: [1.0, 3.0], n: 2 },
  ];
  for (const r of rocks) {
    for (let v = 0; v < r.n; v++) {
      const built = buildRock(r.preset, seed.rng(`rock/${r.preset}/${v}`), r.detail);
      add(`rock/${r.preset}/${v}`, [{ geo: built.geometry, mat: rockMaterial() }], r.maxDist, r.scale, false);
    }
  }

  // ---- grass: pre-baked clumped patches, instanced per tile ----------------
  // 420 wide blades over 3 m ≈ 2/3 ground coverage inside a patch — with the
  // tundra scatter density (~1 patch / 8 m²) the carpet hides most bare
  // terrain where the vegetation mask passes.
  for (let v = 0; v < 3; v++) {
    const rng = seed.rng(`grass/${v}`);
    const patch = grassPatch(rng, 420, 3, { dryBase: 0.15 });
    const geo = bakeInstanced(patch);
    patch.geometry.dispose(); // blade geometry was baked into the merged patch
    add(`grass/${v}`, [{ geo, mat: patch.material as ShaderMaterial }], 120, [0.8, 1.4], true);
  }

  return { kinds, stats: { kinds: kinds.size, tris, buildMs: performance.now() - t0 } };
}
