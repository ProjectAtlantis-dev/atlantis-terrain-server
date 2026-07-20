import {
  DepthFormat,
  DepthTexture,
  HalfFloatType,
  LinearFilter,
  Matrix4,
  NodeMaterial,
  OrthographicCamera,
  QuadMesh,
  RedFormat,
  RendererUtils,
  RenderTarget,
  UnsignedIntType,
  Vector3
} from 'three/webgpu';
import {
  Fn,
  Loop,
  exp,
  float,
  mix,
  mx_fractal_noise_float,
  positionWorld,
  select,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4
} from 'three/tsl';
import { AtmosphereLightNode } from '@takram/three-atmosphere/webgpu';
import {
  ATMOSPHERE_VISIBILITY_SAMPLES,
  configureSunDepthCamera,
} from './webgpu-sun-depth-camera.js';

const SHADOW_MAP_SIZE = 512;
const SHADOW_MAP_SPAN_M = 70_000;
const SHADOW_RAY_START_M = 14_000;
const SHADOW_RAY_LENGTH_M = 24_000;
const SHADOW_MARCH_STEPS = 24;
const SHADOW_UPDATE_INTERVAL_S = 0.1;
const OPAQUE_SUN_DEPTH_UPDATE_INTERVAL_S = 0.75;
const SUN_DEPTH_BIAS = 0.00035;

const vectorScratch = new Vector3();
const centerScratch = new Vector3();
const matrixScratch = new Matrix4();

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

function createOpaqueSunDepthTarget() {
  const target = new RenderTarget(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, {
    depthBuffer: true,
    format: RedFormat,
    type: HalfFloatType
  });
  target.texture.name = 'WebGPUOpaqueSunDepth.color';
  target.texture.generateMipmaps = false;
  target.depthTexture = new DepthTexture(
    SHADOW_MAP_SIZE,
    SHADOW_MAP_SIZE,
    UnsignedIntType,
  );
  target.depthTexture.name = 'WebGPUOpaqueSunDepth.depth';
  target.depthTexture.format = DepthFormat;
  return target;
}

export class CloudShadowAtmosphereLightNode extends AtmosphereLightNode {
  static get type() {
    return 'CloudShadowAtmosphereLightNode';
  }

  setupDirect(builder) {
    const directLight = super.setupDirect(builder);
    const cloudShadow = this.light?.cloudShadow;
    const atmosphereContext = this.light?.atmosphereContext;
    if (directLight == null || cloudShadow == null || atmosphereContext == null) {
      return directLight;
    }

    let positionECEF = atmosphereContext.matrixWorldToECEF
      .mul(vec4(positionWorld, 1))
      .xyz;
    if (atmosphereContext.correctAltitude) {
      positionECEF = positionECEF.add(atmosphereContext.altitudeCorrectionECEF);
    }
    directLight.lightColor = directLight.lightColor.mul(
      cloudShadow.getSurfaceSunVisibilityNode(positionECEF, positionWorld)
    );
    return directLight;
  }
}

export class WebGPUCloudShadows {
  constructor({ scene, anchor, east, north, up, camera, atmosphereContext }) {
    this.scene = scene;
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
    this.sunViewProjection = uniform(new Matrix4()).setName('opaqueSunViewProjection');
    this.sunDepthBias = uniform(SUN_DEPTH_BIAS).setName('opaqueSunDepthBias');
    this.shaftsEnabled = uniform(true).setName('atmosphereShaftsEnabled');
    this.shaftStrength = uniform(0.82).setName('atmosphereShaftStrength');
    this.indirectFloor = uniform(0.28).setName('atmosphereShaftIndirectFloor');

    this.renderTarget = createShadowTarget();
    this.material = new NodeMaterial();
    this.material.name = 'WebGPUCloudShadow.opticalDepth';
    this.material.fragmentNode = this.createOpticalDepthNode();
    this.quad = new QuadMesh(this.material);
    this.opaqueSunTarget = createOpaqueSunDepthTarget();
    this.sunCamera = new OrthographicCamera();
    this.sunDepthMaterial = new NodeMaterial();
    this.sunDepthMaterial.name = 'WebGPUOpaqueSunDepth.material';
    this.sunDepthMaterial.fragmentNode = vec4(1);
    this.sunDepthMaterial.fog = false;
    // Must be undefined, not null: three's saveRendererState(renderer, state = {})
    // only substitutes the default object for undefined.
    this.rendererState = undefined;
    this.lastCloudUpdateSeconds = -Infinity;
    this.lastOpaqueUpdateSeconds = -Infinity;
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

  getOpaqueSunVisibilityNode(positionWorld) {
    const clip = this.sunViewProjection.mul(vec4(positionWorld, 1));
    const ndc = clip.xyz.div(clip.w);
    // Render-target textures follow WebGPU's top-left texture convention.
    const shadowUv = vec2(
      ndc.x.mul(0.5).add(0.5),
      ndc.y.mul(-0.5).add(0.5),
    );
    const inside = shadowUv.x.greaterThanEqual(0)
      .and(shadowUv.x.lessThanEqual(1))
      .and(shadowUv.y.greaterThanEqual(0))
      .and(shadowUv.y.lessThanEqual(1))
      .and(ndc.z.greaterThanEqual(0))
      .and(ndc.z.lessThanEqual(1));
    const storedDepth = texture(this.opaqueSunTarget.depthTexture, shadowUv).r;
    const lit = storedDepth.add(this.sunDepthBias).greaterThanEqual(ndc.z);
    return select(inside, select(lit, 1, 0), 1);
  }

  getAtmosphereVisibilityNode(cameraPositionECEF, endPositionECEF) {
    return Fn(() => {
      const visibility = float(0).toVar('atmosphereSunVisibility');
      Loop(ATMOSPHERE_VISIBILITY_SAMPLES, ({ i }) => {
        const amount = float(i).add(0.5).div(ATMOSPHERE_VISIBILITY_SAMPLES);
        const positionECEF = mix(cameraPositionECEF, endPositionECEF, amount);
        const positionWorld = this.atmosphereContext.matrixECEFToWorld
          .mul(vec4(positionECEF, 1)).xyz;
        visibility.addAssign(
          this.getOpaqueSunVisibilityNode(positionWorld)
            .mul(this.getTransmittanceNode(positionECEF)),
        );
      });
      const meanVisibility = visibility.div(ATMOSPHERE_VISIBILITY_SAMPLES);
      const shaftVisibility = mix(
        this.indirectFloor,
        1,
        meanVisibility,
      );
      return select(
        this.shaftsEnabled,
        mix(1, shaftVisibility, this.shaftStrength),
        1,
      );
    })();
  }

  getSurfaceSunVisibilityNode(positionECEF, positionWorld = null) {
    const worldPosition = positionWorld ?? this.atmosphereContext.matrixECEFToWorld
      .mul(vec4(positionECEF, 1)).xyz;
    const opaqueVisibility = select(
      this.shaftsEnabled,
      this.getOpaqueSunVisibilityNode(worldPosition),
      1,
    );
    return opaqueVisibility.mul(this.getTransmittanceNode(positionECEF));
  }

  renderOpaqueSunDepth(renderer) {
    if (!this.scene) return;
    configureSunDepthCamera(this.sunCamera, {
      center: this.shadowCenter.value,
      sunDirection: this.sunDirection.value,
      up: this.shadowUp.value,
      span: this.mapSpan.value,
    });

    const previousOverride = this.scene.overrideMaterial;
    const previousBackground = this.scene.background;
    const previousBackgroundNode = this.scene.backgroundNode;
    const previousShadowAutoUpdate = renderer.shadowMap.autoUpdate;
    this.scene.overrideMaterial = this.sunDepthMaterial;
    this.scene.background = null;
    this.scene.backgroundNode = null;
    renderer.shadowMap.autoUpdate = false;
    try {
      renderer.setClearColor(0xffffff, 1);
      renderer.setRenderTarget(this.opaqueSunTarget);
      renderer.clear();
      renderer.render(this.scene, this.sunCamera);
      this.sunViewProjection.value.copy(
        matrixScratch.multiplyMatrices(
          this.sunCamera.projectionMatrix,
          this.sunCamera.matrixWorldInverse,
        ),
      );
    } finally {
      this.scene.overrideMaterial = previousOverride;
      this.scene.background = previousBackground;
      this.scene.backgroundNode = previousBackgroundNode;
      renderer.shadowMap.autoUpdate = previousShadowAutoUpdate;
    }
  }

  update(renderer, elapsedSeconds) {
    this.driftTime.value = elapsedSeconds;
    if (!this.enabled.value && !this.shaftsEnabled.value) {
      return;
    }
    const updateCloudDepth = this.enabled.value && (
      elapsedSeconds - this.lastCloudUpdateSeconds >= SHADOW_UPDATE_INTERVAL_S
    );
    const updateOpaqueDepth = this.shaftsEnabled.value && (
      elapsedSeconds - this.lastOpaqueUpdateSeconds >= OPAQUE_SUN_DEPTH_UPDATE_INTERVAL_S
    );
    if (!updateCloudDepth && !updateOpaqueDepth) {
      return;
    }
    if (updateCloudDepth) this.lastCloudUpdateSeconds = elapsedSeconds;
    if (updateOpaqueDepth) this.lastOpaqueUpdateSeconds = elapsedSeconds;
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
    try {
      if (updateCloudDepth) {
        renderer.setRenderTarget(this.renderTarget);
        this.quad.render(renderer);
      }
      if (updateOpaqueDepth) {
        this.renderOpaqueSunDepth(renderer);
      }
    } finally {
      RendererUtils.restoreRendererState(renderer, this.rendererState);
    }
  }

  dispose() {
    this.renderTarget.dispose();
    this.opaqueSunTarget.dispose();
    this.material.dispose();
    this.sunDepthMaterial.dispose();
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
      shaftsEnabled: this.shaftsEnabled.value,
      shaftStrength: this.shaftStrength.value,
      indirectFloor: this.indirectFloor.value,
      center: this.shadowCenter.value.toArray(),
      sunDirection: this.sunDirection.value.toArray()
    };
  }
}
