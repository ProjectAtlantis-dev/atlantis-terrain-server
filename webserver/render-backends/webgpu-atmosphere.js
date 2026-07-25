import * as THREE from 'three';
import {
  context as tslContext,
  mrt,
  normalView,
  output,
  pass,
  renderOutput,
} from 'three/tsl';
import { PostProcessing } from 'three/webgpu';
import {
  getECIToECEFRotationMatrix,
  getMoonDirectionECEF,
  getSunDirectionECEF,
} from '@takram/three-atmosphere';
import {
  AtmosphereContextNode,
  AtmosphereLight,
  AtmosphereLightNode,
  AtmosphereParameters,
  shadowLength,
  sky,
  skyBackground,
  viewZUnit,
} from '@takram/three-atmosphere/webgpu';
import { Ellipsoid } from '@takram/three-geospatial';
import {
  CascadedShadowMapsNode,
  dithering,
  highpVelocity,
  lensFlare,
  temporalAntialias,
} from '@takram/three-geospatial/webgpu';
import {
  CloudBeerShadowMapNode,
  CloudDensityField,
  CloudShapeDetailNode,
  CloudShapeNode,
  LocalWeatherNode,
  TurbulenceNode,
} from '@takram/three-clouds/webgpu';
import { WebGPUCloudShadows } from '../webgpu-cloud-shadows.js';
import { cloudShadowAerialPerspective } from '../webgpu-cloud-shadow-aerial-perspective.js';
import { createCloudGodRayShadowLength } from '../webgpu-cloud-godrays.js';
import { createGroundingNode } from '../webgpu-ground-post.js';

const CSM_REFRESH_POLICY = [
  { driftTexels: 8, vehicleHoldMs: 100, sunRadians: 0.05 * THREE.MathUtils.DEG2RAD, streamHoldMs: 2000, fallbackMs: 5000 },
  { driftTexels: 4, vehicleHoldMs: 250, sunRadians: 0.10 * THREE.MathUtils.DEG2RAD, streamHoldMs: 5000, fallbackMs: 15000 },
  { driftTexels: 2, vehicleHoldMs: 500, sunRadians: 0.20 * THREE.MathUtils.DEG2RAD, streamHoldMs: 10000, fallbackMs: 30000 },
];
const CSM_REASON_RANK = {
  init: 0, recenter: 1, projection: 1, drift: 2, sun: 3,
  vehicle: 4, stream: 5, fallback: 6,
};

export function createWebGPUAtmosphereController({
  renderer, setPostProcessing, scene, camera, anchor, east, north, up, maxViewDistance,
  settings, cloudShadowSettings, bootLog = () => {}, enqueueLog = () => {},
  flushLog = () => {}, performanceImpl = globalThis.performance,
} = {}) {
  let parameters = null;
  let context = null;
  let skyNode = null;
  let atmosphereLight = null;
  let atmosphereNode = null;
  let postProcessing = null;
  let cloudShadows = null;
  let csmShadowNode = null;
  let shadowLengthNode = null;
  let activeShadowLengthNode = null;
  let grounding = null;
  let cloudTextureNodes = [];
  let cloudDensityField = null;
  let beerShadowMap = null;
  let cloudGodRays = null;
  let lastDate = new Date();
  let lastSunLogMs = 0;
  let lastSunLogDateMs = NaN;
  let lastFeatureLogMs = -Infinity;
  let featureFrameLogged = false;
  let csmWaitingLogged = false;
  let cloudComputeFailed = false;
  let csmRefreshOwner = null;
  let csmCascadeState = [];
  let csmSeenSceneVersion = -1;
  let csmSeenProceduralCenter = null;
  let csmSeenFov = -1;
  let csmSeenAspect = -1;
  let csmLastLogMs = -Infinity;
  const csmVehiclePositions = new Map();
  const csmSunDirection = new THREE.Vector3();
  const csmRefreshStats = { count: [0, 0, 0], reasons: {}, deferred: 0 };
  function createContext() {
    parameters = new AtmosphereParameters();
    parameters.luminanceScale *= settings.luminanceScale;
    parameters.rayleighScattering.multiplyScalar(settings.rayleighScale);
    parameters.mieScattering.multiplyScalar(settings.mieScale);
    parameters.mieExtinction.multiplyScalar(settings.mieScale);
    parameters.groundAlbedo.setScalar(settings.groundAlbedo);
    const nextContext = new AtmosphereContextNode(parameters);
    nextContext.camera = camera;
    nextContext.ellipsoid = Ellipsoid.WGS84;
    nextContext.matrixWorldToECEF.value.identity();
    return nextContext;
  }

  function sunDebug(date, source = 'update') {
    const sun = context?.sunDirectionECEF?.value;
    if (!sun) return { source, date: date?.toISOString?.() ?? String(date), hasSun: false };
    const eastDot = sun.dot(east);
    const northDot = sun.dot(north);
    const upDot = sun.dot(up);
    return {
      source, date: date.toISOString(),
      ecef: { x: +sun.x.toFixed(6), y: +sun.y.toFixed(6), z: +sun.z.toFixed(6) },
      local: {
        east: +eastDot.toFixed(6), north: +northDot.toFixed(6), up: +upDot.toFixed(6),
        azimuthDeg: +(((Math.atan2(eastDot, northDot) * 180 / Math.PI + 360) % 360).toFixed(2)),
        elevationDeg: +(Math.asin(THREE.MathUtils.clamp(upDot, -1, 1)) * 180 / Math.PI).toFixed(2),
      },
    };
  }

  function maybeLogSun(date, source = 'update', force = false) {
    if (!context) return;
    const now = performanceImpl.now();
    const dateMs = date.getTime();
    if (!force && now - lastSunLogMs < 5000 && Math.abs(dateMs - lastSunLogDateMs) < 600000) return;
    lastSunLogMs = now;
    lastSunLogDateMs = dateMs;
    enqueueLog('info', 'webgpu.sun', sunDebug(date, source));
    if (force) flushLog();
  }

  function updateDate(date, sunDirectionSource = null) {
    if (!context) return;
    lastDate = new Date(date);
    const { matrixECIToECEF, sunDirectionECEF, moonDirectionECEF } = context;
    getECIToECEFRotationMatrix(date, matrixECIToECEF.value);
    if (sunDirectionSource) sunDirectionECEF.value.copy(sunDirectionSource);
    else getSunDirectionECEF(date, sunDirectionECEF.value);
    getMoonDirectionECEF(date, moonDirectionECEF.value);
    maybeLogSun(date);
  }

  function applyCloudShadowSettings() {
    if (cloudShadows) {
      cloudShadows.enabled.value = cloudShadowSettings.enabled;
      cloudShadows.debugSurface.value = cloudShadowSettings.debugSurface;
      cloudShadows.coverage.value = cloudShadowSettings.coverage;
      cloudShadows.density.value = cloudShadowSettings.density;
      cloudShadows.strength.value = cloudShadowSettings.strength;
    }
    if (cloudDensityField) {
      cloudDensityField.coverage.value = cloudShadowSettings.coverage;
      const scale = cloudShadowSettings.density;
      const layers = cloudDensityField.layers;
      cloudDensityField.densityScales.value.set(
        layers[0].densityScale * scale,
        layers[1].densityScale * scale,
        layers[2].densityScale * scale,
        layers[3].densityScale * scale,
      );
    }
    if (cloudGodRays?.uniforms?.uStrength) {
      cloudGodRays.uniforms.uStrength.value = cloudShadowSettings.enabled
        ? cloudShadowSettings.strength
        : 0;
    }
  }

  function applyLiveSettings() {
    renderer.toneMappingExposure = settings.toneMappingExposure;
    for (const sun of [skyNode?.sunNode, atmosphereNode?.skyNode?.sunNode]) {
      if (!sun) continue;
      sun.angularRadius.value = settings.sunAngularRadius;
      sun.intensity.value = settings.sunIntensity;
    }
  }

  function disposePipeline() {
    if (atmosphereLight) {
      scene.remove(atmosphereLight.target);
      scene.remove(atmosphereLight);
      atmosphereLight = null;
    }
    cloudShadows?.dispose();
    cloudShadows = null;
    shadowLengthNode?.dispose?.();
    shadowLengthNode = null;
    activeShadowLengthNode = null;
    csmShadowNode?.dispose?.();
    csmShadowNode = null;
    grounding = null;
    beerShadowMap?.dispose?.();
    beerShadowMap = null;
    cloudDensityField = null;
    cloudTextureNodes = [];
    cloudGodRays = null;
    cloudComputeFailed = false;
    featureFrameLogged = false;
    csmWaitingLogged = false;
    csmRefreshOwner = null;
    csmCascadeState = [];
    csmVehiclePositions.clear();
    postProcessing?.dispose?.();
    postProcessing = null;
    atmosphereNode = null;
    context?.dispose?.();
    context = null;
  }

  function rebuild(date = lastDate) {
    disposePipeline();
    context = createContext();
    renderer.contextNode = tslContext({
      ...renderer.contextNode.value,
      getAtmosphere: () => context,
    });
    skyNode = skyBackground();
    scene.backgroundNode = skyNode;
    updateDate(date);
    renderer.library.addLight(AtmosphereLightNode, AtmosphereLight);
    atmosphereLight = new AtmosphereLight(maxViewDistance);
    atmosphereLight.name = 'webgpu-atmosphere-light';
    atmosphereLight.castShadow = true;
    atmosphereLight.shadow.mapSize.set(2048, 2048);
    atmosphereLight.shadow.bias = 1e-4;
    atmosphereLight.shadow.camera.near = 0;
    atmosphereLight.shadow.camera.far = 3e5;
    const bootQuery = globalThis.__BOOT_QUERY instanceof URLSearchParams
      ? globalThis.__BOOT_QUERY
      : new URLSearchParams();
    if (bootQuery.get('csm') !== '0') {
      csmShadowNode = new CascadedShadowMapsNode(atmosphereLight, {
        cascades: 3,
        maxFar: maxViewDistance,
        mode: 'custom',
        lightMargin: 1e5,
        customSplitsCallback(cascades, near, far, target) {
          const splitsM = [500, 8000];
          let previous = 0;
          for (let index = 0; index < cascades - 1; index++) {
            const fraction = Math.min(
              Math.max((splitsM[index] ?? far) / far, previous + 1e-4),
              1,
            );
            target.push(fraction);
            previous = fraction;
          }
          target.push(1);
        },
      });
      csmShadowNode.fade = false;
      atmosphereLight.shadow.shadowNode = csmShadowNode;
    }
    cloudShadows = new WebGPUCloudShadows({
      anchor, east, north, up, camera, atmosphereContext: context,
    });
    applyCloudShadowSettings();
    // Keep the cloud lookup in one post pass. Attaching it to the light
    // duplicates the node graph into every lit material and was the source
    // of the severe WebGPU slowdown in the monolithic implementation.
    scene.add(atmosphereLight);
    scene.add(atmosphereLight.target);
    // Temporal AA replaces MSAA and stabilizes the epipolar shadow samples.
    const scenePass = pass(scene, camera, { samples: 0 });
    const useTerrainSlopes = settings.terrainNormalMode === 'geometry';
    const sceneOutputs = { output, velocity: highpVelocity, viewZUnit };
    if (useTerrainSlopes) sceneOutputs.normal = normalView;
    scenePass.setMRT(mrt(sceneOutputs));
    const colorNode = scenePass.getTextureNode('output');
    const depthNode = scenePass.getTextureNode('depth');
    const velocityNode = scenePass.getTextureNode('velocity');
    const lightingNormalNode = useTerrainSlopes
      ? scenePass.getTextureNode('normal')
      : null;
    const viewZUnitNode = scenePass.getTextureNode('viewZUnit');
    viewZUnitNode.value.format = THREE.RedFormat;
    if (csmShadowNode) {
      shadowLengthNode = shadowLength(csmShadowNode, viewZUnitNode);
      shadowLengthNode.autoSampleResolution = false;
      shadowLengthNode.epipolarSliceCount.value = 256;
      shadowLengthNode.maxSliceSampleCount.value = 128;
    }
    activeShadowLengthNode = shadowLengthNode;
    if (shadowLengthNode && bootQuery.get('cloudGodRays') !== '0') {
      cloudTextureNodes = [
        new LocalWeatherNode(),
        new CloudShapeNode(),
        new CloudShapeDetailNode(),
        new TurbulenceNode(),
      ];
      for (const node of cloudTextureNodes) node.autoDispatch = false;
      cloudDensityField = new CloudDensityField({
        localWeatherNode: cloudTextureNodes[0].getTextureNode(),
        shapeNode: cloudTextureNodes[1].getTextureNode(),
        shapeDetailNode: cloudTextureNodes[2].getTextureNode(),
        turbulenceNode: cloudTextureNodes[3].getTextureNode(),
      });
      beerShadowMap = new CloudBeerShadowMapNode(camera, cloudDensityField);
      beerShadowMap.maxFar = maxViewDistance;
      cloudGodRays = createCloudGodRayShadowLength({
        csmShadowLengthNode: shadowLengthNode,
        beerShadowMap,
        depthNode,
        camera,
        atmosphereContext: context,
        worldToUnit: parameters.worldToUnit,
        fullRes: bootQuery.get('cloudGodRaysFull') === '1',
      });
      activeShadowLengthNode = cloudGodRays.node;
    }
    applyCloudShadowSettings();
    grounding = createGroundingNode({
      colorNode,
      depthNode,
      camera,
      getSunDirectionECEF: () => context?.sunDirectionECEF?.value ?? null,
      enabled: {
        gtao: bootQuery.get('gtao') !== '0',
        contact: bootQuery.get('contact') !== '0',
      },
      fullRes: bootQuery.get('groundingFull') === '1',
    });
    postProcessing = new PostProcessing(renderer);
    atmosphereNode = cloudShadowAerialPerspective(
      grounding.node,
      depthNode,
      // Smooth-globe mode preserves the old seam-hiding fallback. Terrain-
      // slopes mode exposes the real view-space geometry normals so the two
      // lighting models can be compared live from Scene settings.
      lightingNormalNode,
      cloudShadows,
    );
    atmosphereNode.inscattering = settings.aerialInscattering !== false;
    atmosphereNode.transmittance = settings.aerialTransmittance !== false;
    atmosphereNode.shadowLengthNode = activeShadowLengthNode;
    atmosphereNode.skyNode = sky(activeShadowLengthNode);
    const lensFlareNode = lensFlare(atmosphereNode);
    const antialiasedNode = temporalAntialias(
      lensFlareNode,
      depthNode,
      velocityNode,
      camera,
    );
    // RenderPipeline normally appends its own renderer output transform. Keep
    // that automation disabled here because dithering belongs after the one
    // and only HDR -> AgX -> output-colour conversion, not before it.
    postProcessing.outputColorTransform = false;
    postProcessing.outputNode = renderOutput(
      antialiasedNode,
      THREE.AgXToneMapping,
      renderer.outputColorSpace,
    ).add(dithering);
    setPostProcessing(postProcessing);
    applyLiveSettings();
    bootLog('renderer.webgpu.atmosphere.ready', {
      csmCascades: csmShadowNode?.cascades ?? 0,
      csmMaxFar: csmShadowNode?.maxFar ?? 0,
      godRays: shadowLengthNode != null,
      cloudGodRays: cloudGodRays != null,
      gtao: bootQuery.get('gtao') !== '0',
      contactShadows: bootQuery.get('contact') !== '0',
      antialiasing: 'temporal',
      lensFlare: true,
      cloudSurfaceShadows: cloudShadowSettings.enabled,
      terrainNormalMode: settings.terrainNormalMode,
      aerialInscattering: atmosphereNode.inscattering,
      aerialTransmittance: atmosphereNode.transmittance,
      outputPipeline: 'hdr-atmosphere>taa>agx>output-color>dither',
      toneMappingPasses: 1,
    });
  }

  function updateShadowBudget({
    sceneVersion = 0,
    proceduralCenter = null,
    vehicles = [],
    traversalSpeedMps = 0,
  } = {}) {
    const csm = csmShadowNode;
    const lights = csm?.lights;
    if (!csm || !Array.isArray(lights) || lights.length === 0) {
      if (csm && !csmWaitingLogged) {
        csmWaitingLogged = true;
        bootLog('webgpu.csm.waiting', { reason: 'cascade-lights-not-materialized' });
      }
      return;
    }
    csmWaitingLogged = false;
    const nowMs = performanceImpl.now();
    if (csmRefreshOwner !== csm) {
      csmRefreshOwner = csm;
      csmCascadeState = [];
      csmSeenSceneVersion = sceneVersion;
      csmSeenProceduralCenter = proceduralCenter;
      csmSeenFov = camera.fov;
      csmSeenAspect = camera.aspect;
      csmRefreshStats.count = [0, 0, 0];
      csmRefreshStats.reasons = {};
      csmRefreshStats.deferred = 0;
    }

    const castersChanged = sceneVersion !== csmSeenSceneVersion;
    csmSeenSceneVersion = sceneVersion;
    let globalReason = null;
    if (proceduralCenter !== csmSeenProceduralCenter) {
      csmSeenProceduralCenter = proceduralCenter;
      globalReason = 'recenter';
    }
    if (camera.fov !== csmSeenFov || camera.aspect !== csmSeenAspect) {
      csmSeenFov = camera.fov;
      csmSeenAspect = camera.aspect;
      if (csm.camera) csm.updateFrustums();
      globalReason = 'projection';
    }

    let vehicleMoved = false;
    for (const vehicle of vehicles) {
      if (!vehicle?.loaded || !Array.isArray(vehicle.position)) continue;
      const current = new THREE.Vector3().fromArray(vehicle.position);
      const previous = csmVehiclePositions.get(vehicle.id);
      if (!previous || previous.distanceToSquared(current) > 0.05 * 0.05) {
        csmVehiclePositions.set(vehicle.id, current);
        vehicleMoved = true;
      }
    }
    csmSunDirection.copy(context.sunDirectionECEF.value).normalize();
    const traversalActive = traversalSpeedMps > 0.5;
    const candidates = [];
    for (let index = 0; index < lights.length; index++) {
      const light = lights[index];
      const shadow = light?.shadow;
      if (!shadow) continue;
      shadow.autoUpdate = false;
      const policy = CSM_REFRESH_POLICY[Math.min(index, CSM_REFRESH_POLICY.length - 1)];
      let state = csmCascadeState[index];
      if (!state) {
        state = csmCascadeState[index] = {
          fitPosition: new THREE.Vector3(),
          sunDirection: new THREE.Vector3(),
          lastMs: -Infinity,
          rendered: false,
          dirtyStream: false,
          dirtyGlobal: null,
          dirtyVehicle: false,
        };
      }
      if (castersChanged) state.dirtyStream = true;
      if (globalReason && state.rendered) state.dirtyGlobal = globalReason;
      if (vehicleMoved && index === 0) state.dirtyVehicle = true;
      let reason = state.rendered ? state.dirtyGlobal : 'init';
      const shadowCamera = shadow.camera;
      const texel = Number.isFinite(shadowCamera?.right) && Number.isFinite(shadowCamera?.left)
        ? (shadowCamera.right - shadowCamera.left) / shadow.mapSize.x
        : 0;
      const driftThreshold = traversalActive ? policy.driftTexels : 2;
      if (!reason && texel > 0
          && light.position.distanceTo(state.fitPosition) > driftThreshold * texel) {
        reason = 'drift';
      }
      if (!reason && csmSunDirection.angleTo(state.sunDirection) > policy.sunRadians) {
        reason = 'sun';
      }
      if (!reason && state.dirtyVehicle
          && nowMs - state.lastMs >= policy.vehicleHoldMs) reason = 'vehicle';
      if (!reason && state.dirtyStream
          && nowMs - state.lastMs >= policy.streamHoldMs) reason = 'stream';
      if (!reason && nowMs - state.lastMs >= policy.fallbackMs) reason = 'fallback';
      if (reason) candidates.push({ index, light, shadow, state, reason });
    }
    candidates.sort((a, b) =>
      (CSM_REASON_RANK[a.reason] ?? 9) - (CSM_REASON_RANK[b.reason] ?? 9)
      || a.state.lastMs - b.state.lastMs);
    let granted = 0;
    for (const candidate of candidates) {
      const initial = candidate.reason === 'init';
      if (!initial && granted >= 1) {
        csmRefreshStats.deferred++;
        continue;
      }
      if (!initial) granted++;
      candidate.shadow.needsUpdate = true;
      candidate.state.rendered = true;
      candidate.state.dirtyStream = false;
      candidate.state.dirtyGlobal = null;
      candidate.state.dirtyVehicle = false;
      candidate.state.lastMs = nowMs;
      candidate.state.fitPosition.copy(candidate.light.position);
      candidate.state.sunDirection.copy(csmSunDirection);
      csmRefreshStats.count[candidate.index] =
        (csmRefreshStats.count[candidate.index] ?? 0) + 1;
      csmRefreshStats.reasons[candidate.reason] =
        (csmRefreshStats.reasons[candidate.reason] ?? 0) + 1;
    }
    if (nowMs - csmLastLogMs >= 5000) {
      csmLastLogMs = nowMs;
      enqueueLog('info', 'webgpu.csm.refresh', {
        mode: 'invalidation-budgeted',
        budgetPerFrame: 1,
        lightsReady: lights.length,
        refreshCount: [...csmRefreshStats.count],
        reasons: { ...csmRefreshStats.reasons },
        deferred: csmRefreshStats.deferred,
      });
    }
  }

  return {
    settings, cloudShadowSettings, rebuild, updateDate, applyLiveSettings,
    applyCloudShadowSettings,
    getLight() { return atmosphereLight; },
    getCSM() { return csmShadowNode; },
    updateShadowBudget,
    updateCloudShadows(time) {
      if (!featureFrameLogged) {
        featureFrameLogged = true;
        bootLog('webgpu.frame.features.started', {
          cloudTextures: cloudTextureNodes.length,
          csmConfigured: csmShadowNode != null,
          godRays: cloudGodRays != null,
        });
      }
      cloudShadows?.update(renderer, time);
      if (!cloudComputeFailed) {
        try {
          for (const node of cloudTextureNodes) node.dispatch(renderer);
          const bootQuery = globalThis.__BOOT_QUERY;
          if (bootQuery?.get?.('bsmFreeze') !== '1') beerShadowMap?.update(renderer);
        } catch (error) {
          cloudComputeFailed = true;
          bootLog('webgpu.cloud.compute.error', {
            message: error?.message ?? String(error),
            stack: error?.stack ?? null,
          }, 'error');
          flushLog();
        }
      }
      const now = performanceImpl.now();
      if (now - lastFeatureLogMs >= 5000) {
        lastFeatureLogMs = now;
        enqueueLog('info', 'webgpu.features.live', {
          csmConfigured: csmShadowNode != null,
          csmCascades: csmShadowNode?.cascades ?? 0,
          csmLightsReady: csmShadowNode?.lights?.length ?? 0,
          godRays: shadowLengthNode != null,
          cloudGodRays: cloudGodRays != null,
          cloudTexturesReady: cloudTextureNodes.map(node => node.computeDispatched === true),
          beerShadowDispatches: beerShadowMap?.dispatchCount ?? 0,
          cloudComputeFailed,
          cloudSurfaceShadows: Boolean(cloudShadows?.enabled?.value),
          gtaoStrength: grounding?.uniforms?.uAoStrength?.value ?? null,
          contactStrength: grounding?.uniforms?.uContactStrength?.value ?? null,
          terrainNormalMode: settings.terrainNormalMode,
          aerialInscattering: atmosphereNode?.inscattering ?? null,
          aerialTransmittance: atmosphereNode?.transmittance ?? null,
          outputPipeline: 'single-agx-after-taa',
        });
      }
    },
    debugSummary() {
      return {
        cloudShadows: cloudShadows?.debugSummary() ?? null,
        csmCascades: csmShadowNode?.cascades ?? 0,
        grounding: grounding?.uniforms ?? null,
        godRays: shadowLengthNode != null,
        cloudGodRays: cloudGodRays?.uniforms ?? null,
        beerShadowDispatches: beerShadowMap?.dispatchCount ?? 0,
        terrainNormalMode: settings.terrainNormalMode,
        aerialInscattering: atmosphereNode?.inscattering ?? null,
        aerialTransmittance: atmosphereNode?.transmittance ?? null,
      };
    },
    maybeLogSun,
    sunDebug,
    dispose() { disposePipeline(); scene.backgroundNode = null; },
  };
}
