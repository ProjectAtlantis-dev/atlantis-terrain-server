import { useRef, useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useVehicleStore } from '@/stores/vehicleStore';
import { useTerrainStore } from '@/stores/terrainStore';
import { getTerrainMeshes } from '@/utils/terrain';
import { playGunshotSound } from '@/utils/audio';
import {
  FIRE_INTERVAL,
  TRACER_SPEED,
  TRACER_MAX_RANGE,
  MAX_TRACERS,
  MAX_IMPACTS,
} from '@/utils/constants';

const _fireOrigin = new THREE.Vector3();
const _fireDir = new THREE.Vector3();
const _fireRaycaster = new THREE.Raycaster();
const _aimTarget = new THREE.Vector3();
const _camRayOrigin = new THREE.Vector3();
const _camRayDir = new THREE.Vector3();
const _tracerQuat = new THREE.Quaternion();
const _tracerUp = new THREE.Vector3(0, 1, 0);

interface TracerData {
  active: boolean;
  pos: THREE.Vector3;
  dir: THREE.Vector3;
  dist: number;
}

interface ImpactData {
  active: boolean;
  timer: number;
}

/**
 * Fire system: tracers, impacts, muzzle flash triggering.
 * Manages shared object pools for tracer cylinders and impact sprites.
 */
export function FireSystem() {
  const camera = useThree((s) => s.camera);
  const tracerPoolRef = useRef<THREE.Mesh[]>([]);
  const impactPoolRef = useRef<THREE.Sprite[]>([]);
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const terrainRoot = useTerrainStore.getState().terrainRoot;
    if (!terrainRoot) return;

    // Create tracer pool
    const tracerGeo = new THREE.CylinderGeometry(0.08, 0.08, 3, 6);
    const tracerMat = new THREE.MeshBasicMaterial({ color: 0xffcc00, toneMapped: false });
    for (let i = 0; i < MAX_TRACERS; i++) {
      const m = new THREE.Mesh(tracerGeo, tracerMat);
      m.visible = false;
      m.userData = { active: false, pos: new THREE.Vector3(), dir: new THREE.Vector3(), dist: 0 } as TracerData;
      terrainRoot.add(m);
      tracerPoolRef.current.push(m);
    }

    // Create impact pool
    const impCanvas = document.createElement('canvas');
    impCanvas.width = 32;
    impCanvas.height = 32;
    const ctx = impCanvas.getContext('2d')!;
    const grad = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(200,150,80,1)');
    grad.addColorStop(0.5, 'rgba(150,100,40,0.6)');
    grad.addColorStop(1, 'rgba(100,60,20,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 32, 32);
    const impTex = new THREE.CanvasTexture(impCanvas);
    const impMat = new THREE.SpriteMaterial({
      map: impTex,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });
    for (let i = 0; i < MAX_IMPACTS; i++) {
      const s = new THREE.Sprite(impMat.clone());
      s.visible = false;
      s.userData = { active: false, timer: 0 } as ImpactData;
      terrainRoot.add(s);
      impactPoolRef.current.push(s);
    }

    return () => {
      // Cleanup
      for (const t of tracerPoolRef.current) {
        t.removeFromParent();
        t.geometry.dispose();
        (t.material as THREE.Material).dispose();
      }
      for (const s of impactPoolRef.current) {
        s.removeFromParent();
        (s.material as THREE.Material).dispose();
      }
      tracerPoolRef.current = [];
      impactPoolRef.current = [];
    };
  }, []);

  useFrame((_, delta) => {
    const dt = Math.min(0.05, delta);
    const vStore = useVehicleStore.getState();
    const tStore = useTerrainStore.getState();
    const terrainRoot = tStore.terrainRoot;
    if (!terrainRoot) return;

    const activeVehicle = vStore.getActiveVehicle();

    // Fire turret
    if (activeVehicle?.turretControlActive && activeVehicle.fireHeld) {
      fireTurret(
        activeVehicle,
        camera,
        terrainRoot,
        tracerPoolRef.current,
        impactPoolRef.current
      );
    }

    // Update tracers
    const step = TRACER_SPEED * dt;
    for (const t of tracerPoolRef.current) {
      const ud = t.userData as TracerData;
      if (!ud.active) continue;
      ud.dist += step;
      if (ud.dist > TRACER_MAX_RANGE) {
        ud.active = false;
        t.visible = false;
        continue;
      }
      ud.pos.addScaledVector(ud.dir, step);
      t.position.copy(ud.pos);
      _tracerQuat.setFromUnitVectors(_tracerUp, ud.dir);
      t.quaternion.copy(_tracerQuat);
    }

    // Update impacts
    for (const imp of impactPoolRef.current) {
      const ud = imp.userData as ImpactData;
      if (!ud.active) continue;
      ud.timer -= dt;
      if (ud.timer <= 0) {
        ud.active = false;
        imp.visible = false;
        continue;
      }
      imp.material.opacity = ud.timer / 0.4;
      imp.scale.setScalar(0.5 + (1 - ud.timer / 0.4) * 1.5);
    }
  });

  return null;
}

function fireTurret(
  vehicle: any,
  camera: THREE.Camera,
  terrainRoot: THREE.Group,
  tracerPool: THREE.Mesh[],
  impactPool: THREE.Sprite[]
) {
  const now = performance.now() / 1000;
  if (now - vehicle.lastFireTime < FIRE_INTERVAL) return;
  vehicle.lastFireTime = now;

  // Get barrel tip in terrainRoot-local space
  if (!vehicle.gunPivot) return;
  _fireOrigin.copy(vehicle.barrelTipLocal);
  vehicle.gunPivot.localToWorld(_fireOrigin);
  terrainRoot.worldToLocal(_fireOrigin);

  // Camera ray
  camera.getWorldPosition(_camRayOrigin);
  camera.getWorldDirection(_camRayDir);
  _fireRaycaster.set(_camRayOrigin, _camRayDir);
  _fireRaycaster.far = TRACER_MAX_RANGE;

  const terrainMeshes = getTerrainMeshes(terrainRoot);
  const camHits = _fireRaycaster.intersectObjects(terrainMeshes, false);

  if (camHits.length > 0) {
    _aimTarget.copy(camHits[0].point);
    terrainRoot.worldToLocal(_aimTarget);
  } else {
    _aimTarget.copy(_camRayDir).multiplyScalar(TRACER_MAX_RANGE).add(_camRayOrigin);
    terrainRoot.worldToLocal(_aimTarget);
  }

  _fireDir.copy(_aimTarget).sub(_fireOrigin).normalize();

  // Muzzle flash
  if (vehicle.muzzleFlashSprite && vehicle.gunPivot) {
    const worldTip = vehicle.barrelTipLocal.clone();
    vehicle.gunPivot.localToWorld(worldTip);
    vehicle.group.worldToLocal(worldTip);
    vehicle.muzzleFlashSprite.position.copy(worldTip);
    vehicle.muzzleFlashSprite.visible = true;
    vehicle.muzzleFlashSprite.material.opacity = 1;
    vehicle.muzzleFlashTimer = 0.05;
  }

  // Spawn tracer
  for (const t of tracerPool) {
    const ud = t.userData as TracerData;
    if (!ud.active) {
      ud.active = true;
      ud.pos.copy(_fireOrigin);
      ud.dir.copy(_fireDir);
      ud.dist = 0;
      t.visible = true;
      t.position.copy(_fireOrigin);
      _tracerQuat.setFromUnitVectors(_tracerUp, _fireDir);
      t.quaternion.copy(_tracerQuat);
      break;
    }
  }

  // Spawn impact
  if (camHits.length > 0) {
    const hitLocal = camHits[0].point.clone();
    terrainRoot.worldToLocal(hitLocal);
    for (const imp of impactPool) {
      const ud = imp.userData as ImpactData;
      if (!ud.active) {
        ud.active = true;
        ud.timer = 0.4;
        imp.position.copy(hitLocal);
        imp.scale.setScalar(0.5);
        imp.material.opacity = 1;
        imp.visible = true;
        break;
      }
    }
  }

  playGunshotSound();
}
