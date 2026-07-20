import {
  AddEquation,
  Color,
  CustomBlending,
  DataTexture,
  HalfFloatType,
  LinearFilter,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  OrthographicCamera,
  RGBAFormat,
  UnsignedByteType,
  Vector2,
  Vector3,
} from 'three';
import { NodeMaterial, RenderTarget, RendererUtils } from 'three/webgpu';
import {
  Fn,
  If,
  dFdx,
  dFdy,
  float,
  mix,
  normalize,
  positionGeometry,
  positionView,
  reflect,
  select,
  smoothstep,
  step,
  texture,
  uniform,
  userData,
  varyingProperty,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { WebGPUWaterSimulation } from './webgpu-water-sim.js';
import {
  NORTH_CLIFF_REFLECTION_MAX_PADDING_M,
  NORTH_CLIFF_SLOPE_FULL,
  NORTH_CLIFF_SLOPE_START,
} from '../water/water-reflection-mask.js';

// Fjord water surface for the WebGPU backend — TSL port of webgl-water.js,
// same terrainRoot tangent frame (xy horizontal local metres, z up) and the
// same deliberate differences from the standalone ocean2 demo:
//   - All positions/directions are terrainRoot-LOCAL (uCameraLocal/uSunDir
//     uniforms), never ECEF world space: FFT texture sampling needs stable
//     planar metres, and ECEF coordinates are too large for float precision.
//   - No sky dome and no in-shader haze: the scene pipeline owns atmosphere
//     (WebGPU Takram atmosphere + scene fogNode). The analytic skyColor
//     stays only as the Fresnel reflection environment.
//   - Translucent (premultiplied alpha, no depth write, log-depth tested):
//     the dropped seabed carries the satellite imagery OF the water, so the
//     surface lets it show through — colour inheritance is per-pixel and
//     free, with veil/reflection/glint composited on top.
//
// Porting notes vs the GLSL twin:
//   - The fragment emits ALREADY-premultiplied radiance, so the material uses
//     explicit ONE / ONE_MINUS_SRC_ALPHA blending. NodeMaterial's
//     premultipliedAlpha flag would multiply by alpha a second time.
//   - The bathymetry capture cannot use the WebGL per-tile onBeforeRender
//     uniform swap (WebGPU binds per render object, not per draw call), so
//     the override material reads each tile's map/color through per-object
//     userData reference nodes instead.
//   - Vertex-color brightness is not captured: the g channel is only trusted
//     where b says a real satellite texture was mapped, and vertex-colored
//     tiles are exactly the not-yet-textured ones (b = 0, gate full open).

const BATHYMETRY_LAYER = 31;
const BATHY_CAM_H = 10000;

// WebGPU variant of webgl-water.js's prepare: same layer/renderOrder handling,
// plus the per-object userData references the capture override material reads
// in place of the WebGL onBeforeRender uniform swap. Mapless tiles bind
// dummyMap so the per-object texture binding always resolves; bathyUseMap = 0
// marks their brightness as meaningless.
export function prepareBathymetryTerrainTiles(terrainRoot, { dummyMap, fallbackColor } = {}) {
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
    const source = tile.material;
    tile.userData.bathyMap = source?.map ?? dummyMap;
    tile.userData.bathyUseMap = source?.map ? 1 : 0;
    tile.userData.bathyColor = source?.color ?? fallbackColor;
  }
  return () => {
    for (const state of restore) {
      state.tile.layers.mask = state.layerMask;
      state.tile.renderOrder = state.renderOrder;
      delete state.tile.userData.bathyMap;
      delete state.tile.userData.bathyUseMap;
      delete state.tile.userData.bathyColor;
    }
  };
}

// --- shared node helpers ---------------------------------------------------

// Stochastic de-tiling: each FFT cascade repeats every uL metres, which
// reads as a wallpaper grid from altitude. Partition the cascade's uv space
// into a triangular lattice (~0.44 tiles per cell), give every lattice
// vertex a fixed random uv offset, and combine the three nearest offset
// copies of the texture. Weights are smoothed barycentrics normalised to
// unit L2 — the ocean field is Gaussian, so that combination has the SAME
// spectrum as one copy: ridge trains and chop statistics survive, the
// repeat does not. Shared verbatim by vertex (displacement) and fragment
// (derivatives) so geometry and shading see the same field.
function cellHash(c) {
  const p3a = vec3(c.x, c.y, c.x).mul(vec3(0.1031, 0.1030, 0.0973)).fract();
  const p3 = p3a.add(p3a.dot(p3a.yzx.add(33.33)));
  return p3.xx.add(p3.yz).mul(p3.zy).fract();
}

function triLattice(uvNode) {
  // mat2(1, 0, -0.57735027, 1.15470054) * (uv / 0.437)
  const p = uvNode.div(0.437);
  const s = vec2(p.x.sub(p.y.mul(0.57735027)), p.y.mul(1.15470054));
  const base = s.floor();
  const f = s.fract();
  const c = float(1.0).sub(f.x).sub(f.y);
  const lower = c.greaterThan(0.0);
  // upper-triangle barycentrics: weight 1-f.y belongs to vertex (1,0)
  // and 1-f.x to (0,1) — pairing them the other way tears the blended
  // field along every diagonal cell edge (visible water seams)
  const w0 = select(lower,
    vec3(c, f.x, f.y),
    vec3(c.negate(), f.y.oneMinus(), f.x.oneMinus()));
  const v1 = select(lower, base, base.add(vec2(1.0, 1.0)));
  const v2 = base.add(vec2(1.0, 0.0));
  const v3 = base.add(vec2(0.0, 1.0));
  // C1-smooth the weights, then unit-L2: variance-preserving for the
  // Gaussian wave field (an averaged blend would flatten the waves in
  // every blend zone and re-draw the grid as lanes of calm water)
  const ws = w0.mul(w0).mul(w0.mul(-2.0).add(3.0));
  const w = ws.div(ws.length().max(1e-4));
  return { o1: cellHash(v1), o2: cellHash(v2), o3: cellHash(v3), w };
}

function hash21(p) {
  const q = p.mul(vec2(234.34, 435.345)).fract();
  const q2 = q.add(q.dot(q.add(34.23)));
  return q2.x.mul(q2.y).fract();
}

function vnoise(p) {
  const i = p.floor();
  const f = p.fract();
  const u = f.mul(f).mul(f.mul(-2.0).add(3.0));
  return mix(
    mix(hash21(i), hash21(i.add(vec2(1.0, 0.0))), u.x),
    mix(hash21(i.add(vec2(0.0, 1.0))), hash21(i.add(vec2(1.0, 1.0))), u.x),
    u.y,
  );
}

function fbm(p) {
  let value = float(0.0);
  let amplitude = 0.5;
  let q = p;
  for (let i = 0; i < 4; i++) {
    value = value.add(vnoise(q).mul(amplitude));
    q = q.mul(2.17).add(vec2(13.7, 7.1));
    amplitude *= 0.5;
  }
  return value;
}

function skyColor(dir, sunDir, horizonWarm, horizonCool, zenithCol, sunCol, cloud) {
  const t = dir.z.clamp(0.0, 1.0);
  // warm horizon only near the sun's azimuth; the opposite sky stays cool
  const dh = normalize(dir.xy.add(vec2(1e-5, 0.0)));
  const sh = normalize(sunDir.xy.add(vec2(1e-5, 0.0)));
  const az = dh.dot(sh).mul(0.5).add(0.5);
  const horizonCol = mix(horizonCool, horizonWarm, az.mul(az));
  const col = mix(horizonCol, zenithCol, t.pow(0.48));
  const sd = dir.dot(sunDir).max(0.0);
  // sun disk + circumsolar haze; cloud diffuses the disk away
  return col.add(sunCol.mul(
    sd.pow(1500.0).mul(55.0).add(sd.pow(18.0).mul(0.10)).mul(cloud.oneMinus())
      .add(sd.pow(3.0).mul(0.035)),
  ));
}

// anisotropic GGX in the surface tangent frame (T = along wind)
function ggxAniso(H, N, T, B, ax, ay) {
  const hx = H.dot(T);
  const hy = H.dot(B);
  const hz = H.dot(N).max(1e-4);
  const d = hx.mul(hx).div(ax.mul(ax))
    .add(hy.mul(hy).div(ay.mul(ay)))
    .add(hz.mul(hz));
  return float(1.0).div(d.mul(d).mul(ax).mul(ay).mul(Math.PI));
}

function decodeHalf(bits) {
  const sign = (bits & 0x8000) ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 31) return mantissa ? NaN : sign * Infinity;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

function percentile(sorted, q) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

export function createWebGPUWater({
  renderer,
  geometry,
  resolution = 256,
  bathySize = 1024,
  bathyExtent = 30000,
  log = null,
  // Output gain vs the WebGL twin. The analytic water palette was tuned
  // against WebGL's relative-luminance pipeline (composer AGX at exposure
  // 10); the WebGPU pipeline tone maps at 2.5, so 4x restores the relative
  // brightness as an eyeball STARTING POINT. Both pipelines' constants were
  // calibrated against the broken-dark WebGL reference — recalibrate
  // cloudless-vs-cloudless, not against this value.
  radianceScale = 4,
} = {}) {
  const sim = new WebGPUWaterSimulation(renderer, { resolution });

  // --- uniforms (mirrors webgl-water.js) -----------------------------------
  const uTime = uniform(0).setName('waterTime');
  const uL = uniform(new Vector3(1, 1, 1)).setName('waterCascadeSizes');
  const uMeshOffset = uniform(new Vector2()).setName('waterMeshOffset');
  const uCameraLocal = uniform(new Vector3()).setName('waterCameraLocal');
  const uSunDir = uniform(new Vector3(0, 0, 1)).setName('waterSunDir');
  // Match procgen/library.ts's fixed baked-light convention. Water local is
  // east/north/up, so negative y places this implied sun in the south.
  const uBakedSunDir = uniform(new Vector3(0.33, -0.5, 0.8).normalize()).setName('waterBakedSunDir');
  const uSunColor = uniform(new Color()).setName('waterSunColor');
  const uZenithColor = uniform(new Color()).setName('waterZenithColor');
  const uHorizonColor = uniform(new Color()).setName('waterHorizonColor');
  const uHorizonCool = uniform(new Color()).setName('waterHorizonCool');
  const uDeepColor = uniform(new Color(0.032, 0.046, 0.048)).setName('waterDeepColor');
  const uScatterColor = uniform(new Color(0.020, 0.16, 0.18)).setName('waterScatterColor');
  const uWindDir = uniform(new Vector2(1, 0)).setName('waterWindDir');
  const uWindFactor = uniform(0.5).setName('waterWindFactor');
  const uHs = uniform(2).setName('waterSignificantHeight');
  const uCloud = uniform(0).setName('waterCloudiness');
  const uRadiance = uniform(radianceScale).setName('waterRadiance');
  const uOpacity = uniform(0).setName('waterOpacity');
  const uReflect = uniform(0.4).setName('waterReflect');
  const uGlintStrength = uniform(1).setName('waterGlintStrength');
  const uBathyCenter = uniform(new Vector2()).setName('waterBathyCenter');
  const uBathyExtent = uniform(bathyExtent).setName('waterBathyExtent');
  const uBathyTexel = uniform(bathyExtent / bathySize).setName('waterBathyTexel');
  const uAbsorb = uniform(0.25).setName('waterAbsorb');
  const uFetchRamp = uniform(3000).setName('waterFetchRamp');
  const uNorthCliffReflectionPadding =
    uniform(NORTH_CLIFF_REFLECTION_MAX_PADDING_M).setName('waterNorthCliffPad');
  // Port-validation bisect switch (takramDebug.setWaterDebugMode):
  //   0 normal | 1 fetch forced open | 2 fetch open + de-tile bypassed |
  //   3 diagnostic paint (r = fetch, g = |wave height|/2m, b = reflection gate)
  const uDebugMode = uniform(0).setName('waterDebugMode');

  // --- sim texture slots ----------------------------------------------------
  // Base TextureNodes; .sample()/.grad() clones reference back to these, so
  // swapping .value after each sim update reaches every sampling site.
  // Linear half-float to match the sim's displacement/derivative targets:
  // the pipeline's bind-group layout (filterable float) is derived from
  // whatever texture is bound when it first compiles.
  const placeholder = new DataTexture(
    new Uint16Array(4), 1, 1, RGBAFormat, HalfFloatType,
  );
  placeholder.magFilter = placeholder.minFilter = LinearFilter;
  placeholder.needsUpdate = true;
  const texDisp = [texture(placeholder), texture(placeholder), texture(placeholder)];
  const texDeriv = [texture(placeholder), texture(placeholder), texture(placeholder)];

  // Top-down bathymetry capture: terrain local height (z) rendered from an
  // ortho camera into a half-float target. The surface shader turns it into
  // water-column depth (surface is z = 0), driving the Beer-Lambert veil.
  // Alpha 0 where nothing drew = no coverage.
  const bathyTarget = new RenderTarget(bathySize, bathySize, {
    type: HalfFloatType,
    magFilter: LinearFilter,
    minFilter: LinearFilter,
    depthBuffer: true,
    stencilBuffer: false,
  });
  const texBathy = texture(bathyTarget.texture);

  // --- bathymetry access + lee-shore fetch (shared vertex/fragment) ---------

  // local terrain height under the water plane; -10 m (the synthetic fjord
  // floor) wherever the capture has no coverage
  // WebGPU stores the scene-rendered capture with V inverted relative to the
  // WebGL twin (quad-pass ping-pong is immune — its uv rides the flipped
  // geometry — but computed world->uv sampling of a scene render is not), so
  // flip V at the sampling seam and keep the GLSL twin's math intact.
  function bathySampleUv(buv) {
    return vec2(buv.x, buv.y.oneMinus());
  }

  function bathyAt(p) {
    const buv = p.sub(uBathyCenter).div(uBathyExtent).add(0.5);
    const inB = step(buv.x.sub(0.5).abs(), float(0.5))
      .mul(step(buv.y.sub(0.5).abs(), float(0.5)));
    const b = texBathy.sample(bathySampleUv(buv));
    return mix(vec4(-10.0, 0.0, 0.0, 0.0), b, b.a.mul(inB));
  }

  function seabedAt(p) {
    return bathyAt(p).r;
  }

  // Lee-shore fetch: waves need open water upwind to build, so a shore the
  // wind blows FROM is flanked by calm water that roughens over uFetchRamp
  // metres downwind. March upwind and take the nearest land hit. Like the
  // north-cliff reflection setback this is coarse and low-frequency on
  // purpose; missing a narrow islet between samples is fine. Outside the
  // capture window there is no land data and the sea stays at full state.
  function fetchMarch(p, upwind) {
    let nearestLand = float(uFetchRamp);
    for (let i = 1; i <= 8; i++) {
      // squared spacing: dense samples near p, sparse far away. Uniform
      // steps bottomed out at t1/ramp = 0.125 — waves could never drop
      // below ~a third of full amplitude even touching the shoreline.
      const s = i / 8;
      const t = uFetchRamp.mul(s * s);
      const b = bathyAt(p.add(upwind.mul(t)));
      // covered capture + terrain at/above the waterline = land
      const land = step(0.5, b.a).mul(smoothstep(-1.0, 1.0, b.r));
      nearestLand = nearestLand.min(mix(float(uFetchRamp), t, land));
    }
    return nearestLand;
  }

  function fetchFractionAt(p) {
    const u0 = normalize(uWindDir.add(vec2(1e-5, 0.0))).negate();
    // Waves spread in a directional cone, so the calm zone behind a headland
    // has a penumbra: average three upwind rays (+-14 degrees) instead of
    // marching one, or every islet casts a hard-edged wedge downwind that
    // reads as a cast shadow on the water.
    const u1 = vec2(
      u0.x.mul(0.970).sub(u0.y.mul(0.242)),
      u0.x.mul(0.242).add(u0.y.mul(0.970)),
    );
    const u2 = vec2(
      u0.x.mul(0.970).add(u0.y.mul(0.242)),
      u0.y.mul(0.970).sub(u0.x.mul(0.242)),
    );
    const f = fetchMarch(p, u0).add(fetchMarch(p, u1)).add(fetchMarch(p, u2));
    const fraction = f.div(uFetchRamp.mul(3.0)).clamp(0.0, 1.0);
    return select(uFetchRamp.lessThanEqual(0.0), float(1.0), fraction);
  }

  // --- varyings --------------------------------------------------------------
  const vPlanePos = varyingProperty('vec3', 'vWaterPlanePos'); // terrainRoot-local, z up
  const vHeight = varyingProperty('float', 'vWaterHeight');
  const vDist = varyingProperty('float', 'vWaterDist');
  const vFetch = varyingProperty('float', 'vWaterFetch');      // 0 at an upwind shoreline -> 1 at full fetch

  // --- vertex: cascade displacement ------------------------------------------

  function detiledDisp(baseTex, uvNode) {
    const { o1, o2, o3, w } = triLattice(uvNode);
    return baseTex.sample(uvNode.add(o1)).xyz.mul(w.x)
      .add(baseTex.sample(uvNode.add(o2)).xyz.mul(w.y))
      .add(baseTex.sample(uvNode.add(o3)).xyz.mul(w.z));
  }

  const positionNode = Fn(() => {
    const gridXY = positionGeometry.xy.add(uMeshOffset);
    const d0 = uCameraLocal.sub(vec3(gridXY, 0.0)).length();

    // cascade blend: fine cascades only contribute geometry near the camera
    const f1 = float(1.0).div(d0.div(3000.0).add(1.0));
    const f2 = float(1.0).div(d0.div(420.0).add(1.0));

    // sim textures are (Dx, h, Dz): sim x/z horizontal -> local x/y, h -> z
    const dispSample = (baseTex, uvNode) => select(
      uDebugMode.greaterThanEqual(2.0),
      baseTex.sample(uvNode).xyz,
      detiledDisp(baseTex, uvNode),
    );
    let disp = dispSample(texDisp[0], gridXY.div(uL.x));
    disp = disp.add(dispSample(texDisp[1], gridXY.div(uL.y)).mul(f1));
    disp = disp.add(dispSample(texDisp[2], gridXY.div(uL.z)).mul(f2));

    // lee-shore fetch scales the whole displacement field. LINEAR in the
    // open-water fraction: the physical sqrt growth curve kept ~70% wave
    // amplitude across most of the band and the calm zone never read as
    // calm — flat presentation beats fidelity here.
    const fetch = select(
      uDebugMode.greaterThanEqual(1.0), float(1.0), fetchFractionAt(gridXY),
    );
    vFetch.assign(fetch);
    disp = disp.mul(fetch);

    const planePos = vec3(gridXY.add(disp.xz), disp.y);
    vPlanePos.assign(planePos);
    vHeight.assign(disp.y);
    vDist.assign(uCameraLocal.sub(planePos).length());

    return vec3(positionGeometry.xy.add(disp.xz), disp.y);
  })();

  // --- fragment ----------------------------------------------------------------

  // derivatives cascade: slopes are Gaussian -> straight L2-weighted sum;
  // J deviates about 1, so blend the deviation; .w is a variance, so its
  // weights square. Gradients come from the un-offset uv (offsets are
  // constant per cell) with a 2^-0.5 scale standing in for the -0.5 mip
  // bias the WebGL samplers used.
  function detiledDeriv(baseTex, uvNode) {
    const { o1, o2, o3, w } = triLattice(uvNode);
    const gx = dFdx(uvNode).mul(0.71);
    const gy = dFdy(uvNode).mul(0.71);
    const t1 = baseTex.sample(uvNode.add(o1)).grad(gx, gy);
    const t2 = baseTex.sample(uvNode.add(o2)).grad(gx, gy);
    const t3 = baseTex.sample(uvNode.add(o3)).grad(gx, gy);
    const rxy = t1.xy.mul(w.x).add(t2.xy.mul(w.y)).add(t3.xy.mul(w.z));
    const rz = float(1.0)
      .add(t1.z.sub(1.0).mul(w.x))
      .add(t2.z.sub(1.0).mul(w.y))
      .add(t3.z.sub(1.0).mul(w.z));
    const rw = t1.w.mul(w.x).mul(w.x)
      .add(t2.w.mul(w.y).mul(w.y))
      .add(t3.w.mul(w.z).mul(w.z));
    return vec4(rxy, rz, rw);
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
  // suppress reflection.
  function reflectionGateAt(p) {
    const buv = p.sub(uBathyCenter).div(uBathyExtent).add(0.5);
    const b = texBathy.sample(bathySampleUv(buv));
    const inB = step(buv.x.sub(0.5).abs(), float(0.5))
      .mul(step(buv.y.sub(0.5).abs(), float(0.5)));
    // Relax to full-open across the outer ~2.5 km of the capture window so
    // the boundary never draws a straight seam through dark shadow water.
    const edge = buv.x.sub(0.5).abs().max(buv.y.sub(0.5).abs());
    const windowFade = smoothstep(0.42, 0.5, edge).oneMinus();
    const validity = b.b.clamp(0.0, 1.0).mul(b.a).mul(inB).mul(windowFade);
    const gate = smoothstep(0.0008, 0.0035, b.g);
    return mix(float(1.0), gate, validity);
  }

  // Replace analytic sky reflections near north-facing coastal cliffs. Local
  // +y is north, so a north-facing slope rises toward -y (south). Search only
  // on that axis: east/west/south-facing shores are deliberately unaffected.
  // The broad derivative also rejects the artificial 10 m sea-floor drop at
  // an otherwise flat shoreline. Exact shoreline distance is unnecessary;
  // this is intentionally a coarse, low-frequency visual setback.
  function northCliffReflectionKeep(p, centerBathy) {
    const waterCoverage = centerBathy.a
      .mul(smoothstep(-0.5, 0.5, centerBathy.r).oneMinus());

    const sampleStep = uNorthCliffReflectionPadding.div(12.0);
    const baseline = uBathyTexel.mul(2.0).max(sampleStep.mul(0.5));
    let exclusion = float(0.0);
    for (let i = 1; i <= 12; i++) {
      const distanceSouth = sampleStep.mul(i);
      const q = vec2(p.x, p.y.sub(distanceSouth));
      const terrainSouth = bathyAt(vec2(q.x, q.y.sub(baseline)));
      const terrainNorth = bathyAt(vec2(q.x, q.y.add(baseline)));
      const coverage = terrainSouth.a.mul(terrainNorth.a);
      const northFacingSlope = terrainSouth.r.sub(terrainNorth.r)
        .div(baseline.mul(2.0)).max(0.0).mul(coverage);
      const cliffWeight = smoothstep(
        NORTH_CLIFF_SLOPE_START, NORTH_CLIFF_SLOPE_FULL, northFacingSlope,
      );
      const padding = uNorthCliffReflectionPadding.mul(cliffWeight);
      // Do not create a fully cliff-reflected slab followed by a narrow hard
      // transition: the dark reflection should relax across the full setback.
      // Instead the cliff influence decays across its entire proportional
      // padding distance, both in reach and strength.
      const candidate = cliffWeight.mul(
        smoothstep(float(0.0), padding.max(1.0), distanceSouth).oneMinus(),
      );
      exclusion = exclusion.max(candidate);
    }
    const keep = exclusion.mul(waterCoverage).oneMinus();
    return select(uNorthCliffReflectionPadding.lessThanEqual(0.0), float(1.0), keep);
  }

  // Cheap, deterministic approximation of the broad shadow implied by the
  // baked southern light. This deliberately uses only two filtered terrain
  // samples: full per-pixel horizon tracing starves the terrain texture
  // streamer and exposes its grey fallbacks while tiles repaint.
  function bakedShoreVisibility(p, ray) {
    const horizontal = ray.xy.length();
    const safeHorizontal = horizontal.max(1e-5);
    const direction = ray.xy.div(safeHorizontal);
    const rise = ray.z.div(safeHorizontal);
    const nearDistance = uBathyTexel.mul(6.0);
    const farDistance = uBathyTexel.mul(20.0);
    const nearTerrain = bathyAt(p.add(direction.mul(nearDistance)));
    const farTerrain = bathyAt(p.add(direction.mul(farDistance)));
    const nearBlocked = nearTerrain.a.mul(smoothstep(
      nearDistance.mul(rise).sub(12.0), nearDistance.mul(rise).add(24.0), nearTerrain.r,
    ));
    const farBlocked = farTerrain.a.mul(smoothstep(
      farDistance.mul(rise).sub(20.0), farDistance.mul(rise).add(40.0), farTerrain.r,
    ));
    const visibility = nearBlocked.max(farBlocked.mul(0.75)).oneMinus();
    return select(
      horizontal.lessThan(0.02).or(ray.z.lessThanEqual(0.0)),
      float(1.0),
      visibility,
    );
  }

  const fragmentColor = Fn(() => {
    const pxy = vPlanePos.xy;
    const d = float(vDist);
    const V = normalize(uCameraLocal.sub(vPlanePos));
    const L = vec3(uSunDir);

    // ---- water column depth from the bathymetry capture -------------------
    // The surface sits at local z = 0, so column depth is just -seabed.
    const bathySample = bathyAt(pxy);
    const seabed = bathySample.r;
    const colDepth = seabed.negate().clamp(0.0, 60.0);
    const northCliffReflection = northCliffReflectionKeep(pxy, bathySample);
    // Luminance is a poor darkness proxy for blue fjord water because it
    // heavily discounts the blue channel; the gate uses the max channel and
    // only calls a pixel black when all three are nearly absent.
    const bottomReflection = reflectionGateAt(pxy);

    // Wall detection: the open fjord floor is a flat synthetic -10 m plane —
    // the only steep thing under the surface is the artificial mask-drop wall
    // at the shoreline (10 m over a texel or two). The veil below must hide
    // exactly that band and nothing else, so measure seabed slope in world
    // metres (central differences one texel apart, resolution-independent).
    const h = float(uBathyTexel);
    const sgrad = vec2(
      seabedAt(pxy.add(vec2(h, 0.0))).sub(seabedAt(pxy.sub(vec2(h, 0.0)))),
      seabedAt(pxy.add(vec2(0.0, h))).sub(seabedAt(pxy.sub(vec2(0.0, h)))),
    ).div(h.mul(2.0));
    const wall = smoothstep(0.04, 0.15, sgrad.length());

    // ---- normals & Jacobian from the cascades ----------------------------
    const D0 = detiledDeriv(texDeriv[0], pxy.div(uL.x));
    const D1 = detiledDeriv(texDeriv[1], pxy.div(uL.y));
    const D2 = detiledDeriv(texDeriv[2], pxy.div(uL.z));

    const f1 = float(1.0).div(d.div(5000.0).add(1.0));
    const f2 = float(1.0).div(d.div(900.0).add(1.0));

    // slope variance lost to mip filtering: .w holds E[|slope|^2], .xy the
    // filtered mean, so per-cascade variance is E[s^2] - |E[s]|^2. Cascades
    // are independent, so their (fade-weighted) variances add.
    const slopeVarRaw = D0.w.sub(D0.xy.dot(D0.xy)).max(0.0)
      .add(D1.w.sub(D1.xy.dot(D1.xy)).max(0.0).mul(f1).mul(f1))
      .add(D2.w.sub(D2.xy.dot(D2.xy)).max(0.0).mul(f2).mul(f2));

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
    const microFade = float(1.0).div(d.mul(0.004).add(1.0));
    const fetchAmp = float(vFetch);
    const microGate = smoothstep(0.02, 0.25, vFetch);
    const windMicro = float(0.35).mul(uWindFactor);
    const slopeVarFull = slopeVarRaw
      .add(windMicro.mul(windMicro).mul(0.5).mul(microFade.oneMinus()));

    const slope = D0.xy.add(D1.xy.mul(f1)).add(D2.xy.mul(f2))
      .mul(fetchAmp).toVar('waterSlope');
    let slopeVar = slopeVarRaw.mul(vFetch).mul(vFetch);

    // micro-ripple detail for near/mid-field sparkle; its slope energy
    // migrates into roughness as it fades with distance
    const microAmp = windMicro.mul(microFade).mul(microGate);
    If(microAmp.greaterThan(0.003), () => {
      const mp = pxy.mul(2.3).sub(uWindDir.mul(uTime.mul(1.5)));
      const e = 0.25;
      const m0 = fbm(mp);
      slope.addAssign(vec2(
        fbm(mp.add(vec2(e, 0.0))).sub(m0),
        fbm(mp.add(vec2(0.0, e))).sub(m0),
      ).div(e).mul(microAmp));
    });
    const microVarAmp = windMicro.mul(microGate);
    slopeVar = slopeVar.add(
      microVarAmp.mul(microVarAmp).mul(0.5).mul(microFade.oneMinus()),
    );

    const N = normalize(vec3(slope.x.negate(), slope.y.negate(), 1.0));
    // shading normal: relax toward up with distance. The full-detail N feeds
    // the (variance-filtered) specular lobe; using it for Fresnel/diffuse too
    // would make km-distant wave slopes strobe the sky reflection at far
    // higher contrast than a real ocean shows from altitude.
    const NsRelaxed = normalize(mix(
      vec3(0.0, 0.0, 1.0), N, float(1.0).div(d.mul(0.0004).add(1.0)),
    ));
    // facet gain: mip filtering halves apparent slope contrast by mid-frame,
    // so re-steepen the shading normal with distance — crests keep their
    // lit-face/dark-edge wedge read instead of melting into mounds
    const facetGain = mix(float(1.0), float(1.35), smoothstep(300.0, 2500.0, d));
    const Ns = normalize(vec3(NsRelaxed.xy.mul(facetGain), NsRelaxed.z));

    // swell-phase elevation, used by the crest scatter term below.
    const hN = vHeight.div(uHs.mul(0.5).max(0.05)).clamp(-1.0, 1.5);

    // ---- lighting ---------------------------------------------------------
    const NdotV = Ns.dot(V).max(1e-3);
    const NdotL = Ns.dot(L).max(0.0);
    // Grazing-angle EXCESS only, no 0.022 base: the satellite imagery is a
    // photo of lit water, so the near-nadir sky reflection is already baked
    // into the background colour. Adding full Fresnel double-counts it and
    // washes the whole fjord toward the analytic sky. This term is exactly
    // zero looking straight down and only adds the shine a satellite could
    // not have seen.
    const fresnel = NdotV.oneMinus().pow(5.0).mul(0.978);

    const R0 = reflect(V.negate(), Ns);
    const R = vec3(R0.xy, R0.z.max(0.018));
    // filtered specular: fold the sub-pixel slope variance into the GGX lobe
    const a2 = slopeVar.mul(2.0).add(0.0009);
    const rough = a2.min(1.0).pow(0.25);

    // Cox-Munk: mean-square slope along the wind exceeds cross-wind ~60/40,
    // so the filtered glitter lobe must be anisotropic in the wind frame or
    // wind direction becomes invisible at distance
    const ax2 = slopeVar.mul(2.0).mul(0.62).add(0.0009);
    const ay2 = slopeVar.mul(2.0).mul(0.38).add(0.0006);
    const TwindFlat = normalize(vec3(uWindDir.x, uWindDir.y, 0.0));
    const Twind = normalize(TwindFlat.sub(N.mul(N.dot(TwindFlat))));
    const Bwind = N.cross(Twind);
    // pull rough reflections toward the open-sky average — gently, or facet
    // shading vanishes at distance and waves read as smooth mounds
    const Rr = normalize(mix(R, vec3(0.0, 0.0, 1.0), rough.mul(0.25)));
    const skyRefl = skyColor(
      Rr, L, uHorizonColor, uHorizonCool, uZenithColor, uSunColor.mul(0.4), uCloud,
    );

    // The analytic dome has no horizon occlusion and its daylight anti-sun
    // side is still bright enough to bleach the satellite water colour.
    // Preserve that colour when the sun is behind the viewer (R points away
    // from the sun), then open the reflection toward the sun where the real
    // circumsolar sky and glint should turn the surface white. At high sun
    // there is no meaningful horizontal sun direction, so retain a small,
    // neutral sky contribution instead of choosing an unstable azimuth.
    const sunHorizontal = L.xy.length();
    const reflectedSunAzimuth = normalize(Rr.xy.add(vec2(1e-5, 0.0)))
      .dot(normalize(L.xy.add(vec2(1e-5, 0.0))));
    const sunwardSky = smoothstep(-0.35, 0.65, reflectedSunAzimuth);
    const ambientReflection = mix(
      float(0.12),
      mix(float(0.06), float(1.0), sunwardSky),
      smoothstep(0.08, 0.25, sunHorizontal),
    );
    // Two suns deliberately coexist here. The satellite terrain already has
    // shadows baked from a fixed light in the southern sky, while L is the
    // astronomical sun used by the atmosphere and live glint. The broad dark
    // water below the baked cliff shadow must follow the former; otherwise it
    // changes with time of day and contradicts the photographic terrain.
    const bakedCliffVisibility = bakedShoreVisibility(pxy, vec3(uBakedSunDir));

    // sun glint (GGX lobe, HDR). Full Cook-Torrance normalization: the
    // 1/(4 NdotV NdotL) denominator is what lets the peak reach genuinely
    // HDR values (several times scene white) when sun, wave normal, and eye
    // align — a flat gain in its place kept the peak near 1.0 and AGX
    // flattened it into ordinary bright water. Clamps stand in for the
    // missing masking-shadowing term at grazing angles.
    const H = normalize(L.add(V));
    const LdotH = L.dot(H).max(0.0);
    const fresL = LdotH.oneMinus().pow(5.0).mul(0.978).add(0.022);
    let spec = uSunColor.mul(ggxAniso(
      H, N, Twind, Bwind, ax2.sqrt().max(0.002), ay2.sqrt().max(0.002),
    ))
      .mul(fresL)
      .mul(smoothstep(0.0, 0.06, L.z))
      .div(NdotV.max(0.1).mul(N.dot(L).max(0.1)).mul(4.0));
    // As filtering folds slope variance into the lobe, the glint stops being
    // sparkle and becomes a broad HDR sheen across the sunward half of the
    // fjord (which AGX then desaturates to milky white). The lobe widening
    // already drops the peak (energy-conserving); this extra cut only tames
    // the residual far-field sheen, so keep it gentle or the glitter path
    // from altitude — the normal viewing condition — goes dull.
    // Roll off against the FULL-fetch variance, not the fetch-scaled one:
    // keyed to the scaled variance, calming the water released this rolloff
    // and painted the mid-fetch band as a hot white stripe brighter than
    // the open sea.
    spec = spec.mul(float(0.06).div(slopeVarFull.add(0.06)));

    const backlight = L.dot(V.negate()).mul(0.5).add(0.5).clamp(0.0, 1.0).pow(3.0);
    const ambient = mix(uHorizonCool, uZenithColor, 0.4).mul(0.65);
    const bodyCol = uDeepColor.mul(ambient).mul(4.0);

    // facet lighting from the SWELL slope (cascades 0+1, chop excluded):
    // sunward ridge faces brighten, leeward faces darken. Using the full
    // normal here let metre-scale chop bury the dominant ridge trains.
    const swellSlope = D0.xy.add(D1.xy.mul(f1).mul(0.5)).mul(facetGain).mul(fetchAmp);
    const Nsw = normalize(vec3(swellSlope.negate(), 1.0));
    const facet = Nsw.dot(L).max(0.0).sub(L.z.max(0.0)).mul(uCloud.mul(0.65).oneMinus());

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
    const crestFade = microFade; // same 1/(1 + d*0.004) falloff
    let body = bodyCol
      .add(uScatterColor.mul(hN.max(0.0))
        .mul(backlight.mul(0.50).add(0.06))
        .mul(NdotL.mul(0.65).add(0.35))
        .mul(crestFade))
      .add(uScatterColor.mul(uSunColor).mul(0.015).mul(NdotL));
    // facet shading multiplies the body (it is our own light, unlike the
    // background): sunward ridge faces brighten, leeward darken
    body = body.mul(facet.mul(1.1).add(1.0).max(0.0));

    // Beer-Lambert veil from the water column, gated to the mask-drop walls:
    // shallow shore water stays glass-clear so the imagery shows, and the
    // wall band fades out with depth instead of standing naked behind a
    // transparent surface. This is extinction only: feeding its weight into
    // the sky-lit body colour creates an opaque cyan ribbon along the shore.
    const veil = wall.mul(uAbsorb.negate().mul(colDepth).exp().oneMinus()).mul(0.35);
    // Smooth water is DARKER from altitude, not lighter: a lee-shore slick
    // mirrors the mostly-dark sky away from the sun, while rough water
    // spreads sun glitter into broad bright sheen. Carry the calm band as
    // extra radiance-free alpha (the same premultiplied trick as the wall
    // veil): it darkens the imagery underneath instead of painting the
    // surface with light of its own. The narrow direct-sun mirror line
    // survives via the glint term, whose lobe tightens as slopeVar
    // collapses with the fetch.
    const slick = smoothstep(0.05, 0.6, vFetch).oneMinus().mul(0.18);
    const bodyW = uOpacity.add(
      veil.add(slick.mul(veil.oneMinus())).mul(uOpacity.oneMinus()),
    );

    // Reflection gain < 1 stands in for the sky occlusion the analytic dome
    // cannot know about. The terrain imagery contains the cliff shadows the
    // reflection model lacks, so dark water suppresses the entire analytic
    // reflection—not only the narrow direct-sun glint.
    const reflectionGain = 0.333333;
    let refl = fresnel.mul(uReflect).mul(bottomReflection).mul(ambientReflection)
      .mul(bakedCliffVisibility).mul(reflectionGain);
    // The grazing-angle sky sheen uses the distance-relaxed normal (~up far
    // from the camera), so it is blind to the flattened wave field — left
    // ungated it bleaches the calm band white at oblique view angles. A
    // small floor keeps the slick from going pitch black at grazing.
    refl = refl.mul(mix(float(0.1), float(1.0), smoothstep(0.0, 0.5, vFetch)));
    const alpha = bodyW.add(refl.mul(bodyW.oneMinus()));
    // Only the explicit surface opacity emits body colour. The extra wall
    // alpha carries no radiance, so premultiplied blending uses it to darken
    // the terrain underneath instead of painting the wall cyan.
    // A north-facing cliff does not remove the reflection and reveal the
    // bright source imagery underneath; it replaces reflected sky with the
    // cliff's dark silhouette. Keep reflection alpha intact and change only
    // its radiance, otherwise the padded region becomes a flat teal blob.
    const cliffReflection = uDeepColor.mul(0.06);
    const reflectedRadiance = mix(cliffReflection, skyRefl, northCliffReflection);
    let accum = body.mul(uOpacity).add(reflectedRadiance.mul(refl));

    // sun glint: pure added light
    // Cliff occlusion is absent from the analytic sun model. The satellite
    // image already contains the desired shadowed-water colour, so use its
    // darkness as the cheap local occlusion proxy for direct sun glint.
    accum = accum.add(
      spec.mul(bottomReflection).mul(northCliffReflection).mul(uGlintStrength),
    );

    // no in-shader haze: scene fogNode + the aerial perspective pass own that
    const composed = vec4(accum.mul(uRadiance), alpha.clamp(0.0, 1.0));
    const paint = vec4(
      vFetch,
      vHeight.abs().div(2.0).clamp(0.0, 1.0),
      bottomReflection,
      1.0,
    );
    return select(uDebugMode.equal(3.0), paint, composed);
  })();

  const material = new NodeMaterial();
  material.name = 'WebGPUWater.surface';
  material.positionNode = positionNode;
  material.colorNode = fragmentColor.rgb;
  material.opacityNode = fragmentColor.a;
  material.transparent = true;
  material.depthWrite = false;
  // The fragment emits premultiplied radiance already; NodeMaterial's
  // premultipliedAlpha flag would multiply by alpha again, so express the
  // ONE / ONE_MINUS_SRC_ALPHA blend explicitly instead.
  material.blending = CustomBlending;
  material.blendEquation = AddEquation;
  material.blendSrc = OneFactor;
  material.blendDst = OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = OneFactor;
  material.blendDstAlpha = OneMinusSrcAlphaFactor;

  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.visible = false;

  // --- bathymetry capture ----------------------------------------------------

  const bathyCamera = new OrthographicCamera(
    -bathyExtent / 2, bathyExtent / 2,
    bathyExtent / 2, -bathyExtent / 2,
    1, 30000,
  );
  bathyCamera.layers.set(BATHYMETRY_LAYER);

  // Mapless tiles get this stand-in so the per-object texture binding always
  // resolves; bathyUseMap = 0 marks their brightness as meaningless.
  const dummyMap = new DataTexture(
    new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat, UnsignedByteType,
  );
  dummyMap.needsUpdate = true;
  const fallbackColor = new Color(1, 1, 1);

  // Height override: the capture camera is a terrainRoot child looking down
  // -z, so view z recovers local height as uCamH + positionView.z regardless
  // of the ECEF model transforms. Each tile's texture/color arrives through
  // per-object userData references — the WebGPU replacement for the WebGL
  // onBeforeRender uniform swap.
  const uCamH = uniform(BATHY_CAM_H).setName('waterBathyCamH');
  const bathyMaterial = new NodeMaterial();
  bathyMaterial.name = 'WebGPUWater.bathymetryCapture';
  bathyMaterial.fragmentNode = Fn(() => {
    const tileMap = userData('bathyMap', 'texture');
    const useMap = float(userData('bathyUseMap', 'float'));
    const tileColor = vec3(userData('bathyColor', 'color'));
    const imageColor = tileColor.mul(mix(vec3(1.0), tileMap.rgb, useMap));
    const brightness = imageColor.r.max(imageColor.g).max(imageColor.b);
    // b flags imagery-backed brightness. Tiles still waiting for their
    // satellite texture render flat colour — a capture taken from those
    // reported meaningless brightness fjord-wide, so the reflection gate
    // must know g is untrusted there.
    return vec4(uCamH.add(positionView.z), brightness, useMap, 1.0);
  })();
  bathyMaterial.depthTest = false;
  bathyMaterial.depthWrite = false;
  // The capture renders the MAIN scene, which carries the backend's fogNode;
  // fragmentNode output still passes through setupOutput's fog wrap, and fog
  // mixed into (height, brightness, useMap) would corrupt the data channels.
  bathyMaterial.fog = false;
  let bathyRendererState;

  // WebGPU-port diagnostic: read cascade 0's displacement back periodically
  // and log wave-height stats — directly answers whether the FFT chain is
  // alive (healthy: rmsH a decent fraction of Hs) or dead (~0 everywhere).
  let lastSimStatsMs = -Infinity;
  function logSimStats() {
    if (!log) return;
    const nowMs = performance.now();
    if (nowMs - lastSimStatsMs < 5000) return;
    lastSimStatsMs = nowMs;
    const target = sim.cascades[0].displacement;
    renderer.readRenderTargetPixelsAsync(target, 0, 0, sim.N, sim.N)
      .then(data => {
        const toFloat = data instanceof Uint16Array ? decodeHalf : (v => v);
        let sumH2 = 0, sumDx2 = 0, maxAbsH = 0, count = 0;
        for (let i = 0; i < data.length; i += 16) {
          const dx = toFloat(data[i]);
          const heightSample = toFloat(data[i + 1]);
          sumH2 += heightSample * heightSample;
          sumDx2 += dx * dx;
          maxAbsH = Math.max(maxAbsH, Math.abs(heightSample));
          count += 1;
        }
        log('water.sim.displacement', {
          rmsH: Number(Math.sqrt(sumH2 / count).toFixed(3)),
          maxH: Number(maxAbsH.toFixed(3)),
          rmsDx: Number(Math.sqrt(sumDx2 / count).toFixed(3)),
          hs: Number(sim.significantWaveHeight.toFixed(2)),
        });
      })
      .catch(error => {
        log('water.sim.displacement.error', {
          message: error?.message ?? String(error),
        });
      });
  }

  // WebGPU-port diagnostic: read the capture back and log channel stats so
  // gate/fetch/veil misbehaviour can be diagnosed from the client log ring
  // instead of theorized about. Fire-and-forget; ~8 MB readback per capture
  // (>= 15 s apart) while the port is being validated.
  let lastCapturePixelsMs = -Infinity;
  function logCapturePixels() {
    if (!log) return;
    // Captures can fire every ~2 s while textures stream; keep the 8 MB
    // diagnostic readback an order of magnitude rarer than that.
    const nowMs = performance.now();
    if (nowMs - lastCapturePixelsMs < 20000) return;
    lastCapturePixelsMs = nowMs;
    renderer.readRenderTargetPixelsAsync(bathyTarget, 0, 0, bathySize, bathySize)
      .then(data => {
        const toFloat = data instanceof Uint16Array ? decodeHalf : (v => v);
        let sampled = 0, covered = 0, water = 0, land = 0, texturedWater = 0;
        const rCovered = [];
        const gTexturedWater = [];
        for (let y = 0; y < bathySize; y += 4) {
          for (let x = 0; x < bathySize; x += 4) {
            const i = (y * bathySize + x) * 4;
            const r = toFloat(data[i]);
            const g = toFloat(data[i + 1]);
            const b = toFloat(data[i + 2]);
            const a = toFloat(data[i + 3]);
            sampled += 1;
            if (a <= 0.5) continue;
            covered += 1;
            rCovered.push(r);
            if (r < -1) {
              water += 1;
              if (b > 0.5) {
                texturedWater += 1;
                gTexturedWater.push(g);
              }
            } else if (r > -0.5) {
              land += 1;
            }
          }
        }
        rCovered.sort((p, q) => p - q);
        gTexturedWater.sort((p, q) => p - q);
        const round = (v, digits) => (v == null ? null : Number(v.toFixed(digits)));
        log('water.bathymetry.capture.pixels', {
          sampled, covered, water, land, texturedWater,
          rP05: round(percentile(rCovered, 0.05), 2),
          rP50: round(percentile(rCovered, 0.50), 2),
          rP95: round(percentile(rCovered, 0.95), 2),
          gP05: round(percentile(gTexturedWater, 0.05), 5),
          gP50: round(percentile(gTexturedWater, 0.50), 5),
          gP95: round(percentile(gTexturedWater, 0.95), 5),
        });
      })
      .catch(error => {
        log('water.bathymetry.capture.pixels.error', {
          message: error?.message ?? String(error),
        });
      });
  }

  function bindSimTextures() {
    const c0 = sim.getCascadeTextures(0);
    const c1 = sim.getCascadeTextures(1);
    const c2 = sim.getCascadeTextures(2);
    texDisp[0].value = c0.displacement;
    texDisp[1].value = c1.displacement;
    texDisp[2].value = c2.displacement;
    texDeriv[0].value = c0.derivatives;
    texDeriv[1].value = c1.derivatives;
    texDeriv[2].value = c2.derivatives;
    uL.value.set(c0.size, c1.size, c2.size);
  }

  return {
    mesh,

    setWind({ speed, directionRad, amplitude, alignment, seed, fetchKm }) {
      sim.setWind({ speed, directionRad, amplitude, alignment, seed, fetchKm });
      uWindDir.value.set(Math.sin(directionRad), Math.cos(directionRad));
      uWindFactor.value = Math.min(Math.max(speed / 25, 0), 1);
      uHs.value = sim.significantWaveHeight;
    },

    update({ simTime, dt, meshOffset, cameraLocal, sunLocal, palette, params, simParams }) {
      sim.update(simTime, dt, simParams);
      bindSimTextures();
      logSimStats();
      uTime.value = simTime;
      uMeshOffset.value.copy(meshOffset);
      uCameraLocal.value.copy(cameraLocal);
      uSunDir.value.copy(sunLocal);
      uSunColor.value.copy(palette.sun);
      uZenithColor.value.copy(palette.zenith);
      uHorizonColor.value.copy(palette.horizon);
      uHorizonCool.value.copy(palette.horizonCool);
      uDeepColor.value.copy(palette.deep);
      uScatterColor.value.copy(palette.scatter);
      uCloud.value = params.cloudiness;
      uRadiance.value = params.radiance * radianceScale;
      uOpacity.value = params.opacity;
      uReflect.value = params.reflectivity;
      uGlintStrength.value = Math.max(0, params.glintStrength ?? 1);
      uAbsorb.value = params.absorption;
      uFetchRamp.value = Math.max(0, params.shoreFetchRamp ?? 3000);
      uNorthCliffReflectionPadding.value = Math.max(
        0,
        params.northCliffReflectionPadding ?? 0,
      );
    },

    captureBathymetry({ scene, terrainRoot, centerXY }) {
      if (bathyCamera.parent !== terrainRoot) terrainRoot.add(bathyCamera);
      bathyCamera.position.set(centerXY.x, centerXY.y, BATHY_CAM_H);

      const prevOverride = scene.overrideMaterial;
      const prevBackground = scene.background;
      const prevBackgroundNode = scene.backgroundNode;
      const prevVisible = mesh.visible;
      const prevSortObjects = renderer.sortObjects;
      const restoreTerrainTiles = prepareBathymetryTerrainTiles(
        terrainRoot, { dummyMap, fallbackColor },
      );
      const stats = { tiles: 0, textured: 0, untexturedIds: [] };
      for (const tile of terrainRoot.children) {
        if (!tile.isMesh || !/^\d+-\d+-\d+$/.test(tile.userData?.tileId ?? '')) continue;
        stats.tiles += 1;
        if (tile.material?.map) stats.textured += 1;
        else if (stats.untexturedIds.length < 16) stats.untexturedIds.push(tile.userData.tileId);
      }
      bathyRendererState = RendererUtils.resetRendererState(renderer, bathyRendererState);
      scene.overrideMaterial = bathyMaterial;
      scene.background = null;
      scene.backgroundNode = null;
      mesh.visible = false;
      renderer.sortObjects = true;
      try {
        renderer.setClearColor(0x000000, 0);
        renderer.setRenderTarget(bathyTarget);
        renderer.render(scene, bathyCamera);
      } finally {
        RendererUtils.restoreRendererState(renderer, bathyRendererState);
        scene.overrideMaterial = prevOverride;
        scene.background = prevBackground;
        scene.backgroundNode = prevBackgroundNode;
        mesh.visible = prevVisible;
        renderer.sortObjects = prevSortObjects;
        restoreTerrainTiles();
      }
      uBathyCenter.value.set(centerXY.x, centerXY.y);
      uBathyExtent.value = bathyExtent;
      logCapturePixels();
      return stats;
    },

    get bathyExtent() { return bathyExtent; },

    setDebugMode(mode) { uDebugMode.value = Number(mode) || 0; },

    dispose() {
      bathyCamera.parent?.remove(bathyCamera);
      bathyTarget.dispose();
      bathyMaterial.dispose();
      dummyMap.dispose();
      placeholder.dispose();
      sim.dispose();
      material.dispose();
      geometry.dispose();
    },
  };
}
