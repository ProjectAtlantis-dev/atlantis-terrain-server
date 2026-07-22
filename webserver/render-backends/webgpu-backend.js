import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { color, densityFogFactor, fog, uniform } from 'three/tsl';
import { createWebGPUAtmosphereController } from './webgpu-atmosphere.js';
import { createWebGPUWater } from './webgpu-water.js';
import { installMaterialKeyMemo } from '../procedural-runtime/render/ThreePatches.ts';
import { installPositionInvariance } from '../procedural-runtime/render/VegPrepass.ts';

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
    // Procedural terrain combines satellite imagery with field/noise maps.
    // WebGPU grants only conservative defaults unless a higher supported
    // limit is requested during device creation.
    requiredLimits: { maxSampledTexturesPerShaderStage: 24 },
  });
  renderer.setSize(width, height);
  renderer.setPixelRatio(pixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.autoUpdate = true;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = toneMappingExposure;
  let postProcessing = null;
  let atmosphere = null;
  let pendingSceneDate = null;
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
      pendingSceneDate = date ?? pendingSceneDate;
      if (ready) {
        atmosphere?.rebuild(pendingSceneDate ?? undefined);
        pendingSceneDate = null;
      }
    },
    setFogDensity(value) { fogDensity.value = value; },
    setMapMode(active) { fogDensity.value = active ? 0 : fogDensity.value; },
    createWater(options) { return createWebGPUWater({ renderer, ...options }); },
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
      // WebGPURenderer does not reliably retain an animation loop installed
      // before its asynchronous init completes. Leave the loop inactive until
      // the ready callback below requests the first render.
      if (!ready || animationLoopActive || demandRendering == null) return;
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
  async function clampRequiredLimits() {
    const requested = renderer.backend?.parameters?.requiredLimits;
    if (requested == null || navigator.gpu == null) return;
    const adapter = await navigator.gpu.requestAdapter().catch(() => null);
    if (adapter == null) return;
    for (const [name, value] of Object.entries(requested)) {
      const supported = adapter.limits[name];
      if (typeof supported === 'number' && value > supported) {
        requested[name] = supported;
        bootLog('renderer.webgpu.limit.clamped', {
          limit: name,
          requested: value,
          supported,
        }, 'warn');
      }
    }
  }

  clampRequiredLimits().then(() => renderer.init()).then(() => {
    // The vegetation depth prepass requires invariant vertex positions, and
    // material-key memoization prevents shadow passes from rehashing the same
    // r184 node graphs for every object.
    installPositionInvariance(renderer);
    installMaterialKeyMemo(renderer);
    const device = renderer.backend?.device;
    device?.addEventListener?.('uncapturederror', event => {
      bootLog('renderer.webgpu.uncaptured', {
        message: event.error?.message ?? String(event.error),
      }, 'error');
    });
    device?.lost?.then(info => {
      bootLog('renderer.webgpu.device.lost', {
        reason: info.reason,
        message: info.message,
      }, 'error');
    });
    ready = true;
    bootLog('renderer.webgpu.ready');
    // Build the atmosphere against the initialized WebGPU device. The removed
    // water runtime used to trigger this rebuild incidentally when it became
    // ready; lighting must not depend on an unrelated optional surface.
    atmosphere?.rebuild?.(pendingSceneDate ?? undefined);
    pendingSceneDate = null;
    backend.requestRender();
  }).catch(error => {
    bootLog('renderer.webgpu.error', {
      message: error?.message ?? String(error),
      stack: error?.stack ?? null,
    }, 'error');
  });
  return backend;
}
