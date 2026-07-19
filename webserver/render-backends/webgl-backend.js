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

export function createTerrainBackend({
  width,
  height,
  pixelRatio,
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
  renderer.toneMappingExposure = 10;
  let composer = null;
  let demandRendering = null;
  let animationLoopActive = false;
  let sceneMutationVersion = 0;
  const sceneFog = new THREE.FogExp2(0x000000, 0.00009);
  scene.fog = sceneFog;

  bootLog('renderer.ready', {
    backend: 'webgl', width, height, pixelRatio,
    shadowMap: renderer.shadowMap.type,
  });

  const backend = {
    kind: 'webgl',
    defaultFogStrength: 4.5,
    renderer,
    get sceneMutationVersion() { return sceneMutationVersion; },
    setFogDensity(value) { sceneFog.density = value; },
    setMapMode(active) { scene.fog = active ? null : sceneFog; },
    createWater: createWebGLWater,
    prepareUntexturedTerrain(mesh) {
      if (!mesh?.material || mesh.material.map) return;
      if (!mesh.material.vertexColors) {
        mesh.material.vertexColors = true;
        mesh.material.needsUpdate = true;
      }
      mesh.material.color.set(0xffffff);
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
      composer.addPass(new EffectPass(
        camera,
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
