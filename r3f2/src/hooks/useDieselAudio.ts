import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useVehicleStore } from '@/stores/vehicleStore';

const DIESEL_MAX_VOL = 0.3;
const DIESEL_FULL_DIST = 15;
const DIESEL_ZERO_DIST = 150;
const AUDIO_URL = '/audio/diesel_idle.mp3';

/**
 * Diesel engine audio — non-positional looping sound with distance-based volume.
 * Starts on first user interaction (click/keydown) due to browser autoplay policy.
 */
export function useDieselAudio() {
  const { camera } = useThree();
  const listenerRef = useRef<THREE.AudioListener | null>(null);
  const soundRef = useRef<THREE.Audio | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    const listener = new THREE.AudioListener();
    camera.add(listener);
    listenerRef.current = listener;

    const sound = new THREE.Audio(listener);
    sound.setLoop(true);
    sound.setVolume(0);
    soundRef.current = sound;

    const loader = new THREE.AudioLoader();
    loader.load(
      AUDIO_URL,
      (buffer) => {
        sound.setBuffer(buffer);

        const startAudio = () => {
          if (!sound.isPlaying && sound.buffer) {
            sound.play();
          }
          startedRef.current = true;
          window.removeEventListener('click', startAudio);
          window.removeEventListener('keydown', startAudio);
        };

        window.addEventListener('click', startAudio);
        window.addEventListener('keydown', startAudio);
      },
      undefined,
      (error) => {
        console.warn('[DIESEL] audio load failed:', error);
      }
    );

    return () => {
      if (sound.isPlaying) sound.stop();
      sound.disconnect();
      camera.remove(listener);
    };
  }, [camera]);

  // Update volume every frame via subscription (called from VehicleSystem useFrame)
  useEffect(() => {
    const camWorld = new THREE.Vector3();
    const vehWorld = new THREE.Vector3();

    const interval = setInterval(() => {
      const sound = soundRef.current;
      if (!sound?.isPlaying) return;

      const vStore = useVehicleStore.getState();
      const activeVehicle = vStore.getActiveVehicle();
      if (!activeVehicle?.loaded) {
        sound.setVolume(0);
        return;
      }

      camera.getWorldPosition(camWorld);
      activeVehicle.group.getWorldPosition(vehWorld);
      const dist = camWorld.distanceTo(vehWorld);

      if (dist <= DIESEL_FULL_DIST) {
        sound.setVolume(DIESEL_MAX_VOL);
      } else if (dist >= DIESEL_ZERO_DIST) {
        sound.setVolume(0);
      } else {
        const t = (dist - DIESEL_FULL_DIST) / (DIESEL_ZERO_DIST - DIESEL_FULL_DIST);
        sound.setVolume(DIESEL_MAX_VOL * (1 - t * t));
      }
    }, 50); // 20Hz update

    return () => clearInterval(interval);
  }, [camera]);
}
