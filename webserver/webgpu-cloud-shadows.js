import {
  HalfFloatType,
  LinearFilter,
  NodeMaterial,
  QuadMesh,
  RedFormat,
  RendererUtils,
  RenderTarget,
  Vector3
} from 'three/webgpu';
import {
  Fn,
  Loop,
  exp,
  float,
  mix,
  mx_fractal_noise_float,
  positionView,
  select,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4
} from 'three/tsl';
import {
  AtmosphereLightNode,
  getAtmosphereContext
} from '@takram/three-atmosphere/webgpu';

const SHADOW_MAP_SIZE = 512;
const SHADOW_MAP_SPAN_M = 70_000;
const SHADOW_RAY_START_M = 14_000;
const SHADOW_RAY_LENGTH_M = 24_000;
const SHADOW_MARCH_STEPS = 24;
const SHADOW_UPDATE_INTERVAL_S = 0.1;

const vectorScratch = new Vector3();
const centerScratch = new Vector3();

function createShadowTarget() {
  const target = new RenderTarget(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, {
    depthBuffer: false,
    format: RedFormat,
    type: HalfFloatType
  });
  target.texture.name = 'WebGPUCloudShadow.opticalDepth';
  target.texture.minFilter = LinearFilter;
  target.texture.magFilter = LinearFilter;
  target.texture.generateMipmaps = false;
  return target;
}

// Live toggle for cloud shadows on surfaces (1 = on). A uniform so flipping
// it does not rebuild the lighting graph.
export const cloudShadowsEnabled = uniform(1).setName('cloudShadowsEnabled');

export class CloudShadowAtmosphereLightNode extends AtmosphereLightNode {
  static get type() {
    return 'CloudShadowAtmosphereLightNode';
  }

  setupDirect(builder) {
    const directLight = super.setupDirect(builder);
    const cloudShadow = this.light?.cloudShadow;
    if (directLight == null || cloudShadow == null) {
      return directLight;
    }
    // v0.19: the context is resolved through the builder, not the light.
    const atmosphereContext = getAtmosphereContext(builder);

    let positionECEF = atmosphereContext.matrixViewToECEF
      .mul(vec4(positionView, 1))
      .xyz;
    if (atmosphereContext.correctAltitude) {
      positionECEF = positionECEF.add(atmosphereContext.altitudeCorrectionECEF);
    }
    // Takram beer shadow map (CloudBeerShadowMapNode) or the legacy
    // procedural map (WebGPUCloudShadows) — both expose a transmittance node.
    const transmittance = cloudShadow.sampleTransmittance != null
      ? cloudShadow.sampleTransmittance(positionECEF)
      : cloudShadow.getTransmittanceNode(positionECEF);
    directLight.lightColor = directLight.lightColor.mul(
      mix(float(1), transmittance, cloudShadowsEnabled)
    );
    return directLight;
  }
}

export class WebGPUCloudShadows {
  constructor({ anchor, east, north, up, camera, atmosphereContext }) {
    this.camera = camera;
    this.atmosphereContext = atmosphereContext;
    this.anchor = anchor.clone();
    this.east = east.clone();
    this.north = north.clone();
    this.up = up.clone();

    this.enabled = uniform(true).setName('cloudShadowsEnabled');
    this.debugSurface = uniform(false).setName('cloudShadowDebugSurface');
    this.strength = uniform(1).setName('cloudShadowStrength');
    this.coverage = uniform(0.52).setName('cloudShadowCoverage');
    this.density = uniform(1.15).setName('cloudShadowDensity');
    this.driftTime = uniform(0).setName('cloudShadowDriftTime');
    this.mapSpan = uniform(SHADOW_MAP_SPAN_M).setName('cloudShadowMapSpan');
    this.shadowCenter = uniform(anchor.clone()).setName('cloudShadowCenter');
    this.densityOrigin = uniform(anchor.clone()).setName('cloudDensityOrigin');
    this.shadowRight = uniform(east.clone()).setName('cloudShadowRight');
    this.shadowUp = uniform(north.clone()).setName('cloudShadowUp');
    this.sunDirection = uniform(new Vector3(0, 0, 1)).setName('cloudShadowSunDirection');

    this.renderTarget = createShadowTarget();
    this.material = new NodeMaterial();
    this.material.name = 'WebGPUCloudShadow.opticalDepth';
    this.material.fragmentNode = this.createOpticalDepthNode();
    this.quad = new QuadMesh(this.material);
    // Must be undefined, not null: three's saveRendererState(renderer, state = {})
    // only substitutes the default object for undefined.
    this.rendererState = undefined;
    this.lastUpdateSeconds = -Infinity;
  }

  createDensityNode(positionECEF) {
    const relative = positionECEF.sub(this.densityOrigin);
    const local = vec3(
      relative.dot(vec3(this.east)),
      relative.dot(vec3(this.north)),
      relative.dot(vec3(this.up))
    );

    const drift = vec2(this.driftTime.mul(0.018), this.driftTime.mul(0.006));
    const weatherPosition = local.xy.mul(0.000055).add(drift);
    const detailPosition = local.xy.mul(0.00019).add(drift.mul(1.7));
    const weather = mx_fractal_noise_float(weatherPosition, 4, 2.03, 0.53)
      .mul(0.5)
      .add(0.5);
    const detail = mx_fractal_noise_float(detailPosition, 3, 2.1, 0.5)
      .mul(0.5)
      .add(0.5);
    const shape = mix(weather, weather.mul(detail), 0.38);
    const coverageThreshold = float(1).sub(this.coverage).mul(0.72).add(0.12);
    const horizontalDensity = smoothstep(
      coverageThreshold,
      coverageThreshold.add(0.2),
      shape
    );

    const base = smoothstep(900, 1450, local.z);
    const top = float(1).sub(smoothstep(2500, 3300, local.z));
    const profile = base.mul(top);
    return horizontalDensity.mul(profile).mul(this.density);
  }

  createOpticalDepthNode() {
    return Fn(() => {
      const mapPosition = uv().sub(0.5).mul(this.mapSpan);
      const rayOrigin = this.shadowCenter
        .add(this.shadowRight.mul(mapPosition.x))
        .add(this.shadowUp.mul(mapPosition.y))
        .add(this.sunDirection.mul(SHADOW_RAY_START_M));
      const rayDirection = this.sunDirection.negate();
      const stepSize = SHADOW_RAY_LENGTH_M / SHADOW_MARCH_STEPS;
      const opticalDepth = float(0).toVar('cloudOpticalDepth');

      Loop(SHADOW_MARCH_STEPS, ({ i }) => {
        const distance = float(i).add(0.5).mul(stepSize);
        const position = rayOrigin.add(rayDirection.mul(distance));
        opticalDepth.addAssign(this.createDensityNode(position).mul(stepSize * 0.00135));
      });

      return vec4(opticalDepth, 0, 0, 1);
    })();
  }

  getShadowUvNode(positionECEF) {
    const relative = positionECEF.sub(this.shadowCenter);
    return vec2(
      relative.dot(this.shadowRight),
      relative.dot(this.shadowUp)
    ).div(this.mapSpan).add(0.5);
  }

  getTransmittanceNode(positionECEF) {
    const shadowUv = this.getShadowUvNode(positionECEF);
    const inside = shadowUv.x.greaterThanEqual(0)
      .and(shadowUv.x.lessThanEqual(1))
      .and(shadowUv.y.greaterThanEqual(0))
      .and(shadowUv.y.lessThanEqual(1));
    const opticalDepth = texture(this.renderTarget.texture, shadowUv).r;
    const transmittance = exp(opticalDepth.mul(this.strength).negate());
    return select(this.enabled.and(inside), transmittance, 1);
  }

  update(renderer, elapsedSeconds) {
    this.driftTime.value = elapsedSeconds;
    if (elapsedSeconds - this.lastUpdateSeconds < SHADOW_UPDATE_INTERVAL_S) {
      return;
    }
    this.lastUpdateSeconds = elapsedSeconds;
    this.sunDirection.value.copy(this.atmosphereContext.sunDirectionECEF.value).normalize();

    const right = this.shadowRight.value;
    right.crossVectors(this.sunDirection.value, this.up);
    if (right.lengthSq() < 1e-8) {
      right.copy(this.east);
    } else {
      right.normalize();
    }
    this.shadowUp.value.crossVectors(right, this.sunDirection.value).normalize();

    const cameraOffset = vectorScratch.copy(this.camera.position).sub(this.anchor);
    centerScratch.copy(this.anchor)
      .addScaledVector(this.east, cameraOffset.dot(this.east))
      .addScaledVector(this.north, cameraOffset.dot(this.north));
    this.shadowCenter.value.copy(centerScratch);

    this.rendererState = RendererUtils.resetRendererState(renderer, this.rendererState);
    renderer.setRenderTarget(this.renderTarget);
    this.quad.render(renderer);
    RendererUtils.restoreRendererState(renderer, this.rendererState);
  }

  dispose() {
    this.renderTarget.dispose();
    this.material.dispose();
  }

  debugSummary() {
    return {
      enabled: this.enabled.value,
      debugSurface: this.debugSurface.value,
      mapSize: SHADOW_MAP_SIZE,
      mapSpan: this.mapSpan.value,
      coverage: this.coverage.value,
      density: this.density.value,
      strength: this.strength.value,
      center: this.shadowCenter.value.toArray(),
      sunDirection: this.sunDirection.value.toArray()
    };
  }
}
