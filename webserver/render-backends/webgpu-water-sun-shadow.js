import { LinearFilter } from 'three';
import { NodeMaterial, QuadMesh, RenderTarget, RendererUtils } from 'three/webgpu';
import { Break, Fn, If, Loop, float, smoothstep, step, uv, vec2, vec3, vec4 } from 'three/tsl';
import {
  createWaterSunShadowCache,
  WATER_SUN_SHADOW_SIZE,
  WATER_SUN_SHADOW_STEPS,
  WATER_SUN_SHADOW_REACH_M,
  WATER_SUN_SHADOW_BIAS_M,
  WATER_SUN_SHADOW_SOFTNESS_M,
  WATER_SUN_SHADOW_ANGULAR_SOFTNESS,
} from '../water/water-sun-shadow.js';

export function createWebGPUWaterSunShadow(renderer, { texBathy, uBathyExtent, uSunDir, uWaterline }) {
  const target = new RenderTarget(WATER_SUN_SHADOW_SIZE, WATER_SUN_SHADOW_SIZE, {
    minFilter: LinearFilter, magFilter: LinearFilter,
    depthBuffer: false, stencilBuffer: false,
  });
  const material = new NodeMaterial();
  material.name = 'WebGPUWater.sunShadow';
  material.depthTest = false;
  material.depthWrite = false;
  material.toneMapped = false;
  material.fragmentNode = Fn(() => {
    const visibility = float(1).toVar();
    const horizontal = uSunDir.xy.length().toVar();
    If(uSunDir.z.lessThanEqual(0), () => {
      visibility.assign(0);
    }).ElseIf(horizontal.greaterThan(0.001), () => {
      const direction = uSunDir.xy.div(horizontal).toVar();
      const rise = uSunDir.z.div(horizontal).toVar();
      const reach = uBathyExtent.mul(0.5).min(WATER_SUN_SHADOW_REACH_M).toVar();
      Loop({ start: 1, end: WATER_SUN_SHADOW_STEPS, condition: '<=' }, ({ i }) => {
        const s = float(i).div(WATER_SUN_SHADOW_STEPS);
        const distanceM = reach.mul(s).mul(s).toVar();
        const q = uv().add(direction.mul(distanceM).div(uBathyExtent)).toVar();
        If(q.x.lessThan(0).or(q.x.greaterThan(1))
          .or(q.y.lessThan(0)).or(q.y.greaterThan(1)), () => { Break(); });
        // Scene-captured bathymetry has inverted V. The quad-produced shadow
        // texture uses ordinary UVs, matching the FFT pass convention.
        const terrain = texBathy.sample(vec2(q.x, q.y.oneMinus())).level(0).toVar();
        const height = terrain.r.sub(uWaterline).toVar();
        const rayHeight = distanceM.mul(rise).add(WATER_SUN_SHADOW_BIAS_M);
        const softness = distanceM.mul(WATER_SUN_SHADOW_ANGULAR_SOFTNESS)
          .add(WATER_SUN_SHADOW_SOFTNESS_M);
        const blocked = terrain.a.mul(step(0, height))
          .mul(smoothstep(rayHeight, rayHeight.add(softness), height));
        visibility.assign(visibility.min(blocked.oneMinus()));
        If(visibility.lessThanEqual(0), () => { Break(); });
      });
    });
    return vec4(vec3(visibility), 1);
  })();
  const quad = new QuadMesh(material);
  let rendererState;
  const cache = createWaterSunShadowCache(() => {
    rendererState = RendererUtils.resetRendererState(renderer, rendererState);
    try {
      renderer.setRenderTarget(target);
      quad.render(renderer);
    } finally {
      RendererUtils.restoreRendererState(renderer, rendererState);
    }
  });
  return {
    texture: target.texture,
    invalidate: cache.invalidate,
    update() { return cache.update(uSunDir.value, uWaterline.value); },
    dispose() { target.dispose(); material.dispose(); },
  };
}
