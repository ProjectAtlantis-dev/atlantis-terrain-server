import * as THREE from 'three';
import {
  DETAIL_FADE_END_M,
  DETAIL_FADE_START_M,
  DETAIL_RELATIVE_PERIOD,
  DETAIL_SHADE_STRENGTH,
  DETAIL_STRENGTH,
  DETAIL_SUN_DIR,
} from '../terrain-detail-layer.js';

// WebGL side of the frequency-split ground detail. Keep the math in sync
// with render-backends/webgpu-terrain-detail.js (GLSL/TSL twins, same
// contract as the water shaders).

const FRAGMENT_DECLS = `
uniform sampler2D detailMask;
uniform sampler2D detailRock;
uniform sampler2D detailVegetation;
uniform sampler2D detailSnow;
uniform sampler2D detailRockNormal;
uniform sampler2D detailVegetationNormal;
uniform sampler2D detailSnowNormal;
uniform vec3 detailParams;
uniform vec4 detailShade; // xyz = sun direction, w = shade strength
varying vec2 vDetailUv;
varying float vDetailDist;
`;

const FRAGMENT_BLEND = `
{
  vec3 surfaceWeights = texture2D(detailMask, vMapUv).rgb;
  float weightTotal = min(1.0, surfaceWeights.r + surfaceWeights.g + surfaceWeights.b);
  float fade = 1.0 - smoothstep(detailParams.x, detailParams.y, vDetailDist);
  if (weightTotal * fade > 0.001) {
    vec2 rockUv = vDetailUv * ${DETAIL_RELATIVE_PERIOD.rock.toFixed(3)};
    vec2 vegUv = vDetailUv * ${DETAIL_RELATIVE_PERIOD.vegetation.toFixed(3)};
    vec2 snowUv = vDetailUv * ${DETAIL_RELATIVE_PERIOD.snow.toFixed(3)};
    float detailValue =
      texture2D(detailRock, rockUv).r * surfaceWeights.r +
      texture2D(detailVegetation, vegUv).r * surfaceWeights.g +
      texture2D(detailSnow, snowUv).r * surfaceWeights.b;
    vec3 detailNormal = normalize(
      (texture2D(detailRockNormal, rockUv).rgb * 2.0 - 1.0) * surfaceWeights.r +
      (texture2D(detailVegetationNormal, vegUv).rgb * 2.0 - 1.0) * surfaceWeights.g +
      (texture2D(detailSnowNormal, snowUv).rgb * 2.0 - 1.0) * surfaceWeights.b +
      vec3(0.0, 0.0, 0.001));
    // The base material is unlit — the satellite photo carries the real
    // sun — so grain relief becomes a directional shading term against a
    // fixed southern sun, blended in with the same mask and fade.
    float sunLight = max(dot(detailNormal, detailShade.xyz), 0.0);
    float grainShade = mix(
      1.0,
      0.45 + 1.1 * sunLight,
      detailShade.w * weightTotal * fade);
    float modulation = 1.0 + detailParams.z * (detailValue * 2.0 - 1.0) * weightTotal * fade;
    diffuseColor.rgb *= modulation * grainShade;
  }
}
`;

export function applyTerrainDetailWebGL(mesh, context) {
  const material = mesh?.material;
  if (!material || !material.map) return false;
  const state = material.userData;
  if (state.terrainDetailUniforms) {
    // Material already patched — refresh the per-tile inputs in place.
    state.terrainDetailUniforms.detailMask.value = context.maskTexture;
    state.terrainDetailUniforms.detailUvScale.value = context.uv.scale;
    state.terrainDetailUniforms.detailUvOffset.value.set(
      context.uv.offsetX, context.uv.offsetY,
    );
    return true;
  }

  const uniforms = {
    detailMask: { value: context.maskTexture },
    detailRock: { value: context.textures.rock },
    detailVegetation: { value: context.textures.vegetation },
    detailSnow: { value: context.textures.snow },
    detailRockNormal: { value: context.textures.rockNormal },
    detailVegetationNormal: { value: context.textures.vegetationNormal },
    detailSnowNormal: { value: context.textures.snowNormal },
    detailShade: {
      value: new THREE.Vector4(...DETAIL_SUN_DIR, DETAIL_SHADE_STRENGTH),
    },
    detailUvScale: { value: context.uv.scale },
    detailUvOffset: {
      value: new THREE.Vector2(context.uv.offsetX, context.uv.offsetY),
    },
    detailParams: {
      value: new THREE.Vector3(
        DETAIL_FADE_START_M, DETAIL_FADE_END_M, DETAIL_STRENGTH,
      ),
    },
  };
  state.terrainDetailUniforms = uniforms;
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\n'
        + 'uniform float detailUvScale;\n'
        + 'uniform vec2 detailUvOffset;\n'
        + 'varying vec2 vDetailUv;\n'
        + 'varying float vDetailDist;\n',
      )
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\n'
        + 'vDetailUv = uv * detailUvScale + detailUvOffset;\n'
        + 'vDetailDist = length(mvPosition.xyz);\n',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAGMENT_DECLS)
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + FRAGMENT_BLEND);
  };
  material.customProgramCacheKey = () => 'terrain-detail-v2';
  material.needsUpdate = true;
  return true;
}
