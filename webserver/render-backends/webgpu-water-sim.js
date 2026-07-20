import {
  DataTexture,
  FloatType,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  NearestFilter,
  RGBAFormat,
  RepeatWrapping,
} from 'three';
import { NodeMaterial, QuadMesh, RenderTarget, RendererUtils } from 'three/webgpu';
import { Fn, float, select, texture, uniform, uv, vec2, vec4 } from 'three/tsl';
import {
  DEFAULT_CASCADES,
  buildButterflyData,
  buildInitialSpectra,
} from '../water/water-spectrum.js';

// ---------------------------------------------------------------------------
// GPU FFT water simulation (Tessendorf), multi-cascade. TSL/WebGPU port of
// render-backends/webgl-water-sim.js — same pass structure, same shared CPU
// math (water/water-spectrum.js), same output texture contract, so the two
// backends' surfaces stay comparable pixel-for-pixel.
//
// Per cascade, per frame:
//   1. evolve: time-evolve the initial spectrum h0(k) and pack 8 real fields
//      (h, Dx, Dz, dh/dx, dh/dz, dDx/dx, dDz/dz, dDx/dz) into 4 complex
//      signals across two RGBA targets (Hermitian packing trick).
//   2. IFFT: 2 ping-pong butterfly chains (horizontal + vertical stages).
//   3. assembly: write displacement map (Dx*λ, h, Dz*λ) and derivatives map
//      (dh/dx, dh/dz, Jacobian) with the (-1)^(x+y) shift correction.
//
// Structural difference from the GLSL version: WebGPU pipelines want
// compile-time variants, not runtime int-uniform branches, so uMode/uVertical
// become separate materials (evolve0/evolve1, butterflyH/butterflyV).
// Ping-pong inputs are swapped through TextureNode.value — the same pattern
// three's own feedback nodes (AfterImageNode) use.
// ---------------------------------------------------------------------------

const GRAVITY = 9.81;
const TWO_PI = 6.28318530718;

const cmul = /*@__PURE__*/ Fn(([a, b]) =>
  vec2(
    a.x.mul(b.x).sub(a.y.mul(b.y)),
    a.x.mul(b.y).add(a.y.mul(b.x)),
  ));

function computeRT(n, opts = {}) {
  const rt = new RenderTarget(n, n, {
    format: RGBAFormat,
    type: opts.type ?? FloatType,
    magFilter: opts.filter ?? NearestFilter,
    minFilter: opts.mips ? LinearMipmapLinearFilter : (opts.filter ?? NearestFilter),
    generateMipmaps: !!opts.mips,
    wrapS: RepeatWrapping,
    wrapT: RepeatWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
  // the surface is viewed at grazing angles from altitude; without aniso the
  // sampler mips for the footprint's long axis and smears all crest detail
  if (opts.mips) rt.texture.anisotropy = 8;
  return rt;
}

export class WebGPUWaterSimulation {
  /**
   * @param {import('three/webgpu').WebGPURenderer} renderer
   * @param {{resolution?: number, cascades?: {size:number, minWave:number, maxWave:number}[]}} opts
   */
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.N = opts.resolution ?? 256;
    this.cascadeDefs = opts.cascades ?? DEFAULT_CASCADES;

    const butterfly = buildButterflyData(this.N);
    this.stages = butterfly.stages;
    this.butterfly = new DataTexture(
      butterfly.data, butterfly.stages, this.N, RGBAFormat, FloatType,
    );
    this.butterfly.magFilter = this.butterfly.minFilter = NearestFilter;
    this.butterfly.needsUpdate = true;

    // 1x1 float placeholder: TextureNode needs a texture at graph-build time;
    // real sim textures are swapped in through the slot lists before use.
    this.placeholder = new DataTexture(new Float32Array(4), 1, 1, RGBAFormat, FloatType);
    this.placeholder.magFilter = this.placeholder.minFilter = NearestFilter;
    this.placeholder.needsUpdate = true;

    // Slots: every TextureNode that reads a logical input registers here, and
    // setSlot() swaps them together (one logical texture may be sampled from
    // several materials / at several coordinates).
    this.slots = { h0: [], input: [], t0: [], t1: [] };

    this.uTime = uniform(0).setName('waterSimTime');
    this.uN = uniform(this.N).setName('waterSimN');
    this.uL = uniform(1).setName('waterSimL');
    this.uStages = uniform(this.stages).setName('waterSimStages');
    this.uStage = uniform(0).setName('waterSimStage');
    this.uLambda = uniform(1).setName('waterSimLambda');

    this.matEvolve0 = this.makeKernelMaterial('evolve0', this.makeEvolveNode(0));
    this.matEvolve1 = this.makeKernelMaterial('evolve1', this.makeEvolveNode(1));
    this.matButterflyH = this.makeKernelMaterial('butterflyH', this.makeButterflyNode(false));
    this.matButterflyV = this.makeKernelMaterial('butterflyV', this.makeButterflyNode(true));
    this.matDisp = this.makeKernelMaterial('displacement', this.makeDisplacementNode());
    this.matDeriv = this.makeKernelMaterial('derivatives', this.makeDerivativesNode());

    this.quad = new QuadMesh(this.matEvolve0);
    // Must be undefined, not null: three's saveRendererState(renderer, state = {})
    // only substitutes the default object for undefined.
    this.rendererState = undefined;

    const N = this.N;
    this.cascades = this.cascadeDefs.map(def => ({
      def,
      h0: null,                                   // DataTexture, rebuilt on wind change
      evolve0: computeRT(N),
      evolve1: computeRT(N),
      ping: [computeRT(N), computeRT(N), computeRT(N), computeRT(N)],
      displacement: computeRT(N, { type: HalfFloatType, filter: LinearFilter, mips: true }),
      derivatives: computeRT(N, { type: HalfFloatType, filter: LinearFilter, mips: true }),
    }));

    this.significantWaveHeight = 1;
  }

  sampleSlot(name, uvNode) {
    const node = texture(this.placeholder, uvNode);
    this.slots[name].push(node);
    return node;
  }

  setSlot(name, tex) {
    for (const node of this.slots[name]) node.value = tex;
  }

  makeKernelMaterial(name, fragmentNode) {
    const material = new NodeMaterial();
    material.name = `WebGPUWaterSim.${name}`;
    material.fragmentNode = fragmentNode;
    material.depthTest = false;
    material.depthWrite = false;
    // Data passes: never let a scene fogNode wrap the kernel output.
    material.fog = false;
    return material;
  }

  makeEvolveNode(mode) {
    return Fn(() => {
      const coord = uv().mul(this.uN).floor();
      const k = coord.sub(this.uN.mul(0.5)).mul(TWO_PI).div(this.uL);
      const kl = k.length().max(1e-6);

      const h0 = this.sampleSlot('h0', coord.add(0.5).div(this.uN));
      const w = kl.mul(GRAVITY).sqrt();
      // e^{-iwt}: with the inverse FFT's e^{+ik.x} convention this makes each
      // component e^{i(k.x - wt)}, i.e. crests travel toward +k — the +wind
      // direction the spectrum aligns energy with. See the GLSL twin for the
      // regression this sign fixed.
      const wt = w.mul(this.uTime);
      const e = vec2(wt.cos(), wt.sin().negate());

      // h(k,t) = h0(k) e^{-iwt} + h0*(-k) e^{+iwt}
      const h = cmul(h0.xy, e)
        .add(cmul(vec2(h0.z, h0.w.negate()), vec2(e.x, e.y.negate())));

      let cA, cB;
      if (mode === 0) {
        cA = h.mul(k.x.div(kl).add(1.0));                        // h + i*Dx
        cB = cmul(vec2(k.x.negate(), k.y.negate().div(kl)), h);  // Dz + i*dh/dx
      } else {
        cA = cmul(vec2(0.0, k.y.add(k.x.mul(k.x).div(kl))), h);        // dh/dz + i*dDx/dx
        cB = cmul(vec2(k.y.mul(k.y).div(kl), k.x.mul(k.y).div(kl)), h); // dDz/dz + i*dDx/dz
      }
      return vec4(cA, cB);
    })();
  }

  makeButterflyNode(vertical) {
    return Fn(() => {
      const coord = uv().mul(this.uN).floor();
      const pos = vertical ? coord.y : coord.x;
      const b = texture(this.butterfly, vec2(
        this.uStage.add(0.5).div(this.uStages),
        pos.add(0.5).div(this.uN),
      ));
      const tw = b.xy;

      const uvA = vertical
        ? vec2(coord.x.add(0.5), b.z.add(0.5)).div(this.uN)
        : vec2(b.z.add(0.5), coord.y.add(0.5)).div(this.uN);
      const uvB = vertical
        ? vec2(coord.x.add(0.5), b.w.add(0.5)).div(this.uN)
        : vec2(b.w.add(0.5), coord.y.add(0.5)).div(this.uN);
      const A = this.sampleSlot('input', uvA);
      const B = this.sampleSlot('input', uvB);

      return vec4(
        A.xy.add(cmul(tw, B.xy)),
        A.zw.add(cmul(tw, B.zw)),
      );
    })();
  }

  makeDisplacementNode() {
    return Fn(() => {
      const coord = uv().mul(this.uN).floor();
      const sgn = select(coord.x.add(coord.y).mod(2.0).lessThan(0.5), float(1.0), float(-1.0));
      const t0 = this.sampleSlot('t0', coord.add(0.5).div(this.uN)).mul(sgn);
      // t0 = (h, Dx, Dz, dh/dx). Negative lambda: the empirical fold test
      // shows this FFT convention needs the flip so horizontal displacement
      // converges water onto crests (sharp peaks, J<1 at crests) rather than
      // into troughs (rounded mounds, J<1 in troughs).
      const negLambda = this.uLambda.negate();
      return vec4(t0.y.mul(negLambda), t0.x, t0.z.mul(negLambda), 1.0);
    })();
  }

  makeDerivativesNode() {
    return Fn(() => {
      const coord = uv().mul(this.uN).floor();
      const sgn = select(coord.x.add(coord.y).mod(2.0).lessThan(0.5), float(1.0), float(-1.0));
      const uvc = coord.add(0.5).div(this.uN);
      const t0 = this.sampleSlot('t0', uvc).mul(sgn);
      const t1 = this.sampleSlot('t1', uvc).mul(sgn);
      const dhdx = t0.w, dhdz = t1.x, dDxdx = t1.y, dDzdz = t1.z, dDxdz = t1.w;
      const lambda = this.uLambda;
      // same -lambda as the displacement pass (cross term is sign-invariant)
      const J = float(1.0).sub(lambda.mul(dDxdx))
        .mul(float(1.0).sub(lambda.mul(dDzdz)))
        .sub(lambda.mul(lambda).mul(dDxdz).mul(dDxdz));
      // slopes of the DISPLACED surface: chop converges geometry at crests, so
      // true slopes steepen by the inverse of M = I + lambda*grad(D) (det = J).
      // Shading raw grad(h) instead lights the undisplaced Gaussian field —
      // smooth, blobby, 'perlin' — regardless of how sharp the geometry is.
      const Js = J.max(0.50);
      const sx = float(1.0).sub(lambda.mul(dDzdz)).mul(dhdx)
        .add(lambda.mul(dDxdz).mul(dhdz)).div(Js);
      const sz = lambda.mul(dDxdz).mul(dhdx)
        .add(float(1.0).sub(lambda.mul(dDxdx)).mul(dhdz)).div(Js);
      // .w carries E[|slope|^2]: under mip filtering this stays put while .xy
      // averages toward 0, so the shader can recover the slope variance lost
      // to filtering and turn it into specular roughness (LEAN/Toksvig).
      return vec4(sx, sz, J, sx.mul(sx).add(sz.mul(sz)));
    })();
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
      c.h0 = new DataTexture(spectra[i], this.N, this.N, RGBAFormat, FloatType);
      c.h0.magFilter = c.h0.minFilter = NearestFilter;
      c.h0.needsUpdate = true;
    });
  }

  runPass(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.quad.render(this.renderer);
  }

  ifft(srcRT, pingA, pingB) {
    let input = srcRT;
    const outs = [pingA, pingB];
    let oi = 0;
    for (let dir = 0; dir < 2; dir++) {
      const material = dir === 1 ? this.matButterflyV : this.matButterflyH;
      for (let s = 0; s < this.stages; s++) {
        this.setSlot('input', input.texture);
        this.uStage.value = s;
        this.runPass(material, outs[oi]);
        input = outs[oi];
        oi ^= 1;
      }
    }
    return input;
  }

  update(time, dt, { choppiness = 1.1 } = {}) {
    this.rendererState = RendererUtils.resetRendererState(this.renderer, this.rendererState);

    for (const c of this.cascades) {
      if (!c.h0) continue;

      // 1. spectrum evolution (two packings)
      this.setSlot('h0', c.h0);
      this.uTime.value = time;
      this.uL.value = c.def.size;
      this.runPass(this.matEvolve0, c.evolve0);
      this.runPass(this.matEvolve1, c.evolve1);

      // 2. inverse FFTs
      const t0 = this.ifft(c.evolve0, c.ping[0], c.ping[1]);
      const t1 = this.ifft(c.evolve1, c.ping[2], c.ping[3]);

      // 3. assemble displacement + derivatives/Jacobian
      this.setSlot('t0', t0.texture);
      this.setSlot('t1', t1.texture);
      this.uLambda.value = choppiness;
      this.runPass(this.matDisp, c.displacement);
      this.runPass(this.matDeriv, c.derivatives);
    }

    RendererUtils.restoreRendererState(this.renderer, this.rendererState);
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
    this.placeholder.dispose();
    [this.matEvolve0, this.matEvolve1, this.matButterflyH, this.matButterflyV,
      this.matDisp, this.matDeriv].forEach(m => m.dispose());
  }
}
