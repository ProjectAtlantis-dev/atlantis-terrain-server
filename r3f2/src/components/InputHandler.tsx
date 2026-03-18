import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useControlsStore } from '@/stores/controlsStore';
import { useVehicleStore } from '@/stores/vehicleStore';
import { useUIStore } from '@/stores/uiStore';
import {
  MOUSE_SENS,
  VEHICLE_CAMERA_ORBIT_SENS,
  VEHICLE_CAMERA_ORBIT_PITCH_MIN,
  VEHICLE_CAMERA_ORBIT_PITCH_MAX,
  TURRET_MOUSE_SENS,
  TURRET_PITCH_MIN,
  TURRET_PITCH_MAX,
  VEHICLE_CAM_MODES,
  MAP_PAN_FACTOR,
} from '@/utils/constants';

/**
 * Handles all keyboard, mouse, and pointer lock input.
 * Runs as a component inside the Canvas so it can access useThree().
 */
export function InputHandler() {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);

  useEffect(() => {
    const dom = gl.domElement;
    const controls = useControlsStore.getState;
    const setKey = useControlsStore.getState().setKey;
    const clearKeys = useControlsStore.getState().clearKeys;

    // ── Keyboard ──────────────────────────────────────────────────
    const onKeyDown = (e: KeyboardEvent) => {
      // Don't capture if typing in an input
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
      setKey(e.code, true);

      const vStore = useVehicleStore.getState();
      const activeVehicle = vStore.getActiveVehicle();

      // M = toggle map mode
      if (e.code === 'KeyM') {
        const mapMode = !controls().mapMode;
        useControlsStore.getState().setMapMode(mapMode);
        if (activeVehicle?.controlActive && mapMode) {
          // Exit vehicle control when entering map mode
          vStore.updateVehicle(activeVehicle.id, { controlActive: false, turretControlActive: false, fireHeld: false });
        }
      }

      // R = reset view
      if (e.code === 'KeyR' && !e.ctrlKey && !e.metaKey) {
        useControlsStore.setState({
          yaw: 0,
          pitch: -0.32,
          speed: 0,
          mapMode: false,
          mapPanEast: 0,
          mapPanNorth: 0,
        });
      }

      // G = toggle Google Maps panel
      if (e.code === 'KeyG') {
        const uiStore = useUIStore.getState();
        uiStore.setGmapsPanelOpen(!uiStore.gmapsPanelOpen);
      }

      // H = toggle HUD
      if (e.code === 'KeyH') {
        const uiStore = useUIStore.getState();
        uiStore.setHudVisible(!uiStore.hudVisible);
      }

      // Escape = exit vehicle/turret control
      if (e.code === 'Escape') {
        if (activeVehicle?.turretControlActive) {
          vStore.updateVehicle(activeVehicle.id, {
            turretControlActive: false,
            fireHeld: false,
            turretYawRad: 0,
            turretPitchRad: 0,
          });
          useUIStore.getState().setCrosshairVisible(false);
          if (document.pointerLockElement) document.exitPointerLock();
        } else if (activeVehicle?.controlActive) {
          vStore.updateVehicle(activeVehicle.id, { controlActive: false });
          useControlsStore.getState().setSpeed(0);
        }
      }

      // T = enter turret mode (when in vehicle control)
      if (e.code === 'KeyT' && activeVehicle?.controlActive && !activeVehicle.turretControlActive) {
        vStore.updateVehicle(activeVehicle.id, { turretControlActive: true });
        useUIStore.getState().setCrosshairVisible(true);
        dom.requestPointerLock();
      } else if (e.code === 'KeyT' && activeVehicle?.turretControlActive) {
        vStore.updateVehicle(activeVehicle.id, {
          turretControlActive: false,
          fireHeld: false,
          turretYawRad: 0,
          turretPitchRad: 0,
        });
        useUIStore.getState().setCrosshairVisible(false);
        if (document.pointerLockElement) document.exitPointerLock();
      }

      // V = cycle camera mode
      if (e.code === 'KeyV' && activeVehicle?.controlActive && !activeVehicle.turretControlActive) {
        const nextIdx = (activeVehicle.camModeIndex + 1) % VEHICLE_CAM_MODES.length;
        const mode = VEHICLE_CAM_MODES[nextIdx];
        vStore.updateVehicle(activeVehicle.id, {
          camModeIndex: nextIdx,
          cameraFollowDist: mode.dist,
          cameraFollowHeight: mode.height,
        });
      }

      // Shift = drift mode
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
        if (activeVehicle?.controlActive) {
          vStore.updateVehicle(activeVehicle.id, { driftMode: true });
        }
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      setKey(e.code, false);

      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
        const vStore = useVehicleStore.getState();
        const av = vStore.getActiveVehicle();
        if (av?.controlActive) {
          vStore.updateVehicle(av.id, { driftMode: false });
        }
      }
    };

    // ── Mouse ─────────────────────────────────────────────────────
    const onMouseDown = (e: MouseEvent) => {
      useControlsStore.getState().setDragging(true, e.button);

      const vStore = useVehicleStore.getState();
      const av = vStore.getActiveVehicle();

      // Left click in turret mode = fire
      if (e.button === 0 && av?.turretControlActive) {
        vStore.updateVehicle(av.id, { fireHeld: true });
      }

      // Right click = try enter vehicle control (if not in map mode)
      if (e.button === 2 && !controls().mapMode) {
        // Vehicle click detection would go here in a full implementation
        // For now, right-click toggles vehicle control on the active vehicle
        if (av && !av.controlActive && av.loaded) {
          vStore.updateVehicle(av.id, { controlActive: true });
          useControlsStore.getState().setSpeed(0);
          const mode = VEHICLE_CAM_MODES[av.camModeIndex];
          vStore.setCameraOrbit(
            0,
            Math.atan2(mode.height, mode.dist)
          );
        }
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      useControlsStore.getState().setDragging(false);
      const vStore = useVehicleStore.getState();
      const av = vStore.getActiveVehicle();
      if (e.button === 0 && av?.turretControlActive) {
        vStore.updateVehicle(av.id, { fireHeld: false });
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      const state = controls();
      const vStore = useVehicleStore.getState();
      const av = vStore.getActiveVehicle();

      // Turret mode: pointer lock mouse movement
      if (av?.turretControlActive && document.pointerLockElement) {
        const newYaw = av.turretYawRad - e.movementX * TURRET_MOUSE_SENS;
        const newPitch = Math.max(
          TURRET_PITCH_MIN,
          Math.min(TURRET_PITCH_MAX, av.turretPitchRad + e.movementY * TURRET_MOUSE_SENS)
        );
        vStore.updateVehicle(av.id, {
          turretYawRad: newYaw,
          turretPitchRad: newPitch,
        });
        return;
      }

      // Vehicle follow camera orbit (when dragging)
      if (av?.controlActive && !av.turretControlActive && state.dragging) {
        const orbitState = vStore;
        const newYaw = orbitState.cameraOrbitYaw + e.movementX * VEHICLE_CAMERA_ORBIT_SENS;
        const newPitch = Math.max(
          VEHICLE_CAMERA_ORBIT_PITCH_MIN,
          Math.min(
            VEHICLE_CAMERA_ORBIT_PITCH_MAX,
            orbitState.cameraOrbitPitch - e.movementY * VEHICLE_CAMERA_ORBIT_SENS
          )
        );
        vStore.setCameraOrbit(newYaw, newPitch);
        return;
      }

      // Free flight camera: drag to look
      if (state.dragging && !state.mapMode) {
        useControlsStore.getState().setYaw(state.yaw - e.movementX * MOUSE_SENS);
        useControlsStore.getState().setPitch(
          Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, state.pitch - e.movementY * MOUSE_SENS))
        );
      }

      // Map mode: drag to pan
      if (state.dragging && state.mapMode) {
        if (state.dragButton === 2 || state.dragButton === 1) {
          useControlsStore.getState().setMapPan(
            state.mapPanEast - e.movementX * state.mapZoom * 0.002 * MAP_PAN_FACTOR,
            state.mapPanNorth + e.movementY * state.mapZoom * 0.002 * MAP_PAN_FACTOR
          );
        }
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const state = controls();
      const zoomIn = e.deltaY < 0;
      const vStore = useVehicleStore.getState();
      const av = vStore.getActiveVehicle();

      if (state.mapMode) {
        const newZoom = state.mapZoom * (zoomIn ? 0.85 : 1.18);
        useControlsStore.getState().setMapZoom(newZoom);
      } else if (av?.controlActive) {
        const scale = zoomIn ? 0.9 : 1.1;
        vStore.updateVehicle(av.id, {
          cameraFollowDist: Math.max(8, Math.min(200, av.cameraFollowDist * scale)),
          cameraFollowHeight: Math.max(2, Math.min(80, av.cameraFollowHeight * scale)),
        });
      } else {
        const cam = camera as THREE.PerspectiveCamera;
        cam.fov *= zoomIn ? 0.95 : 1.05;
        cam.fov = Math.max(20, Math.min(100, cam.fov));
        cam.updateProjectionMatrix();
      }
    };

    const onContextMenu = (e: Event) => e.preventDefault();

    const onPointerLockChange = () => {
      if (!document.pointerLockElement) {
        const vStore = useVehicleStore.getState();
        const av = vStore.getActiveVehicle();
        if (av?.turretControlActive) {
          vStore.updateVehicle(av.id, {
            turretControlActive: false,
            fireHeld: false,
            turretYawRad: 0,
            turretPitchRad: 0,
          });
          useUIStore.getState().setCrosshairVisible(false);
        }
      }
    };

    // Bind events
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    dom.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('mousemove', onMouseMove);
    dom.addEventListener('wheel', onWheel, { passive: false });
    dom.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('pointerlockchange', onPointerLockChange);
    window.addEventListener('blur', clearKeys);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      dom.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('mousemove', onMouseMove);
      dom.removeEventListener('wheel', onWheel);
      dom.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      window.removeEventListener('blur', clearKeys);
    };
  }, [gl, camera]);

  return null;
}
