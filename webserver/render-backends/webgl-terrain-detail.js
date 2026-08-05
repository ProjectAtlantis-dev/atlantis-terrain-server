import * as THREE from 'three';
import {
  DETAIL_RELATIVE_PERIOD,
  ROCK_COLOR_RELATIVE_PERIOD,
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
uniform sampler2D detailRockColor;
uniform sampler2D detailVegetation;
uniform sampler2D detailSnow;
uniform sampler2D detailRockNormal;
uniform sampler2D detailVegetationNormal;
uniform sampler2D detailSnowNormal;
uniform sampler2D detailGraft;
uniform sampler2D detailGraftNormal;
uniform sampler2D detailGraftSecondaryTexture;
uniform sampler2D detailGraftSecondaryNormal;
uniform sampler2D detailGraftTertiaryTexture;
uniform sampler2D detailGraftTertiaryNormal;
uniform sampler2D detailUnderlying;
uniform vec3 detailParams;
uniform vec4 detailShade; // xyz = sun direction, w = shade strength
uniform float detailUseUnderlying;
uniform float detailSurfaceEnabled;
uniform vec4 detailGraftParams; // period, slope start/end, strength
uniform vec2 detailGraftSecondary; // scale, mix
uniform vec4 detailGraftVariation; // tertiary scale/mix, variation period/amount
uniform vec2 detailGraftAspect; // south-facing feather start/end
uniform float detailGraftTint;
uniform float detailGraftNormalStrength;
uniform float detailGraftAllAspects;
uniform vec3 detailGraftRelief; // slope gain, relief contrast, clamp floor
uniform float detailGraftSaturation; // 1 = capture as shot, 0 = fully the tint
uniform vec4 detailGraftPhase;
varying vec2 vDetailUv;
varying float vDetailDist;
varying vec3 vDetailPosition;
varying vec3 vDetailNormal;

// Each graft normal sample arrives in its own triplanar projection's tangent
// frame, so it has to be rebuilt against the world axes that projection's u, v
// and projection directions actually correspond to. Dotting the raw sample
// against a world-space sun instead lights a vertical cliff as if it were lying
// flat, which flattens the rock out. Stretching the material far past its
// capture scale also dilutes the encoded slopes, so detailGraftRelief.x scales
// them back up to legible relief.
// The graft textures upload with flipY = false, which reverses the surface
// gradient along v while the map's green channel still encodes the original
// +v. Left uncorrected every bump lights as a dent, so negate y here.
vec3 graftWorldNormal(vec3 sampled, vec3 uDir, vec3 vDir, vec3 wDir) {
  vec3 tangentNormal = vec3(
    vec2(sampled.x, -sampled.y) * detailGraftRelief.x,
    max(sampled.z, 0.05));
  return normalize(
    tangentNormal.x * uDir + tangentNormal.y * vDir + tangentNormal.z * wDir);
}
`;

const FRAGMENT_GRAFT = `
  if (detailGraftParams.w > 0.001) {
    vec3 geometricNormal = normalize(vDetailNormal);
    vec3 graftWorldX = vec3(1.0, 0.0, 0.0);
    vec3 graftWorldY = vec3(0.0, 1.0, 0.0);
    vec3 graftWorldZ = vec3(0.0, 0.0, 1.0);
    // Each projection faces along its own axis, flipped to the side of the
    // surface the camera can actually see.
    vec3 graftAxisX = vec3(geometricNormal.x >= 0.0 ? 1.0 : -1.0, 0.0, 0.0);
    vec3 graftAxisY = vec3(0.0, geometricNormal.y >= 0.0 ? 1.0 : -1.0, 0.0);
    vec2 sideWeights = abs(geometricNormal.xy);
    sideWeights /= max(sideWeights.x + sideWeights.y, 0.001);
    float period = detailGraftParams.x;
    vec2 graftXUv = vDetailPosition.yz / period + detailGraftPhase.xy;
    vec2 graftYUv = vDetailPosition.xz / period + detailGraftPhase.yx;
    vec3 graftPrimary =
      texture2D(detailGraft, graftXUv).rgb * sideWeights.x +
      texture2D(detailGraft, graftYUv).rgb * sideWeights.y;
    vec2 graftSecondaryXUv =
      vDetailPosition.zy / detailGraftSecondary.x + detailGraftPhase.zw;
    vec2 graftSecondaryYUv =
      vDetailPosition.zx / detailGraftSecondary.x + detailGraftPhase.wz;
    vec3 graftSecondary =
      texture2D(detailGraftSecondaryTexture, graftSecondaryXUv).rgb * sideWeights.x +
      texture2D(detailGraftSecondaryTexture, graftSecondaryYUv).rgb * sideWeights.y;
    mat2 graftRotation = mat2(0.7986, -0.6018, 0.6018, 0.7986);
    vec2 graftTertiaryXUv = graftRotation *
      (vDetailPosition.yz / detailGraftVariation.x) +
      detailGraftPhase.wy + vec2(0.371, 0.113);
    vec2 graftTertiaryYUv = graftRotation *
      (vDetailPosition.xz / detailGraftVariation.x) +
      detailGraftPhase.xz + vec2(0.193, 0.467);
    vec3 graftTertiary =
      texture2D(detailGraftTertiaryTexture, graftTertiaryXUv).rgb * sideWeights.x +
      texture2D(detailGraftTertiaryTexture, graftTertiaryYUv).rgb * sideWeights.y;
    float scaleVariation = 0.5 + 0.5 *
      sin((vDetailPosition.x + vDetailPosition.y) / detailGraftVariation.z) *
      sin((vDetailPosition.z - vDetailPosition.x) /
        (detailGraftVariation.z * 0.73));
    // Floor at zero, not 0.08: a spec asking for a single sample must get one,
    // because every part mixed in costs contrast.
    float secondaryMix = clamp(
      detailGraftSecondary.y +
      (scaleVariation - 0.5) * detailGraftVariation.w, 0.0, 0.62);
    float tertiaryMix = detailGraftVariation.y *
      (1.15 - 0.55 * scaleVariation);
    vec3 graftColor = mix(graftPrimary, graftSecondary, secondaryMix);
    graftColor = mix(graftColor, graftTertiary, tertiaryMix);
    // Primary projections sample position.yz and position.xz.
    vec3 graftNormalPrimary = normalize(
      graftWorldNormal(
        texture2D(detailGraftNormal, graftXUv).rgb * 2.0 - 1.0,
        graftWorldY, graftWorldZ, graftAxisX) * sideWeights.x +
      graftWorldNormal(
        texture2D(detailGraftNormal, graftYUv).rgb * 2.0 - 1.0,
        graftWorldX, graftWorldZ, graftAxisY) * sideWeights.y);
    // The secondary projections swap u and v to break alignment, so their
    // world axes swap with them.
    vec3 graftNormalSecondary = normalize(
      graftWorldNormal(
        texture2D(detailGraftSecondaryNormal, graftSecondaryXUv).rgb * 2.0 - 1.0,
        graftWorldZ, graftWorldY, graftAxisX) * sideWeights.x +
      graftWorldNormal(
        texture2D(detailGraftSecondaryNormal, graftSecondaryYUv).rgb * 2.0 - 1.0,
        graftWorldZ, graftWorldX, graftAxisY) * sideWeights.y);
    // The tertiary projections rotate their uv, so counter-rotate the sampled
    // tangent directions back before rebuilding. In GLSL a vector times a
    // matrix applies the transpose, which for a rotation is its inverse.
    vec3 tertiaryXSample =
      texture2D(detailGraftTertiaryNormal, graftTertiaryXUv).rgb * 2.0 - 1.0;
    tertiaryXSample.xy = tertiaryXSample.xy * graftRotation;
    vec3 tertiaryYSample =
      texture2D(detailGraftTertiaryNormal, graftTertiaryYUv).rgb * 2.0 - 1.0;
    tertiaryYSample.xy = tertiaryYSample.xy * graftRotation;
    vec3 graftNormalTertiary = normalize(
      graftWorldNormal(
        tertiaryXSample, graftWorldY, graftWorldZ, graftAxisX) * sideWeights.x +
      graftWorldNormal(
        tertiaryYSample, graftWorldX, graftWorldZ, graftAxisY) * sideWeights.y);
    vec3 graftNormal = mix(graftNormalPrimary, graftNormalSecondary, secondaryMix);
    graftNormal = normalize(mix(graftNormal, graftNormalTertiary, tertiaryMix));
    // Shade on how much the rock's relief turns away from the sun relative to
    // the face it sits on, not on absolute light. The sun points nearly
    // straight at a south wall, so absolute light is both high and almost
    // constant there — using it directly just scales the whole face up.
    float graftLight = dot(graftNormal, detailShade.xyz);
    float faceLight = dot(geometricNormal, detailShade.xyz);
    float relief = (graftLight - faceLight) * detailGraftRelief.y;
    graftColor *= mix(
      1.0,
      clamp(1.0 + relief, detailGraftRelief.z, 2.0 - detailGraftRelief.z),
      detailGraftNormalStrength);

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
    // Pulling the graft back toward the photo's luminance also cancels the
    // relief shading above, so match tone only loosely.
    graftColor *= mix(1.0, toneScale, 0.15);

    // The capture's blue-grey granite balance is baked into the albedo at load
    // time (see terrain-cliff-graft.js), so only chroma variation is left to
    // trim here. This desaturates toward plain luminance, which drifts green
    // because luma weights green at 0.72 — change greyTint for hue, this only
    // to flatten variation.
    float graftSaturationLuma = dot(graftColor, lumaWeights);
    graftColor = mix(
      vec3(graftSaturationLuma), graftColor, detailGraftSaturation);

    float slopeSignal = 1.0 - abs(geometricNormal.z);
    float targetLand = smoothstep(0.001, 0.02, weightTotal);
    float horizontalLength = max(length(geometricNormal.xy), 0.001);
    float southness = max(-geometricNormal.y / horizontalLength, 0.0);
    float southBlend = smoothstep(
      detailGraftAspect.x, detailGraftAspect.y, southness);
    southBlend = mix(southBlend, 1.0, detailGraftAllAspects);
    float graftBlend =
      smoothstep(detailGraftParams.y, detailGraftParams.z, slopeSignal) *
      southBlend * detailGraftParams.w * targetLand * fade;
    diffuseColor.rgb = mix(diffuseColor.rgb, graftColor, graftBlend);
    graftCoverage = graftBlend;
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
  // Computed before the graft, not after: the graft needs it too. Without a
  // distance fade the cliff material runs at full strength until the tile LOD
  // drops below its minDepth and it vanishes at a tile edge, which reads as a
  // hard cutoff — and it aliases into noise well before that.
  float fade = 1.0 - smoothstep(detailParams.x, detailParams.y, vDetailDist);
  float graftCoverage = 0.0;
${FRAGMENT_GRAFT}
  // The flat-ground detail below carries its own material and its own shading
  // term. Where the cliff graft has taken the surface over, stacking both
  // blends two rock materials onto one face, so hand the surface across.
  float surfaceDetailWeight =
    detailSurfaceEnabled * weightTotal * fade * (1.0 - graftCoverage);
  if (surfaceDetailWeight > 0.001) {
    vec2 rockUv = vDetailUv * ${DETAIL_RELATIVE_PERIOD.rock.toFixed(3)};
    vec2 vegUv = vDetailUv * ${DETAIL_RELATIVE_PERIOD.vegetation.toFixed(3)};
    vec2 snowUv = vDetailUv * ${DETAIL_RELATIVE_PERIOD.snow.toFixed(3)};
    float flatRockWeight = surfaceWeights.r *
      smoothstep(0.55, 0.90, abs(normalize(vDetailNormal).z));
    vec2 rockColorUv = vDetailUv * ${ROCK_COLOR_RELATIVE_PERIOD.toFixed(4)};
    vec3 rockAlbedo = texture2D(detailRockColor, rockColorUv).rgb;
    float rockAlbedoLuma = dot(rockAlbedo, vec3(0.2126, 0.7152, 0.0722));
    vec3 rockChroma = clamp(
      rockAlbedo / max(rockAlbedoLuma, 0.05), vec3(0.72), vec3(1.28));
    diffuseColor.rgb *= mix(
      vec3(1.0), rockChroma, flatRockWeight * fade * 0.38);
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

// Every input the patched uniforms are derived from. Re-applying a tile whose
// inputs are all unchanged writes identical values and still costs a repaint,
// so callers need to be able to tell that apart from real work.
function detailInputSignature(context, cliffGraft, layers, tintMap) {
  const spec = cliffGraft?.spec;
  return [
    context.maskTexture?.uuid,
    context.uv.scale, context.uv.offsetX, context.uv.offsetY,
    cliffGraft?.texture?.uuid, cliffGraft?.normalTexture?.uuid,
    layers[1]?.texture?.uuid, layers[2]?.texture?.uuid,
    tintMap?.uuid,
    context.detailEnabled === false ? 0 : 1,
    spec?.aspect, spec?.periodM, spec?.slopeStart, spec?.slopeEnd,
    spec?.strength, spec?.phaseMix, spec?.phaseMix2, spec?.phaseVariation,
    spec?.variationPeriodM, spec?.southStart, spec?.southEnd,
    spec?.tintStrength, spec?.normalStrength, spec?.normalRelief,
    spec?.reliefContrast, spec?.reliefFloor, spec?.saturation,
  ].join('|');
}

// Returns 'patched' on the first application, 'refreshed' when an input really
// changed, 'unchanged' when the call was redundant, or false when the mesh
// cannot take the detail layer at all.
export function applyTerrainDetailWebGL(mesh, context) {
  const material = mesh?.material;
  if (!material || !material.map) return false;
  const cliffGraft = context.grafts?.[0];
  const cliffLayers = cliffGraft?.layers ?? [];
  const primaryLayer = cliffLayers[0];
  const secondaryLayer = cliffLayers[1] ?? primaryLayer;
  const tertiaryLayer = cliffLayers[2] ?? primaryLayer;
  const tintMap = context.tintMap ?? material.map;
  const useUnderlying = tintMap !== material.map;
  const state = material.userData;
  const signature = detailInputSignature(
    context, cliffGraft, cliffLayers, tintMap,
  );
  if (state.terrainDetailUniforms) {
    if (state.terrainDetailSignature === signature) return 'unchanged';
    state.terrainDetailSignature = signature;
    // Material already patched — refresh the per-tile inputs in place.
    state.terrainDetailUniforms.detailMask.value = context.maskTexture;
    state.terrainDetailUniforms.detailUvScale.value = context.uv.scale;
    state.terrainDetailUniforms.detailUvOffset.value.set(
      context.uv.offsetX, context.uv.offsetY,
    );
    state.terrainDetailUniforms.detailGraft.value =
      cliffGraft?.texture ?? context.textures.rock;
    state.terrainDetailUniforms.detailGraftNormal.value =
      cliffGraft?.normalTexture ?? context.textures.rockNormal;
    state.terrainDetailUniforms.detailGraftSecondaryTexture.value =
      secondaryLayer?.texture ?? context.textures.rock;
    state.terrainDetailUniforms.detailGraftSecondaryNormal.value =
      secondaryLayer?.normalTexture ?? context.textures.rockNormal;
    state.terrainDetailUniforms.detailGraftTertiaryTexture.value =
      tertiaryLayer?.texture ?? context.textures.rock;
    state.terrainDetailUniforms.detailGraftTertiaryNormal.value =
      tertiaryLayer?.normalTexture ?? context.textures.rockNormal;
    state.terrainDetailUniforms.detailGraftParams.value.set(
      cliffGraft?.spec.periodM ?? primaryLayer?.periodM ?? 1,
      cliffGraft?.spec.slopeStart ?? 0,
      cliffGraft?.spec.slopeEnd ?? 1,
      cliffGraft?.spec.strength ?? 0,
    );
    state.terrainDetailUniforms.detailGraftSecondary.value.set(
      cliffGraft?.spec.periodM ?? primaryLayer?.periodM ?? 1,
      cliffGraft?.spec.phaseMix ?? 0,
    );
    state.terrainDetailUniforms.detailGraftVariation.value.set(
      cliffGraft?.spec.periodM ?? primaryLayer?.periodM ?? 1,
      cliffGraft?.spec.phaseMix2 ?? 0,
      cliffGraft?.spec.variationPeriodM ?? 1,
      cliffGraft?.spec.phaseVariation ?? 0,
    );
    state.terrainDetailUniforms.detailGraftAspect.value.set(
      cliffGraft?.spec.southStart ?? 0,
      cliffGraft?.spec.southEnd ?? 1,
    );
    state.terrainDetailUniforms.detailGraftTint.value =
      cliffGraft?.spec.tintStrength ?? 0;
    state.terrainDetailUniforms.detailGraftNormalStrength.value =
      cliffGraft?.spec.normalStrength ?? 0;
    state.terrainDetailUniforms.detailGraftAllAspects.value =
      cliffGraft?.spec.aspect === 'all' ? 1 : 0;
    state.terrainDetailUniforms.detailGraftSaturation.value =
      cliffGraft?.spec.saturation ?? 1;
    state.terrainDetailUniforms.detailGraftRelief.value.set(
      cliffGraft?.spec.normalRelief ?? 1,
      cliffGraft?.spec.reliefContrast ?? 0,
      cliffGraft?.spec.reliefFloor ?? 0.5,
    );
    state.terrainDetailUniforms.detailGraftPhase.value.fromArray(
      cliffGraft?.spec.phase ?? [0, 0, 0, 0],
    );
    state.terrainDetailUniforms.detailUnderlying.value = tintMap;
    state.terrainDetailUniforms.detailUseUnderlying.value =
      useUnderlying ? 1 : 0;
    state.terrainDetailUniforms.detailSurfaceEnabled.value =
      context.detailEnabled === false ? 0 : 1;
    return 'refreshed';
  }

  const uniforms = {
    detailMask: { value: context.maskTexture },
    detailRock: { value: context.textures.rock },
    detailRockColor: { value: context.textures.rockColor },
    detailVegetation: { value: context.textures.vegetation },
    detailSnow: { value: context.textures.snow },
    detailRockNormal: { value: context.textures.rockNormal },
    detailVegetationNormal: { value: context.textures.vegetationNormal },
    detailSnowNormal: { value: context.textures.snowNormal },
    detailGraft: { value: cliffGraft?.texture ?? context.textures.rock },
    detailGraftNormal: {
      value: cliffGraft?.normalTexture ?? context.textures.rockNormal,
    },
    detailGraftSecondaryTexture: {
      value: secondaryLayer?.texture ?? context.textures.rock,
    },
    detailGraftSecondaryNormal: {
      value: secondaryLayer?.normalTexture ?? context.textures.rockNormal,
    },
    detailGraftTertiaryTexture: {
      value: tertiaryLayer?.texture ?? context.textures.rock,
    },
    detailGraftTertiaryNormal: {
      value: tertiaryLayer?.normalTexture ?? context.textures.rockNormal,
    },
    detailGraftParams: {
      value: new THREE.Vector4(
        cliffGraft?.spec.periodM ?? primaryLayer?.periodM ?? 1,
        cliffGraft?.spec.slopeStart ?? 0,
        cliffGraft?.spec.slopeEnd ?? 1,
        cliffGraft?.spec.strength ?? 0,
      ),
    },
    detailGraftSecondary: {
      value: new THREE.Vector2(
        cliffGraft?.spec.periodM ?? primaryLayer?.periodM ?? 1,
        cliffGraft?.spec.phaseMix ?? 0,
      ),
    },
    detailGraftVariation: {
      value: new THREE.Vector4(
        cliffGraft?.spec.periodM ?? primaryLayer?.periodM ?? 1,
        cliffGraft?.spec.phaseMix2 ?? 0,
        cliffGraft?.spec.variationPeriodM ?? 1,
        cliffGraft?.spec.phaseVariation ?? 0,
      ),
    },
    detailGraftAspect: {
      value: new THREE.Vector2(
        cliffGraft?.spec.southStart ?? 0,
        cliffGraft?.spec.southEnd ?? 1,
      ),
    },
    detailGraftTint: { value: cliffGraft?.spec.tintStrength ?? 0 },
    detailGraftNormalStrength: {
      value: cliffGraft?.spec.normalStrength ?? 0,
    },
    detailGraftAllAspects: {
      value: cliffGraft?.spec.aspect === 'all' ? 1 : 0,
    },
    detailGraftSaturation: { value: cliffGraft?.spec.saturation ?? 1 },
    detailGraftRelief: {
      value: new THREE.Vector3(
        cliffGraft?.spec.normalRelief ?? 1,
        cliffGraft?.spec.reliefContrast ?? 0,
        cliffGraft?.spec.reliefFloor ?? 0.5,
      ),
    },
    detailGraftPhase: {
      value: new THREE.Vector4(...(cliffGraft?.spec.phase ?? [0, 0, 0, 0])),
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
  state.terrainDetailSignature = signature;
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
  material.customProgramCacheKey = () => 'terrain-detail-v21-no-isolate';
  material.needsUpdate = true;
  return 'patched';
}
