import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import { TerrainRoot } from '@/components/TerrainRoot';
import { WaterPlane } from '@/components/WaterPlane';
import { TerrainManager } from '@/components/TerrainManager';
import { VehicleSystem } from '@/components/VehicleSystem';
import { CameraController } from '@/components/CameraController';
import { AtmosphereEffects } from '@/components/AtmosphereEffects';
import { StructuresLayer } from '@/components/StructuresLayer';
import { FireSystem } from '@/components/FireSystem';
import { MapModeRenderer } from '@/components/MapModeRenderer';
import { InputHandler } from '@/components/InputHandler';
import { HUD } from '@/components/HUD';
import { GameClockHUD } from '@/components/GameClockHUD';
import { TuningPanel } from '@/components/TuningPanel';
import { GoogleMapsPanel } from '@/components/GoogleMapsPanel';
import { Crosshair } from '@/components/Crosshair';
import { useAssetServer } from '@/hooks/useAssetServer';
import { useVehicleSave } from '@/hooks/useVehicleSave';
import { DEFAULT_LOCATION, MAX_VIEW_DIST } from '@/utils/constants';

/** Inner component to call hooks that need Canvas context */
function SceneHooks() {
  // Diesel audio is imported inside VehicleSystem via useDieselAudio
  return null;
}

export function App() {
  const assets = useAssetServer();

  // Vehicle state persistence (runs outside Canvas — uses zustand stores directly)
  useVehicleSave();

  return (
    <>
      <Canvas
        gl={{
          antialias: true,
          depth: false,
          logarithmicDepthBuffer: true,
          toneMapping: THREE.NoToneMapping,
          toneMappingExposure: 10,
        }}
        shadows={{
          enabled: true,
          type: THREE.PCFSoftShadowMap,
        }}
        camera={{
          fov: 60,
          near: 1,
          far: MAX_VIEW_DIST,
        }}
        onCreated={({ gl, invalidate }) => {
          gl.setPixelRatio(window.devicePixelRatio);
          gl.shadowMap.autoUpdate = true;
          // Prevent R3F from calling gl.render() automatically
          // Our AtmosphereEffects EffectComposer handles rendering
          gl.info.autoReset = false;
        }}
      >
        <fogExp2 attach="fog" args={[0x000000, 0.00009]} />

        <InputHandler />
        <CameraController />
        <MapModeRenderer />

        <TerrainRoot lat={DEFAULT_LOCATION.lat} lon={DEFAULT_LOCATION.lon}>
          <WaterPlane />
          <TerrainManager />
          {assets && (
            <>
              <VehicleSystem assets={assets} />
              <StructuresLayer assets={assets} />
            </>
          )}
          <FireSystem />
        </TerrainRoot>

        <AtmosphereEffects />
        <SceneHooks />
      </Canvas>

      {/* HTML overlay UI */}
      <HUD />
      <GameClockHUD />
      <Crosshair />
      <TuningPanel />
      <GoogleMapsPanel />
    </>
  );
}
