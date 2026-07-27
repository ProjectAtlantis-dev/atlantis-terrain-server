import * as THREE from 'three';
import {
  DETAIL_RELATIVE_PERIOD,
  DETAIL_SHADE_STRENGTH,
  DETAIL_SUN_DIR,
  detailParams,
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
uniform sampler2D detailGraft;
uniform sampler2D detailUnderlying;
uniform vec3 detailParams;
uniform vec4 detailShade; // xyz = sun direction, w = shade strength
uniform float detailUseUnderlying;
uniform float detailSurfaceEnabled;
uniform vec4 detailGraftParams; // period, slope start/end, strength
uniform vec2 detailGraftSecondary; // scale, mix
uniform vec2 detailGraftAspect; // south-facing feather start/end
uniform float detailGraftTint;
uniform vec4 detailGraftPhase;
varying vec2 vDetailUv;
varying float vDetailDist;
varying vec3 vDetailPosition;
varying vec3 vDetailNormal;
`;

const FRAGMENT_GRAFT = `
  if (detailGraftParams.w > 0.001) {
    vec3 geometricNormal = normalize(vDetailNormal);
    vec2 sideWeights = abs(geometricNormal.xy);
    sideWeights /= max(sideWeights.x + sideWeights.y, 0.001);
    float period = detailGraftParams.x;
    vec2 graftXUv = vDetailPosition.yz / period + detailGraftPhase.xy;
    vec2 graftYUv = vDetailPosition.xz / period + detailGraftPhase.yx;
    vec3 graftPrimary =
      texture2D(detailGraft, graftXUv).rgb * sideWeights.x +
      texture2D(detailGraft, graftYUv).rgb * sideWeights.y;
    vec2 graftSecondaryXUv =
      vDetailPosition.zy / period * detailGraftSecondary.x + detailGraftPhase.zw;
    vec2 graftSecondaryYUv =
      vDetailPosition.zx / period * detailGraftSecondary.x + detailGraftPhase.wz;
    vec3 graftSecondary =
      texture2D(detailGraft, graftSecondaryXUv).rgb * sideWeights.x +
      texture2D(detailGraft, graftSecondaryYUv).rgb * sideWeights.y;
    vec3 graftColor = mix(
      graftPrimary, graftSecondary, detailGraftSecondary.y);

    // Keep the recipient's large-scale brightness and shadows while replacing
    // the vertically stretched orthophoto detail.
    const vec3 lumaWeights = vec3(0.2126, 0.7152, 0.0722);
    float baseLuma = dot(underlayColor, lumaWeights);
    float graftLuma = dot(graftColor, lumaWeights);
    vec3 baseChroma = underlayColor / max(baseLuma, 0.04);
    vec3 graftChroma = graftColor / max(graftLuma, 0.04);
    vec3 tintRatio = clamp(
      baseChroma / max(graftChroma, vec3(0.05)),
      vec3(0.72), vec3(1.38));
    graftColor *= mix(vec3(1.0), tintRatio, detailGraftTint);
    graftLuma = dot(graftColor, lumaWeights);
    float toneScale = clamp(
      (baseLuma + 0.03) / (graftLuma + 0.03), 0.65, 1.35);
    graftColor *= mix(1.0, toneScale, 0.32);

    float slopeSignal = 1.0 - abs(geometricNormal.z);
    float targetLand = smoothstep(0.001, 0.02, weightTotal);
    float horizontalLength = max(length(geometricNormal.xy), 0.001);
    float southness = max(-geometricNormal.y / horizontalLength, 0.0);
    float southBlend = smoothstep(
      detailGraftAspect.x, detailGraftAspect.y, southness);
    float graftBlend =
      smoothstep(detailGraftParams.y, detailGraftParams.z, slopeSignal) *
      southBlend * detailGraftParams.w * targetLand;
    diffuseColor.rgb = mix(diffuseColor.rgb, graftColor, graftBlend);
  }
`;

const FRAGMENT_BLEND = `
{
  vec3 encodedSurfaceWeights = texture2D(detailMask, vMapUv).rgb;
  float encodedWeightTotal =
    encodedSurfaceWeights.r + encodedSurfaceWeights.g + encodedSurfaceWeights.b;
  // R=1 shadow and R=2 road/path are metadata markers, not materials.
  vec3 surfaceWeights = encodedSurfaceWeights *
    smoothstep(0.02, 0.03, encodedWeightTotal);
  float weightTotal = min(1.0, surfaceWeights.r + surfaceWeights.g + surfaceWeights.b);
  vec3 underlayColor = diffuseColor.rgb;
  if (detailUseUnderlying > 0.5) {
    underlayColor = texture2D(detailUnderlying, vMapUv).rgb;
  }
${FRAGMENT_GRAFT}
  float fade = 1.0 - smoothstep(detailParams.x, detailParams.y, vDetailDist);
  float surfaceDetailWeight = detailSurfaceEnabled * weightTotal * fade;
  if (surfaceDetailWeight > 0.001) {
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
      detailShade.w * surfaceDetailWeight);
    float modulation =
      1.0 + detailParams.z * (detailValue * 2.0 - 1.0) * surfaceDetailWeight;
    diffuseColor.rgb *= modulation * grainShade;
  }
}
`;

export function applyTerrainDetailWebGL(mesh, context) {
  const material = mesh?.material;
  if (!material || !material.map) return false;
  const southGraft = context.grafts?.find(graft => graft.spec.aspect === 'south');
  const tintMap = context.tintMap ?? material.map;
  const useUnderlying = tintMap !== material.map;
  const state = material.userData;
  if (state.terrainDetailUniforms) {
    // Material already patched — refresh the per-tile inputs in place.
    state.terrainDetailUniforms.detailMask.value = context.maskTexture;
    state.terrainDetailUniforms.detailUvScale.value = context.uv.scale;
    state.terrainDetailUniforms.detailUvOffset.value.set(
      context.uv.offsetX, context.uv.offsetY,
    );
    state.terrainDetailUniforms.detailGraft.value =
      southGraft?.texture ?? context.textures.rock;
    state.terrainDetailUniforms.detailGraftParams.value.set(
      southGraft?.spec.periodM ?? 1,
      southGraft?.spec.slopeStart ?? 0,
      southGraft?.spec.slopeEnd ?? 1,
      southGraft?.spec.strength ?? 0,
    );
    state.terrainDetailUniforms.detailGraftSecondary.value.set(
      southGraft?.spec.secondaryScale ?? 1,
      southGraft?.spec.secondaryMix ?? 0,
    );
    state.terrainDetailUniforms.detailGraftAspect.value.set(
      southGraft?.spec.southStart ?? 1,
      southGraft?.spec.southEnd ?? 1,
    );
    state.terrainDetailUniforms.detailGraftTint.value =
      southGraft?.spec.tintStrength ?? 0;
    state.terrainDetailUniforms.detailGraftPhase.value.fromArray(
      southGraft?.spec.phase ?? [0, 0, 0, 0],
    );
    state.terrainDetailUniforms.detailUnderlying.value = tintMap;
    state.terrainDetailUniforms.detailUseUnderlying.value =
      useUnderlying ? 1 : 0;
    state.terrainDetailUniforms.detailSurfaceEnabled.value =
      context.detailEnabled === false ? 0 : 1;
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
    detailGraft: { value: southGraft?.texture ?? context.textures.rock },
    detailGraftParams: {
      value: new THREE.Vector4(
        southGraft?.spec.periodM ?? 1,
        southGraft?.spec.slopeStart ?? 0,
        southGraft?.spec.slopeEnd ?? 1,
        southGraft?.spec.strength ?? 0,
      ),
    },
    detailGraftSecondary: {
      value: new THREE.Vector2(
        southGraft?.spec.secondaryScale ?? 1,
        southGraft?.spec.secondaryMix ?? 0,
      ),
    },
    detailGraftAspect: {
      value: new THREE.Vector2(
        southGraft?.spec.southStart ?? 1,
        southGraft?.spec.southEnd ?? 1,
      ),
    },
    detailGraftTint: { value: southGraft?.spec.tintStrength ?? 0 },
    detailGraftPhase: {
      value: new THREE.Vector4(...(southGraft?.spec.phase ?? [0, 0, 0, 0])),
    },
    detailUnderlying: { value: tintMap },
    detailUseUnderlying: { value: useUnderlying ? 1 : 0 },
    detailSurfaceEnabled: {
      value: context.detailEnabled === false ? 0 : 1,
    },
    detailShade: {
      value: new THREE.Vector4(...DETAIL_SUN_DIR, DETAIL_SHADE_STRENGTH),
    },
    detailUvScale: { value: context.uv.scale },
    detailUvOffset: {
      value: new THREE.Vector2(context.uv.offsetX, context.uv.offsetY),
    },
    // Shared live-tuning vector — the tuning panel mutates it in place.
    detailParams: { value: detailParams },
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
        + 'varying float vDetailDist;\n'
        + 'varying vec3 vDetailPosition;\n'
        + 'varying vec3 vDetailNormal;\n',
      )
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\n'
        + 'vDetailUv = uv * detailUvScale + detailUvOffset;\n'
        + 'vDetailDist = length(mvPosition.xyz);\n'
        + 'vDetailPosition = transformed;\n'
        + 'vDetailNormal = normal;\n',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAGMENT_DECLS)
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + FRAGMENT_BLEND);
  };
  material.customProgramCacheKey = () => 'terrain-detail-v7-south-graft-only';
  material.needsUpdate = true;
  return true;
}
