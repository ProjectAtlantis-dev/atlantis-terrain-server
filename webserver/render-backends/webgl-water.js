import * as THREE from 'three';
import { WebGLWaterSimulation } from './webgl-water-sim.js';
import {
  NORTH_CLIFF_REFLECTION_MAX_PADDING_M,
  NORTH_CLIFF_SLOPE_FULL,
  NORTH_CLIFF_SLOPE_START,
} from '../water/water-reflection-mask.js';

// Fjord water surface for the WebGL backend — port of ~/work/ocean2 main.js
// rotated onto the terrainRoot tangent frame (xy horizontal local metres,
// z up). Differences from the standalone demo, all deliberate:
//   - All positions/directions are terrainRoot-LOCAL (uCameraLocal/uSunDir
//     uniforms), never ECEF world space: FFT texture sampling needs stable
//     planar metres, and ECEF coordinates are too large for float precision.
//   - No sky dome and no in-shader haze: the scene pipeline owns atmosphere
//     (Takram aerial perspective + clouds + scene fog). The analytic skyColor
//     stays only as the Fresnel reflection environment.
//   - Translucent (premultiplied alpha, no depth write, log-depth tested):
//     the dropped seabed carries the satellite imagery OF the water, so the
//     surface lets it show through — colour inheritance is per-pixel and
//     free, with veil/reflection/glint composited on top. Depth read by
//     the post passes is the seabed, 5 m below the surface — negligible.

const SKY_GLSL = /* glsl */ `
  vec3 skyColor(vec3 dir, vec3 sunDir, vec3 horizonWarm, vec3 horizonCool, vec3 zenithCol, vec3 sunCol, float cloud) {
    float t = clamp(dir.z, 0.0, 1.0);
    // warm horizon only near the sun's azimuth; the opposite sky stays cool
    vec2 dh = normalize(dir.xy + vec2(1e-5, 0.0));
    vec2 sh = normalize(sunDir.xy + vec2(1e-5, 0.0));
    float az = 0.5 + 0.5 * dot(dh, sh);
    // Keep the orange sunset reflection in a narrow sunward lane so the
    // violet off-axis sky remains visible on both sides of the glitter path.
    float sunward = pow(az, 6.0);
    vec3 horizonCol = mix(horizonCool, horizonWarm, sunward);
    vec3 col = mix(horizonCol, zenithCol, pow(t, 0.48));
    float sd = max(dot(dir, sunDir), 0.0);
    // sun disk + circumsolar haze; cloud diffuses the disk away
    col += sunCol * ((pow(sd, 1500.0) * 55.0 + pow(sd, 18.0) * 0.10) * (1.0 - cloud)
                     + pow(sd, 3.0) * 0.035);
    return col;
  }
`;

const BATHYMETRY_LAYER = 31;

export function prepareBathymetryTerrainTiles(terrainRoot) {
  const restore = [];
  for (const tile of terrainRoot?.children ?? []) {
    if (!tile.isMesh || !/^\d+-\d+-\d+$/.test(tile.userData?.tileId ?? '')) continue;
    restore.push({
      tile,
      layerMask: tile.layers.mask,
      renderOrder: tile.renderOrder,
    });
    tile.layers.set(BATHYMETRY_LAYER);
    // The capture material does not depth-test: parents establish fallback
    // coverage first, then finer tiles overwrite them regardless of whether
    // the coarse shoreline happens to be geometrically higher.
    tile.renderOrder = Number.parseInt(tile.userData.tileId, 10);
  }
  return () => {
    for (const state of restore) {
      state.tile.layers.mask = state.layerMask;
      state.tile.renderOrder = state.renderOrder;
    }
  };
}

// Stochastic de-tiling: each FFT cascade repeats every uL metres, which
// reads as a wallpaper grid from altitude. Partition the cascade's uv space
// into a triangular lattice (~0.44 tiles per cell), give every lattice
// vertex a fixed random uv offset, and combine the three nearest offset
// copies of the texture. Weights are smoothed barycentrics normalised to
// unit L2 — the ocean field is Gaussian, so that combination has the SAME
// spectrum as one copy: ridge trains and chop statistics survive, the
// repeat does not. Shared verbatim by vertex (displacement) and fragment
// (derivatives) so geometry and shading see the same field.
const DETILE_GLSL = /* glsl */ `
  vec2 cellHash(vec2 c) {
    vec3 p3 = fract(vec3(c.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
  }
  void triLattice(vec2 uv, out vec2 o1, out vec2 o2, out vec2 o3, out vec3 w) {
    vec2 s = mat2(1.0, 0.0, -0.57735027, 1.15470054) * (uv / 0.437);
    vec2 base = floor(s);
    vec2 f = fract(s);
    float c = 1.0 - f.x - f.y;
    vec2 v1, v2, v3;
    if (c > 0.0) {
      w = vec3(c, f.x, f.y);
      v1 = base; v2 = base + vec2(1.0, 0.0); v3 = base + vec2(0.0, 1.0);
    } else {
      // upper-triangle barycentrics: weight 1-f.y belongs to vertex (1,0)
      // and 1-f.x to (0,1) — pairing them the other way tears the blended
      // field along every diagonal cell edge (visible water seams)
      w = vec3(-c, 1.0 - f.y, 1.0 - f.x);
      v1 = base + vec2(1.0, 1.0); v2 = base + vec2(1.0, 0.0); v3 = base + vec2(0.0, 1.0);
    }
    // C1-smooth the weights, then unit-L2: variance-preserving for the
    // Gaussian wave field (an averaged blend would flatten the waves in
    // every blend zone and re-draw the grid as lanes of calm water)
    w = w * w * (3.0 - 2.0 * w);
    w /= max(length(w), 1e-4);
    o1 = cellHash(v1); o2 = cellHash(v2); o3 = cellHash(v3);
  }
`;

// Bathymetry capture access + lee-shore fetch, shared by vertex (geometry
// amplitude) and fragment (slope/variance shading) so both see the same
// spatially-varying sea state.
const BATHY_GLSL = /* glsl */ `
  uniform sampler2D uBathy;    // top-down capture: R = local z, G = image brightness
  uniform vec2 uBathyCenter;
  uniform float uBathyExtent;
  uniform vec2 uWindDir;       // local xy, direction the wind blows toward
  uniform float uFetchRamp;    // metres of open water upwind for a full sea
                               // state; 0 disables the lee-shore calm zone

  // local terrain height under the water plane; -5 m (the synthetic fjord
  // floor) wherever the capture has no coverage
  vec4 bathyAt(vec2 p) {
    vec2 uv = (p - uBathyCenter) / uBathyExtent + 0.5;
    float inB = step(abs(uv.x - 0.5), 0.5) * step(abs(uv.y - 0.5), 0.5);
    vec4 b = texture2D(uBathy, uv);
    return mix(vec4(-5.0, 0.0, 0.0, 0.0), b, b.a * inB);
  }

  // Lee-shore fetch: waves need open water upwind to build, so a shore the
  // wind blows FROM is flanked by calm water that roughens over uFetchRamp
  // metres downwind. March upwind and take the nearest land hit. Like the
  // north-cliff reflection setback this is coarse and low-frequency on
  // purpose; missing a narrow islet between samples is fine. Outside the
  // capture window there is no land data and the sea stays at full state.
  float fetchMarch(vec2 p, vec2 upwind) {
    float nearestLand = uFetchRamp;
    for (int i = 1; i <= 8; i++) {
      // squared spacing: dense samples near p, sparse far away. Uniform
      // steps bottomed out at t1/ramp = 0.125 — waves could never drop
      // below ~a third of full amplitude even touching the shoreline.
      float s = float(i) / 8.0;
      float t = uFetchRamp * s * s;
      vec4 b = bathyAt(p + upwind * t);
      // covered capture + terrain at/above the waterline = land
      float land = step(0.5, b.a) * smoothstep(-1.0, 1.0, b.r);
      nearestLand = min(nearestLand, mix(uFetchRamp, t, land));
    }
    return nearestLand;
  }
  float fetchFractionAt(vec2 p) {
    if (uFetchRamp <= 0.0) return 1.0;
    vec2 u0 = -normalize(uWindDir + vec2(1e-5, 0.0));
    // Waves spread in a directional cone, so the calm zone behind a headland
    // has a penumbra: average three upwind rays (+-14 degrees) instead of
    // marching one, or every islet casts a hard-edged wedge downwind that
    // reads as a cast shadow on the water.
    vec2 u1 = vec2(u0.x * 0.970 - u0.y * 0.242, u0.x * 0.242 + u0.y * 0.970);
    vec2 u2 = vec2(u0.x * 0.970 + u0.y * 0.242, -u0.x * 0.242 + u0.y * 0.970);
    float f = fetchMarch(p, u0) + fetchMarch(p, u1) + fetchMarch(p, u2);
    return clamp(f / (3.0 * uFetchRamp), 0.0, 1.0);
  }
`;

const WATER_VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  #include <fog_pars_vertex>
  uniform sampler2D uDisp0;
  uniform sampler2D uDisp1;
  uniform sampler2D uDisp2;
  uniform vec3 uL;
  uniform vec2 uMeshOffset;   // mesh position in terrainRoot-local metres
  uniform vec3 uCameraLocal;  // camera in terrainRoot-local metres

  varying vec3 vPlanePos;     // terrainRoot-local, z up
  varying float vHeight;
  varying float vDist;
  varying float vFetch;       // 0 at an upwind shoreline -> 1 at full fetch

  ${DETILE_GLSL}
  ${BATHY_GLSL}

  vec3 detiledDisp(sampler2D tex, vec2 uv) {
    vec2 o1, o2, o3; vec3 w;
    triLattice(uv, o1, o2, o3, w);
    return texture2D(tex, uv + o1).xyz * w.x
         + texture2D(tex, uv + o2).xyz * w.y
         + texture2D(tex, uv + o3).xyz * w.z;
  }

  void main() {
    vec2 gridXY = position.xy + uMeshOffset;
    float d0 = distance(uCameraLocal, vec3(gridXY, 0.0));

    // cascade blend: fine cascades only contribute geometry near the camera
    float f1 = 1.0 / (1.0 + d0 / 3000.0);
    float f2 = 1.0 / (1.0 + d0 / 420.0);

    // sim textures are (Dx, h, Dz): sim x/z horizontal -> local x/y, h -> z
    vec3 disp = detiledDisp(uDisp0, gridXY / uL.x);
    disp += detiledDisp(uDisp1, gridXY / uL.y) * f1;
    disp += detiledDisp(uDisp2, gridXY / uL.z) * f2;

    // lee-shore fetch scales the whole displacement field. LINEAR in the
    // open-water fraction: the physical sqrt growth curve kept ~70% wave
    // amplitude across most of the band and the calm zone never read as
    // calm — flat presentation beats fidelity here.
    vFetch = fetchFractionAt(gridXY);
    disp *= vFetch;

    vec3 localPos = vec3(position.xy + disp.xz, disp.y);
    vPlanePos = vec3(gridXY + disp.xz, disp.y);
    vHeight = disp.y;
    vDist = distance(uCameraLocal, vPlanePos);

    vec4 mvPosition = modelViewMatrix * vec4(localPos, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <logdepthbuf_vertex>
    #include <fog_vertex>
  }
`;

const WATER_FRAGMENT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  #include <fog_pars_fragment>
  uniform sampler2D uDeriv0;
  uniform sampler2D uDeriv1;
  uniform sampler2D uDeriv2;
  uniform vec3 uL;
  uniform float uTime;
  uniform vec3 uCameraLocal;
  uniform vec3 uSunDir;        // terrainRoot-local, z up
  uniform vec3 uBakedSunDir;   // fixed southern light implied by the imagery
  uniform vec3 uSunColor;
  uniform vec3 uZenithColor;
  uniform vec3 uHorizonColor;
  uniform vec3 uHorizonCool;
  uniform vec3 uDeepColor;
  uniform vec3 uScatterColor;
  uniform float uWindFactor;
  uniform float uHs;
  uniform float uCloud;
  uniform float uRadiance;     // overall output gain: calibrates the ocean2
                               // palette against this pipeline's AGX exposure
  uniform float uOpacity;      // base veil opacity of the surface body
  uniform float uReflect;      // sky-reflection gain (fjord walls occlude sky)
  uniform float uGlintStrength; // direct-sun glitter gain
  uniform float uBathyTexel;   // world metres per bathy texel
  uniform float uAbsorb;       // Beer-Lambert absorption, 1/m of water column
  uniform float uNorthCliffReflectionPadding; // max reflection setback, metres

  varying vec3 vPlanePos;
  varying float vHeight;
  varying float vDist;
  varying float vFetch;       // 0 at an upwind shoreline -> 1 at full fetch

  ${SKY_GLSL}
  ${DETILE_GLSL}
  ${BATHY_GLSL}

  // derivatives cascade: slopes are Gaussian -> straight L2-weighted sum;
  // J deviates about 1, so blend the deviation; .w is a variance, so its
  // weights square. Gradients come from the un-offset uv (offsets are
  // constant per cell) with a 2^-0.5 scale standing in for the -0.5 mip
  // bias the plain samplers used.
  vec4 detiledDeriv(sampler2D tex, vec2 uv) {
    vec2 o1, o2, o3; vec3 w;
    triLattice(uv, o1, o2, o3, w);
    vec2 gx = dFdx(uv) * 0.71, gy = dFdy(uv) * 0.71;
    vec4 t1 = texture2DGradEXT(tex, uv + o1, gx, gy);
    vec4 t2 = texture2DGradEXT(tex, uv + o2, gx, gy);
    vec4 t3 = texture2DGradEXT(tex, uv + o3, gx, gy);
    vec4 r;
    r.xy = t1.xy * w.x + t2.xy * w.y + t3.xy * w.z;
    r.z = 1.0 + (t1.z - 1.0) * w.x + (t2.z - 1.0) * w.y + (t3.z - 1.0) * w.z;
    r.w = t1.w * w.x * w.x + t2.w * w.y * w.y + t3.w * w.z * w.z;
    return r;
  }

  float hash21(vec2 p) {
    p = fract(p * vec2(234.34, 435.345));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1, 0)), u.x),
               mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += a * vnoise(p);
      p = p * 2.17 + vec2(13.7, 7.1);
      a *= 0.5;
    }
    return v;
  }

  float seabedAt(vec2 p) {
    return bathyAt(p).r;
  }

  // Imagery-darkness reflection gate. The capture's g channel is only
  // meaningful where its b channel says a real satellite texture was mapped;
  // everywhere else (placeholder-less tiles, no coverage, beyond the window)
  // the gate stays FULL OPEN — matching lit water, so texture-state churn
  // during LOD reshuffles cannot flip a tile's reflection.
  //
  // Thresholds are measured, not aesthetic (2026-07, Nuuk archipelago vs the
  // eastern fjords): lit open-water imagery never goes below ~0.0035 linear
  // anywhere sampled, while baked cliff-shadow bands fall under ~0.002. The
  // gate therefore restores fully by 0.0035 and only near-black shadow bands
  // suppress reflection. The previous 0.0005..0.025 band put ALL of the
  // archipelago's dark water (median 0.0048) at gate 0.1 — reflection
  // suppressed fjord-wide, exactly the "scatter trashed" presentation.
  float reflectionGateAt(vec2 p) {
    vec2 uv = (p - uBathyCenter) / uBathyExtent + 0.5;
    vec4 b = texture2D(uBathy, uv);
    float inB = step(abs(uv.x - 0.5), 0.5) * step(abs(uv.y - 0.5), 0.5);
    // Relax to full-open across the outer ~2.5 km of the capture window so
    // the boundary never draws a straight seam through dark shadow water.
    float edge = max(abs(uv.x - 0.5), abs(uv.y - 0.5));
    float windowFade = 1.0 - smoothstep(0.42, 0.5, edge);
    float validity = clamp(b.b, 0.0, 1.0) * b.a * inB * windowFade;
    float gate = smoothstep(0.0008, 0.0035, b.g);
    return mix(1.0, gate, validity);
  }

  // Replace analytic sky reflections near north-facing coastal cliffs. Local +y is
  // north, so a north-facing slope rises toward -y (south). Search only on
  // that axis: east/west/south-facing shores are deliberately unaffected.
  // The broad derivative also rejects the artificial 3 m sea-floor drop at
  // an otherwise flat shoreline. Exact shoreline distance is unnecessary;
  // this is intentionally a coarse, low-frequency visual setback.
  float northCliffReflectionKeep(vec2 p, vec4 centerBathy) {
    if (uNorthCliffReflectionPadding <= 0.0) return 1.0;
    float waterCoverage = centerBathy.a
                        * (1.0 - smoothstep(-0.5, 0.5, centerBathy.r));
    if (waterCoverage <= 0.0) return 1.0;

    float sampleStep = uNorthCliffReflectionPadding / 12.0;
    float baseline = max(uBathyTexel * 2.0, sampleStep * 0.5);
    float exclusion = 0.0;
    for (int i = 1; i <= 12; i++) {
      float distanceSouth = sampleStep * float(i);
      vec2 q = p + vec2(0.0, -distanceSouth);
      vec4 terrainSouth = bathyAt(q + vec2(0.0, -baseline));
      vec4 terrainNorth = bathyAt(q + vec2(0.0, baseline));
      float coverage = terrainSouth.a * terrainNorth.a;
      float northFacingSlope = max(
        (terrainSouth.r - terrainNorth.r) / (2.0 * baseline), 0.0
      ) * coverage;
      float cliffWeight = smoothstep(
        ${NORTH_CLIFF_SLOPE_START.toFixed(2)},
        ${NORTH_CLIFF_SLOPE_FULL.toFixed(2)},
        northFacingSlope
      );
      float padding = uNorthCliffReflectionPadding * cliffWeight;
      // Do not create a fully cliff-reflected slab followed by a narrow hard
      // transition: the dark reflection should relax across the full setback.
      // Instead the cliff influence decays across its entire proportional
      // padding distance, both in reach and strength.
      float candidate = cliffWeight * (
        1.0 - smoothstep(0.0, max(padding, 1.0), distanceSouth)
      );
      exclusion = max(exclusion, candidate);
    }
    return 1.0 - exclusion * waterCoverage;
  }

  // Cheap, deterministic approximation of the broad shadow implied by the
  // baked southern light. This deliberately uses only two filtered terrain
  // samples: full per-pixel horizon tracing starves the terrain texture
  // streamer and exposes its grey fallbacks while tiles repaint.
  float bakedShoreVisibility(vec2 p, vec3 ray) {
    float horizontal = length(ray.xy);
    if (horizontal < 0.02 || ray.z <= 0.0) return 1.0;
    vec2 direction = ray.xy / horizontal;
    float rise = ray.z / horizontal;
    float nearDistance = uBathyTexel * 6.0;
    float farDistance = uBathyTexel * 20.0;
    vec4 nearTerrain = bathyAt(p + direction * nearDistance);
    vec4 farTerrain = bathyAt(p + direction * farDistance);
    float nearBlocked = nearTerrain.a
                      * smoothstep(nearDistance * rise - 12.0,
                                   nearDistance * rise + 24.0, nearTerrain.r);
    float farBlocked = farTerrain.a
                     * smoothstep(farDistance * rise - 20.0,
                                  farDistance * rise + 40.0, farTerrain.r);
    return 1.0 - max(nearBlocked, farBlocked * 0.75);
  }

  // anisotropic GGX in the surface tangent frame (T = along wind)
  float ggxAniso(vec3 H, vec3 N, vec3 T, vec3 B, float ax, float ay) {
    float hx = dot(H, T), hy = dot(H, B), hz = max(dot(H, N), 1e-4);
    float d = hx * hx / (ax * ax) + hy * hy / (ay * ay) + hz * hz;
    return 1.0 / (3.14159265 * ax * ay * d * d);
  }

  void main() {
    #include <logdepthbuf_fragment>
    vec2 pxy = vPlanePos.xy;
    float d = vDist;
    vec3 V = normalize(uCameraLocal - vPlanePos);
    vec3 L = uSunDir;

    // ---- water column depth from the bathymetry capture -------------------
    // The surface sits at local z = 0, so column depth is just -seabed.
    vec4 bathySample = bathyAt(pxy);
    float seabed = bathySample.r;
    float colDepth = clamp(-seabed, 0.0, 60.0);
    float northCliffReflection = northCliffReflectionKeep(pxy, bathySample);
    // Luminance is a poor darkness proxy for blue fjord water because it
    // heavily discounts the blue channel; the gate uses the max channel and
    // only calls a pixel black when all three are nearly absent.
    float bottomReflection = reflectionGateAt(pxy);

    // Wall detection: the open fjord floor is a flat synthetic -5 m plane —
    // the only steep thing under the surface is the artificial mask-drop wall
    // at the shoreline (5 m over a texel or two). The veil below must hide
    // exactly that band and nothing else, so measure seabed slope in world
    // metres (central differences one texel apart, resolution-independent).
    float h = uBathyTexel;
    vec2 sgrad = vec2(seabedAt(pxy + vec2(h, 0.0)) - seabedAt(pxy - vec2(h, 0.0)),
                      seabedAt(pxy + vec2(0.0, h)) - seabedAt(pxy - vec2(0.0, h)))
               / (2.0 * h);
    float wall = smoothstep(0.04, 0.15, length(sgrad));

    // ---- normals & Jacobian from the cascades ----------------------------
    // de-tiled sampling; the 2^-0.5 gradient scale inside keeps the old
    // -0.5 mip bias (pre-filtering slopes before nonlinear shading erases
    // crest facets a camera would keep; the recovered E[s^2]-|E[s]|^2
    // variance absorbs what stays sub-pixel).
    vec4 D0 = detiledDeriv(uDeriv0, pxy / uL.x);
    vec4 D1 = detiledDeriv(uDeriv1, pxy / uL.y);
    vec4 D2 = detiledDeriv(uDeriv2, pxy / uL.z);

    float f1 = 1.0 / (1.0 + d / 5000.0);
    float f2 = 1.0 / (1.0 + d / 900.0);
    vec2 slope = D0.xy + D1.xy * f1 + D2.xy * f2;

    // slope variance lost to mip filtering: .w holds E[|slope|^2], .xy the
    // filtered mean, so per-cascade variance is E[s^2] - |E[s]|^2. Cascades
    // are independent, so their (fade-weighted) variances add.
    float slopeVar = max(D0.w - dot(D0.xy, D0.xy), 0.0)
                   + max(D1.w - dot(D1.xy, D1.xy), 0.0) * f1 * f1
                   + max(D2.w - dot(D2.xy, D2.xy), 0.0) * f2 * f2;

    // lee-shore fetch: slopes scale like amplitude (the vertex stage scaled
    // the geometry by the same linear factor), variance like amplitude
    // squared. The micro-ripples get their own faster ramp: wind re-textures
    // a lee shore within the first stretch of open water, long before swell.
    // slopeVarFull keeps the FULL-fetch variance (including the micro energy
    // that migrates to roughness at distance): the glint energy rolloff must
    // key off the sea state the sun sees at full fetch, or calming the
    // variance RELEASES the rolloff and the mid-band renders as a hot white
    // stripe brighter than the open sea.
    // micro fade reaches a few hundred metres: the ripples are the only
    // pixel-scale temporal glitter, and killing them by ~150 m left nothing
    // but smooth sheen from altitude.
    float microFade = 1.0 / (1.0 + d * 0.004);
    float fetchAmp = vFetch;
    // Calm is not flat: even directly behind a lee shore, retain a small
    // wind-ripple field.  The fetch mask owns the swell amplitude; using it
    // as an on/off switch for capillary detail made the calm band lose its
    // moving normals and therefore read as matte water.
    float microGate = mix(0.22, 1.0, smoothstep(0.02, 0.25, vFetch));
    float slopeVarFull = slopeVar
      + 0.5 * (0.35 * uWindFactor) * (0.35 * uWindFactor) * (1.0 - microFade);
    slope *= fetchAmp;
    slopeVar *= vFetch * vFetch;

    // micro-ripple detail for near/mid-field sparkle; its slope energy
    // migrates into roughness as it fades with distance
    float microAmp = 0.35 * uWindFactor * microFade * microGate;
    if (microAmp > 0.003) {
      vec2 mp = pxy * 2.3 - uWindDir * uTime * 1.5;
      float e = 0.25;
      float m0 = fbm(mp);
      slope += vec2(fbm(mp + vec2(e, 0.0)) - m0, fbm(mp + vec2(0.0, e)) - m0) / e * microAmp;
    }
    float microVarAmp = 0.35 * uWindFactor * microGate;
    slopeVar += 0.5 * microVarAmp * microVarAmp * (1.0 - microFade);

    vec3 N = normalize(vec3(-slope.x, -slope.y, 1.0));
    // shading normal: relax toward up with distance. The full-detail N feeds
    // the (variance-filtered) specular lobe; using it for Fresnel/diffuse too
    // would make km-distant wave slopes strobe the sky reflection at far
    // higher contrast than a real ocean shows from altitude.
    vec3 Ns = normalize(mix(vec3(0.0, 0.0, 1.0), N, 1.0 / (1.0 + d * 0.0004)));
    // facet gain: mip filtering halves apparent slope contrast by mid-frame,
    // so re-steepen the shading normal with distance — crests keep their
    // lit-face/dark-edge wedge read instead of melting into mounds
    float facetGain = mix(1.0, 1.35, smoothstep(300.0, 2500.0, d));
    Ns = normalize(vec3(Ns.xy * facetGain, Ns.z));

    // swell-phase elevation, used by the crest scatter term below.
    // (The whitecap/foam system that lived here was removed at the user's
    // request — repeated attempts read as garbage from altitude. The sim's
    // foam passes went with it; the surface is waves + light only.)
    float hN = clamp(vHeight / max(uHs * 0.5, 0.05), -1.0, 1.5);

    // ---- lighting ---------------------------------------------------------
    float NdotV = max(dot(Ns, V), 1e-3);
    float NdotL = max(dot(Ns, L), 0.0);
    // Grazing-angle EXCESS only, no 0.022 base: the satellite imagery is a
    // photo of lit water, so the near-nadir sky reflection is already baked
    // into the background colour. Adding full Fresnel double-counts it and
    // washes the whole fjord toward the analytic sky. This term is exactly
    // zero looking straight down and only adds the shine a satellite could
    // not have seen.
    float fresnel = 0.978 * pow(1.0 - NdotV, 5.0);

    vec3 R = reflect(-V, Ns);
    R.z = max(R.z, 0.018);
    // filtered specular: fold the sub-pixel slope variance into the GGX lobe
    float a2 = 0.0009 + 2.0 * slopeVar;
    float rough = pow(min(a2, 1.0), 0.25);

    // Cox-Munk: mean-square slope along the wind exceeds cross-wind ~60/40,
    // so the filtered glitter lobe must be anisotropic in the wind frame or
    // wind direction becomes invisible at distance
    float ax2 = 0.0009 + 2.0 * slopeVar * 0.62;
    float ay2 = 0.0006 + 2.0 * slopeVar * 0.38;
    vec3 Twind = normalize(vec3(uWindDir.x, uWindDir.y, 0.0));
    Twind = normalize(Twind - N * dot(N, Twind));
    vec3 Bwind = cross(N, Twind);
    // pull rough reflections toward the open-sky average — gently, or facet
    // shading vanishes at distance and waves read as smooth mounds
    vec3 Rr = normalize(mix(R, vec3(0.0, 0.0, 1.0), rough * 0.25));
    vec3 skyRefl = skyColor(Rr, L, uHorizonColor, uHorizonCool, uZenithColor,
                            uSunColor * 0.4, uCloud);

    // The analytic dome has no horizon occlusion and its daylight anti-sun
    // side is still bright enough to bleach the satellite water colour.
    // Preserve that colour when the sun is behind the viewer (R points away
    // from the sun), then open the reflection toward the sun where the real
    // circumsolar sky and glint should turn the surface white.  At high sun
    // there is no meaningful horizontal sun direction, so retain a small,
    // neutral sky contribution instead of choosing an unstable azimuth.
    float sunHorizontal = length(L.xy);
    float reflectedSunAzimuth = dot(normalize(Rr.xy + vec2(1e-5, 0.0)),
                                    normalize(L.xy + vec2(1e-5, 0.0)));
    float sunwardSky = smoothstep(-0.35, 0.65, reflectedSunAzimuth);
    float ambientReflection = mix(0.06, 1.0, sunwardSky);
    ambientReflection = mix(0.12, ambientReflection,
                            smoothstep(0.08, 0.25, sunHorizontal));
    // Two suns deliberately coexist here. The satellite terrain already has
    // shadows baked from a fixed light in the southern sky, while L is the
    // astronomical sun used by the atmosphere and live glint. The broad dark
    // water below the baked cliff shadow must follow the former; otherwise it
    // changes with time of day and contradicts the photographic terrain.
    float bakedCliffVisibility = bakedShoreVisibility(pxy, uBakedSunDir);

    // sun glint (GGX lobe, HDR). Full Cook-Torrance normalization: the
    // 1/(4 NdotV NdotL) denominator is what lets the peak reach genuinely
    // HDR values (several times scene white) when sun, wave normal, and eye
    // align — a flat gain in its place kept the peak near 1.0 and AGX
    // flattened it into ordinary bright water. Clamps stand in for the
    // missing masking-shadowing term at grazing angles.
    vec3 H = normalize(L + V);
    float LdotH = max(dot(L, H), 0.0);
    float fresL = 0.022 + 0.978 * pow(1.0 - LdotH, 5.0);
    vec3 spec = uSunColor * ggxAniso(H, N, Twind, Bwind, max(sqrt(ax2), 0.002), max(sqrt(ay2), 0.002))
              * fresL * smoothstep(0.0, 0.06, L.z)
              / (4.0 * max(NdotV, 0.1) * max(dot(N, L), 0.1));
    // As filtering folds slope variance into the lobe, the glint stops being
    // sparkle and becomes a broad HDR sheen across the sunward half of the
    // fjord (which AGX then desaturates to milky white). The lobe widening
    // already drops the peak (energy-conserving); this extra cut only tames
    // the residual far-field sheen, so keep it gentle or the glitter path
    // from altitude — the normal viewing condition — goes dull.
    // Roll off against the FULL-fetch variance, not the fetch-scaled one:
    // keyed to the scaled variance, calming the water released this rolloff
    // and painted the mid-fetch band as a hot white stripe brighter than
    // the open sea. With the full-sea key, brightness varies only through
    // lobe geometry: glassy water keeps a narrowing direct-sun mirror
    // streak (the one brightening a calm band is allowed) and fades dark
    // away from the sun path — no hard fetch gate needed.
    spec *= 0.06 / (0.06 + slopeVarFull);

    // Crest sparkle, not foam. Reuse the three physical signals that made
    // plausible whitecap *locations*—high swell phase, a steep advancing
    // face, and horizontal compression—but emit only reflected sun. There
    // is no persistence buffer, breakup texture, white albedo, or residue.
    // The narrow N.H term breaks crest rows into momentary facet flashes.
    float J = 1.0 + ((D0.z - 1.0)
            + (D1.z - 1.0) * mix(f1, 1.0, 0.6)
            + (D2.z - 1.0) * f2 * 0.5) * fetchAmp;
    vec2 crestSlope = (D0.xy + D1.xy * 0.6) * fetchAmp;
    float faceSteep = max(-dot(crestSlope, uWindDir), 0.0);
    float crestTop = smoothstep(0.05, 0.55, hN);
    float advancingFace = smoothstep(0.025, 0.11, faceSteep);
    float compression = 1.0 - smoothstep(0.58, 0.92, J);
    float crestSite = crestTop * advancingFace * mix(0.30, 1.0, compression);
    // Normalized narrow microfacet distribution. The previous unnormalized
    // pow(N.H, 48) * 4 never reached HDR after water's ~2.2% Fresnel term;
    // this carries the same Cook-Torrance normalization as the main glint.
    const float crestExponent = 96.0;
    float crestD = (crestExponent + 2.0) / (2.0 * 3.14159265)
                 * pow(max(dot(N, H), 0.0), crestExponent);
    vec3 resolvedCrestGlint = uSunColor * crestD * fresL
      * smoothstep(0.0, 0.06, L.z) * crestSite
      / (4.0 * max(NdotV, 0.1) * max(dot(N, L), 0.1));
    // Past the point where mip filtering can resolve individual N.H peaks,
    // use the variance-filtered sun lobe already computed above and gate it
    // by the same crest physics. Otherwise sparkle exists only near camera.
    vec3 filteredCrestGlint = spec * crestSite * 3.0;
    float crestFilterBlend = smoothstep(450.0, 2200.0, d);
    spec += mix(resolvedCrestGlint, filteredCrestGlint, crestFilterBlend);

    float backlight = pow(clamp(dot(L, -V) * 0.5 + 0.5, 0.0, 1.0), 3.0);
    vec3 ambient = mix(uHorizonCool, uZenithColor, 0.4) * 0.65;
    vec3 bodyCol = uDeepColor * ambient * 4.0;

    // facet lighting from the SWELL slope (cascades 0+1, chop excluded):
    // sunward ridge faces brighten, leeward faces darken. Using the full
    // normal here let metre-scale chop bury the dominant ridge trains.
    vec2 swellSlope = (D0.xy + D1.xy * f1 * 0.5) * facetGain * fetchAmp;
    vec3 Nsw = normalize(vec3(-swellSlope.x, -swellSlope.y, 1.0));
    float facet = (max(dot(Nsw, L), 0.0) - max(L.z, 0.0)) * (1.0 - 0.65 * uCloud);

    // ---- premultiplied composition over the seabed imagery ----------------
    // The terrain under the water mask carries the satellite imagery OF this
    // water, so the 'seabed' showing through IS the faithful local colour —
    // blue at the coast, milky teal toward the glacier outflows. EVERY bit of
    // surface light except glint must scale with uOpacity: the fjord
    // imagery is dark (near-black in mountain shadow), and any ungated
    // additive veil is several times brighter than that background, which
    // reads as opaque water exactly along shadowed coastline.
    // crest transmission is a close-range effect (thin backlit crests); from
    // altitude elevation must not modulate colour or swells read as pale
    // cloudy blobs under the surface
    float crestFade = 1.0 / (1.0 + d * 0.004);
    vec3 body = bodyCol;
    body += uScatterColor * max(hN, 0.0) * (0.06 + 0.50 * backlight) * (0.35 + 0.65 * NdotL) * crestFade
           + uScatterColor * uSunColor * 0.015 * NdotL;
    // facet shading multiplies the body (it is our own light, unlike the
    // background): sunward ridge faces brighten, leeward darken
    body *= max(1.0 + 1.1 * facet, 0.0);

    // Beer-Lambert veil from the water column, gated to the mask-drop walls:
    // shallow shore water stays glass-clear so the imagery shows, and the
    // wall band fades out with depth instead of standing naked behind a
    // transparent surface. This is extinction only: feeding its weight into
    // the sky-lit body colour creates an opaque cyan ribbon along the shore.
    // Cap it so even a full-depth mask wall only darkens rather than becoming
    // a replacement surface. The gate matters: ungated, the uniform -5 m
    // floor made the veil a de facto 40% opacity over EVERY open-water
    // pixel, replacing the satellite colour with the shader's own sky-lit
    // teal — exactly the veil light the design forbids.
    float veil = wall * (1.0 - exp(-uAbsorb * colDepth)) * 0.35;
    // Fetch must not change base opacity: doing so paints the lee mask as a
    // dark shadow over the satellite water. Calmness is represented solely
    // by the smaller swell and residual micro-ripple normals above.
    float bodyW = uOpacity + veil * (1.0 - uOpacity);

    // Reflection gain < 1 stands in for the sky occlusion the analytic dome
    // cannot know about. The terrain imagery contains the cliff shadows the
    // reflection model lacks, so dark water suppresses the entire analytic
    // reflection—not only the narrow direct-sun glint.
    // Keep the analytic sky reflection subdued so it does not bleach the
    // satellite water colour. Direct-sun glint is intentionally separate:
    // when sun, wave normal, and eye align it must retain its HDR peak.
    const float reflectionGain = 0.333333;
    float refl = fresnel * uReflect * bottomReflection * ambientReflection
               * bakedCliffVisibility * reflectionGain;
    // Fetch changes surface roughness, not how reflective water is.  The
    // retained micro-ripple normals keep the lee band from becoming a flat
    // oblique mirror, while Fresnel still makes calm water properly shiny.
    float a = bodyW + refl * (1.0 - bodyW);
    // Only the explicit surface opacity emits body colour. The extra wall
    // alpha carries no radiance, so premultiplied blending uses it to darken
    // the terrain underneath instead of painting the wall cyan.
    // A north-facing cliff does not remove the reflection and reveal the
    // bright source imagery underneath; it replaces reflected sky with the
    // cliff's dark silhouette. Keep reflection alpha intact and change only
    // its radiance, otherwise the padded region becomes a flat teal blob.
    vec3 cliffReflection = uDeepColor * 0.06;
    vec3 reflectedRadiance = mix(
      cliffReflection,
      skyRefl,
      northCliffReflection
    );
    vec3 accum = body * uOpacity + reflectedRadiance * refl;

    // sun glint: pure added light
    // Cliff occlusion is absent from the analytic sun model. The satellite
    // image already contains the desired shadowed-water colour, so use its
    // darkness as the cheap local occlusion proxy for direct sun glint.
    accum += spec * bottomReflection * northCliffReflection * uGlintStrength;

    // no in-shader haze: scene fog + the aerial perspective pass own that
    gl_FragColor = vec4(accum * uRadiance, clamp(a, 0.0, 1.0));
    #include <fog_fragment>
  }
`;

export function createWebGLWater({
  renderer,
  geometry,
  resolution = 256,
  bathySize = 1024,
  bathyExtent = 30000,
} = {}) {
  const sim = new WebGLWaterSimulation(renderer, { resolution });

  const uniforms = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    uTime: { value: 0 },
    uDisp0: { value: null }, uDisp1: { value: null }, uDisp2: { value: null },
    uDeriv0: { value: null }, uDeriv1: { value: null }, uDeriv2: { value: null },
    uL: { value: new THREE.Vector3(1, 1, 1) },
    uMeshOffset: { value: new THREE.Vector2() },
    uCameraLocal: { value: new THREE.Vector3() },
    uSunDir: { value: new THREE.Vector3(0, 0, 1) },
    // Match procgen/library.ts's fixed baked-light convention. Water local is
    // east/north/up, so negative y places this implied sun in the south.
    uBakedSunDir: { value: new THREE.Vector3(0.33, -0.5, 0.8).normalize() },
    uSunColor: { value: new THREE.Color() },
    uZenithColor: { value: new THREE.Color() },
    uHorizonColor: { value: new THREE.Color() },
    uHorizonCool: { value: new THREE.Color() },
    uDeepColor: { value: new THREE.Color(0.032, 0.046, 0.048) },
    uScatterColor: { value: new THREE.Color(0.020, 0.16, 0.18) },
    uWindDir: { value: new THREE.Vector2(1, 0) },
    uWindFactor: { value: 0.5 },
    uHs: { value: 2 },
    uCloud: { value: 0 },
    uRadiance: { value: 1 },
    uOpacity: { value: 0 },
    uReflect: { value: 0.4 },
    uGlintStrength: { value: 1 },
    uBathy: { value: null },
    uBathyCenter: { value: new THREE.Vector2() },
    uBathyExtent: { value: bathyExtent },
    uBathyTexel: { value: bathyExtent / bathySize },
    uAbsorb: { value: 0.25 },
    uFetchRamp: { value: 3000 },
    uNorthCliffReflectionPadding: { value: NORTH_CLIFF_REFLECTION_MAX_PADDING_M },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: WATER_VERTEX,
    fragmentShader: WATER_FRAGMENT,
    fog: true,
    transparent: true,
    depthWrite: false,
    premultipliedAlpha: true,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.visible = false;

  // Top-down bathymetry capture: terrain local height (z) rendered from an
  // ortho camera into a half-float target. The surface shader turns it into
  // water-column depth (surface is z = 0), driving the Beer-Lambert veil.
  // Alpha 0 where nothing drew = no coverage.
  const bathyTarget = new THREE.WebGLRenderTarget(bathySize, bathySize, {
    type: THREE.HalfFloatType,
    magFilter: THREE.LinearFilter,
    minFilter: THREE.LinearFilter,
    depthBuffer: true,
    stencilBuffer: false,
  });
  uniforms.uBathy.value = bathyTarget.texture;
  const BATHY_CAM_H = 10000;
  const bathyCamera = new THREE.OrthographicCamera(
    -bathyExtent / 2, bathyExtent / 2,
    bathyExtent / 2, -bathyExtent / 2,
    1, 30000,
  );
  bathyCamera.layers.set(BATHYMETRY_LAYER);
  // Height override: the capture camera is a terrainRoot child looking down
  // -z, so view z recovers local height as uCamH + mvPosition.z regardless
  // of the ECEF model transforms.
  const bathyMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uCamH: { value: BATHY_CAM_H },
      uMap: { value: null },
      uUseMap: { value: 0 },
      uUseVertexColor: { value: 0 },
      uMaterialColor: { value: new THREE.Color(1, 1, 1) },
    },
    vertexShader: /* glsl */ `
      varying float vZ;
      varying vec2 vUv;
      varying vec3 vColor;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vZ = mv.z;
        vUv = uv;
        vColor = color;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vZ;
      varying vec2 vUv;
      varying vec3 vColor;
      uniform float uCamH;
      uniform sampler2D uMap;
      uniform float uUseMap;
      uniform float uUseVertexColor;
      uniform vec3 uMaterialColor;
      void main() {
        vec3 imageColor = uMaterialColor;
        if (uUseMap > 0.5) imageColor *= texture2D(uMap, vUv).rgb;
        if (uUseVertexColor > 0.5) imageColor *= vColor;
        float brightness = max(max(imageColor.r, imageColor.g), imageColor.b);
        // b flags imagery-backed brightness. Tiles still waiting for their
        // satellite texture render grayscale elevation (or plain white), and
        // a capture taken from those reported full brightness fjord-wide —
        // the reflection gate must know g is meaningless there.
        gl_FragColor = vec4(uCamH + vZ, brightness, uUseMap, 1.0);
      }
    `,
    vertexColors: true,
    depthTest: false,
    depthWrite: false,
  });
  const prevClearColor = new THREE.Color();

  function bindSimTextures() {
    const c0 = sim.getCascadeTextures(0);
    const c1 = sim.getCascadeTextures(1);
    const c2 = sim.getCascadeTextures(2);
    uniforms.uDisp0.value = c0.displacement;
    uniforms.uDisp1.value = c1.displacement;
    uniforms.uDisp2.value = c2.displacement;
    uniforms.uDeriv0.value = c0.derivatives;
    uniforms.uDeriv1.value = c1.derivatives;
    uniforms.uDeriv2.value = c2.derivatives;
    uniforms.uL.value.set(c0.size, c1.size, c2.size);
  }

  return {
    mesh,

    setWind({ speed, directionRad, amplitude, alignment, seed, fetchKm }) {
      sim.setWind({ speed, directionRad, amplitude, alignment, seed, fetchKm });
      uniforms.uWindDir.value.set(Math.sin(directionRad), Math.cos(directionRad));
      uniforms.uWindFactor.value = THREE.MathUtils.clamp(speed / 25, 0, 1);
      uniforms.uHs.value = sim.significantWaveHeight;
    },

    update({ simTime, dt, meshOffset, cameraLocal, sunLocal, palette, params, simParams }) {
      sim.update(simTime, dt, simParams);
      bindSimTextures();
      uniforms.uTime.value = simTime;
      uniforms.uMeshOffset.value.copy(meshOffset);
      uniforms.uCameraLocal.value.copy(cameraLocal);
      uniforms.uSunDir.value.copy(sunLocal);
      uniforms.uSunColor.value.copy(palette.sun);
      uniforms.uZenithColor.value.copy(palette.zenith);
      uniforms.uHorizonColor.value.copy(palette.horizon);
      uniforms.uHorizonCool.value.copy(palette.horizonCool);
      uniforms.uDeepColor.value.copy(palette.deep);
      uniforms.uScatterColor.value.copy(palette.scatter);
      uniforms.uCloud.value = params.cloudiness;
      uniforms.uRadiance.value = params.radiance;
      uniforms.uOpacity.value = params.opacity;
      uniforms.uReflect.value = params.reflectivity;
      uniforms.uGlintStrength.value = Math.max(0, params.glintStrength ?? 1);
      uniforms.uAbsorb.value = params.absorption;
      uniforms.uFetchRamp.value = Math.max(0, params.shoreFetchRamp ?? 3000);
      uniforms.uNorthCliffReflectionPadding.value = Math.max(
        0,
        params.northCliffReflectionPadding ?? 0,
      );
    },

    captureBathymetry({ scene, terrainRoot, centerXY }) {
      if (bathyCamera.parent !== terrainRoot) terrainRoot.add(bathyCamera);
      bathyCamera.position.set(centerXY.x, centerXY.y, BATHY_CAM_H);

      const prevTarget = renderer.getRenderTarget();
      const prevOverride = scene.overrideMaterial;
      const prevBackground = scene.background;
      const prevAlpha = renderer.getClearAlpha();
      const prevSortObjects = renderer.sortObjects;
      renderer.getClearColor(prevClearColor);
      const prevVisible = mesh.visible;
      const restoreTerrainTiles = prepareBathymetryTerrainTiles(terrainRoot);
      const renderCallbacks = [];
      const stats = { tiles: 0, textured: 0, untexturedIds: [] };
      for (const tile of terrainRoot.children) {
        if (!tile.isMesh || !/^\d+-\d+-\d+$/.test(tile.userData?.tileId ?? '')) continue;
        stats.tiles += 1;
        if (tile.material?.map) stats.textured += 1;
        else if (stats.untexturedIds.length < 16) stats.untexturedIds.push(tile.userData.tileId);
        const previous = tile.onBeforeRender;
        renderCallbacks.push([tile, previous]);
        tile.onBeforeRender = (...args) => {
          previous?.apply(tile, args);
          const source = tile.material;
          bathyMaterial.uniforms.uMap.value = source.map;
          bathyMaterial.uniforms.uUseMap.value = source.map ? 1 : 0;
          bathyMaterial.uniforms.uUseVertexColor.value = source.vertexColors ? 1 : 0;
          bathyMaterial.uniforms.uMaterialColor.value.copy(source.color);
        };
      }
      scene.overrideMaterial = bathyMaterial;
      scene.background = null;
      mesh.visible = false;
      renderer.sortObjects = true;
      renderer.setClearColor(0x000000, 0);
      try {
        renderer.setRenderTarget(bathyTarget);
        renderer.clear();
        renderer.render(scene, bathyCamera);
      } finally {
        renderer.setRenderTarget(prevTarget);
        renderer.setClearColor(prevClearColor, prevAlpha);
        scene.overrideMaterial = prevOverride;
        scene.background = prevBackground;
        mesh.visible = prevVisible;
        renderer.sortObjects = prevSortObjects;
        for (const [tile, callback] of renderCallbacks) tile.onBeforeRender = callback;
        restoreTerrainTiles();
      }
      uniforms.uBathyCenter.value.set(centerXY.x, centerXY.y);
      uniforms.uBathyExtent.value = bathyExtent;
      return stats;
    },

    get bathyExtent() { return bathyExtent; },

    dispose() {
      bathyCamera.parent?.remove(bathyCamera);
      bathyTarget.dispose();
      bathyMaterial.dispose();
      sim.dispose();
      material.dispose();
      geometry.dispose();
    },
  };
}
