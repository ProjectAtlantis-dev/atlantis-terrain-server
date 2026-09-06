import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import {
  createWaterSunShadowCache,
  WATER_SUN_SHADOW_SIZE,
  WATER_SUN_SHADOW_STEPS,
  WATER_SUN_SHADOW_REACH_M,
  WATER_SUN_SHADOW_BIAS_M,
  WATER_SUN_SHADOW_SOFTNESS_M,
  WATER_SUN_SHADOW_ANGULAR_SOFTNESS,
} from '../water/water-sun-shadow.js';

export function createWebGLWaterSunShadow(renderer, uniforms) {
  const target = new THREE.WebGLRenderTarget(WATER_SUN_SHADOW_SIZE, WATER_SUN_SHADOW_SIZE, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    depthBuffer: false, stencilBuffer: false,
  });
  const material = new THREE.ShaderMaterial({
    uniforms,
    depthTest: false, depthWrite: false, toneMapped: false,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      uniform sampler2D uBathy;
      uniform float uBathyExtent;
      uniform float uWaterline;
      uniform vec3 uSunDir;
      void main() {
        float visibility = 1.0;
        float horizontal = length(uSunDir.xy);
        if (uSunDir.z <= 0.0) visibility = 0.0;
        else if (horizontal > 0.001) {
          vec2 direction = uSunDir.xy / horizontal;
          float rise = uSunDir.z / horizontal;
          float reach = min(${WATER_SUN_SHADOW_REACH_M.toFixed(1)}, uBathyExtent * 0.5);
          for (int i = 1; i <= ${WATER_SUN_SHADOW_STEPS}; i++) {
            float s = float(i) / ${WATER_SUN_SHADOW_STEPS.toFixed(1)};
            float distanceM = reach * s * s;
            vec2 q = vUv + direction * distanceM / uBathyExtent;
            if (any(lessThan(q, vec2(0.0))) || any(greaterThan(q, vec2(1.0)))) break;
            vec4 terrain = texture2D(uBathy, q);
            float height = terrain.r - uWaterline;
            float rayHeight = distanceM * rise + ${WATER_SUN_SHADOW_BIAS_M.toFixed(1)};
            float softness = ${WATER_SUN_SHADOW_SOFTNESS_M.toFixed(1)}
                           + distanceM * ${WATER_SUN_SHADOW_ANGULAR_SOFTNESS};
            float blocked = terrain.a * step(0.0, height)
                          * smoothstep(rayHeight, rayHeight + softness, height);
            visibility = min(visibility, 1.0 - blocked);
            if (visibility <= 0.0) break;
          }
        }
        gl_FragColor = vec4(vec3(visibility), 1.0);
      }
    `,
  });
  const quad = new FullScreenQuad(material);
  const cache = createWaterSunShadowCache(() => {
    const previousTarget = renderer.getRenderTarget();
    const previousCubeFace = renderer.getActiveCubeFace();
    const previousMipmapLevel = renderer.getActiveMipmapLevel();
    try {
      renderer.setRenderTarget(target);
      quad.render(renderer);
    } finally {
      renderer.setRenderTarget(previousTarget, previousCubeFace, previousMipmapLevel);
    }
  });
  return {
    texture: target.texture,
    invalidate: cache.invalidate,
    update() { return cache.update(uniforms.uSunDir.value, uniforms.uWaterline.value); },
    dispose() { target.dispose(); material.dispose(); quad.dispose(); },
  };
}
