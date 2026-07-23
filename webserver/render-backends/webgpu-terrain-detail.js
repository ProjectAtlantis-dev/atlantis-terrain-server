import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn,
  float,
  max,
  mix,
  normalize,
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

function buildColorNode({ map, maskTexture, textures, uvTransform }) {
  return Fn(() => {
    const baseUv = uv();
    const base = texture(map, baseUv);
    const surfaceWeights = texture(maskTexture, baseUv).rgb;
    const weightTotal = surfaceWeights.r
      .add(surfaceWeights.g)
      .add(surfaceWeights.b)
      .min(1.0);
    const fade = float(1.0).sub(smoothstep(
      detailTuning.x,
      detailTuning.y,
      positionView.length(),
    ));
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
      float(DETAIL_SHADE_STRENGTH).mul(weightTotal).mul(fade),
    );
    const modulation = float(1.0).add(
      detailValue.mul(2.0).sub(1.0)
        .mul(detailTuning.z)
        .mul(weightTotal)
        .mul(fade),
    );
    return base.rgb.mul(modulation).mul(grainShade);
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
    maskTexture: context.maskTexture,
    textures: context.textures,
    uvTransform: context.uv,
  });
  material.userData.terrainDetailMap = material.map;
  material.userData.terrainDetailMask = context.maskTexture;
  material.needsUpdate = true;
  if (material !== current) {
    mesh.material = material;
    current.dispose?.();
  }
  return true;
}
