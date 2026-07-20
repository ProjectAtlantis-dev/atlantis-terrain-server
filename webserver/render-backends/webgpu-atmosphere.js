import * as THREE from 'three';
import { mrt, normalView, output, pass } from 'three/tsl';
import { PostProcessing } from 'three/webgpu';
import {
  getECIToECEFRotationMatrix,
  getMoonDirectionECEF,
  getSunDirectionECEF,
} from '@takram/three-atmosphere';
import {
  AtmosphereContextNode,
  AtmosphereLight,
  AtmosphereParameters,
  skyBackground,
} from '@takram/three-atmosphere/webgpu';
import { Ellipsoid } from '@takram/three-geospatial';
import { CloudShadowAtmosphereLightNode, WebGPUCloudShadows } from '../webgpu-cloud-shadows.js';
import { cloudShadowAerialPerspective } from '../webgpu-cloud-shadow-aerial-perspective.js';

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
  let lightNodeRegistered = false;
  let lastDate = new Date();
  let lastSunLogMs = 0;
  let lastSunLogDateMs = NaN;

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
    if (!cloudShadows) return;
    cloudShadows.enabled.value = cloudShadowSettings.enabled;
    cloudShadows.debugSurface.value = cloudShadowSettings.debugSurface;
    cloudShadows.coverage.value = cloudShadowSettings.coverage;
    cloudShadows.density.value = cloudShadowSettings.density;
    cloudShadows.strength.value = cloudShadowSettings.strength;
    cloudShadows.shaftsEnabled.value = cloudShadowSettings.shaftsEnabled;
    cloudShadows.shaftStrength.value = cloudShadowSettings.shaftStrength;
    cloudShadows.indirectFloor.value = cloudShadowSettings.indirectFloor;
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
    postProcessing?.dispose?.();
    postProcessing = null;
    atmosphereNode = null;
    context?.dispose?.();
    context = null;
  }

  function rebuild(date = lastDate) {
    disposePipeline();
    context = createContext();
    skyNode = skyBackground(context);
    scene.backgroundNode = skyNode;
    updateDate(date);
    if (!lightNodeRegistered) {
      const registeredNode = renderer.library.getLightNodeClass(AtmosphereLight);
      if (registeredNode == null) {
        renderer.library.addLight(CloudShadowAtmosphereLightNode, AtmosphereLight);
      } else if (registeredNode !== CloudShadowAtmosphereLightNode) {
        throw new Error(
          `AtmosphereLight already uses ${registeredNode.name}; `
          + `cannot install ${CloudShadowAtmosphereLightNode.name}`,
        );
      }
      lightNodeRegistered = true;
    }
    atmosphereLight = new AtmosphereLight(context, maxViewDistance);
    atmosphereLight.name = 'webgpu-atmosphere-light';
    cloudShadows = new WebGPUCloudShadows({
      scene, anchor, east, north, up, camera, atmosphereContext: context,
    });
    applyCloudShadowSettings();
    atmosphereLight.cloudShadow = cloudShadows;
    scene.add(atmosphereLight);
    scene.add(atmosphereLight.target);
    const scenePass = pass(scene, camera, { samples: 4 });
    scenePass.setMRT(mrt({ output, normal: normalView }));
    postProcessing = new PostProcessing(renderer);
    atmosphereNode = cloudShadowAerialPerspective(
      context,
      scenePass.getTextureNode('output'),
      scenePass.getTextureNode('depth'),
      // Terrain tiles compute normals independently. At cross-LOD boundaries
      // the depth-11 and depth-12 edge normals differ even where the geometry
      // meets exactly, and atmosphere relighting turns that into a dark seam.
      // Use the continuous ellipsoid-normal fallback for direct sun and
      // spectral sky/ambient illumination across all terrain LODs.
      null,
      cloudShadows,
    );
    postProcessing.outputNode = atmosphereNode;
    setPostProcessing(postProcessing);
    applyLiveSettings();
    bootLog('renderer.webgpu.atmosphere.ready');
  }

  return {
    settings, cloudShadowSettings, rebuild, updateDate, applyLiveSettings,
    applyCloudShadowSettings,
    updateCloudShadows(time) { cloudShadows?.update(renderer, time); },
    debugSummary() { return cloudShadows?.debugSummary() ?? null; },
    maybeLogSun,
    sunDebug,
    dispose() { disposePipeline(); scene.backgroundNode = null; },
  };
}
