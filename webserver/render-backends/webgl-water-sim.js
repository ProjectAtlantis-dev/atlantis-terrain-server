import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import {
  DEFAULT_CASCADES,
  buildButterflyData,
  buildInitialSpectra,
} from '../water/water-spectrum.js';

// ---------------------------------------------------------------------------
// GPU FFT water simulation (Tessendorf), multi-cascade. WebGL/GLSL port of
// ~/work/ocean2 sim.js; the CPU math (butterfly + initial spectra) lives in
// water/water-spectrum.js so a WGSL port shares it.
//
// Per cascade, per frame:
//   1. evolve: time-evolve the initial spectrum h0(k) and pack 8 real fields
//      (h, Dx, Dz, dh/dx, dh/dz, dDx/dx, dDz/dz, dDx/dz) into 4 complex
//      signals across two RGBA targets (Hermitian packing trick).
//   2. IFFT: 2 ping-pong butterfly chains (horizontal + vertical stages).
//   3. assembly: write displacement map (Dx*λ, h, Dz*λ) and derivatives map
//      (dh/dx, dh/dz, Jacobian) with the (-1)^(x+y) shift correction.
// ---------------------------------------------------------------------------

const GRAVITY = 9.81;

const COMPLEX_GLSL = /* glsl */ `
  vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
`;

const EVOLVE_SHADER = /* glsl */ `
  uniform sampler2D uH0;
  uniform float uTime;
  uniform float uN;
  uniform float uL;
  uniform int uMode;   // 0 -> (c0 = h + i*Dx, c1 = Dz + i*dh/dx)
                       // 1 -> (c2 = dh/dz + i*dDx/dx, c3 = dDz/dz + i*dDx/dz)
  ${COMPLEX_GLSL}

  void main() {
    vec2 coord = floor(gl_FragCoord.xy);
    vec2 k = 6.28318530718 * (coord - uN * 0.5) / uL;
    float kl = max(length(k), 1e-6);

    vec4 h0 = texture2D(uH0, (coord + 0.5) / uN);
    float w = sqrt(${GRAVITY.toFixed(3)} * kl);
    // e^{-iwt}: with the inverse FFT's e^{+ik.x} convention this makes each
    // component e^{i(k.x - wt)}, i.e. crests travel toward +k — the +wind
    // direction the spectrum aligns energy with. The +iwt sign propagated
    // the swell AGAINST uWindDir, contradicting the micro-ripple advection,
    // the lee-shore fetch march, and the wind-direction slider semantics.
    vec2 e = vec2(cos(w * uTime), -sin(w * uTime));

    // h(k,t) = h0(k) e^{-iwt} + h0*(-k) e^{+iwt}
    vec2 h = cmul(h0.xy, e) + cmul(vec2(h0.z, -h0.w), vec2(e.x, -e.y));

    vec2 cA, cB;
    if (uMode == 0) {
      cA = (1.0 + k.x / kl) * h;                       // h + i*Dx
      cB = cmul(vec2(-k.x, -k.y / kl), h);             // Dz + i*dh/dx
    } else {
      cA = cmul(vec2(0.0, k.y + k.x * k.x / kl), h);   // dh/dz + i*dDx/dx
      cB = cmul(vec2(k.y * k.y / kl, k.x * k.y / kl), h); // dDz/dz + i*dDx/dz
    }
    gl_FragColor = vec4(cA, cB);
  }
`;

const BUTTERFLY_SHADER = /* glsl */ `
  uniform sampler2D uButterfly; // x: stage, y: index -> (twiddle.re, twiddle.im, idxA, idxB)
  uniform sampler2D uInput;
  uniform float uN;
  uniform float uStages;
  uniform float uStage;
  uniform int uVertical;

  ${COMPLEX_GLSL}

  void main() {
    vec2 coord = floor(gl_FragCoord.xy);
    float pos = uVertical == 1 ? coord.y : coord.x;
    vec4 b = texture2D(uButterfly, vec2((uStage + 0.5) / uStages, (pos + 0.5) / uN));
    vec2 tw = b.xy;

    vec2 uvA, uvB;
    if (uVertical == 1) {
      uvA = vec2(coord.x + 0.5, b.z + 0.5) / uN;
      uvB = vec2(coord.x + 0.5, b.w + 0.5) / uN;
    } else {
      uvA = vec2(b.z + 0.5, coord.y + 0.5) / uN;
      uvB = vec2(b.w + 0.5, coord.y + 0.5) / uN;
    }
    vec4 A = texture2D(uInput, uvA);
    vec4 B = texture2D(uInput, uvB);

    gl_FragColor = vec4(A.xy + cmul(tw, B.xy), A.zw + cmul(tw, B.zw));
  }
`;

const DISPLACEMENT_SHADER = /* glsl */ `
  uniform sampler2D uT0;
  uniform float uN;
  uniform float uLambda;

  void main() {
    vec2 coord = floor(gl_FragCoord.xy);
    float sgn = mod(coord.x + coord.y, 2.0) < 0.5 ? 1.0 : -1.0;
    vec4 t0 = texture2D(uT0, (coord + 0.5) / uN) * sgn;
    // t0 = (h, Dx, Dz, dh/dx). Negative lambda: the empirical fold test
    // shows this FFT convention needs the flip so horizontal displacement
    // converges water onto crests (sharp peaks, J<1 at crests) rather than
    // into troughs (rounded mounds, J<1 in troughs).
    gl_FragColor = vec4(-uLambda * t0.y, t0.x, -uLambda * t0.z, 1.0);
  }
`;

const DERIVATIVES_SHADER = /* glsl */ `
  uniform sampler2D uT0;
  uniform sampler2D uT1;
  uniform float uN;
  uniform float uLambda;

  void main() {
    vec2 coord = floor(gl_FragCoord.xy);
    float sgn = mod(coord.x + coord.y, 2.0) < 0.5 ? 1.0 : -1.0;
    vec2 uv = (coord + 0.5) / uN;
    vec4 t0 = texture2D(uT0, uv) * sgn;
    vec4 t1 = texture2D(uT1, uv) * sgn;
    float dhdx = t0.w, dhdz = t1.x, dDxdx = t1.y, dDzdz = t1.z, dDxdz = t1.w;
    // same -lambda as the displacement pass (cross term is sign-invariant)
    float J = (1.0 - uLambda * dDxdx) * (1.0 - uLambda * dDzdz)
            - uLambda * uLambda * dDxdz * dDxdz;
    // slopes of the DISPLACED surface: chop converges geometry at crests, so
    // true slopes steepen by the inverse of M = I + lambda*grad(D) (det = J).
    // Shading raw grad(h) instead lights the undisplaced Gaussian field —
    // smooth, blobby, 'perlin' — regardless of how sharp the geometry is.
    float Js = max(J, 0.50);
    float sx = ((1.0 - uLambda * dDzdz) * dhdx + uLambda * dDxdz * dhdz) / Js;
    float sz = (uLambda * dDxdz * dhdx + (1.0 - uLambda * dDxdx) * dhdz) / Js;
    // .w carries E[|slope|^2]: under mip filtering this stays put while .xy
    // averages toward 0, so the shader can recover the slope variance lost
    // to filtering and turn it into specular roughness (LEAN/Toksvig).
    gl_FragColor = vec4(sx, sz, J, sx * sx + sz * sz);
  }
`;

// (A whitecap/foam accumulation pass lived here — Jacobian-injected plume +
// persistence + age channels. Removed at the user's request: every foam
// presentation read as garbage from altitude. The Jacobian in the
// derivatives pass survives untouched for any future attempt.)

// three.js caches the uniform list per program, so every uniform must exist
// before first render and only its .value may be mutated afterwards.
function makeSimMaterial(fragmentShader, uniformNames) {
  const uniforms = {};
  for (const name of uniformNames) uniforms[name] = { value: null };
  return new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
  });
}

function computeRT(n, opts = {}) {
  const rt = new THREE.WebGLRenderTarget(n, n, {
    format: THREE.RGBAFormat,
    type: opts.type ?? THREE.FloatType,
    magFilter: opts.filter ?? THREE.NearestFilter,
    minFilter: opts.mips ? THREE.LinearMipmapLinearFilter : (opts.filter ?? THREE.NearestFilter),
    generateMipmaps: !!opts.mips,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
  // the surface is viewed at grazing angles from altitude; without aniso the
  // sampler mips for the footprint's long axis and smears all crest detail
  if (opts.mips) rt.texture.anisotropy = 8;
  return rt;
}

export class WebGLWaterSimulation {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {{resolution?: number, cascades?: {size:number, minWave:number, maxWave:number}[]}} opts
   */
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.N = opts.resolution ?? 256;

    this.cascadeDefs = opts.cascades ?? DEFAULT_CASCADES;

    this.quad = new FullScreenQuad(null);
    const butterfly = buildButterflyData(this.N);
    this.stages = butterfly.stages;
    this.butterfly = new THREE.DataTexture(
      butterfly.data, butterfly.stages, this.N, THREE.RGBAFormat, THREE.FloatType,
    );
    this.butterfly.magFilter = this.butterfly.minFilter = THREE.NearestFilter;
    this.butterfly.needsUpdate = true;

    this.matEvolve = makeSimMaterial(EVOLVE_SHADER, ['uH0', 'uTime', 'uN', 'uL', 'uMode']);
    this.matButterfly = makeSimMaterial(BUTTERFLY_SHADER, ['uButterfly', 'uInput', 'uN', 'uStages', 'uStage', 'uVertical']);
    this.matDisp = makeSimMaterial(DISPLACEMENT_SHADER, ['uT0', 'uN', 'uLambda']);
    this.matDeriv = makeSimMaterial(DERIVATIVES_SHADER, ['uT0', 'uT1', 'uN', 'uLambda']);

    const N = this.N;
    this.cascades = this.cascadeDefs.map(def => ({
      def,
      h0: null,                                   // DataTexture, rebuilt on wind change
      evolve0: computeRT(N),
      evolve1: computeRT(N),
      ping: [computeRT(N), computeRT(N), computeRT(N), computeRT(N)],
      displacement: computeRT(N, { type: THREE.HalfFloatType, filter: THREE.LinearFilter, mips: true }),
      derivatives: computeRT(N, { type: THREE.HalfFloatType, filter: THREE.LinearFilter, mips: true }),
    }));

    this.significantWaveHeight = 1;
  }

  setWind({ speed, directionRad, amplitude = 1, alignment = 1, seed = 1, fetchKm }) {
    const { spectra, significantWaveHeight } = buildInitialSpectra({
      resolution: this.N,
      cascades: this.cascadeDefs,
      speed, directionRad, amplitude, alignment, seed, fetchKm,
    });
    this.significantWaveHeight = significantWaveHeight;

    this.cascades.forEach((c, i) => {
      if (c.h0) c.h0.dispose();
      c.h0 = new THREE.DataTexture(spectra[i], this.N, this.N, THREE.RGBAFormat, THREE.FloatType);
      c.h0.magFilter = c.h0.minFilter = THREE.NearestFilter;
      c.h0.needsUpdate = true;
    });
  }

  runPass(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.quad.render(this.renderer);
  }

  ifft(srcRT, pingA, pingB) {
    const u = this.matButterfly.uniforms;
    u.uButterfly.value = this.butterfly;
    u.uN.value = this.N;
    u.uStages.value = this.stages;
    let input = srcRT;
    const outs = [pingA, pingB];
    let oi = 0;
    for (let dir = 0; dir < 2; dir++) {
      for (let s = 0; s < this.stages; s++) {
        u.uInput.value = input.texture;
        u.uStage.value = s;
        u.uVertical.value = dir;
        this.runPass(this.matButterfly, outs[oi]);
        input = outs[oi];
        oi ^= 1;
      }
    }
    return input;
  }

  update(time, dt, { choppiness = 1.1 } = {}) {
    const prevRT = this.renderer.getRenderTarget();

    for (const c of this.cascades) {
      if (!c.h0) continue;

      // 1. spectrum evolution (two packings)
      const me = this.matEvolve.uniforms;
      me.uH0.value = c.h0;
      me.uTime.value = time;
      me.uN.value = this.N;
      me.uL.value = c.def.size;
      me.uMode.value = 0;
      this.runPass(this.matEvolve, c.evolve0);
      me.uMode.value = 1;
      this.runPass(this.matEvolve, c.evolve1);

      // 2. inverse FFTs
      const t0 = this.ifft(c.evolve0, c.ping[0], c.ping[1]);
      const t1 = this.ifft(c.evolve1, c.ping[2], c.ping[3]);

      // 3. assemble displacement + derivatives/Jacobian
      const md = this.matDisp.uniforms;
      md.uT0.value = t0.texture;
      md.uN.value = this.N;
      md.uLambda.value = choppiness;
      this.runPass(this.matDisp, c.displacement);

      const mv = this.matDeriv.uniforms;
      mv.uT0.value = t0.texture;
      mv.uT1.value = t1.texture;
      mv.uN.value = this.N;
      mv.uLambda.value = choppiness;
      this.runPass(this.matDeriv, c.derivatives);
    }

    this.renderer.setRenderTarget(prevRT);
  }

  getCascadeTextures(i) {
    const c = this.cascades[i];
    return {
      size: c.def.size,
      displacement: c.displacement.texture,
      derivatives: c.derivatives.texture,
    };
  }

  dispose() {
    for (const c of this.cascades) {
      c.h0?.dispose();
      c.evolve0.dispose(); c.evolve1.dispose();
      c.ping.forEach(p => p.dispose());
      c.displacement.dispose(); c.derivatives.dispose();
    }
    this.butterfly.dispose();
    this.quad.dispose();
    [this.matEvolve, this.matButterfly, this.matDisp, this.matDeriv]
      .forEach(m => m.dispose());
  }
}
