import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { color, densityFogFactor, fog, uniform } from 'three/tsl';
import { NormalPass } from 'postprocessing';

/**
 * Create the WebGPU renderer adapter used by the shared terrain application.
 * Atmosphere node construction remains outside temporarily and is attached via
 * setPostProcessing() until it moves behind this backend as well.
 */
export function createWebGPUTerrainBackend({
  width,
  height,
  pixelRatio,
  toneMappingExposure,
  bootLog = () => {},
} = {}) {
  const renderer = new WebGPURenderer({
    antialias: true,
    samples: 4,
    depth: true,
    logarithmicDepthBuffer: false,
  });
  renderer.setSize(width, height);
  renderer.setPixelRatio(pixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.autoUpdate = true;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = toneMappingExposure;
  let composer = null;
  let postProcessing = null;
  let ready = false;
  let animationLoopActive = false;
  let sceneMutationVersion = 0;
  let demandRendering = null;

  bootLog('renderer.ready', {
    backend: 'webgpu', width, height, pixelRatio,
    shadowMap: renderer.shadowMap.type,
  });

  const backend = {
    kind: 'webgpu',
    isWebGPU: true,
    renderer,
    get ready() { return ready; },
    get animationLoopActive() { return animationLoopActive; },
    get sceneMutationVersion() { return sceneMutationVersion; },
    setComposer(nextComposer) { composer = nextComposer; },
    setPostProcessing(nextPostProcessing) { postProcessing = nextPostProcessing; },
    createNormalPass(scene, camera) { return new NormalPass(scene, camera); },
    configureFog(scene) {
      const density = uniform(0).setName('webgpuDistanceFogDensity');
      scene.fog = null;
      scene.fogNode = fog(color(0x000000), densityFogFactor(density));
      return density;
    },
    prepareAerialPerspective() {},
    async initialize() {
      try {
        await renderer.init();
        ready = true;
        bootLog('renderer.webgpu.ready');
      } catch (error) {
        bootLog('renderer.webgpu.error', {
          message: error?.message ?? String(error),
          stack: error?.stack ?? null,
        }, 'error');
      }
    },
    resize(nextWidth, nextHeight) {
      renderer.setSize(nextWidth, nextHeight);
      composer?.setSize(nextWidth, nextHeight);
    },
    renderMap(scene, camera) {
      if (ready) renderer.render(scene, camera);
    },
    renderScene(scene, camera) {
      if (!ready) return;
      if (postProcessing != null) postProcessing.render();
      else renderer.render(scene, camera);
    },
    setAnimationLoop(callback) {
      renderer.setAnimationLoop(callback);
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
      postProcessing?.dispose?.();
      composer?.dispose?.();
      renderer.dispose();
    },
  };
  return backend;
}
