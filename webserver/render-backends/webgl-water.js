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
//     free, with veil/reflection/glint/foam composited on top. Depth read by
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
  uniform float uPlumeLife;
  uniform float uFoamFade;     // foam-raft fade e-folding time, seconds
  uniform float uRadiance;     // overall output gain: calibrates the ocean2
                               // palette against this pipeline's AGX exposure
  uniform float uOpacity;      // base veil opacity of the surface body
  uniform float uReflect;      // sky-reflection gain (fjord walls occlude sky)

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

    // foam buffers: .x = plume energy (bright core, seconds), .y = foam
    // coverage (lingering raft, fades on uFoamFade), .z = age clock.
    // Cascade 0 owns the 55 m+ waves, whose folds paint caps tens of metres
    // across — down-weighted so cap size is set by the chop-scale cascade.
    vec4 F0 = texture2D(uFoam0, pxy / uL.x);
    vec4 F1 = texture2D(uFoam1, pxy / uL.y);
    float acc = F0.x * 0.55 + F1.x * mix(f1, 1.0, 0.5);
    float cov = F0.y * 0.55 + F1.y * mix(f1, 1.0, 0.5);
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

    // existence rides on the SLOW coverage channel through a soft saturating
    // transfer — no clamp plateau. Patches keep interior gradients, and as
    // the raft decays over uFoamFade the whole level glides down, so foam
    // thins out gradually instead of collapsing through a threshold. inst
    // seeds a footprint the moment a crest breaks, before coverage builds.
    float foamRaw = (1.0 - exp(-(cov * sel * 2.0 + inst * 0.5))) * foamGate;

    // spume lines: organise foam into wind-aligned rows, but only once the
    // sea is rough enough for them to exist
    float streak = fbm(fw * vec2(0.22, 0.02));
    foamRaw *= mix(1.0, smoothstep(0.28, 0.62, streak), 0.75 * smoothstep(0.45, 1.0, uWindCoverage));

    // lacy edges: erode the foam patch with the breakup texture. The WIDE
    // smoothstep window is the anti-sharp-edge measure — coverage falls off
    // smoothly at patch rims and over time, and a wide window turns that
    // gradient into a long soft transition instead of a contour line.
    float foamMask = smoothstep(0.07, 0.92, foamRaw * (0.30 + 1.05 * ftex));
    foamMask = clamp(foamMask * (0.55 + 0.65 * ftex), 0.0, 1.0);

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
    // surface light except foam/glint must scale with uOpacity: the fjord
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

    // Reflection gain < 1 stands in for the sky occlusion the analytic dome
    // cannot know about: shadowed fjord walls reflect rock, not bright sky.
    float refl = fresnel * uReflect;
    float a = uOpacity + refl * (1.0 - uOpacity);
    vec3 accum = body * uOpacity + skyRefl * refl;

    // sun glint: pure added light
    accum += spec * (1.0 - foamMask);

    // foam shading: diffuse, slightly shadowed in its own troughs. Only the
    // actively-breaking core is near-white; aged trails and spume streaks are
    // bubbles dispersed into the water column, so they dim and take its tint.
    float capShade = 0.72 + 0.40 * fbm(pxy * 0.05 + vec2(17.3, 5.9));
    vec3 foamCol = vec3(0.74, 0.78, 0.82) * (0.50 + 0.45 * ftex) * capShade;
    // under cloud the dome is the light source; foam's high albedo keeps it
    // bright against the darkened water
    foamCol *= uSunColor * 0.30 * (0.45 + 0.55 * NdotL) + ambient * (0.9 + 1.1 * uCloud);

    // lifecycle: the truly-white core lives on the fast plume clock and a
    // TIGHT threshold — a fleck at the break point, not the whole patch.
    // The surrounding raft grays and dims on the slow foam clock, and its
    // spatial existence fades with the coverage channel above, so there is
    // no timer that cuts foam off — it just gets thinner, grayer, lacier.
    float ageW = exp(-capAge / max(uPlumeLife, 0.1));
    float ageG = exp(-capAge / max(uFoamFade, 1.0));
    float whiteAmt = clamp(ageW * smoothstep(0.30, 0.80, (acc + inst * 0.8) * (0.4 + 1.0 * ftex)) + inst * 0.4, 0.0, 1.0);
    // gray tone itself dims continuously as the bubble raft thins
    vec3 grayCol = (foamCol * 0.50 + bodyCol * 0.40) * (0.45 + 0.55 * ageG);
    vec3 stageCol = mix(grayCol, foamCol, whiteAmt);
    // aged foam keeps a floor weight — the mask thinning is the fade-out,
    // not an age gate; foam covers the imagery, so it composites over
    float foamW = foamMask * (0.40 + 0.60 * max(ageG, whiteAmt));
    accum = accum * (1.0 - foamW) + stageCol * foamW;
    a = mix(a, 0.95, foamW);

    // no in-shader haze: scene fog + the aerial perspective pass own that
    gl_FragColor = vec4(accum * uRadiance, clamp(a, 0.0, 1.0));
    #include <fog_fragment>
  }
`;

export function createWebGLWater({
  renderer,
  geometry,
  resolution = 256,
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
    uPlumeLife: { value: 7 },
    uFoamFade: { value: 60 },
    uRadiance: { value: 1 },
    uOpacity: { value: 0 },
    uReflect: { value: 0.4 },
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

    setWind({ speed, directionRad, amplitude, alignment, seed, fetchKm, windCoverage }) {
      sim.setWind({ speed, directionRad, amplitude, alignment, seed, fetchKm });
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
      uniforms.uPlumeLife.value = params.plumeLife;
      uniforms.uFoamFade.value = params.foamFadeLife;
      uniforms.uRadiance.value = params.radiance;
      uniforms.uOpacity.value = params.opacity;
      uniforms.uReflect.value = params.reflectivity;
    },

    dispose() {
      sim.dispose();
      material.dispose();
      geometry.dispose();
    },
  };
}
