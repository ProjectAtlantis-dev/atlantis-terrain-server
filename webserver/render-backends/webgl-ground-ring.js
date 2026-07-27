import * as THREE from 'three';
import { terrainTileDepth } from '../terrain-tile-address.js';

// webgl-ground-ring — camera-following near-field grass carpet, the WebGL
// translation of the fable5-world-demo / procedural-greenland GroundRing
// (which is WebGPU compute + indirect draws). Same clipmap idea, classic-GL
// execution, and the demo's key insight kept: THICKNESS COMES FROM PER-
// INSTANCE BLADE CLUMPING, NOT JUST DENSITY (the demo bakes 5, then 3,
// blades into every near/mid instance — overlapping blade silhouettes are
// what reads as "thick" at walking distance; single thin blades never do,
// no matter how dense). WebGL can't compute-cull 9M slots, so the demo's
// banding becomes two fixed instanced rings:
//
//   NEAR  — dense 5-blade clumps right around the camera (~51 slots/m²).
//   MID   — 3-blade tussock clumps carrying the carpet out to ~55 m.
//
// Shared mechanics per ring:
//  - ONE InstancedMesh of slots, never re-uploaded. Each slot maps to the
//    unique world cell congruent to it (mod GRID) nearest the camera —
//    computed per-vertex from a camera-cell uniform. Every per-instance
//    parameter re-derives from hash(cell), so a slot's content changes only
//    when its world cell does.
//  - Culling by degenerate collapse instead of compute compaction: failed
//    gates (vegetation/water/snow/elevation/fade) emit an off-screen
//    degenerate position.
//  - Ground height and surface masks come from a small window texture pair
//    composed on the CPU from the already-decoded tile heightmaps and the
//    shared surface-field store, refreshed only when the camera leaves the
//    window core or the underlying tiles change.
//
// Cells are ABSOLUTE EPSG:3413 grid indices (scene position + floating
// origin offset), so the carpet is world-anchored, seam-free across tiles,
// and identical on every client. Hash inputs wrap mod 2^16 cells to stay
// exact in fp32.

const RINGS = [
  {
    name: 'near',
    grid: 256,
    cellM: 0.14,       // ±17.9 m, ~51 slots/m² — the demo-style dense band
    fadeStartM: 10,
    fadeEndM: 16,
    // scale multiplies BOTH the clump footprint and blade height (the
    // clump geometry itself is unit-sized). The original 0.15-0.38 range
    // made individual clumps read as hair-thin, near-invisible flecks even
    // at ~51 slots/m² with 5-blade overlap — bulked up so a clump reads as
    // an actual tuft of grass, not a pixel of green noise.
    scaleMin: 0.30,
    scaleMax: 0.62,
    planarMul: 1.0,
    // Demo's GroundRing (fable5-world-demo) puts 5 blades in ONE instance —
    // per-pixel blade overlap is what reads as "thick" at walking distance;
    // a single thin blade per slot can't do it no matter the density. Base
    // blade width doubled (0.025 -> 0.05) for the same reason: at the old
    // width even a 5-blade clump was mostly gaps.
    geometry: () => buildBladeClumpGeometry(5, 3, 0.05),
  },
  {
    name: 'mid',
    // Grid doubled from 352 (±79 m) to 490 (±110 m) alongside fadeEndM so
    // the carpet's actual radius doubles, not just where within the old
    // radius the fade happened to sit.
    grid: 490,
    cellM: 0.45,       // ±110 m tuft band
    fadeStartM: 68,
    fadeEndM: 110,
    scaleMin: 0.34,
    scaleMax: 0.70,
    planarMul: 1.6,
    // Demo's mid band is a 3-blade clump too (vs. the far crossed-tuft
    // cards); a clump reads as a grass tussock instead of three flat cards.
    geometry: () => buildBladeClumpGeometry(3, 2, 0.05),
  },
];

const WINDOW_RES = 256;
const MIN_ELEVATION_M = 1.0;
const SIGNATURE_CHECK_MS = 1000;

const WINDOW_SPAN_M = Math.max(...RINGS.map(ring => ring.grid * ring.cellM));
const RECOMPOSE_HYSTERESIS_M = Math.max(
  8, WINDOW_SPAN_M / 2 - Math.max(...RINGS.map(ring => ring.fadeEndM)) - 8,
);

// Single tapered blade in this file's local blade-space: x = width (across
// the blade), y = lean (in-plane forward curve), z = height fraction 0..1.
// The ring vertex shader below rotates/translates (x,y) as a unit per
// INSTANCE and uses z as the up axis — so per-blade variation within a
// clump has to be baked into these vertex positions, not left to the
// per-instance transform.
function buildBladeGeometry(segments = 3, width = 0.025) {
  const positions = [];
  const uvs = [];
  const indices = [];
  let vertex = 0;
  for (let segment = 0; segment <= segments; segment++) {
    const t = segment / segments;
    const halfWidth = (width / 2) * (1 - t * 0.8);
    const lean = t * t * 0.35;
    if (segment < segments) {
      positions.push(-halfWidth, lean, t, halfWidth, lean, t);
      uvs.push(0, t, 1, t);
      if (segment > 0) {
        const a = vertex - 2;
        indices.push(a, a + 1, vertex, a + 1, vertex + 1, vertex);
      }
      vertex += 2;
    } else {
      positions.push(0, lean, 1);
      uvs.push(0.5, 1);
      const a = vertex - 2;
      indices.push(a, a + 1, vertex);
    }
  }
  return { positions, uvs, indices };
}

// N-blade clump baked into ONE instance — ported from fable5-world-demo's
// GroundRing.bladeClump: per-pixel blade overlap is what reads as "thick"
// at walking distance, and no amount of instance density alone gets there
// with single thin blades. Each blade gets its own yaw (rotated in the x/y
// blade-space plane, matching how the per-instance transform later rotates
// that same plane), a small planar offset so roots spread across the
// clump footprint, a random height scale, and a slight directional lean.
// Deterministic (fixed LCG seed) — geometry is built once and reused by
// every instance; per-slot variety comes from the instance hash instead.
function buildBladeClumpGeometry(bladeCount, segments, width = 0.025) {
  let seed = 0x9e3779b1 ^ (bladeCount * 0x2545f491) ^ (segments * 0x27d4eb2f);
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const positions = [];
  const uvs = [];
  const indices = [];
  let vertexBase = 0;
  for (let blade = 0; blade < bladeCount; blade++) {
    const base = buildBladeGeometry(segments, width);
    const yaw = rnd() * Math.PI * 2;
    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);
    const offsetX = (rnd() - 0.5) * 0.05;
    const offsetY = (rnd() - 0.5) * 0.05;
    const heightScale = 0.6 + rnd() * 0.55;
    const lean = (rnd() - 0.5) * 0.4;
    const vertexCount = base.positions.length / 3;
    for (let index = 0; index < vertexCount; index++) {
      const x = base.positions[index * 3];
      const y = base.positions[index * 3 + 1];
      const z = base.positions[index * 3 + 2] * heightScale;
      const rotatedX = x * cosYaw - y * sinYaw;
      const rotatedY = x * sinYaw + y * cosYaw;
      positions.push(rotatedX + offsetX + lean * z, rotatedY + offsetY, z);
      uvs.push(base.uvs[index * 2], base.uvs[index * 2 + 1]);
    }
    for (const index of base.indices) indices.push(index + vertexBase);
    vertexBase += vertexCount;
  }
  return { positions, uvs, indices };
}

function instancedGeometry(build, slotCount) {
  const { positions, uvs, indices } = build();
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute(
    'position', new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  const slots = new Float32Array(slotCount);
  for (let index = 0; index < slots.length; index++) slots[index] = index;
  geometry.setAttribute(
    'slot', new THREE.InstancedBufferAttribute(slots, 1),
  );
  geometry.instanceCount = slotCount;
  return geometry;
}

function ringVertexShader(ring) {
  return /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float slot;
  uniform vec2 uCamCell;      // integer world-cell of the camera (this ring)
  uniform vec2 uCamFrac;      // camera position within that cell (m)
  uniform vec2 uCamScene;     // camera xy in scene (tile) frame
  uniform vec2 uWindowMin;    // window origin, scene frame
  uniform sampler2D uHeight;  // R32F, NEAREST — manual bilinear
  uniform sampler2D uMask;    // r=veg g=water b=snow, LINEAR
  uniform float uTime;
  varying float vT;
  varying vec3 vTint;

  vec2 hash22(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    q += dot(q, q.yzx + 33.33);
    return fract((q.xx + q.yz) * q.zy);
  }

  float heightAt(vec2 uv) {
    vec2 st = uv * ${WINDOW_RES}.0 - 0.5;
    vec2 base = floor(st);
    vec2 f = st - base;
    vec2 texel = (base + 0.5) / ${WINDOW_RES}.0;
    float step = 1.0 / ${WINDOW_RES}.0;
    float h00 = texture2D(uHeight, texel).r;
    float h10 = texture2D(uHeight, texel + vec2(step, 0.0)).r;
    float h01 = texture2D(uHeight, texel + vec2(0.0, step)).r;
    float h11 = texture2D(uHeight, texel + vec2(step, step)).r;
    return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
  }

  // Central-difference slope (rise/run) from the same height window —
  // nothing (grass or otherwise) should stand on steep ground right now.
  float slopeAt(vec2 uv) {
    float step = 1.0 / ${WINDOW_RES}.0;
    float worldStep = step * ${WINDOW_SPAN_M.toFixed(3)};
    float dx = (heightAt(uv + vec2(step, 0.0)) - heightAt(uv - vec2(step, 0.0)))
      / (2.0 * worldStep);
    float dy = (heightAt(uv + vec2(0.0, step)) - heightAt(uv - vec2(0.0, step)))
      / (2.0 * worldStep);
    return length(vec2(dx, dy));
  }

  void main() {
    float sx = mod(slot, ${ring.grid}.0);
    float sy = floor(slot / ${ring.grid}.0);
    vec2 cell = vec2(sx, sy)
      + ${ring.grid}.0 * floor((uCamCell - vec2(sx, sy)) / ${ring.grid}.0 + 0.5);

    vec2 hashCell = mod(cell, 65536.0);
    vec2 jitter = hash22(hashCell);
    vec2 params = hash22(hashCell + 17.0);
    vec2 gates = hash22(hashCell + 41.0);

    vec2 rel = (cell - uCamCell) * ${ring.cellM.toFixed(3)}
      + jitter * ${ring.cellM.toFixed(3)} - uCamFrac;
    vec2 sceneXY = uCamScene + rel;
    vec2 windowUv = (sceneXY - uWindowMin) / ${WINDOW_SPAN_M.toFixed(3)};

    vec3 mask = texture2D(uMask, windowUv).rgb;
    float ground = heightAt(windowUv);
    float dist = length(rel);
    float fade = smoothstep(
      ${ring.fadeStartM.toFixed(1)}, ${ring.fadeEndM.toFixed(1)}, dist);
    float slope = slopeAt(windowUv);

    // This terrain is deterministic — every gate below is a CONTINUOUS
    // probability multiplied into density and resolved by the same
    // per-cell hash (gates.x) that already decides vegetation coverage,
    // not a hard boolean cutoff. A boolean (slope > X, mask.g > Y) draws a
    // visible contour line where the world snaps from full cover to bald;
    // a smoothstep taper into the same stochastic gate reproduces
    // identically every time (still a pure function of cell + seed) but
    // reads as a natural thinning edge instead of a fence.
    float slopeFalloff = 1.0 - smoothstep(0.45, 0.62, slope);   // ~24-32 deg taper
    float waterFalloff = 1.0 - smoothstep(0.35, 0.55, mask.g);
    float snowFalloff = 1.0 - smoothstep(0.45, 0.65, mask.b);

    // Strict color-gated density: grass exists ONLY where the classifier
    // reads vegetation (green/yellow-green imagery — see the server-side
    // GREEN proposal in the classifier ladder) — never forced onto grey/white
    // ground by a density floor. Full coverage once meaningfully
    // classified green; nothing where it isn't, tapered by the falloffs.
    float density = clamp(mask.r * 3.0, 0.0, 1.0)
      * slopeFalloff * waterFalloff * snowFalloff;

    bool dead =
      any(lessThan(windowUv, vec2(0.0)))
      || any(greaterThan(windowUv, vec2(1.0)))
      || ground <= ${MIN_ELEVATION_M.toFixed(1)}  // physical fact, not aesthetic — sea level
      || gates.x > density                // vegetation density gate (+ all falloffs)
      || gates.y < fade;                  // dithered distance collapse

    if (dead) {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      vT = 0.0;
      vTint = vec3(0.0);
      return;
    }

    float scale = mix(${ring.scaleMin.toFixed(3)}, ${ring.scaleMax.toFixed(3)}, params.x)
      * mix(1.0, 0.7, fade);
    float yaw = params.y * 6.2831853;
    float cosYaw = cos(yaw);
    float sinYaw = sin(yaw);
    vec2 planar = vec2(
      position.x * cosYaw - position.y * sinYaw,
      position.x * sinYaw + position.y * cosYaw
    ) * scale * ${ring.planarMul.toFixed(2)};
    float heightT = position.z;
    float sway = sin(uTime * 1.7 + (hashCell.x + hashCell.y) * 0.37)
      * 0.035 * heightT * heightT;
    vec3 scenePos = vec3(
      sceneXY + planar + vec2(sway),
      ground + heightT * scale
    );

    vT = heightT;
    float dry = gates.y;
    vec3 fresh = mix(vec3(0.026, 0.06, 0.012), vec3(0.1, 0.16, 0.035), heightT * heightT);
    vec3 dryC = mix(vec3(0.07, 0.055, 0.02), vec3(0.21, 0.16, 0.07), heightT);
    vTint = mix(fresh, dryC, dry * 0.55) * (params.x * 0.16 + 1.0);

    gl_Position = projectionMatrix * modelViewMatrix * vec4(scenePos, 1.0);
    #include <logdepthbuf_vertex>
  }
`;
}

const FRAGMENT = /* glsl */ `
  precision highp float;
  #include <common>
  #include <logdepthbuf_pars_fragment>
  varying float vT;
  varying vec3 vTint;
  void main() {
    #include <logdepthbuf_fragment>
    // baked light: AO ramp + fixed sky term (unlit scene) — matches the
    // tile-scatter grass material so the carpet and patches agree.
    float ao = smoothstep(0.0, 0.55, vT) * 0.55 + 0.45;
    gl_FragColor = vec4(vTint * ao * 2.4, 1.0);
  }
`;

export function createWebGLGroundRing({
  terrainRoot,
  surfaceFields,
  log = () => {},
}) {
  const heightData = new Float32Array(WINDOW_RES * WINDOW_RES);
  const maskData = new Uint8Array(WINDOW_RES * WINDOW_RES * 4);
  const heightTexture = new THREE.DataTexture(
    heightData, WINDOW_RES, WINDOW_RES, THREE.RedFormat, THREE.FloatType,
  );
  heightTexture.minFilter = THREE.NearestFilter;
  heightTexture.magFilter = THREE.NearestFilter;
  const maskTexture = new THREE.DataTexture(
    maskData, WINDOW_RES, WINDOW_RES, THREE.RGBAFormat,
  );
  maskTexture.minFilter = THREE.LinearFilter;
  maskTexture.magFilter = THREE.LinearFilter;

  const sharedUniforms = {
    uCamScene: { value: new THREE.Vector2() },
    uWindowMin: { value: new THREE.Vector2() },
    uHeight: { value: heightTexture },
    uMask: { value: maskTexture },
    uTime: { value: 0 },
  };

  const meshes = [];
  const ringStates = RINGS.map(ring => {
    const uniforms = {
      ...sharedUniforms,
      uCamCell: { value: new THREE.Vector2() },
      uCamFrac: { value: new THREE.Vector2() },
    };
    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: ringVertexShader(ring),
      fragmentShader: FRAGMENT,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(
      instancedGeometry(ring.geometry, ring.grid * ring.grid), material,
    );
    mesh.frustumCulled = false;
    mesh.raycast = () => {};
    mesh.name = `ground-ring/${ring.name}`;
    mesh.visible = false;
    terrainRoot.add(mesh);
    meshes.push(mesh);
    return { ring, mesh, material, uniforms };
  });

  const windowCenter = new THREE.Vector2(Number.NaN, Number.NaN);
  let lastSignature = '';
  let lastSignatureCheck = 0;
  const decodedHeightmaps = new WeakMap();

  function tileHeightmap(tileMesh) {
    let decoded = decodedHeightmaps.get(tileMesh);
    if (!decoded && tileMesh.userData.heightmapPayload) {
      const raw = atob(tileMesh.userData.heightmapPayload);
      const bytes = new Uint8Array(raw.length);
      for (let index = 0; index < raw.length; index++) {
        bytes[index] = raw.charCodeAt(index);
      }
      decoded = new Float32Array(bytes.buffer);
      decodedHeightmaps.set(tileMesh, decoded);
    }
    return decoded ?? null;
  }

  function windowTiles(minX, minY) {
    const maxX = minX + WINDOW_SPAN_M;
    const maxY = minY + WINDOW_SPAN_M;
    return terrainRoot.children
      .filter(child => {
        const box = child.userData?.bbox;
        return child.userData?.tileId && box
          && box[0] < maxX && box[2] > minX && box[1] < maxY && box[3] > minY;
      })
      .sort((a, b) =>
        terrainTileDepth(a.userData.tileId)
        - terrainTileDepth(b.userData.tileId));
  }

  function compose(centerX, centerY) {
    const minX = centerX - WINDOW_SPAN_M / 2;
    const minY = centerY - WINDOW_SPAN_M / 2;
    const texel = WINDOW_SPAN_M / WINDOW_RES;
    heightData.fill(0);
    maskData.fill(0);
    const tiles = windowTiles(minX, minY);
    for (const tileMesh of tiles) {
      const heightmap = tileHeightmap(tileMesh);
      const [bx0, by0, bx1, by1] = tileMesh.userData.bbox;
      const resolution = tileMesh.userData.resolution;
      const entry = surfaceFields?.peek?.(tileMesh.userData.tileId);
      const chans = entry?.fields?.chans;
      const maskRes = entry?.fields?.res ?? 0;
      const columnStart = Math.max(0, Math.floor((bx0 - minX) / texel));
      const columnEnd = Math.min(WINDOW_RES - 1, Math.ceil((bx1 - minX) / texel));
      const rowStart = Math.max(0, Math.floor((by0 - minY) / texel));
      const rowEnd = Math.min(WINDOW_RES - 1, Math.ceil((by1 - minY) / texel));
      for (let row = rowStart; row <= rowEnd; row++) {
        const y = minY + (row + 0.5) * texel;
        if (y < by0 || y >= by1) continue;
        for (let column = columnStart; column <= columnEnd; column++) {
          const x = minX + (column + 0.5) * texel;
          if (x < bx0 || x >= bx1) continue;
          const index = row * WINDOW_RES + column;
          if (heightmap && resolution > 1) {
            // heightmaps are row 0 = south, like the window
            const fc = ((x - bx0) / (bx1 - bx0)) * (resolution - 1);
            const fr = ((y - by0) / (by1 - by0)) * (resolution - 1);
            const c0 = Math.min(resolution - 2, Math.floor(fc));
            const r0 = Math.min(resolution - 2, Math.floor(fr));
            const tc = fc - c0;
            const tr = fr - r0;
            const i00 = r0 * resolution + c0;
            heightData[index] =
              heightmap[i00] * (1 - tc) * (1 - tr)
              + heightmap[i00 + 1] * tc * (1 - tr)
              + heightmap[i00 + resolution] * (1 - tc) * tr
              + heightmap[i00 + resolution + 1] * tc * tr;
          }
          if (chans && maskRes > 0) {
            // mask rasters are image-oriented: row 0 = north
            const mc = Math.min(maskRes - 1, Math.max(0, Math.round(
              ((x - bx0) / (bx1 - bx0)) * (maskRes - 1),
            )));
            const mr = Math.min(maskRes - 1, Math.max(0, Math.round(
              ((by1 - y) / (by1 - by0)) * (maskRes - 1),
            )));
            const maskIndex = mr * maskRes + mc;
            const offset = index * 4;
            maskData[offset] = chans.veg?.[maskIndex] ?? 0;
            maskData[offset + 1] = chans.water?.[maskIndex] ?? 0;
            maskData[offset + 2] = chans.snow?.[maskIndex] ?? 0;
          }
        }
      }
    }
    heightTexture.needsUpdate = true;
    maskTexture.needsUpdate = true;
    windowCenter.set(centerX, centerY);
    sharedUniforms.uWindowMin.value.set(
      centerX - WINDOW_SPAN_M / 2, centerY - WINDOW_SPAN_M / 2,
    );
    lastSignature = tiles.map(tile => tile.userData.tileId).join(',');
    for (const mesh of meshes) mesh.visible = tiles.length > 0;
    log(`ground-ring window recomposed @ ${centerX.toFixed(0)},${centerY.toFixed(0)} (${tiles.length} tiles)`);
  }

  const _local = new THREE.Vector3();

  function update({ camera, worldOffsetX = 0, worldOffsetY = 0, timeMs = 0 }) {
    camera.getWorldPosition(_local);
    terrainRoot.worldToLocal(_local);
    const sceneX = _local.x;
    const sceneY = _local.y;

    const needRecenter = !Number.isFinite(windowCenter.x)
      || Math.hypot(sceneX - windowCenter.x, sceneY - windowCenter.y)
        > RECOMPOSE_HYSTERESIS_M;
    if (needRecenter) {
      compose(sceneX, sceneY);
    } else if (timeMs - lastSignatureCheck > SIGNATURE_CHECK_MS) {
      lastSignatureCheck = timeMs;
      const minX = windowCenter.x - WINDOW_SPAN_M / 2;
      const minY = windowCenter.y - WINDOW_SPAN_M / 2;
      const signature = windowTiles(minX, minY)
        .map(tile => tile.userData.tileId).join(',');
      if (signature !== lastSignature) compose(windowCenter.x, windowCenter.y);
    }

    const absoluteX = sceneX + worldOffsetX;
    const absoluteY = sceneY + worldOffsetY;
    sharedUniforms.uCamScene.value.set(sceneX, sceneY);
    sharedUniforms.uTime.value = timeMs / 1000;
    for (const state of ringStates) {
      const cell = state.ring.cellM;
      const cellX = Math.floor(absoluteX / cell);
      const cellY = Math.floor(absoluteY / cell);
      state.uniforms.uCamCell.value.set(cellX, cellY);
      state.uniforms.uCamFrac.value.set(
        absoluteX - cellX * cell, absoluteY - cellY * cell,
      );
    }
  }

  function dispose() {
    for (const state of ringStates) {
      terrainRoot.remove(state.mesh);
      state.mesh.geometry.dispose();
      state.material.dispose();
    }
    heightTexture.dispose();
    maskTexture.dispose();
  }

  return { update, dispose, meshes };
}
