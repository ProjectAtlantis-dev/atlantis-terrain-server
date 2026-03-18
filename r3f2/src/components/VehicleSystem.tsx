import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { StartupAssets } from '@/hooks/useAssetServer';
import type { VehicleEntry, WheelCluster } from '@/types/vehicle';
import { useVehicleStore } from '@/stores/vehicleStore';
import { useTerrainStore } from '@/stores/terrainStore';
import { useControlsStore } from '@/stores/controlsStore';
import { latLonToLocal } from '@/utils/geodesy';
import { getTerrainMeshes, tileDepthFromId } from '@/utils/terrain';
import { useDieselAudio } from '@/hooks/useDieselAudio';
import {
  VEHICLE_TEXTURE_ANISOTROPY,
  VEHICLE_SUSPENSION_HZ,
  VEHICLE_SUSPENSION_DAMPING_RATIO,
  VEHICLE_SUSPENSION_MAX_VEL,
  VEHICLE_REFINEMENT_BOUNCE,
  VEHICLE_RESNAP_MARGIN_M,
  VEHICLE_ORIENTATION_RESPONSE,
  VEHICLE_SLOPE_PROBE_LENGTH_SCALE,
  VEHICLE_SLOPE_PROBE_WIDTH_SCALE,
  VEHICLE_SNAP_IDLE_MS,
  VEHICLE_SNAP_PENDING_MS,
  VEHICLE_RESTORE_MIN_DEPTH,
  VEHICLE_SHADOW_MAP_SIZE,
  VEHICLE_SHADOW_LIGHT_DISTANCE,
  VEHICLE_SHADOW_MIN_RADIUS,
  VEHICLE_SHADOW_MAX_RADIUS,
  VEHICLE_SHADOW_OPACITY,
  VEHICLE_SHADOW_TEXEL_SNAP,
  VEHICLE_SHADOW_GROUND_ANCHOR,
  HOUSE_MARKER_HEIGHT,
  HOUSE_MARKER_BASE_LIFT,
  MAX_TRACERS,
  MAX_IMPACTS,
  DEFAULT_LOCATION,
} from '@/utils/constants';

interface VehicleSystemProps {
  assets: StartupAssets;
}

// Shared raycasting infrastructure
const _downRaycaster = new THREE.Raycaster();
const _upRaycaster = new THREE.Raycaster();
const _sunLocal = new THREE.Vector3();
const _snapPrevQuat = new THREE.Quaternion();
const _probeLongitudinal = new THREE.Vector3();
const _probeLateral = new THREE.Vector3();
const _probeNormalWorld = new THREE.Vector3();
const _probeNormalLocal = new THREE.Vector3();

/**
 * Vehicle system: loads models, manages terrain snap, suspension, wheel spin,
 * turret rotation, sun lights, shadow system.
 */
export function VehicleSystem({ assets }: VehicleSystemProps) {
  const { gl } = useThree();
  const loaded = useRef(false);

  // Diesel engine audio
  useDieselAudio();

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;

    const vStore = useVehicleStore.getState();
    const def = vStore.definition;
    if (!def) return;

    const tStore = useTerrainStore.getState();
    const terrainRoot = tStore.terrainRoot;
    if (!terrainRoot) return;

    const anchorLat = terrainRoot.userData.anchorLat ?? DEFAULT_LOCATION.lat;
    const anchorLon = terrainRoot.userData.anchorLon ?? DEFAULT_LOCATION.lon;

    // Create initial vehicle entry
    const instanceConfig = vStore.instances[0] ?? {};
    const entry = createVehicleEntry(
      'amv-01',
      def,
      instanceConfig,
      vStore.headlightsConfig,
      terrainRoot,
      anchorLat,
      anchorLon
    );
    vStore.addVehicle(entry);
    vStore.setActiveVehicle(entry.id);

    // Load model
    loadVehicleModel(entry, def, terrainRoot, anchorLat, anchorLon, gl);
  }, [assets, gl]);

  // Per-frame updates
  useFrame((_, delta) => {
    const dt = Math.min(0.05, delta);
    const vStore = useVehicleStore.getState();
    const tStore = useTerrainStore.getState();
    const terrainRoot = tStore.terrainRoot;
    if (!terrainRoot) return;

    const enu = terrainRoot.userData.enu;
    if (!enu) return;

    // Process ALL vehicles
    for (const [, vehicle] of vStore.registry) {
      if (!vehicle.loaded) continue;
      snapVehicleToTerrain(vehicle, terrainRoot, enu, vStore);
      updateVehicleSuspension(vehicle, dt, vStore);
      updateVehicleWheelSpin(vehicle, dt);
      updateTurretRotation(vehicle);
      syncVehicleSunLight(vehicle, enu, vStore);
    }

    // Muzzle flash timer
    const activeVehicle = vStore.getActiveVehicle();
    if (activeVehicle?.muzzleFlashSprite && activeVehicle.muzzleFlashTimer > 0) {
      activeVehicle.muzzleFlashTimer -= dt;
      if (activeVehicle.muzzleFlashTimer <= 0) {
        activeVehicle.muzzleFlashSprite.visible = false;
      } else {
        activeVehicle.muzzleFlashSprite.material.opacity = activeVehicle.muzzleFlashTimer / 0.05;
      }
    }
  });

  return null;
}

function createVehicleEntry(
  id: string,
  definition: any,
  instanceConfig: any,
  headlightsConfig: any,
  terrainRoot: THREE.Group,
  anchorLat: number,
  anchorLon: number
): VehicleEntry {
  const group = new THREE.Group();
  group.name = definition.displayName || 'vehicle';
  terrainRoot.add(group);

  const sunLight = new THREE.DirectionalLight(0xffffff, 3.0);
  sunLight.name = 'vehicle-sun-light';
  sunLight.castShadow = false;
  group.add(sunLight);
  group.add(sunLight.target);

  const ambientLight = new THREE.AmbientLight(0x8090b0, 1.0);
  group.add(ambientLight);

  // Map marker
  const marker = createVehicleMarker(definition.displayName);
  terrainRoot.add(marker);

  const wheelNames = Array.isArray(definition.parts?.wheels) && definition.parts.wheels.length > 0
    ? definition.parts.wheels
    : ['Object_8', 'Object_9', 'Object_10'];
  const turretName = definition.parts?.turret ?? 'Object_3';
  const gunName = definition.parts?.gun ?? 'Object_2';
  const wheelSplitThreshold = Number.isFinite(definition.wheelClusterSplitThreshold)
    ? definition.wheelClusterSplitThreshold
    : 3500;
  const TIRE_RADIUS_M = Math.max(0, (definition.tireDiameterM ?? 1.27) * 0.5);
  const TERRAIN_LIFT_M = (definition.altOffsetM ?? 0.05) + TIRE_RADIUS_M;

  const startLat = Number.isFinite(instanceConfig.lat) ? instanceConfig.lat : anchorLat;
  const startLon = Number.isFinite(instanceConfig.lon) ? instanceConfig.lon : anchorLon;
  const startHeadingDeg = Number.isFinite(instanceConfig.headingDeg) ? instanceConfig.headingDeg : 0;

  return {
    id,
    definition,
    instanceConfig,
    headlightsConfig,
    group,
    model: null,
    meshes: [],
    marker,
    sunLight,
    ambientLight,
    loaded: false,
    wheelObjects: [],
    wheelClusters: [],
    wheelAngle: 0,
    turretPivot: null,
    gunPivot: null,
    turretMesh: null,
    gunMesh: null,
    barrelTipLocal: new THREE.Vector3(),
    muzzleFlashSprite: null,
    muzzleFlashTimer: 0,
    headlightSpots: [],
    wheelNames,
    turretName,
    gunName,
    wheelSplitThreshold,
    TIRE_RADIUS_M,
    TERRAIN_LIFT_M,
    bodyLengthM: definition.realLengthM ?? 7.7,
    bodyWidthM: Math.max(2, (definition.realLengthM ?? 7.7) * 0.35),
    shadowRadius: 100,
    headingRad: THREE.MathUtils.degToRad(startHeadingDeg),
    speed: 0,
    snapPending: true,
    groundZTarget: null,
    verticalVelocity: 0,
    lastContactDepth: -1,
    lastContactTileId: null,
    awaitingInitialSnap: false,
    restoreRequiresDepth: false,
    restoreDepthTarget: -1,
    savedStatePending: instanceConfig.lat != null ? {
      lat: startLat,
      lon: startLon,
      headingDeg: startHeadingDeg,
      z: Number.isFinite(instanceConfig.z) ? instanceConfig.z : null,
      terrainDepth: Number.isFinite(instanceConfig.terrainDepth) ? instanceConfig.terrainDepth : null,
    } : null,
    controlActive: false,
    turretControlActive: false,
    turretYawRad: 0,
    turretPitchRad: 0,
    fireHeld: false,
    lastFireTime: 0,
    camModeIndex: 1,
    cameraFollowDist: 25,
    cameraFollowHeight: 8,
    driftMode: false,
  };
}

function loadVehicleModel(
  vehicle: VehicleEntry,
  definition: any,
  terrainRoot: THREE.Group,
  anchorLat: number,
  anchorLon: number,
  renderer: THREE.WebGLRenderer
) {
  const loader = new GLTFLoader();
  const url = (typeof definition.url === 'string' && definition.url.trim() !== '')
    ? definition.url
    : '/models/patria_amv.glb';
  const realLengthM = definition.realLengthM ?? 7.7;

  loader.load(url, (gltf) => {
    try {
      const model = gltf.scene;
      vehicle.model = model;
      model.rotation.x = Math.PI * 0.5; // Y-up → Z-up

      // Apply texture sampling and enable shadows
      const maxAniso = renderer.capabilities.getMaxAnisotropy?.() ?? 1;
      model.traverse((obj: any) => {
        if (obj.isMesh) {
          obj.castShadow = true;
          obj.receiveShadow = true;
          const applyTex = (tex: any) => {
            if (!tex?.isTexture) return;
            tex.anisotropy = Math.max(1, Math.min(maxAniso, VEHICLE_TEXTURE_ANISOTROPY));
            tex.minFilter = THREE.LinearMipmapLinearFilter;
            tex.magFilter = THREE.LinearFilter;
            tex.generateMipmaps = true;
            tex.needsUpdate = true;
          };
          const applyMat = (mat: any) => {
            if (!mat) return;
            applyTex(mat.map);
            applyTex(mat.normalMap);
            applyTex(mat.roughnessMap);
            applyTex(mat.metalnessMap);
          };
          if (Array.isArray(obj.material)) {
            for (const m of obj.material) applyMat(m);
          } else {
            applyMat(obj.material);
          }
        }
      });

      // Measure and scale
      const bbox = new THREE.Box3().setFromObject(model);
      const modelSize = new THREE.Vector3();
      bbox.getSize(modelSize);
      const modelLength = Math.max(modelSize.x, modelSize.y, modelSize.z);
      const vehicleScale = modelLength > 0 ? realLengthM / modelLength : 1;
      const scaledDims = [
        modelSize.x * vehicleScale,
        modelSize.y * vehicleScale,
        modelSize.z * vehicleScale,
      ].sort((a, b) => b - a);
      vehicle.bodyLengthM = scaledDims[0];
      vehicle.bodyWidthM = scaledDims[1];
      vehicle.shadowRadius = THREE.MathUtils.clamp(
        modelLength * vehicleScale * 12,
        VEHICLE_SHADOW_MIN_RADIUS,
        VEHICLE_SHADOW_MAX_RADIUS
      );
      model.position.z -= bbox.min.z;
      vehicle.group.add(model);

      // Headlights
      if (vehicle.headlightsConfig && vehicle.instanceConfig.headlightsOn === true) {
        setupHeadlights(vehicle, vehicleScale);
      }

      // Collect meshes
      vehicle.meshes = [];
      model.traverse((obj: any) => { if (obj.isMesh) vehicle.meshes.push(obj); });

      // Build wheel clusters
      setupWheelClusters(vehicle, model);

      // Turret & gun pivots
      setupTurretPivots(vehicle, model);

      // Muzzle flash sprite
      setupMuzzleFlash(vehicle);

      // Position vehicle from saved state
      const savedState = vehicle.savedStatePending;
      const startLat = Number.isFinite(savedState?.lat) ? savedState!.lat : anchorLat;
      const startLon = Number.isFinite(savedState?.lon) ? savedState!.lon : anchorLon;
      const startHeadingDeg = Number.isFinite(savedState?.headingDeg) ? savedState!.headingDeg : 0;
      const startZ = Number.isFinite(savedState?.z) ? savedState!.z! : 0;

      const local = latLonToLocal(startLat, startLon, anchorLat, anchorLon);
      vehicle.headingRad = THREE.MathUtils.degToRad(startHeadingDeg);

      // Initialize orientation
      const vStore = useVehicleStore.getState();
      vStore.groundNormal.set(0, 0, 1);
      updateVehicleOrientationTarget(vehicle, vStore);

      vehicle.group.position.set(local.x, local.y, startZ);
      vehicle.group.quaternion.copy(vStore.orientationTargetQuat);
      vehicle.group.scale.setScalar(vehicleScale);
      vehicle.loaded = true;
      vehicle.snapPending = true;
      vehicle.awaitingInitialSnap = true;
      vehicle.restoreRequiresDepth = Boolean(savedState);
      vehicle.restoreDepthTarget = Number.isFinite(savedState?.terrainDepth)
        ? savedState!.terrainDepth!
        : VEHICLE_RESTORE_MIN_DEPTH;
      vehicle.groundZTarget = Number.isFinite(startZ) ? startZ : null;
      vehicle.verticalVelocity = 0;
      vehicle.group.visible = false;
      vehicle.marker.position.set(local.x, local.y, HOUSE_MARKER_BASE_LIFT);

      console.log(`%c[VEHICLE] loaded: ${url}, scale=${vehicleScale.toFixed(4)}`, 'color:#ffbf00;font-weight:600');
    } catch (err) {
      console.warn('[VEHICLE] model setup error:', err);
      vehicle.loaded = true; // prevent crashes from hiding vehicle
    }
  }, undefined, (error) => {
    console.warn('[VEHICLE] load failed:', error);
  });
}

function setupWheelClusters(vehicle: VehicleEntry, model: THREE.Object3D) {
  vehicle.wheelObjects = [];
  vehicle.wheelClusters = [];
  model.traverse((obj: any) => {
    if (vehicle.wheelNames.includes(obj.name)) {
      vehicle.wheelObjects.push(obj);
    }
  });

  for (const mesh of vehicle.wheelObjects) {
    const posAttr = mesh.geometry.attributes.position;
    const count = posAttr.count;
    const verts: { i: number; y: number; z: number }[] = [];
    for (let i = 0; i < count; i++) {
      verts.push({ i, y: posAttr.getY(i), z: posAttr.getZ(i) });
    }
    verts.sort((a, b) => a.y - b.y);

    const rawClusters: typeof verts[] = [[verts[0]]];
    for (let i = 1; i < verts.length; i++) {
      if (verts[i].y - verts[i - 1].y > 0.15) {
        rawClusters.push([verts[i]]);
      } else {
        rawClusters[rawClusters.length - 1].push(verts[i]);
      }
    }

    const clusters: typeof verts[] = [];
    for (const rc of rawClusters) {
      if (vehicle.wheelSplitThreshold && rc.length > vehicle.wheelSplitThreshold) {
        const midY = (rc[0].y + rc[rc.length - 1].y) / 2;
        const lo = rc.filter((v) => v.y <= midY);
        const hi = rc.filter((v) => v.y > midY);
        if (lo.length > 0) clusters.push(lo);
        if (hi.length > 0) clusters.push(hi);
      } else {
        clusters.push(rc);
      }
    }

    for (const cl of clusters) {
      let sumY = 0, sumZ = 0;
      const indices: number[] = [];
      for (const v of cl) {
        sumY += v.y;
        sumZ += v.z;
        indices.push(v.i);
      }
      const n = cl.length;
      const basePositions = new Float32Array(indices.length * 3);
      for (let j = 0; j < indices.length; j++) {
        basePositions[j * 3] = posAttr.getX(indices[j]);
        basePositions[j * 3 + 1] = posAttr.getY(indices[j]);
        basePositions[j * 3 + 2] = posAttr.getZ(indices[j]);
      }
      vehicle.wheelClusters.push({
        mesh,
        indices,
        centerY: sumY / n,
        centerZ: sumZ / n,
        basePositions,
      });
    }
  }
}

function setupTurretPivots(vehicle: VehicleEntry, model: THREE.Object3D) {
  try {
    vehicle.turretMesh = null;
    vehicle.gunMesh = null;
    vehicle.turretPivot = null;
    vehicle.gunPivot = null;
    vehicle.barrelTipLocal = new THREE.Vector3();

    model.traverse((obj: any) => {
      if (!obj.isMesh) return;
      if (vehicle.turretName && obj.name === vehicle.turretName) vehicle.turretMesh = obj;
      if (vehicle.gunName && obj.name === vehicle.gunName) vehicle.gunMesh = obj;
    });

    const tMesh = vehicle.turretMesh as THREE.Mesh | null;
    if (tMesh) {
      const posAttr = tMesh.geometry.attributes.position;
      const count = posAttr.count;
      let sumX = 0, sumY = 0, sumZ = 0;
      for (let i = 0; i < count; i++) {
        sumX += posAttr.getX(i);
        sumY += posAttr.getY(i);
        sumZ += posAttr.getZ(i);
      }
      const cx = sumX / count, cy = sumY / count, cz = sumZ / count;

      vehicle.turretPivot = new THREE.Group();
      vehicle.turretPivot.name = 'turretPivot';
      vehicle.turretPivot.position.set(cx, cy, cz);

      const turretParent = tMesh.parent!;
      turretParent.add(vehicle.turretPivot);
      turretParent.remove(tMesh);
      tMesh.position.set(-cx, -cy, -cz);
      vehicle.turretPivot.add(tMesh);

      const gMesh = vehicle.gunMesh as THREE.Mesh | null;
      if (gMesh) {
        const gunPos = gMesh.geometry.attributes.position;
        const gunCount = gunPos.count;
        let gSumX = 0, gSumY = 0, gSumZ = 0, maxY = -Infinity;
        for (let i = 0; i < gunCount; i++) {
          const x = gunPos.getX(i), y = gunPos.getY(i), z = gunPos.getZ(i);
          gSumX += x; gSumY += y; gSumZ += z;
          if (y > maxY) { maxY = y; vehicle.barrelTipLocal.set(x, y, z); }
        }
        const gcz = gSumZ / gunCount;

        vehicle.gunPivot = new THREE.Group();
        vehicle.gunPivot.name = 'gunPivot';
        vehicle.gunPivot.position.set(0, 0, gcz - cz);

        const gunParent = gMesh.parent!;
        gunParent.remove(gMesh);
        gMesh.position.set(-cx, -cy, -gcz);
        vehicle.turretPivot.add(vehicle.gunPivot);
        vehicle.gunPivot.add(gMesh);

        vehicle.barrelTipLocal.set(
          vehicle.barrelTipLocal.x - cx,
          vehicle.barrelTipLocal.y - cy,
          vehicle.barrelTipLocal.z - gcz
        );
      }
    }
  } catch (err) {
    console.warn('[VEHICLE] turret setup failed:', err);
  }
}

function setupHeadlights(vehicle: VehicleEntry, vehicleScale: number) {
  const hlCfg = vehicle.headlightsConfig!;
  const localScale = vehicleScale !== 0 ? vehicleScale : 1;
  const hlFrontY = (vehicle.bodyLengthM * hlCfg.mountFrontRatio) / localScale;
  const hlHeight = hlCfg.mountHeightM / localScale;
  const hlSpacing = hlCfg.mountSpacingM / localScale;
  const hlTargetY = hlFrontY + (hlCfg.targetForwardM / localScale);
  const hlTargetZ = hlCfg.targetHeightM / localScale;
  const hlAngle = THREE.MathUtils.degToRad(hlCfg.angleDeg);

  vehicle.headlightSpots = [];
  for (const side of [-1, 1]) {
    const hl = new THREE.SpotLight(
      hlCfg.color, hlCfg.intensity, hlCfg.distanceM,
      hlAngle, hlCfg.penumbra, hlCfg.decay
    );
    hl.position.set(side * hlSpacing, hlFrontY, hlHeight);
    hl.castShadow = false;
    const target = new THREE.Object3D();
    target.position.set(side * hlSpacing * hlCfg.targetXScale, hlTargetY, hlTargetZ);
    vehicle.group.add(target);
    hl.target = target;
    vehicle.group.add(hl);
    vehicle.headlightSpots.push(hl);
  }
}

function setupMuzzleFlash(vehicle: VehicleEntry) {
  const flashCanvas = document.createElement('canvas');
  flashCanvas.width = 64;
  flashCanvas.height = 64;
  const ctx = flashCanvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,200,1)');
  grad.addColorStop(0.3, 'rgba(255,200,50,0.8)');
  grad.addColorStop(1, 'rgba(255,100,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  const flashTex = new THREE.CanvasTexture(flashCanvas);
  const flashMat = new THREE.SpriteMaterial({
    map: flashTex,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
  vehicle.muzzleFlashSprite = new THREE.Sprite(flashMat);
  vehicle.muzzleFlashSprite.scale.setScalar(0.5);
  vehicle.muzzleFlashSprite.visible = false;
  vehicle.group.add(vehicle.muzzleFlashSprite);
}

function createVehicleMarker(displayName?: string): THREE.Group {
  const marker = new THREE.Group();
  marker.name = 'vehicle-marker';
  const color = 0xff2d55;

  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, HOUSE_MARKER_HEIGHT),
    ]),
    new THREE.LineBasicMaterial({
      color,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.95,
    })
  );
  line.renderOrder = 1002;

  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(240, 14, 12),
    new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false })
  );
  dot.position.z = HOUSE_MARKER_HEIGHT;
  dot.renderOrder = 1004;

  marker.add(line, dot);
  return marker;
}

// ── Terrain Snap ─────────────────────────────────────────────────────────

function sampleBestTerrainHit(
  vehicle: VehicleEntry,
  terrainRoot: THREE.Group,
  localX?: number,
  localY?: number
) {
  if (localX === undefined) localX = vehicle.group.position.x;
  if (localY === undefined) localY = vehicle.group.position.y;
  if (!vehicle.loaded) return { hit: null, depth: -1, tileId: null };

  const terrainMeshes = getTerrainMeshes(terrainRoot);
  if (terrainMeshes.length === 0) return { hit: null, depth: -1, tileId: null };

  const targetLocal = new THREE.Vector3(localX, localY, 20000);
  const targetWorld = targetLocal.clone();
  terrainRoot.localToWorld(targetWorld);

  const enu = terrainRoot.userData.enu;
  const downDir = enu.up.clone().negate();
  _downRaycaster.set(targetWorld, downDir);

  const terrainHits = _downRaycaster.intersectObjects(terrainMeshes);
  if (terrainHits.length === 0) return { hit: null, depth: -1, tileId: null };

  let bestHit: any = null;
  let bestDepth = -1;
  for (const hit of terrainHits) {
    const depth = tileDepthFromId(hit.object?.userData?.tileId);
    if (depth > bestDepth) {
      bestDepth = depth;
      bestHit = hit;
    }
  }
  return {
    hit: bestHit,
    depth: bestDepth,
    tileId: bestHit?.object?.userData?.tileId ?? null,
  };
}

function snapVehicleToTerrain(
  vehicle: VehicleEntry,
  terrainRoot: THREE.Group,
  enu: any,
  vStore: any
) {
  if (!vehicle.loaded) return;
  const now = performance.now();
  const minInterval = vehicle.snapPending ? VEHICLE_SNAP_PENDING_MS : VEHICLE_SNAP_IDLE_MS;
  if (now - vStore.lastSnapAttemptAt < minInterval) return;
  vStore.setLastSnapAttempt(now);

  const terrainMeshes = getTerrainMeshes(terrainRoot);
  if (terrainMeshes.length === 0 || vehicle.meshes.length === 0) return;

  const terrainSample = sampleBestTerrainHit(vehicle, terrainRoot);
  if (!terrainSample.hit) return;

  const depth = tileDepthFromId(terrainSample.hit.object?.userData?.tileId);
  const selectedTileId = terrainSample.hit.object?.userData?.tileId ?? null;
  const bestMinDepthHit = depth >= vehicle.restoreDepthTarget ? terrainSample.hit : null;
  const selectedHit = vehicle.restoreRequiresDepth ? bestMinDepthHit : terrainSample.hit;
  if (!selectedHit) return;

  // Update ground normal
  updateVehicleGroundNormal(vehicle, selectedHit, terrainRoot, enu, vStore);
  updateVehicleOrientationTarget(vehicle, vStore);

  const terrainPoint = selectedHit.point.clone();
  const targetLocal = terrainPoint.clone();
  terrainRoot.worldToLocal(targetLocal);

  const alignImmediately = vehicle.awaitingInitialSnap;
  const preSnapZ = vehicle.group.position.z;
  _snapPrevQuat.copy(vehicle.group.quaternion);

  vehicle.group.quaternion.copy(vStore.orientationTargetQuat);
  vehicle.group.position.z = targetLocal.z + 50;
  vehicle.group.updateMatrixWorld(true);

  // Raycast up to find vehicle bottom
  const upDir = enu.up.clone();
  _upRaycaster.set(terrainPoint, upDir);
  const vehicleHits = _upRaycaster.intersectObjects(vehicle.meshes);
  let groundedZ = targetLocal.z + vehicle.TERRAIN_LIFT_M;
  if (vehicleHits.length > 0) {
    const gap = vehicleHits[0].distance;
    groundedZ = vehicle.group.position.z - gap + vehicle.TERRAIN_LIFT_M;
  }

  if (!alignImmediately) {
    vehicle.group.position.z = preSnapZ;
    vehicle.group.quaternion.copy(_snapPrevQuat);
  }

  // Set ground target
  const prevDepth = vehicle.lastContactDepth;
  const prevTargetZ = vehicle.groundZTarget;
  vehicle.groundZTarget = groundedZ;
  if (alignImmediately) {
    vehicle.group.position.z = groundedZ;
    vehicle.verticalVelocity = 0;
  }

  // Refinement bounce
  const depthRefined = Number.isFinite(depth) && depth > prevDepth;
  if (depthRefined && Number.isFinite(prevTargetZ)) {
    const dz = groundedZ - prevTargetZ!;
    if (Math.abs(dz) > 0.005) {
      vehicle.verticalVelocity += dz * VEHICLE_REFINEMENT_BOUNCE;
      vehicle.verticalVelocity = THREE.MathUtils.clamp(
        vehicle.verticalVelocity,
        -VEHICLE_SUSPENSION_MAX_VEL,
        VEHICLE_SUSPENSION_MAX_VEL
      );
    }
  }

  vehicle.snapPending = false;
  vehicle.restoreRequiresDepth = false;
  vehicle.restoreDepthTarget = -1;
  vehicle.lastContactDepth = Number.isFinite(depth) ? depth : vehicle.lastContactDepth;
  vehicle.lastContactTileId = selectedTileId;

  if (vehicle.awaitingInitialSnap) {
    vehicle.awaitingInitialSnap = false;
    vehicle.group.visible = true;
  }

  vehicle.marker.position.z = vehicle.group.position.z + HOUSE_MARKER_BASE_LIFT;
}

function updateVehicleGroundNormal(
  vehicle: VehicleEntry,
  centerHit: any,
  terrainRoot: THREE.Group,
  enu: any,
  vStore: any
) {
  const headingForward = new THREE.Vector3(-Math.sin(vehicle.headingRad), Math.cos(vehicle.headingRad), 0).normalize();
  const headingRight = new THREE.Vector3(Math.cos(vehicle.headingRad), Math.sin(vehicle.headingRad), 0).normalize();
  const probeForwardM = Math.max(1.0, vehicle.bodyLengthM * VEHICLE_SLOPE_PROBE_LENGTH_SCALE);
  const probeRightM = Math.max(0.8, vehicle.bodyWidthM * VEHICLE_SLOPE_PROBE_WIDTH_SCALE);
  const cx = vehicle.group.position.x;
  const cy = vehicle.group.position.y;

  const front = sampleBestTerrainHit(vehicle, terrainRoot, cx + headingForward.x * probeForwardM, cy + headingForward.y * probeForwardM);
  const back = sampleBestTerrainHit(vehicle, terrainRoot, cx - headingForward.x * probeForwardM, cy - headingForward.y * probeForwardM);
  const right = sampleBestTerrainHit(vehicle, terrainRoot, cx + headingRight.x * probeRightM, cy + headingRight.y * probeRightM);
  const left = sampleBestTerrainHit(vehicle, terrainRoot, cx - headingRight.x * probeRightM, cy - headingRight.y * probeRightM);

  let normalReady = false;

  if (front.hit && back.hit && right.hit && left.hit) {
    _probeLongitudinal.subVectors(front.hit.point, back.hit.point);
    _probeLateral.subVectors(right.hit.point, left.hit.point);
    if (_probeLongitudinal.lengthSq() > 1e-6 && _probeLateral.lengthSq() > 1e-6) {
      _probeNormalWorld.crossVectors(_probeLateral, _probeLongitudinal);
      if (_probeNormalWorld.lengthSq() > 1e-8) {
        _probeNormalWorld.normalize();
        if (_probeNormalWorld.dot(enu.up) < 0) _probeNormalWorld.multiplyScalar(-1);

        // Convert world → terrainRoot local
        const inv = new THREE.Matrix4().copy(terrainRoot.matrixWorld).invert();
        _probeNormalLocal.copy(_probeNormalWorld).transformDirection(inv).normalize();
        vStore.groundNormal.copy(_probeNormalLocal);
        normalReady = true;
      }
    }
  }

  if (!normalReady && centerHit?.face && centerHit.object) {
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(centerHit.object.matrixWorld);
    _probeNormalWorld.copy(centerHit.face.normal).applyNormalMatrix(normalMatrix).normalize();
    if (_probeNormalWorld.dot(enu.up) < 0) _probeNormalWorld.multiplyScalar(-1);
    const inv = new THREE.Matrix4().copy(terrainRoot.matrixWorld).invert();
    _probeNormalLocal.copy(_probeNormalWorld).transformDirection(inv).normalize();
    vStore.groundNormal.copy(_probeNormalLocal);
    normalReady = true;
  }

  if (!normalReady) {
    vStore.groundNormal.set(0, 0, 1);
  }
}

function updateVehicleOrientationTarget(vehicle: VehicleEntry, vStore: any) {
  const groundNormal = vStore.groundNormal;
  vStore.desiredForward.set(-Math.sin(vehicle.headingRad), Math.cos(vehicle.headingRad), 0);
  vStore.desiredForward.addScaledVector(groundNormal, -vStore.desiredForward.dot(groundNormal));
  if (vStore.desiredForward.lengthSq() < 1e-8) {
    vStore.desiredForward.set(0, 1, 0);
  } else {
    vStore.desiredForward.normalize();
  }
  vStore.desiredRight.crossVectors(vStore.desiredForward, groundNormal);
  if (vStore.desiredRight.lengthSq() < 1e-8) {
    vStore.desiredRight.set(1, 0, 0);
  } else {
    vStore.desiredRight.normalize();
  }
  vStore.orientationMatrix.makeBasis(vStore.desiredRight, vStore.desiredForward, groundNormal);
  vStore.orientationTargetQuat.setFromRotationMatrix(vStore.orientationMatrix);
}

function updateVehicleSuspension(vehicle: VehicleEntry, dt: number, vStore: any) {
  if (!vehicle.loaded || !Number.isFinite(vehicle.groundZTarget)) return;
  const stepDt = Math.min(0.05, Math.max(0.001, dt));
  const omega = 2 * Math.PI * VEHICLE_SUSPENSION_HZ;
  const stiffness = omega * omega;
  const damping = 2 * VEHICLE_SUSPENSION_DAMPING_RATIO * omega;
  const error = vehicle.groundZTarget! - vehicle.group.position.z;
  const accel = stiffness * error - damping * vehicle.verticalVelocity;
  vehicle.verticalVelocity += accel * stepDt;
  vehicle.verticalVelocity = THREE.MathUtils.clamp(
    vehicle.verticalVelocity,
    -VEHICLE_SUSPENSION_MAX_VEL,
    VEHICLE_SUSPENSION_MAX_VEL
  );
  vehicle.group.position.z += vehicle.verticalVelocity * stepDt;

  if (Math.abs(error) < 0.002 && Math.abs(vehicle.verticalVelocity) < 0.01) {
    vehicle.group.position.z = vehicle.groundZTarget!;
    vehicle.verticalVelocity = 0;
  }

  updateVehicleOrientationTarget(vehicle, vStore);
  const orientationAlpha = 1 - Math.exp(-VEHICLE_ORIENTATION_RESPONSE * stepDt);
  vehicle.group.quaternion.slerp(vStore.orientationTargetQuat, orientationAlpha);
  vehicle.marker.position.z = vehicle.group.position.z + HOUSE_MARKER_BASE_LIFT;
}

function updateVehicleWheelSpin(vehicle: VehicleEntry, dt: number) {
  if (!vehicle.loaded || vehicle.wheelClusters.length === 0) return;
  const angularDelta = (vehicle.speed / vehicle.TIRE_RADIUS_M) * dt;
  vehicle.wheelAngle -= angularDelta;
  const cos = Math.cos(vehicle.wheelAngle);
  const sin = Math.sin(vehicle.wheelAngle);
  const dirty = new Set<THREE.Mesh>();

  for (const cl of vehicle.wheelClusters) {
    const posAttr = cl.mesh.geometry.attributes.position;
    for (let j = 0; j < cl.indices.length; j++) {
      const by = cl.basePositions[j * 3 + 1] - cl.centerY;
      const bz = cl.basePositions[j * 3 + 2] - cl.centerZ;
      posAttr.setY(cl.indices[j], cl.centerY + by * cos - bz * sin);
      posAttr.setZ(cl.indices[j], cl.centerZ + by * sin + bz * cos);
    }
    dirty.add(cl.mesh);
  }
  for (const mesh of dirty) {
    mesh.geometry.attributes.position.needsUpdate = true;
  }
}

function updateTurretRotation(vehicle: VehicleEntry) {
  if (!vehicle.loaded) return;
  if (vehicle.turretPivot) vehicle.turretPivot.rotation.z = vehicle.turretYawRad;
  if (vehicle.gunPivot) vehicle.gunPivot.rotation.x = vehicle.turretPitchRad;
  vehicle.group.updateMatrixWorld(true);
}

function syncVehicleSunLight(vehicle: VehicleEntry, enu: any, vStore: any) {
  if (!vehicle.loaded) return;
  // TODO: sunDirection from atmosphere system
  // For now use a fixed direction
  const sunDir = new THREE.Vector3(0.5, 0.3, 0.8).normalize();
  _sunLocal.set(
    sunDir.dot(enu.east),
    sunDir.dot(enu.north),
    sunDir.dot(enu.up)
  ).normalize();

  vStore.invQuat.copy(vehicle.group.quaternion).invert();
  _sunLocal.applyQuaternion(vStore.invQuat);

  vehicle.sunLight.target.position.set(0, 0, 0);
  vehicle.sunLight.position.set(
    _sunLocal.x * 40,
    _sunLocal.y * 40,
    _sunLocal.z * 40
  );
}
