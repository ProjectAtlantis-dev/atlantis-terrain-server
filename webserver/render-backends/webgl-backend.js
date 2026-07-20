import * as THREE from 'three';
import {
  EffectComposer,
  EffectPass,
  LUT3DEffect,
  NormalPass,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
} from 'postprocessing';
import { DitheringEffect } from '../three-geospatial/packages/effects/src/index.ts';
import { createWebGLWater } from './webgl-water.js';
import { TerrainSunFlareEffect } from '../terrain-sun-flare-effect.js';
import {
  loadTerrainColorGradingTexture,
  TERRAIN_COLOR_GRADING_PRESETS,
} from '../terrain-color-grading.js';

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
  let atmospherePass = null;
  let finalPass = null;
  let cloudsEffectRef = null;
  let aerialPerspectiveRef = null;
  let takramCloudsEnabled = true;
  // HDR lens flare (sun disk + water glint). Created here, before the
  // composer, so the tuning UI can bind to it ahead of pipeline configure.
  const lensFlare = new TerrainSunFlareEffect();
  let demandRendering = null;
  let animationLoopActive = false;
  let sceneMutationVersion = 0;
  let colorGradingPreset = 'off';
  let colorGradingEffect = null;
  let colorGradingLoadVersion = 0;
  const colorGradingTextures = new Map();
  const toneMappingEffect = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
  const ditheringEffect = new DitheringEffect();
  const sceneFog = new THREE.FogExp2(0x000000, 0.00009);
  scene.fog = sceneFog;

  const syncFinalEffects = () => {
    if (finalPass == null) return;
    const effects = colorGradingEffect == null
      ? [lensFlare, toneMappingEffect, ditheringEffect]
      : [lensFlare, toneMappingEffect, colorGradingEffect, ditheringEffect];
    finalPass.setEffects(effects);
    finalPass.recompile();
  };

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
    colorGradingPresets: TERRAIN_COLOR_GRADING_PRESETS,
    get colorGradingPreset() { return colorGradingPreset; },
    get takramCloudsEnabled() { return takramCloudsEnabled; },
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
    async setColorGradingPreset(name) {
      const presetName = Object.hasOwn(TERRAIN_COLOR_GRADING_PRESETS, name) ? name : 'off';
      const preset = TERRAIN_COLOR_GRADING_PRESETS[presetName];
      colorGradingPreset = presetName;
      const loadVersion = ++colorGradingLoadVersion;
      if (preset.url == null) {
        colorGradingEffect = null;
        syncFinalEffects();
        bootLog('color-grading.changed', { preset: presetName });
        backend.markSceneMutated();
        backend.requestRender();
        return;
      }
      try {
        let texture = colorGradingTextures.get(presetName);
        if (texture == null) {
          texture = await loadTerrainColorGradingTexture(preset.url);
          colorGradingTextures.set(presetName, texture);
        }
        if (loadVersion !== colorGradingLoadVersion) return;
        colorGradingEffect = new LUT3DEffect(texture, {
          inputColorSpace: THREE.SRGBColorSpace,
          tetrahedralInterpolation: true,
        });
        syncFinalEffects();
        bootLog('color-grading.changed', { preset: presetName });
        backend.markSceneMutated();
        backend.requestRender();
      } catch (error) {
        if (loadVersion !== colorGradingLoadVersion) return;
        colorGradingPreset = 'off';
        colorGradingEffect = null;
        syncFinalEffects();
        bootLog('color-grading.error', {
          preset: presetName,
          message: error?.message ?? String(error),
        }, 'error');
      }
    },
    configureScenePipeline({ scene, camera, normalPass, cloudsEffect, aerialPerspective, sunDirection }) {
      lensFlare.configure({ camera, sunDirection });
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
      const scenePass = new RenderPass(scene, camera);
      atmospherePass = new EffectPass(camera, cloudsEffect, aerialPerspective);
      composer.addPass(scenePass);
      composer.addPass(normalPass);
      composer.addPass(atmospherePass);
      if (!takramCloudsEnabled) {
        aerialPerspective.overlay = null;
        aerialPerspective.shadow = null;
        aerialPerspective.shadowLength = null;
        atmospherePass.setEffects([aerialPerspective]);
        atmospherePass.recompile();
      }
      // Lens flare runs on the HDR frame AFTER sky/clouds (so the sun disk
      // exists in the buffer) and BEFORE tone mapping. It thresholds bright
      // pixels, so it flares the sun itself and any HDR water glint alike.
      finalPass = new EffectPass(
        camera,
        lensFlare,
        toneMappingEffect,
        ...(colorGradingEffect == null ? [] : [colorGradingEffect]),
        ditheringEffect,
      );
      composer.addPass(finalPass);
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
      for (const texture of colorGradingTextures.values()) texture.dispose();
      colorGradingTextures.clear();
      renderer.dispose();
    },
  };
  return backend;
}
