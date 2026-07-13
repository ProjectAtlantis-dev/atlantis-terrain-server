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

export function createWebGLTerrainBackend({
  width,
  height,
  pixelRatio,
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

  bootLog('renderer.ready', {
    backend: 'webgl', width, height, pixelRatio,
    shadowMap: renderer.shadowMap.type,
  });

  return {
    kind: 'webgl',
    isWebGPU: false,
    renderer,
    createNormalPass(scene, camera) {
      return new NormalPass(scene, camera);
    },
    configureScenePipeline({ scene, camera, normalPass, cloudsEffect, aerialPerspective }) {
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
    renderMap(scene, camera) {
      renderer.render(scene, camera);
    },
    renderScene() {
      composer?.render();
    },
    setAnimationLoop(callback) {
      renderer.setAnimationLoop(callback);
    },
    requestRender() {},
    markSceneMutated() {},
    dispose() {
      renderer.setAnimationLoop(null);
      composer?.dispose?.();
      renderer.dispose();
    },
  };
}
