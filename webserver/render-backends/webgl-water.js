import * as THREE from 'three';
import { WebGLWaterSimulation } from './webgl-water-sim.js';

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
//     the post passes is the seabed, 10 m below the surface — negligible.

const SKY_GLSL = /* glsl */ `
  vec3 skyColor(vec3 dir, vec3 sunDir, vec3 horizonWarm, vec3 horizonCool, vec3 zenithCol, vec3 sunCol, float cloud) {
    float t = clamp(dir.z, 0.0, 1.0);
    // warm horizon only near the sun's azimuth; the opposite sky stays cool
    vec2 dh = normalize(dir.xy + vec2(1e-5, 0.0));
    vec2 sh = normalize(sunDir.xy + vec2(1e-5, 0.0));
    float az = 0.5 + 0.5 * dot(dh, sh);
    vec3 horizonCol = mix(horizonCool, horizonWarm, az * az);
    vec3 col = mix(horizonCol, zenithCol, pow(t, 0.48));
    float sd = max(dot(dir, sunDir), 0.0);
    // sun disk + circumsolar haze; cloud diffuses the disk away
    col += sunCol * ((pow(sd, 1500.0) * 55.0 + pow(sd, 18.0) * 0.10) * (1.0 - cloud)
                     + pow(sd, 3.0) * 0.035);
    return col;
  }
`;

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

  ${DETILE_GLSL}

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
  uniform vec3 uSunColor;
  uniform vec3 uZenithColor;
  uniform vec3 uHorizonColor;
  uniform vec3 uHorizonCool;
  uniform vec3 uDeepColor;
  uniform vec3 uScatterColor;
  uniform vec2 uWindDir;       // local xy, direction the wind blows toward
  uniform float uWindFactor;
  uniform float uHs;
  uniform float uCloud;
  uniform float uRadiance;     // overall output gain: calibrates the ocean2
                               // palette against this pipeline's AGX exposure
  uniform float uOpacity;      // base veil opacity of the surface body
  uniform float uReflect;      // sky-reflection gain (fjord walls occlude sky)
  uniform sampler2D uBathy;    // top-down terrain-height capture (R = local z)
  uniform vec2 uBathyCenter;
  uniform float uBathyExtent;
  uniform float uAbsorb;       // Beer-Lambert absorption, 1/m of water column

  varying vec3 vPlanePos;
  varying float vHeight;
  varying float vDist;

  ${SKY_GLSL}
  ${DETILE_GLSL}

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
    // The surface sits at local z = 0, so column depth is just -seabed. Where
    // the capture has no coverage yet, assume the open fjord floor (-10 m).
    vec2 bUV = (pxy - uBathyCenter) / uBathyExtent + 0.5;
    float inB = step(abs(bUV.x - 0.5), 0.5) * step(abs(bUV.y - 0.5), 0.5);
    vec4 bathy = texture2D(uBathy, bUV);
    float seabed = mix(-10.0, bathy.x, bathy.a * inB);
    float colDepth = clamp(-seabed, 0.0, 60.0);

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

    // micro-ripple detail for near-field sparkle; its slope energy migrates
    // into roughness as it fades with distance
    float microFade = 1.0 / (1.0 + d * 0.02);
    float microAmp = 0.35 * uWindFactor * microFade;
    if (microAmp > 0.003) {
      vec2 mp = pxy * 2.3 - uWindDir * uTime * 1.5;
      float e = 0.25;
      float m0 = fbm(mp);
      slope += vec2(fbm(mp + vec2(e, 0.0)) - m0, fbm(mp + vec2(0.0, e)) - m0) / e * microAmp;
    }
    slopeVar += 0.5 * (0.35 * uWindFactor) * (0.35 * uWindFactor) * (1.0 - microFade);

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
    float fresnel = 0.022 + 0.978 * pow(1.0 - NdotV, 5.0);

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
    vec3 skyRefl = skyColor(Rr, L, uHorizonColor, uHorizonCool, uZenithColor, uSunColor * 0.4, uCloud);

    // sun glint (GGX lobe, HDR)
    vec3 H = normalize(L + V);
    float LdotH = max(dot(L, H), 0.0);
    float fresL = 0.022 + 0.978 * pow(1.0 - LdotH, 5.0);
    vec3 spec = uSunColor * ggxAniso(H, N, Twind, Bwind, max(sqrt(ax2), 0.002), max(sqrt(ay2), 0.002))
              * fresL * 0.10 * smoothstep(0.0, 0.06, L.z);

    float backlight = pow(clamp(dot(L, -V) * 0.5 + 0.5, 0.0, 1.0), 3.0);
    vec3 ambient = mix(uHorizonCool, uZenithColor, 0.4) * 0.65;
    vec3 bodyCol = uDeepColor * ambient * 4.0;

    // facet lighting from the SWELL slope (cascades 0+1, chop excluded):
    // sunward ridge faces brighten, leeward faces darken. Using the full
    // normal here let metre-scale chop bury the dominant ridge trains.
    vec2 swellSlope = (D0.xy + D1.xy * f1 * 0.5) * facetGain;
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

    // Beer-Lambert veil from the water column (Water-Pro-style shoreline
    // treatment, world-space): shallow shore water stays glass-clear so the
    // imagery shows, while the artificial mask-drop walls fade out with
    // depth instead of standing naked behind a transparent surface.
    float veil = 1.0 - exp(-uAbsorb * colDepth);
    float bodyW = uOpacity + veil * (1.0 - uOpacity);

    // Reflection gain < 1 stands in for the sky occlusion the analytic dome
    // cannot know about: shadowed fjord walls reflect rock, not bright sky.
    float refl = fresnel * uReflect;
    float a = bodyW + refl * (1.0 - bodyW);
    vec3 accum = body * bodyW + skyRefl * refl;

    // sun glint: pure added light
    accum += spec;

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
    uBathy: { value: null },
    uBathyCenter: { value: new THREE.Vector2() },
    uBathyExtent: { value: bathyExtent },
    uAbsorb: { value: 0.05 },
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
  // Height override: the capture camera is a terrainRoot child looking down
  // -z, so view z recovers local height as uCamH + mvPosition.z regardless
  // of the ECEF model transforms.
  const bathyMaterial = new THREE.ShaderMaterial({
    uniforms: { uCamH: { value: BATHY_CAM_H } },
    vertexShader: /* glsl */ `
      varying float vZ;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vZ = mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vZ;
      uniform float uCamH;
      void main() { gl_FragColor = vec4(uCamH + vZ, 0.0, 0.0, 1.0); }
    `,
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
      uniforms.uAbsorb.value = params.absorption;
    },

    captureBathymetry({ scene, terrainRoot, centerXY }) {
      if (bathyCamera.parent !== terrainRoot) terrainRoot.add(bathyCamera);
      bathyCamera.position.set(centerXY.x, centerXY.y, BATHY_CAM_H);

      const prevTarget = renderer.getRenderTarget();
      const prevOverride = scene.overrideMaterial;
      const prevBackground = scene.background;
      const prevAlpha = renderer.getClearAlpha();
      renderer.getClearColor(prevClearColor);
      const prevVisible = mesh.visible;
      scene.overrideMaterial = bathyMaterial;
      scene.background = null;
      mesh.visible = false;
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
      }
      uniforms.uBathyCenter.value.set(centerXY.x, centerXY.y);
      uniforms.uBathyExtent.value = bathyExtent;
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
