import * as THREE from 'three';
import {
  EffectComposer,
  EffectPass,
  NormalPass,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
} from 'postprocessing';
import { DitheringEffect, LensFlareEffect } from '../three-geospatial/packages/effects/src/index.ts';
import { createWebGLWater } from './webgl-water.js';

export function createTerrainBackend({
  width,
  height,
  pixelRatio,
  toneMappingExposure = 10,
  scene,
  bootLog = () => {},
} = {}) {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    depth: false,
    logarithmicDepthBuffer: true,
  });
  renderer.setSize(width, height);
  renderer.setPixelRatio(pixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = true;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = toneMappingExposure;
  let composer = null;
  // HDR lens flare (sun disk + water glint). Created here, before the
  // composer, so the tuning UI can bind to it ahead of pipeline configure.
  const lensFlare = new LensFlareEffect();
  let demandRendering = null;
  let animationLoopActive = false;
  let sceneMutationVersion = 0;
  const sceneFog = new THREE.FogExp2(0x000000, 0.00009);
  scene.fog = sceneFog;

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
    lensFlare,
    get sceneMutationVersion() { return sceneMutationVersion; },
    setFogDensity(value) { sceneFog.density = value; },
    setMapMode(active) { scene.fog = active ? null : sceneFog; },
    createWater(options) { return createWebGLWater({ renderer, ...options }); },
    prepareUntexturedTerrain(mesh) {
      if (!mesh?.material || mesh.material.map) return;
      if (mesh.material.vertexColors) {
        mesh.material.vertexColors = false;
        mesh.material.needsUpdate = true;
      }
      mesh.material.color.set(0x29313a);
      backend.markSceneMutated();
    },
    configureScenePipeline({ scene, camera, normalPass, cloudsEffect, aerialPerspective }) {
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
      composer.addPass(new RenderPass(scene, camera));
      composer.addPass(normalPass);
      composer.addPass(new EffectPass(camera, cloudsEffect, aerialPerspective));
      // Lens flare runs on the HDR frame AFTER sky/clouds (so the sun disk
      // exists in the buffer) and BEFORE tone mapping. It thresholds bright
      // pixels, so it flares the sun itself and any HDR water glint alike.
      composer.addPass(new EffectPass(
        camera,
        lensFlare,
        new ToneMappingEffect({ mode: ToneMappingMode.AGX }),
        new DitheringEffect(),
      ));
      bootLog('composer.ready', { passCount: composer.passes.length });
    },
    resize(nextWidth, nextHeight) {
      renderer.setSize(nextWidth, nextHeight);
      composer?.setSize(nextWidth, nextHeight);
    },
    renderMap(scene, camera, background) {
      const previousBackground = scene.background;
      scene.background = background;
      try {
        renderer.render(scene, camera);
      } finally {
        scene.background = previousBackground;
      }
    },
    renderScene() {
      composer?.render();
    },
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
      renderer.dispose();
    },
  };
  return backend;
}
