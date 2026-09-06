import * as THREE from 'three';
import {
  EffectComposer,
  EffectPass,
  NormalPass,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
} from 'postprocessing';
import { DitheringEffect } from '../three-geospatial/packages/effects/src/index.ts';
import { createWebGLWater } from './webgl-water.js';
import { TerrainSunFlareEffect } from '../terrain-sun-flare-effect.js';
import { createWebGLGpuProfiler } from '../webgl-gpu-profiler.js';

export function createTerrainBackend({
  width,
  height,
  pixelRatio,
  toneMappingExposure = 10,
  gpuProfilerEnabled = false,
  scene,
  bootLog = () => {},
} = {}) {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    // The composited path never needs canvas depth — EffectComposer renders
    // into its own depth-equipped targets and the final pass is a flat blit.
    // renderMap()/renderScene() callers that bypass the composer draw straight
    // to the canvas, though, and with depth:false those get no depth test at
    // all: geometry simply paints in draw order. Retro mode's hidden-surface
    // removal depends on this attachment existing.
    depth: true,
    logarithmicDepthBuffer: true,
  });
  renderer.setSize(width, height);
  renderer.setPixelRatio(pixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = true;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = toneMappingExposure;
  const gpuProfiler = createWebGLGpuProfiler(renderer, { enabled: gpuProfilerEnabled });
  let composer = null;
  let atmospherePass = null;
  let cloudsEffectRef = null;
  let aerialPerspectiveRef = null;
  let takramCloudsEnabled = true;
  // HDR lens flare from the sun disk. Created here, before the
  // composer, so the tuning UI can bind to it ahead of pipeline configure.
  const lensFlare = new TerrainSunFlareEffect();
  let demandRendering = null;
  let animationLoopActive = false;
  let sceneMutationVersion = 0;
  const sceneFog = new THREE.FogExp2(0x000000, 0.00009);
  scene.fog = sceneFog;

  function renderDiagnosticOverlay(overlayScene, camera) {
    if (overlayScene == null) return;
    const previousAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    try {
      renderer.render(overlayScene, camera);
    } finally {
      renderer.autoClear = previousAutoClear;
    }
  }

  bootLog('renderer.ready', {
    backend: 'webgl', width, height, pixelRatio,
    shadowMap: renderer.shadowMap.type,
    logarithmicDepthBuffer: renderer.capabilities.logarithmicDepthBuffer,
    toneMapping: 'agx', toneMappingExposure,
  });

  const backend = {
    kind: 'webgl',
    defaultFogStrength: 4.5,
    renderer,
    gpuProfiler,
    lensFlare,
    get takramCloudsEnabled() { return takramCloudsEnabled; },
    get sceneMutationVersion() { return sceneMutationVersion; },
    setFogDensity(value) { sceneFog.density = value; },
    setMapMode(active) { scene.fog = active ? null : sceneFog; },
    createWater(options) { return createWebGLWater({ renderer, gpuProfiler, ...options }); },
    prepareUntexturedTerrain(mesh) {
      if (!mesh?.material || mesh.material.map) return;
      if (!mesh.material.vertexColors) {
        mesh.material.vertexColors = true;
        mesh.material.needsUpdate = true;
      }
      mesh.material.color.set(0xffffff);
      backend.markSceneMutated();
    },
    setTakramCloudsEnabled(enabled) {
      takramCloudsEnabled = Boolean(enabled);
      if (atmospherePass != null && cloudsEffectRef != null && aerialPerspectiveRef != null) {
        if (takramCloudsEnabled) {
          aerialPerspectiveRef.overlay = cloudsEffectRef.atmosphereOverlay;
          aerialPerspectiveRef.shadow = cloudsEffectRef.atmosphereShadow;
          aerialPerspectiveRef.shadowLength = cloudsEffectRef.atmosphereShadowLength;
          atmospherePass.setEffects([cloudsEffectRef, aerialPerspectiveRef]);
        } else {
          aerialPerspectiveRef.overlay = null;
          aerialPerspectiveRef.shadow = null;
          aerialPerspectiveRef.shadowLength = null;
          atmospherePass.setEffects([aerialPerspectiveRef]);
        }
        atmospherePass.recompile();
      }
      bootLog('clouds.takram.toggle', { enabled: takramCloudsEnabled });
      backend.markSceneMutated();
      backend.requestRender();
    },
    configureScenePipeline({ scene, camera, normalPass, cloudsEffect, aerialPerspective, sunDirection, up }) {
      lensFlare.configure({ camera, sunDirection, surfaceUp: up });
      cloudsEffectRef = cloudsEffect;
      aerialPerspectiveRef = aerialPerspective;
      // IMPORTANT — verified visual regression fix:
      // postprocessing decodes logarithmic depth in readDepth(), while the
      // pinned three-geospatial shader applies reverseLogDepth() again. Keep
      // this WebGL-only patch unless both dependencies are upgraded and the
      // reconstructed world positions are re-verified. The obvious symptom
      // when this is removed is broken Takram clouds: their god rays and cloud
      // shadows project onto a vertical curtain instead of across the terrain.
      aerialPerspective.setFragmentShader(
        aerialPerspective.getFragmentShader().replace(
          'depth = reverseLogDepth(depth, cameraNear, cameraFar);',
          '',
        ),
      );
      composer = new EffectComposer(renderer, {
        frameBufferType: THREE.HalfFloatType,
        multisampling: Math.min(4, renderer.capabilities.maxSamples),
      });
      const scenePass = gpuProfiler.wrapPass(new RenderPass(scene, camera), 'scene+shadows');
      const cloudProfileOptions = {
        level: 'detail',
        parent: 'clouds+aerial-perspective',
      };
      gpuProfiler.wrapPass(
        cloudsEffect.shadowPass.currentPass,
        'takram.shadow-march',
        cloudProfileOptions,
      );
      gpuProfiler.wrapPass(
        cloudsEffect.shadowPass.resolvePass,
        'takram.shadow-resolve',
        cloudProfileOptions,
      );
      gpuProfiler.wrapPass(
        cloudsEffect.cloudsPass.currentPass,
        'takram.cloud-march',
        cloudProfileOptions,
      );
      gpuProfiler.wrapPass(
        cloudsEffect.cloudsPass.resolvePass,
        'takram.cloud-resolve',
        cloudProfileOptions,
      );
      atmospherePass = gpuProfiler.wrapPass(
        new EffectPass(camera, cloudsEffect, aerialPerspective),
        'clouds+aerial-perspective',
      );
      composer.addPass(scenePass);
      composer.addPass(gpuProfiler.wrapPass(normalPass, 'normal-buffer'));
      composer.addPass(atmospherePass);
      if (!takramCloudsEnabled) {
        aerialPerspective.overlay = null;
        aerialPerspective.shadow = null;
        aerialPerspective.shadowLength = null;
        atmospherePass.setEffects([aerialPerspective]);
        atmospherePass.recompile();
      }
      // Lens flare runs on the HDR frame AFTER sky/clouds (so the sun disk
      // exists in the buffer) and BEFORE tone mapping. The source is sampled
      // at the sun's projected position in the current scene frame.
      const finalPass = gpuProfiler.wrapPass(new EffectPass(
        camera,
        lensFlare,
        new ToneMappingEffect({ mode: ToneMappingMode.AGX }),
        new DitheringEffect(),
      ), 'lens-flare+tone-map+dither');
      composer.addPass(finalPass);
      bootLog('composer.ready', { passCount: composer.passes.length });
    },
    resize(nextWidth, nextHeight) {
      renderer.setSize(nextWidth, nextHeight);
      composer?.setSize(nextWidth, nextHeight);
    },
    renderMap(scene, camera, background, overlayScene = null) {
      const previousBackground = scene.background;
      scene.background = background;
      try {
        renderer.render(scene, camera);
        renderDiagnosticOverlay(overlayScene, camera);
      } finally {
        scene.background = previousBackground;
      }
    },
    renderScene(scene, camera, overlayScene = null) {
      composer?.render();
      renderDiagnosticOverlay(overlayScene, camera);
    },
    beginFrameProfile() { gpuProfiler.beginFrame(); },
    endFrameProfile() { gpuProfiler.endFrame(); },
    configureDemandRendering(configuration) { demandRendering = configuration; },
    startRenderLoop() {
      if (animationLoopActive || demandRendering == null) return;
      animationLoopActive = true;
      demandRendering.onStart?.();
      renderer.setAnimationLoop(demandRendering.render);
    },
    requestRender() { backend.startRenderLoop(); },
    markSceneMutated() { sceneMutationVersion += 1; },
    stopRenderLoopIfIdle() { return false; },
    dispose() {
      renderer.setAnimationLoop(null);
      animationLoopActive = false;
      composer?.dispose?.();
      gpuProfiler.dispose();
      renderer.dispose();
    },
  };
  return backend;
}
