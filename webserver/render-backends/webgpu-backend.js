import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { color, densityFogFactor, fog, uniform } from 'three/tsl';
import { createWebGPUAtmosphereController } from './webgpu-atmosphere.js';

/**
 * Create the WebGPU renderer adapter used by the shared terrain application.
 * Atmosphere node construction remains outside temporarily and is attached via
 * setPostProcessing() until it moves behind this backend as well.
 */
export function createTerrainBackend({
  width,
  height,
  pixelRatio,
  toneMappingExposure,
  scene,
  bootLog = () => {},
} = {}) {
  const renderer = new WebGPURenderer({
    antialias: true,
    samples: 4,
    depth: true,
    logarithmicDepthBuffer: true,
  });
  renderer.setSize(width, height);
  renderer.setPixelRatio(pixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.autoUpdate = true;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = toneMappingExposure;
  let postProcessing = null;
  let atmosphere = null;
  let ready = false;
  let animationLoopActive = false;
  let sceneMutationVersion = 0;
  let demandRendering = null;
  const fogDensity = uniform(0).setName('webgpuDistanceFogDensity');
  scene.fog = null;
  scene.fogNode = fog(color(0x000000), densityFogFactor(fogDensity));

  bootLog('renderer.ready', {
    backend: 'webgpu', width, height, pixelRatio,
    shadowMap: renderer.shadowMap.type,
    logarithmicDepthBuffer: renderer.logarithmicDepthBuffer,
    toneMapping: 'agx', toneMappingExposure,
  });

  const backend = {
    kind: 'webgpu',
    defaultFogStrength: 6.5,
    renderer,
    get ready() { return ready; },
    get animationLoopActive() { return animationLoopActive; },
    get sceneMutationVersion() { return sceneMutationVersion; },
    createAtmosphere(options) {
      atmosphere = createWebGPUAtmosphereController({
        ...options,
        renderer,
        setPostProcessing(nextPostProcessing) { postProcessing = nextPostProcessing; },
      });
      return atmosphere;
    },
    configureScenePipeline({ date }) {
      atmosphere?.rebuild(date);
    },
    setFogDensity(value) { fogDensity.value = value; },
    setMapMode(active) { fogDensity.value = active ? 0 : fogDensity.value; },
    prepareUntexturedTerrain(mesh) {
      if (!mesh?.material || mesh.material.map) return;
      let needsUpdate = false;
      if (mesh.material.vertexColors) {
        mesh.material.vertexColors = false;
        needsUpdate = true;
      }
      mesh.material.color.set(0x29313a);
      if (needsUpdate) {
        mesh.material.needsUpdate = true;
      }
      backend.markSceneMutated();
    },
    resize(nextWidth, nextHeight) {
      renderer.setSize(nextWidth, nextHeight);
    },
    renderMap(scene, camera, background) {
      if (!ready) return;
      const previousBackground = scene.background;
      const previousBackgroundNode = scene.backgroundNode;
      scene.background = background;
      scene.backgroundNode = null;
      try {
        renderer.render(scene, camera);
      } finally {
        scene.background = previousBackground;
        scene.backgroundNode = previousBackgroundNode;
      }
    },
    renderScene(scene, camera) {
      if (!ready) return;
      if (postProcessing != null) postProcessing.render();
      else renderer.render(scene, camera);
    },
    configureDemandRendering(configuration) {
      demandRendering = configuration;
    },
    markSceneMutated() {
      sceneMutationVersion += 1;
    },
    startRenderLoop() {
      if (animationLoopActive || demandRendering == null) return;
      animationLoopActive = true;
      demandRendering.onStart?.();
      renderer.setAnimationLoop(demandRendering.render);
    },
    requestRender() {
      backend.startRenderLoop();
    },
    stopRenderLoopIfIdle() {
      if (
        !animationLoopActive ||
        demandRendering == null ||
        demandRendering.needsContinuousRender()
      ) return false;
      animationLoopActive = false;
      renderer.setAnimationLoop(null);
      demandRendering.onIdle?.();
      return true;
    },
    dispose() {
      renderer.setAnimationLoop(null);
      animationLoopActive = false;
      atmosphere?.dispose?.();
      postProcessing?.dispose?.();
      renderer.dispose();
    },
  };
  renderer.init().then(() => {
    ready = true;
    bootLog('renderer.webgpu.ready');
    // Build the atmosphere against the initialized WebGPU device. The removed
    // water runtime used to trigger this rebuild incidentally when it became
    // ready; lighting must not depend on an unrelated optional surface.
    atmosphere?.rebuild?.();
    backend.requestRender();
  }).catch(error => {
    bootLog('renderer.webgpu.error', {
      message: error?.message ?? String(error),
      stack: error?.stack ?? null,
    }, 'error');
  });
  return backend;
}
