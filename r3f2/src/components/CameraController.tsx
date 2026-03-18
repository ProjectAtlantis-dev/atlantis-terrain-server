import { useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useControlsStore } from '@/stores/controlsStore';
import { useVehicleStore } from '@/stores/vehicleStore';
import { useTerrainStore } from '@/stores/terrainStore';
import {
  BASE_ACCEL,
  BASE_BRAKE,
  BASE_MAX_SPEED,
  BASE_STRAFE_SPEED,
  TURN_SPEED,
  MIN_FLIGHT_ALT,
  AGL_FULL_SPEED_M,
  AGL_MIN_FACTOR,
  VEHICLE_DRIVE_SPEED,
  VEHICLE_ACCEL,
  VEHICLE_BRAKE,
  VEHICLE_STEER_SPEED,
  VEHICLE_CAMERA_LOOK_HEIGHT,
  TURRET_CAM_BEHIND,
  TURRET_CAM_ABOVE,
} from '@/utils/constants';
import { getTerrainMeshes } from '@/utils/terrain';

const _movementForward = new THREE.Vector3();
const _movementRight = new THREE.Vector3();
const _move = new THREE.Vector3();
const _lastGoodCamPos = new THREE.Vector3();
const _aglRaycaster = new THREE.Raycaster();
const _vehicleFollowLocal = new THREE.Vector3();
const _vehicleFollowWorld = new THREE.Vector3();
const _vehicleLookTargetLocal = new THREE.Vector3();
const _vehicleLookTargetWorld = new THREE.Vector3();
const _vehicleLookDirLocal = new THREE.Vector3();
const _barrelTipWorld = new THREE.Vector3();
const _turretDir = new THREE.Vector3();
const _turretCamLocal = new THREE.Vector3();
const _turretLookLocal = new THREE.Vector3();
const _turretCamWorld = new THREE.Vector3();
const _turretLookWorld = new THREE.Vector3();
const _vUp = new THREE.Vector3();

let cameraAGL = AGL_FULL_SPEED_M;

function aglSpeedFactor(): number {
  const t = Math.min(1, Math.max(0, cameraAGL / AGL_FULL_SPEED_M));
  return AGL_MIN_FACTOR + (1 - AGL_MIN_FACTOR) * t;
}

/**
 * Handles all camera movement: free-flight, vehicle follow, turret follow, map mode.
 */
export function CameraController() {
  const camera = useThree((s) => s.camera);
  const initialized = useRef(false);

  useFrame((state, delta) => {
    // Expose camera for HUD/GoogleMapsPanel coordinate computation
    (window as any).__r3fCamera = camera;

    const dt = Math.min(0.05, delta);
    const controls = useControlsStore.getState();
    const vStore = useVehicleStore.getState();
    const tStore = useTerrainStore.getState();
    const terrainRoot = tStore.terrainRoot;
    const activeVehicle = vStore.getActiveVehicle();

    if (!initialized.current && terrainRoot) {
      // Initialize camera position relative to terrain root
      const enu = terrainRoot.userData.enu;
      if (enu) {
        const offset = new THREE.Vector3()
          .addScaledVector(enu.east, -2600)
          .addScaledVector(enu.north, -3600)
          .addScaledVector(enu.up, 700);
        camera.position.copy(enu.anchorPosition).add(offset);
        camera.up.copy(enu.up);
        camera.lookAt(enu.anchorPosition);
        camera.updateMatrixWorld();
        _lastGoodCamPos.copy(camera.position);
        // Compute initial yaw/pitch from the look direction
        const forward = enu.anchorPosition.clone().sub(camera.position).normalize();
        const yaw = Math.atan2(-forward.dot(enu.east), forward.dot(enu.north));
        const pitch = Math.asin(Math.max(-1, Math.min(1, forward.dot(enu.up))));
        useControlsStore.setState({ yaw, pitch });
        initialized.current = true;
      }
      return;
    }

    if (!terrainRoot) return;
    const enu = terrainRoot.userData.enu;
    if (!enu) return;
    const { east, north, up } = enu;

    // Map mode: no movement updates (MapModeRenderer handles this)
    if (controls.mapMode) return;

    // ── Vehicle Control Mode ──────────────────────────────────────
    if (activeVehicle?.controlActive && activeVehicle.loaded) {
      // Vehicle movement
      const isPressed = controls.isPressed;
      const forwardPressed = isPressed('KeyW', 'ArrowUp');
      const backPressed = isPressed('KeyS', 'ArrowDown');
      const leftPressed = isPressed('KeyA', 'ArrowLeft');
      const rightPressed = isPressed('KeyD', 'ArrowRight');

      const steer = (leftPressed ? 1 : 0) + (rightPressed ? -1 : 0);
      if (steer !== 0) {
        activeVehicle.headingRad += steer * VEHICLE_STEER_SPEED * dt;
      }

      const drive = (forwardPressed ? 1 : 0) + (backPressed ? -1 : 0);
      // Slope gravity
      const groundNormal = vStore.groundNormal;
      const slopeForwardComponent = -(
        groundNormal.x * (-Math.sin(activeVehicle.headingRad)) +
        groundNormal.y * Math.cos(activeVehicle.headingRad)
      );
      const VEHICLE_SLOPE_GRAVITY = 6.0;
      const slopeAccel = slopeForwardComponent * VEHICLE_SLOPE_GRAVITY;
      const friction = activeVehicle.speed > 0 ? -VEHICLE_BRAKE
                     : activeVehicle.speed < 0 ? VEHICLE_BRAKE
                     : 0;

      if (drive !== 0) {
        activeVehicle.speed += (drive * VEHICLE_ACCEL + slopeAccel) * dt;
      } else {
        const coastAccel = slopeAccel + friction;
        const prevSpeed = activeVehicle.speed;
        activeVehicle.speed += coastAccel * dt;
        if (prevSpeed > 0 && activeVehicle.speed < 0 && slopeAccel >= 0) activeVehicle.speed = 0;
        if (prevSpeed < 0 && activeVehicle.speed > 0 && slopeAccel <= 0) activeVehicle.speed = 0;
        if (prevSpeed === 0) activeVehicle.speed = slopeAccel * dt;
      }
      activeVehicle.speed = Math.max(-VEHICLE_DRIVE_SPEED, Math.min(VEHICLE_DRIVE_SPEED, activeVehicle.speed));

      if (activeVehicle.speed !== 0 || steer !== 0) {
        const heading = activeVehicle.headingRad;
        const forwardX = -Math.sin(heading);
        const forwardY = Math.cos(heading);
        const driveDist = activeVehicle.speed * dt;
        activeVehicle.group.position.x += forwardX * driveDist;
        activeVehicle.group.position.y += forwardY * driveDist;
        activeVehicle.marker.position.x = activeVehicle.group.position.x;
        activeVehicle.marker.position.y = activeVehicle.group.position.y;
        activeVehicle.snapPending = true;
      }

      // Camera: turret follow or vehicle follow
      if (activeVehicle.turretControlActive) {
        updateTurretFollowCamera(activeVehicle, camera, terrainRoot, up);
      } else {
        updateVehicleFollowCamera(activeVehicle, camera, terrainRoot, up, vStore);
      }

      // Sync controls yaw from vehicle look direction
      return;
    }

    // ── Free-Flight Camera Mode ───────────────────────────────────
    const isPressed = controls.isPressed;
    const forwardPressed = isPressed('KeyW', 'ArrowUp');
    const backPressed = isPressed('KeyS', 'ArrowDown');
    const leftPressed = isPressed('KeyA', 'ArrowLeft');
    const rightPressed = isPressed('KeyD', 'ArrowRight');

    // AGL-based speed scaling
    if (terrainRoot) {
      const terrainMeshes = getTerrainMeshes(terrainRoot);
      if (terrainMeshes.length > 0) {
        _aglRaycaster.set(camera.position, up.clone().negate());
        const hits = _aglRaycaster.intersectObjects(terrainMeshes);
        if (hits.length > 0) cameraAGL = hits[0].distance;
      }
    }

    const sf = aglSpeedFactor();
    const ACCEL = BASE_ACCEL * sf;
    const BRAKE = BASE_BRAKE * sf;
    const MAX_SPEED = BASE_MAX_SPEED * sf;
    const STRAFE_SPEED = BASE_STRAFE_SPEED * sf;

    let speed = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, controls.speed));

    if (forwardPressed) {
      speed = Math.min(speed + ACCEL * dt, MAX_SPEED);
    } else if (backPressed) {
      speed = Math.max(speed - ACCEL * dt, -MAX_SPEED);
    } else {
      if (speed > 0) speed = Math.max(speed - BRAKE * dt, 0);
      else if (speed < 0) speed = Math.min(speed + BRAKE * dt, 0);
    }
    useControlsStore.getState().setSpeed(speed);

    // Apply camera orientation
    applyCameraOrientation(camera, controls.yaw, controls.pitch, east, north, up);

    // Build movement vectors (horizontal plane)
    camera.getWorldDirection(_movementForward);
    _movementForward.addScaledVector(up, -_movementForward.dot(up));
    if (_movementForward.lengthSq() < 1e-9) {
      _movementForward.copy(north);
    } else {
      _movementForward.normalize();
    }
    _movementRight.crossVectors(_movementForward, up).normalize();

    _move.set(0, 0, 0);
    if (speed !== 0) _move.addScaledVector(_movementForward, speed * dt);
    if (leftPressed) _move.addScaledVector(_movementRight, -STRAFE_SPEED * dt);
    if (rightPressed) _move.addScaledVector(_movementRight, STRAFE_SPEED * dt);
    if (controls.keys.KeyQ) _move.addScaledVector(up, STRAFE_SPEED * dt * 0.5);
    if (controls.keys.KeyZ) _move.addScaledVector(up, -STRAFE_SPEED * dt * 0.5);

    camera.position.add(_move);

    // NaN guard
    if (isNaN(camera.position.x) || isNaN(camera.position.y) || isNaN(camera.position.z)) {
      camera.position.copy(_lastGoodCamPos);
      useControlsStore.getState().setSpeed(0);
    } else {
      _lastGoodCamPos.copy(camera.position);
    }

    // Clamp altitude
    const rel = camera.position.clone().sub(enu.anchorPosition);
    const altitude = rel.dot(up);
    const clamped = Math.max(MIN_FLIGHT_ALT, Math.min(6000, altitude));
    const altDelta = clamped - altitude;
    if (Math.abs(altDelta) > 1e-6) {
      camera.position.addScaledVector(up, altDelta);
    }
  });

  return null;
}

function applyCameraOrientation(
  camera: THREE.Camera,
  yaw: number,
  pitch: number,
  east: THREE.Vector3,
  north: THREE.Vector3,
  up: THREE.Vector3
) {
  const forward = new THREE.Vector3()
    .addScaledVector(north, Math.cos(yaw) * Math.cos(pitch))
    .addScaledVector(east, -Math.sin(yaw) * Math.cos(pitch))
    .addScaledVector(up, Math.sin(pitch));
  const target = camera.position.clone().add(forward);
  camera.up.copy(up);
  camera.lookAt(target);
}

function updateVehicleFollowCamera(
  vehicle: any,
  camera: THREE.Camera,
  terrainRoot: THREE.Group,
  up: THREE.Vector3,
  vStore: any
) {
  const heading = vehicle.headingRad;
  const radius = Math.sqrt(
    vehicle.cameraFollowDist * vehicle.cameraFollowDist +
    vehicle.cameraFollowHeight * vehicle.cameraFollowHeight
  );
  const orbitYaw = vStore.cameraOrbitYaw;
  const orbitPitch = vStore.cameraOrbitPitch;

  const horizontalRadius = radius * Math.cos(orbitPitch);
  const verticalOffset = radius * Math.sin(orbitPitch);
  const backScale = Math.cos(orbitYaw);
  const sideScale = Math.sin(orbitYaw);

  const localOffX = sideScale * horizontalRadius;
  const localOffY = -backScale * horizontalRadius;
  const localOffZ = verticalOffset;

  _vehicleFollowLocal.set(localOffX, localOffY, localOffZ);
  _vehicleFollowLocal.applyQuaternion(vehicle.group.quaternion);
  _vehicleFollowLocal.add(vehicle.group.position);

  _vehicleLookTargetLocal.set(
    vehicle.group.position.x,
    vehicle.group.position.y,
    vehicle.group.position.z + VEHICLE_CAMERA_LOOK_HEIGHT
  );

  _vehicleFollowWorld.copy(_vehicleFollowLocal);
  terrainRoot.localToWorld(_vehicleFollowWorld);
  _vehicleLookTargetWorld.copy(_vehicleLookTargetLocal);
  terrainRoot.localToWorld(_vehicleLookTargetWorld);

  camera.position.copy(_vehicleFollowWorld);
  camera.up.copy(up);
  camera.lookAt(_vehicleLookTargetWorld);

  // Update controls yaw/pitch to match
  _vehicleLookDirLocal.copy(_vehicleLookTargetLocal).sub(_vehicleFollowLocal).normalize();
  useControlsStore.setState({
    yaw: Math.atan2(-_vehicleLookDirLocal.x, _vehicleLookDirLocal.y),
    pitch: Math.asin(THREE.MathUtils.clamp(_vehicleLookDirLocal.z, -1, 1)),
  });
}

function updateTurretFollowCamera(
  vehicle: any,
  camera: THREE.Camera,
  terrainRoot: THREE.Group,
  up: THREE.Vector3
) {
  getBarrelTipWorld(vehicle, _barrelTipWorld, terrainRoot);
  getTurretDirection(vehicle, _turretDir, terrainRoot);

  _turretCamLocal.copy(_barrelTipWorld);
  _turretCamLocal.addScaledVector(_turretDir, -TURRET_CAM_BEHIND);
  _vUp.set(0, 0, 1).applyQuaternion(vehicle.group.quaternion);
  _turretCamLocal.addScaledVector(_vUp, TURRET_CAM_ABOVE);

  _turretLookLocal.copy(_barrelTipWorld);
  _turretLookLocal.addScaledVector(_turretDir, 500);

  _turretCamWorld.copy(_turretCamLocal);
  terrainRoot.localToWorld(_turretCamWorld);
  _turretLookWorld.copy(_turretLookLocal);
  terrainRoot.localToWorld(_turretLookWorld);

  camera.position.copy(_turretCamWorld);
  camera.up.copy(up);
  camera.lookAt(_turretLookWorld);
}

function getBarrelTipWorld(vehicle: any, target: THREE.Vector3, terrainRoot: THREE.Group) {
  if (!vehicle.gunPivot) return target.copy(vehicle.group.position);
  target.copy(vehicle.barrelTipLocal);
  vehicle.gunPivot.localToWorld(target);
  terrainRoot.worldToLocal(target);
  return target;
}

function getTurretDirection(vehicle: any, target: THREE.Vector3, terrainRoot: THREE.Group) {
  if (!vehicle.gunPivot) {
    target.set(0, 1, 0).applyQuaternion(vehicle.group.quaternion).normalize();
    return target;
  }
  const origin = new THREE.Vector3(0, 0, 0);
  const forward = new THREE.Vector3(0, 1, 0);
  vehicle.gunPivot.localToWorld(origin);
  vehicle.gunPivot.localToWorld(forward);
  terrainRoot.worldToLocal(origin);
  terrainRoot.worldToLocal(forward);
  target.copy(forward).sub(origin).normalize();
  return target;
}
