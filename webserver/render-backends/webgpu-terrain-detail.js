import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn,
  float,
  max,
  mix,
  normalLocal,
  normalize,
  positionLocal,
  positionView,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import {
  DETAIL_RELATIVE_PERIOD,
  DETAIL_SHADE_STRENGTH,
  DETAIL_SUN_DIR,
  detailParams,
} from '../terrain-detail-layer.js';

// WebGPU side of the frequency-split ground detail. Keep the math in sync
// with render-backends/webgl-terrain-detail.js (GLSL/TSL twins, same
// contract as the water shaders). Tile materials arrive as MeshBasicMaterial
// from the shared mesh builder; the first detail application swaps in a
// MeshBasicNodeMaterial whose colorNode implements satellite × detail.

// Shared live-tuning uniform (x = fade start, y = fade end, z = strength):
// wraps the SAME vector the WebGL twin and the tuning sliders mutate.
const detailTuning = uniform(detailParams);

function graftTextureKey(grafts = []) {
  return grafts.map(graft => graft.texture.uuid).join('|');
}

function buildColorNode({
  map, tintMap, maskTexture, textures, uvTransform, grafts = [],
  detailEnabled = true,
}) {
  return Fn(() => {
    const baseUv = uv();
    const base = texture(map, baseUv);
    const underlayColor = tintMap && tintMap !== map
      ? texture(tintMap, baseUv).rgb
      : base.rgb;
    const surfaceWeights = texture(maskTexture, baseUv).rgb;
    const weightTotal = surfaceWeights.r
      .add(surfaceWeights.g)
      .add(surfaceWeights.b)
      .min(1.0);
    let terrainColor = base.rgb;
    for (const graft of grafts) {
      const geometricNormal = normalize(normalLocal);
      const sideWeights = geometricNormal.xy.abs();
      const sideWeightTotal = sideWeights.x.add(sideWeights.y).max(0.001);
      const xWeight = sideWeights.x.div(sideWeightTotal);
      const yWeight = sideWeights.y.div(sideWeightTotal);
      const period = float(graft.spec.periodM);
      const phase = graft.spec.phase;
      const position = positionLocal;
      const graftXUv = position.yz.div(period).add(vec2(phase[0], phase[1]));
      const graftYUv = position.xz.div(period).add(vec2(phase[1], phase[0]));
      const primary = texture(graft.texture, graftXUv).rgb.mul(xWeight)
        .add(texture(graft.texture, graftYUv).rgb.mul(yWeight));
      const secondaryScale = float(graft.spec.secondaryScale);
      const secondaryXUv = position.zy.div(period).mul(secondaryScale)
        .add(vec2(phase[2], phase[3]));
      const secondaryYUv = position.zx.div(period).mul(secondaryScale)
        .add(vec2(phase[3], phase[2]));
      const secondary = texture(graft.texture, secondaryXUv).rgb.mul(xWeight)
        .add(texture(graft.texture, secondaryYUv).rgb.mul(yWeight));
      let graftColor = mix(
        primary,
        secondary,
        float(graft.spec.secondaryMix),
      );

      // Preserve macro lighting/shadows from the recipient while replacing
      // its stretched cliff paint with the donor's intact ground texture.
      // Transfer bounded chroma separately from luminance: the graft adopts
      // the underlying terrain's local tint without copying its smeared
      // cliff projection or allowing near-black pixels to explode saturation.
      const lumaWeights = vec3(0.2126, 0.7152, 0.0722);
      const baseLuma = underlayColor.dot(lumaWeights);
      const donorLuma = graftColor.dot(lumaWeights);
      const baseChroma = underlayColor.div(baseLuma.max(0.04));
      const donorChroma = graftColor.div(donorLuma.max(0.04));
      const tintRatio = baseChroma.div(donorChroma.max(vec3(0.05)))
        .max(vec3(0.72)).min(vec3(1.38));
      graftColor = graftColor.mul(mix(
        vec3(1.0),
        tintRatio,
        float(graft.spec.tintStrength),
      ));
      const tintedGraftLuma = graftColor.dot(lumaWeights);
      const toneScale = baseLuma.add(0.03).div(tintedGraftLuma.add(0.03))
        .max(0.65).min(1.35);
      graftColor = graftColor.mul(mix(float(1.0), toneScale, float(0.32)));

      const slopeSignal = float(1.0).sub(geometricNormal.z.abs());
      const targetLand = smoothstep(float(0.001), float(0.02), weightTotal);
      const graftBlend = smoothstep(
        float(graft.spec.slopeStart),
        float(graft.spec.slopeEnd),
        slopeSignal,
      );
      const horizontalLength = geometricNormal.xy.length().max(0.001);
      const southness = geometricNormal.y.negate().div(horizontalLength).max(0.0);
      const aspectBlend = smoothstep(
        float(graft.spec.southStart),
        float(graft.spec.southEnd),
        southness,
      );
      const finalGraftBlend = graftBlend
        .mul(aspectBlend)
        .mul(float(graft.spec.strength))
        .mul(targetLand);
      terrainColor = mix(terrainColor, graftColor, finalGraftBlend);
    }

    const fade = float(1.0).sub(smoothstep(
      detailTuning.x,
      detailTuning.y,
      positionView.length(),
    ));
    const surfaceDetailWeight = detailEnabled
      ? weightTotal.mul(fade)
      : float(0.0);
    const detailUv = baseUv
      .mul(float(uvTransform.scale))
      .add(vec2(uvTransform.offsetX, uvTransform.offsetY));
    const rockUv = detailUv.mul(float(DETAIL_RELATIVE_PERIOD.rock));
    const vegUv = detailUv.mul(float(DETAIL_RELATIVE_PERIOD.vegetation));
    const snowUv = detailUv.mul(float(DETAIL_RELATIVE_PERIOD.snow));
    const detailValue = texture(textures.rock, rockUv).r.mul(surfaceWeights.r)
      .add(texture(textures.vegetation, vegUv).r.mul(surfaceWeights.g))
      .add(texture(textures.snow, snowUv).r.mul(surfaceWeights.b));
    const detailNormal = normalize(
      texture(textures.rockNormal, rockUv).rgb.mul(2.0).sub(1.0)
        .mul(surfaceWeights.r)
        .add(
          texture(textures.vegetationNormal, vegUv).rgb.mul(2.0).sub(1.0)
            .mul(surfaceWeights.g),
        )
        .add(
          texture(textures.snowNormal, snowUv).rgb.mul(2.0).sub(1.0)
            .mul(surfaceWeights.b),
        )
        .add(vec3(0.0, 0.0, 0.001)),
    );
    // Unlit base material: grain relief becomes a directional shading term
    // against a fixed southern sun (see terrain-detail-layer constants) —
    // keep in sync with the GLSL twin.
    const sunLight = max(
      detailNormal.dot(vec3(...DETAIL_SUN_DIR)), float(0.0),
    );
    const grainShade = mix(
      float(1.0),
      float(0.45).add(sunLight.mul(1.1)),
      float(DETAIL_SHADE_STRENGTH).mul(surfaceDetailWeight),
    );
    const modulation = float(1.0).add(
      detailValue.mul(2.0).sub(1.0)
        .mul(detailTuning.z)
        .mul(surfaceDetailWeight),
    );
    return terrainColor.mul(modulation).mul(grainShade);
  })();
}

export function applyTerrainDetailWebGPU(mesh, context) {
  const current = mesh?.material;
  if (!current || !current.map) return false;
  const isDetailMaterial = current.userData.terrainDetail === true;
  const previousMap = current.userData.terrainDetailMap;
  if (
    isDetailMaterial
    && previousMap === current.map
    && current.userData.terrainDetailMask === context.maskTexture
    && current.userData.terrainDetailGraftKey === graftTextureKey(context.grafts)
    && current.userData.terrainDetailTintMap === context.tintMap
    && current.userData.terrainDetailSurfaceEnabled === context.detailEnabled
  ) {
    return true;
  }

  let material = current;
  if (!isDetailMaterial) {
    material = new MeshBasicNodeMaterial();
    material.side = current.side;
    material.map = current.map;
    material.color.set(0xffffff);
    material.userData.terrainDetail = true;
  }
  // TSL texture nodes capture the texture object, not the material slot, so
  // the colorNode is rebuilt whenever the streamed satellite texture or the
  // surface mask for this tile changes.
  material.colorNode = buildColorNode({
    map: material.map,
    tintMap: context.tintMap,
    maskTexture: context.maskTexture,
    textures: context.textures,
    uvTransform: context.uv,
    grafts: context.grafts,
    detailEnabled: context.detailEnabled,
  });
  material.userData.terrainDetailMap = material.map;
  material.userData.terrainDetailMask = context.maskTexture;
  material.userData.terrainDetailGraftKey = graftTextureKey(context.grafts);
  material.userData.terrainDetailTintMap = context.tintMap;
  material.userData.terrainDetailSurfaceEnabled = context.detailEnabled;
  material.needsUpdate = true;
  if (material !== current) {
    mesh.material = material;
    current.dispose?.();
  }
  return true;
}
