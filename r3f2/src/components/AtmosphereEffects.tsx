import { useEffect, useRef, useMemo } from 'react';
import { useFrame, useThree, extend } from '@react-three/fiber';
import * as THREE from 'three';
import { EffectComposer, RenderPass, EffectPass, NormalPass } from 'postprocessing';
import {
  AerialPerspectiveEffect,
  PrecomputedTexturesLoader,
  getSunDirectionECEF,
} from '@takram/three-atmosphere';
import {
  CloudsEffect,
  CloudShape,
  CloudShapeDetail,
  LocalWeather,
  Turbulence,
} from '@takram/three-clouds';
import { ToneMappingEffect, ToneMappingMode } from 'postprocessing';
import { DitheringEffect } from '@takram/three-geospatial-effects';
import { useGameClockStore } from '@/stores/gameClockStore';
import { useControlsStore } from '@/stores/controlsStore';
import {
  ATMOSPHERE_CACHE_NAME,
  ATMOSPHERE_TEXTURE_FILES,
} from '@/utils/constants';

// Default URL for precomputed atmosphere textures
const DEFAULT_PRECOMPUTED_TEXTURES_URL =
  'https://unpkg.com/@takram/three-atmosphere@0.4.6/assets';

/**
 * Atmosphere effects: aerial perspective, clouds, tone mapping.
 * Uses postprocessing EffectComposer for the render pipeline.
 */
export function AtmosphereEffects() {
  const { gl, scene, camera, size } = useThree();
  const composerRef = useRef<EffectComposer | null>(null);
  const sunDirectionRef = useRef(new THREE.Vector3());
  const aerialPerspectiveRef = useRef<any>(null);
  const cloudsEffectRef = useRef<any>(null);

  useEffect(() => {
    // Create postprocessing pipeline
    const composer = new EffectComposer(gl, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: Math.min(4, gl.capabilities.maxSamples),
    });

    // NormalPass
    const normalPass = new NormalPass(scene, camera);

    // Cloud effect
    const cloudsEffect = new CloudsEffect(camera, { resolutionScale: 1 });
    cloudsEffect.qualityPreset = 'high';
    cloudsEffect.coverage = 0.28;
    cloudsEffect.cloudLayers[0].altitude = 1550;
    cloudsEffect.cloudLayers[1].altitude = 1800;
    cloudsEffect.cloudLayers[2].altitude = 8300;
    // Cirrus layer — off at startup
    cloudsEffect.cloudLayers[3].altitude = 9100;
    cloudsEffect.cloudLayers[3].height = 400;
    cloudsEffect.cloudLayers[3].densityScale = 0;
    cloudsEffect.cloudLayers[3].shapeAmount = 0.3;
    cloudsEffect.cloudLayers[3].shapeDetailAmount = 0;
    cloudsEffect.cloudLayers[3].weatherExponent = 1;
    cloudsEffect.cloudLayers[3].shapeAlteringBias = 0.35;
    cloudsEffect.cloudLayers[3].coverageFilterWidth = 0.5;
    cloudsEffect.localWeatherVelocity.set(0.00004, 0);
    cloudsEffect.shapeVelocity.set(0, 0, 0);
    cloudsEffect.shapeDetailVelocity.set(0, 0, 0);
    cloudsEffect.shadow.maxFar = 1e5;
    cloudsEffect.shadow.farScale = 0.25;
    cloudsEffect.shadow.minTransmittance = 1e-5;
    cloudsEffect.shadow.opticalDepthTailScale = 3;
    cloudsEffect.localWeatherTexture = new LocalWeather();
    cloudsEffect.shapeTexture = new CloudShape();
    cloudsEffect.shapeDetailTexture = new CloudShapeDetail();
    cloudsEffect.turbulenceTexture = new Turbulence();
    cloudsEffectRef.current = cloudsEffect;

    // Aerial perspective
    const aerialPerspective = new AerialPerspectiveEffect(camera);
    aerialPerspective.sky = true;
    aerialPerspective.sun = true;
    aerialPerspective.sunIrradiance = true;
    aerialPerspective.skyIrradiance = true;
    aerialPerspective.normalBuffer = normalPass.texture;
    aerialPerspective.albedoScale = 1.0;
    aerialPerspective.shadowRadius = 1.8;
    aerialPerspective.shadowSampleCount = 12;
    aerialPerspectiveRef.current = aerialPerspective;

    // Sync cloud composition
    const syncComposition = () => {
      aerialPerspective.overlay = cloudsEffect.atmosphereOverlay;
      aerialPerspective.shadow = cloudsEffect.atmosphereShadow;
      aerialPerspective.shadowLength = cloudsEffect.atmosphereShadowLength;
    };
    syncComposition();

    cloudsEffect.events.addEventListener('change', (event: any) => {
      switch (event.property) {
        case 'atmosphereOverlay':
          aerialPerspective.overlay = cloudsEffect.atmosphereOverlay;
          break;
        case 'atmosphereShadow':
          aerialPerspective.shadow = cloudsEffect.atmosphereShadow;
          break;
        case 'atmosphereShadowLength':
          aerialPerspective.shadowLength = cloudsEffect.atmosphereShadowLength;
          break;
      }
    });

    // Build passes
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(normalPass);
    composer.addPass(new EffectPass(camera, cloudsEffect as any, aerialPerspective as any));
    composer.addPass(
      new EffectPass(
        camera,
        new ToneMappingEffect({ mode: ToneMappingMode.AGX }),
        new DitheringEffect() as any
      )
    );

    composerRef.current = composer;

    // Load atmosphere textures
    loadAtmosphereTextures(aerialPerspective, cloudsEffect);

    // Expose sun direction for other systems
    (window as any).__sunDirection = sunDirectionRef.current;

    return () => {
      composer.dispose();
    };
  }, [gl, scene, camera]);

  // Handle resize
  useEffect(() => {
    if (composerRef.current) {
      composerRef.current.setSize(size.width, size.height);
    }
  }, [size]);

  // Disable R3F's default rendering — we use our own EffectComposer
  useEffect(() => {
    // Override the internal render call to prevent double rendering
    (gl as any).__r3fComposerActive = true;
  }, [gl]);

  // Main render loop
  useFrame(({ gl: renderer }, delta) => {
    const controls = useControlsStore.getState();

    // Update sun direction from game clock
    const gameDate = useGameClockStore.getState().currentDate;
    getSunDirectionECEF(gameDate, sunDirectionRef.current);
    if (aerialPerspectiveRef.current) {
      aerialPerspectiveRef.current.sunDirection.copy(sunDirectionRef.current);
    }
    if (cloudsEffectRef.current) {
      cloudsEffectRef.current.sunDirection.copy(sunDirectionRef.current);
    }

    // Tick game clock
    useGameClockStore.getState().tick();
    useGameClockStore.getState().saveIfNeeded();

    // Don't use composer in map mode — MapModeRenderer does direct render
    if (controls.mapMode) return;

    // Render via composer (replaces R3F's default gl.render)
    if (composerRef.current) {
      composerRef.current.render(delta);
    }
  }, 1); // Priority 1 = runs after default (0)

  return null;
}

async function loadAtmosphereTextures(aerialPerspective: any, cloudsEffect: any) {
  try {
    if (!('caches' in window)) {
      // Direct load without caching
      new PrecomputedTexturesLoader({}).load(
        DEFAULT_PRECOMPUTED_TEXTURES_URL,
        (textures: any) => {
          Object.assign(aerialPerspective, textures);
          Object.assign(cloudsEffect, textures);
        }
      );
      return;
    }

    const cache = await caches.open(ATMOSPHERE_CACHE_NAME);
    const urlMap = new Map<string, string>();

    for (const fileName of ATMOSPHERE_TEXTURE_FILES) {
      const sourceUrl = `${DEFAULT_PRECOMPUTED_TEXTURES_URL}/${fileName}`;
      let response = await cache.match(sourceUrl);
      if (!response) {
        response = await fetch(sourceUrl);
        if (!response.ok) throw new Error(`fetch failed: ${response.status} ${sourceUrl}`);
        await cache.put(sourceUrl, response.clone());
      }
      const blob = await response.blob();
      urlMap.set(sourceUrl, URL.createObjectURL(blob));
    }

    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url: string) => urlMap.get(url) ?? url);

    new PrecomputedTexturesLoader({}, manager).load(
      DEFAULT_PRECOMPUTED_TEXTURES_URL,
      (textures: any) => {
        Object.assign(aerialPerspective, textures);
        Object.assign(cloudsEffect, textures);
        // Revoke object URLs
        for (const objectUrl of urlMap.values()) {
          URL.revokeObjectURL(objectUrl);
        }
      },
      undefined,
      () => {
        for (const objectUrl of urlMap.values()) {
          URL.revokeObjectURL(objectUrl);
        }
      }
    );
  } catch (err) {
    console.warn('[ATMOSPHERE] texture load failed, trying direct:', err);
    new PrecomputedTexturesLoader({}).load(
      DEFAULT_PRECOMPUTED_TEXTURES_URL,
      (textures: any) => {
        Object.assign(aerialPerspective, textures);
        Object.assign(cloudsEffect, textures);
      }
    );
  }
}
