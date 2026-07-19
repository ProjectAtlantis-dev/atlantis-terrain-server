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
//   - Opaque + depth write + logarithmic depth, so the dropped seabed is
//     occluded and the post passes treat water like any other surface.
//   - Water colour inherits from the satellite imagery painted on the seabed
//     (blue coastal water -> milky teal toward the glacier outflows): a
//     periodic top-down ortho capture of the loaded terrain becomes a colour
//     map that reskins uDeepColor/uScatterColor per-location, falling back to
//     the palette defaults where nothing is loaded.

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

  void main() {
    vec2 gridXY = position.xy + uMeshOffset;
    float d0 = distance(uCameraLocal, vec3(gridXY, 0.0));

    // cascade blend: fine cascades only contribute geometry near the camera
    float f1 = 1.0 / (1.0 + d0 / 3000.0);
    float f2 = 1.0 / (1.0 + d0 / 420.0);

    // sim textures are (Dx, h, Dz): sim x/z horizontal -> local x/y, h -> z
    vec3 disp = texture2D(uDisp0, gridXY / uL.x).xyz;
    disp += texture2D(uDisp1, gridXY / uL.y).xyz * f1;
    disp += texture2D(uDisp2, gridXY / uL.z).xyz * f2;

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
  uniform sampler2D uFoam0;
  uniform sampler2D uFoam1;
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
  uniform float uWindCoverage;
  uniform float uWindFactor;
  uniform float uFoamAmount;
  uniform float uHs;
  uniform float uCloud;
  uniform float uGhost;
  uniform float uPlumeLife;
  uniform float uResidueLife;
  uniform float uRadiance;     // overall output gain: calibrates the ocean2
                               // palette against this pipeline's AGX exposure
  uniform sampler2D uColorMap; // top-down capture of loaded terrain textures
  uniform vec2 uColorMapCenter;
  uniform float uColorMapExtent;
  uniform float uTintStrength;
  uniform float uTintDeepGain;
  uniform float uTintScatterGain;

  varying vec3 vPlanePos;
  varying float vHeight;
  varying float vDist;

  ${SKY_GLSL}

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

    // ---- normals & Jacobian from the cascades ----------------------------
    // -1 mip bias: pre-filtering slopes before (nonlinear) shading erases
    // crest facets a camera would keep; sample one level sharper and let the
    // recovered E[s^2]-|E[s]|^2 variance absorb what stays sub-pixel.
    vec4 D0 = texture2D(uDeriv0, pxy / uL.x, -0.5);
    vec4 D1 = texture2D(uDeriv1, pxy / uL.y, -0.5);
    vec4 D2 = texture2D(uDeriv2, pxy / uL.z, -0.5);

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

    // combined folding measure (deviations from 1 add across cascades)
    float J = D0.z + (D1.z - 1.0) * mix(f1, 1.0, 0.6) + (D2.z - 1.0) * f2 * 0.5;

    // ---- whitecaps --------------------------------------------------------
    float foamGate = smoothstep(0.015, 0.10, uWindCoverage * uFoamAmount);

    // swell-phase gating: chop breaks preferentially where the underlying
    // swell crest lifts it, which strings the caps into rows along crest
    // lines (orthogonal to wind) instead of scattering them uniformly
    float hN = clamp(vHeight / max(uHs * 0.5, 0.05), -1.0, 1.5);
    // breaking requires a computable wave face: the swell's downwind-facing
    // slope must exceed a steepness the wave cannot sustain. grad(h) points
    // uphill, so on the forward face -dot(slope, wind) is the face steepness.
    // Rolling hills (high but gentle) never cap; short steep seas do.
    vec2 swellS = D0.xy + D1.xy * 0.6;
    float faceSteep = max(-dot(swellS, uWindDir), 0.0);
    float breaking = smoothstep(0.045, 0.13, faceSteep);
    // elevation keeps caps near the crest top rather than mid-face
    float crestBand = mix(0.02, 1.0, smoothstep(0.10, 0.65, hN) * breaking);

    // the foam cascades tile every 840/160 m, which reads as a repeating cap
    // pattern from altitude. Non-repeating world-space noise (km-scale and
    // ~300 m scale) varies the gate per location, so each tile whitens a
    // different subset of its real folds instead of the same wallpaper.
    float patchK = fbm(pxy * 0.00071 + vec2(31.7, 11.3));
    float patchM = fbm(pxy * 0.0029 - vec2(7.3, 19.1));

    // two-stage foam buffers: .x = plume energy (whitecap), .y = residue
    vec4 F0 = texture2D(uFoam0, pxy / uL.x);
    vec4 F1 = texture2D(uFoam1, pxy / uL.y);
    float acc = F0.x + F1.x * mix(f1, 1.0, 0.5);
    float resid = F0.y + F1.y * mix(f1, 1.0, 0.5);
    // youngest contributing foam sets the patch's apparent age
    float capAge = min(F0.z, F1.z);
    // de-tiling selection, anisotropic in the wind frame: long correlation
    // along crest lines, short along wind, so surviving caps band
    // crest-parallel. The SAME factor must gate both the fresh break and its
    // accumulated trail — otherwise caps flash on and leave no trail behind.
    mat2 toWind = mat2(uWindDir.y, uWindDir.x, -uWindDir.x, uWindDir.y);
    vec2 cw = toWind * pxy;
    float capSel = fbm(vec2(cw.x * 0.004, cw.y * 0.016) + vec2(3.1, 27.9));
    // crestBand (breaking face + elevation) is the physical gate; the noise
    // terms only de-tile and vary density, so they must not stack another
    // deep cut on top of it
    float sel = mix(0.35, 1.15, smoothstep(0.26, 0.58, capSel)) * (0.65 + 0.7 * patchM) * crestBand;
    // age comes from the RAW buffer level — selection decides whether a cap
    // exists here, not how old it is. Folding sel into the age read made
    // every thinned cap render as dim aged foam.
    float accRaw = acc;
    acc *= sel;

    // instantaneous breaking on the crest itself.
    // J bottoms out around ~0.6-0.7 for a developed sea at any wind, so the
    // wind dependence lives in this threshold curve, not in J itself.
    float thr = mix(0.36, 0.80, pow(clamp(uWindCoverage * uFoamAmount, 0.0, 1.0), 0.55));
    thr += (patchK - 0.5) * 0.20;
    float inst = (1.0 - smoothstep(thr - 0.22, thr, J)) * sel;

    // streaky breakup texture, stretched and advected along the wind
    vec2 fw = cw;
    fw.y -= uTime * (0.6 + uWindFactor * 2.0);
    float ftex = fbm(fw * vec2(0.16, 0.05)) * 0.45
               + fbm(fw * vec2(0.85, 0.30)) * 0.35
               + fbm(fw * vec2(3.1, 1.6)) * 0.20;

    // cap existence rides on plume + residue: after the plume degasses
    // (seconds) the cap's ghost persists on the residue clock (minutes),
    // eroding away from its lacy edges instead of being erased on a timer
    float residCap = resid * sel;
    float foamRaw = clamp(acc * 2.2 + inst * 0.7 + residCap * uGhost, 0.0, 1.0) * foamGate;

    // spume lines: organise foam into wind-aligned rows, but only once the
    // sea is rough enough for them to exist
    float streak = fbm(fw * vec2(0.22, 0.02));
    foamRaw *= mix(1.0, smoothstep(0.28, 0.62, streak), 0.75 * smoothstep(0.45, 1.0, uWindCoverage));

    // lacy edges: erode the foam patch with the breakup texture. The high
    // threshold keeps only the core of each cap — from altitude a whitecap
    // is a fleck a few metres across, not the whole disturbed patch.
    float foamMask = smoothstep(0.24, 0.66, foamRaw * (0.3 + 1.15 * ftex));
    foamMask = clamp(foamMask * (0.7 + 0.55 * ftex), 0.0, 1.0);

    // ---- inherited water colour ------------------------------------------
    // The satellite imagery of the water (painted on the dropped seabed) is
    // the ground truth for local water colour: blue at the coast, milky teal
    // toward the glacier outflows. Sample the ortho capture where available;
    // its alpha is 0 wherever nothing was loaded, falling back to defaults.
    vec2 cmUV = (pxy - uColorMapCenter) / uColorMapExtent + 0.5;
    float inMap = step(abs(cmUV.x - 0.5), 0.5) * step(abs(cmUV.y - 0.5), 0.5);
    vec4 cm = texture2D(uColorMap, cmUV);
    float cmW = cm.a * inMap * uTintStrength;
    vec3 deepCol = mix(uDeepColor, cm.rgb * uTintDeepGain, cmW);
    vec3 scatCol = mix(uScatterColor, cm.rgb * uTintScatterGain, cmW);

    // ---- lighting ---------------------------------------------------------
    float NdotV = max(dot(Ns, V), 1e-3);
    float NdotL = max(dot(Ns, L), 0.0);
    float fresnel = 0.022 + 0.978 * pow(1.0 - NdotV, 5.0);

    vec3 R = reflect(-V, Ns);
    R.z = max(R.z, 0.018);
    // filtered specular: fold the sub-pixel slope variance into the GGX lobe
    float a2 = 0.0009 + 2.0 * slopeVar + 0.12 * foamMask;
    float rough = pow(min(a2, 1.0), 0.25);

    // Cox-Munk: mean-square slope along the wind exceeds cross-wind ~60/40,
    // so the filtered glitter lobe must be anisotropic in the wind frame or
    // wind direction becomes invisible at distance
    float ax2 = 0.0009 + 2.0 * slopeVar * 0.62 + 0.12 * foamMask;
    float ay2 = 0.0006 + 2.0 * slopeVar * 0.38 + 0.12 * foamMask;
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

    // upwelling water colour with crest subsurface scattering
    float backlight = pow(clamp(dot(L, -V) * 0.5 + 0.5, 0.0, 1.0), 3.0);
    vec3 ambient = mix(uHorizonCool, uZenithColor, 0.4) * 0.65;
    vec3 waterCol = deepCol * ambient * 4.0;
    // crest transmission is a close-range effect (thin backlit crests); from
    // altitude elevation must not modulate colour or swells read as pale
    // cloudy blobs under the surface
    float crestFade = 1.0 / (1.0 + d * 0.004);
    waterCol += scatCol * max(hN, 0.0) * (0.06 + 0.50 * backlight) * (0.35 + 0.65 * NdotL) * crestFade;
    waterCol += scatCol * uSunColor * 0.015 * NdotL;

    vec3 col = mix(waterCol, skyRefl, fresnel) + spec * (1.0 - foamMask);
    // facet lighting from the SWELL slope (cascades 0+1, chop excluded):
    // sunward ridge faces brighten, leeward faces darken. Using the full
    // normal here let metre-scale chop bury the dominant ridge trains —
    // the chop still shades through Fresnel and specular.
    vec2 swellSlope = (D0.xy + D1.xy * f1 * 0.5) * facetGain;
    vec3 Nsw = normalize(vec3(-swellSlope.x, -swellSlope.y, 1.0));
    float swellNdotL = max(dot(Nsw, L), 0.0);
    col *= 1.0 + 1.1 * (1.0 - 0.65 * uCloud) * (swellNdotL - max(L.z, 0.0));

    // foam shading: diffuse, slightly shadowed in its own troughs. Only the
    // actively-breaking core is near-white; aged trails and spume streaks are
    // bubbles dispersed into the water column, so they dim and take its tint.
    float capShade = 0.72 + 0.40 * fbm(pxy * 0.05 + vec2(17.3, 5.9));
    vec3 foamCol = vec3(0.74, 0.78, 0.82) * (0.50 + 0.45 * ftex) * capShade;
    // under cloud the dome is the light source; foam's high albedo keeps it
    // bright against the darkened water
    foamCol *= uSunColor * 0.30 * (0.45 + 0.55 * NdotL) + ambient * (0.9 + 1.1 * uCloud);

    // continuous lifecycle colour driven by the per-texel age clock — two
    // overlapping exponentials, so brightness glides white -> cream -> gray
    // -> residual with no plateaus and no sliding-timer pop
    vec3 residueLight = (uSunColor * 0.12 + ambient) * 0.32;
    float ageW = exp(-capAge / max(uPlumeLife, 0.1));
    float ageG = exp(-capAge / max(uResidueLife * 0.5, 1.0));
    float whiteAmt = clamp(ageW * smoothstep(0.10, 0.55, accRaw + inst * 0.8) + inst * 0.5, 0.0, 1.0);
    // gray tone itself dims continuously as the bubble raft thins
    vec3 grayCol = (foamCol * 0.50 + waterCol * 0.40) * (0.55 + 0.45 * ageG);
    vec3 stageCol = mix(grayCol, foamCol, whiteAmt);
    stageCol = mix(col * 0.80 + residueLight, stageCol, max(ageG, whiteAmt));
    // older rafts also thin out spatially, not just in tone
    col = mix(col, stageCol, foamMask * mix(0.45, 1.0, ageG));

    // bubble residue: pale streaky patches that persist for minutes, drift
    // downwind in the sim, and lighten the water rather than painting it
    // white. Langmuir windrows: residue collects in convergence lanes
    // parallel to the wind, which also breaks the foam tile repetition.
    float rsel = fbm(vec2(cw.x * 0.02, cw.y * 0.0035) + vec2(8.7, 41.2));
    float resTex = fbm(fw * vec2(0.045, 0.011));
    float resMask = smoothstep(0.20, 1.0, resid * mix(0.2, 1.3, smoothstep(0.28, 0.66, rsel)) * (0.45 + 0.95 * resTex))
                  * (1.0 - foamMask);
    col = mix(col, col * 0.72 + residueLight, resMask * 0.6 * foamGate);

    // no in-shader haze: scene fog + the aerial perspective pass own that
    gl_FragColor = vec4(col * uRadiance, 1.0);
    #include <fog_fragment>
  }
`;

export function createWebGLWater({
  renderer,
  geometry,
  resolution = 256,
  colorMapSize = 1024,
  colorMapExtent = 60000,
} = {}) {
  const sim = new WebGLWaterSimulation(renderer, { resolution });

  const uniforms = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    uTime: { value: 0 },
    uDisp0: { value: null }, uDisp1: { value: null }, uDisp2: { value: null },
    uDeriv0: { value: null }, uDeriv1: { value: null }, uDeriv2: { value: null },
    uFoam0: { value: null }, uFoam1: { value: null },
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
    uWindCoverage: { value: 0.5 },
    uWindFactor: { value: 0.5 },
    uFoamAmount: { value: 1 },
    uHs: { value: 2 },
    uCloud: { value: 0 },
    uGhost: { value: 2 },
    uPlumeLife: { value: 7 },
    uResidueLife: { value: 150 },
    uRadiance: { value: 1 },
    uColorMap: { value: null },
    uColorMapCenter: { value: new THREE.Vector2() },
    uColorMapExtent: { value: colorMapExtent },
    uTintStrength: { value: 0.85 },
    uTintDeepGain: { value: 0.5 },
    uTintScatterGain: { value: 2.2 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: WATER_VERTEX,
    fragmentShader: WATER_FRAGMENT,
    fog: true,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.visible = false;

  // Top-down colour capture of whatever terrain textures are streamed in.
  // Rendered into a half-float target (linear working space, no output
  // transform) with alpha 0 where nothing drew, so the surface shader can
  // fall back to palette colours. Mips + linear filtering do the blurring.
  const colorTarget = new THREE.WebGLRenderTarget(colorMapSize, colorMapSize, {
    type: THREE.HalfFloatType,
    magFilter: THREE.LinearFilter,
    minFilter: THREE.LinearMipmapLinearFilter,
    generateMipmaps: true,
    depthBuffer: true,
    stencilBuffer: false,
  });
  const captureCamera = new THREE.OrthographicCamera(
    -colorMapExtent / 2, colorMapExtent / 2,
    colorMapExtent / 2, -colorMapExtent / 2,
    1, 30000,
  );
  const prevClearColor = new THREE.Color();
  uniforms.uColorMap.value = colorTarget.texture;

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
    uniforms.uFoam0.value = c0.foam;
    uniforms.uFoam1.value = c1.foam;
    uniforms.uL.value.set(c0.size, c1.size, c2.size);
  }

  return {
    mesh,

    setWind({ speed, directionRad, amplitude, alignment, seed, windCoverage }) {
      sim.setWind({ speed, directionRad, amplitude, alignment, seed });
      uniforms.uWindDir.value.set(Math.sin(directionRad), Math.cos(directionRad));
      uniforms.uWindCoverage.value = windCoverage;
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
      uniforms.uFoamAmount.value = params.foamAmount;
      uniforms.uGhost.value = params.ghostStrength;
      uniforms.uPlumeLife.value = params.plumeLife;
      uniforms.uResidueLife.value = params.residueLife;
      uniforms.uRadiance.value = params.radiance;
      uniforms.uTintStrength.value = params.tintStrength;
    },

    captureColorMap({ scene, terrainRoot, centerXY }) {
      if (captureCamera.parent !== terrainRoot) terrainRoot.add(captureCamera);
      captureCamera.position.set(centerXY.x, centerXY.y, 10000);

      const prevTarget = renderer.getRenderTarget();
      const prevFog = scene.fog;
      const prevBackground = scene.background;
      const prevAlpha = renderer.getClearAlpha();
      renderer.getClearColor(prevClearColor);
      const prevVisible = mesh.visible;
      scene.fog = null;
      scene.background = null;
      mesh.visible = false;
      renderer.setClearColor(0x000000, 0);
      try {
        renderer.setRenderTarget(colorTarget);
        renderer.clear();
        renderer.render(scene, captureCamera);
      } finally {
        renderer.setRenderTarget(prevTarget);
        renderer.setClearColor(prevClearColor, prevAlpha);
        scene.fog = prevFog;
        scene.background = prevBackground;
        mesh.visible = prevVisible;
      }
      uniforms.uColorMapCenter.value.set(centerXY.x, centerXY.y);
      uniforms.uColorMapExtent.value = colorMapExtent;
    },

    get colorMapExtent() { return colorMapExtent; },

    dispose() {
      captureCamera.parent?.remove(captureCamera);
      colorTarget.dispose();
      sim.dispose();
      material.dispose();
      geometry.dispose();
    },
  };
}
