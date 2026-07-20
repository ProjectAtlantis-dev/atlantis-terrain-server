import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { rendererTextureAnisotropy } from './terrain-texture-streamer.js';
import { tileDepthFromId } from './terrain-tile-runtime.js';
import {
  createVehiclePersistenceRuntime,
  normalizeSavedVehicleState,
  stepSuspension,
  terrainBboxIntersectsCircle,
  vehicleLocalToLatLon as terrainVehicleLocalToLatLon,
  vehicleStateSnapshot,
} from './terrain-vehicle.js';

export function createTerrainVehicleRuntime({
  vehicleDefinition: VEHICLE_DEFINITION,
  vehicleHeadlights: VEHICLE_HEADLIGHTS,
  assetVehicleInstances: ASSET_VEHICLE_INSTANCES,
  startupAssetsResponse,
  houseSites,
  vehicleStateEndpoint: VEHICLE_STATE_ENDPOINT,
  vehicleSaveTimeoutMs: VEHICLE_SAVE_FETCH_TIMEOUT_MS,
  vehicleSaveFailureCooldownMs: VEHICLE_SAVE_FAILURE_COOLDOWN_MS,
  houseMarkerBaseLift: HOUSE_MARKER_BASE_LIFT,
  houseMarkerHeight: HOUSE_MARKER_HEIGHT,
  houseMarkerHaloGeo,
  houseMarkerDotGeo,
  createHouseLabelSprite,
  mouseSensitivity: MOUSE_SENS,
  scene, camera, renderer, terrainRoot, controls, mouseNDC, raycaster,
  up, east, north, anchorLat, anchorLon,
  paramNumber, bootLog, enqueueClientLog,
  houseTerrainMeshes, houseLocalFromLatLon,
  getSunDirection,
  windowImpl = globalThis.window,
} = {}) {
  // ── Patria AMV vehicle ──────────────────────────────────────────────────
  const _vehicleSeedInstance = ASSET_VEHICLE_INSTANCES.length > 0 ? ASSET_VEHICLE_INSTANCES[0] : {};
  const VEHICLE_MODEL = {
    url: (typeof VEHICLE_DEFINITION.url === 'string' && VEHICLE_DEFINITION.url.trim() !== '')
      ? VEHICLE_DEFINITION.url
      : '/models/patria_amv.glb',
    lat: Number.isFinite(_vehicleSeedInstance.lat) ? _vehicleSeedInstance.lat : anchorLat,
    lon: Number.isFinite(_vehicleSeedInstance.lon) ? _vehicleSeedInstance.lon : anchorLon,
    headingDeg: Number.isFinite(_vehicleSeedInstance.headingDeg) ? _vehicleSeedInstance.headingDeg : 0,
    z: Number.isFinite(_vehicleSeedInstance.z) ? _vehicleSeedInstance.z : 0,
    realLengthM: Number.isFinite(VEHICLE_DEFINITION.realLengthM) ? VEHICLE_DEFINITION.realLengthM : 7.7,
    tireDiameterM: paramNumber(
      'vehicleTireDiameterM',
      Number.isFinite(VEHICLE_DEFINITION.tireDiameterM)
        ? VEHICLE_DEFINITION.tireDiameterM
        : 1.27
    ),
    altOffsetM: Number.isFinite(VEHICLE_DEFINITION.altOffsetM) ? VEHICLE_DEFINITION.altOffsetM : 0.05,
  };
  bootLog('assets.loaded', {
    source: startupAssetsResponse.source,
    schemaVersion: startupAssetsResponse.schemaVersion,
    seeded: startupAssetsResponse.seeded,
    headlightsOn: _vehicleSeedInstance.headlightsOn === true,
    headlightsParams: VEHICLE_HEADLIGHTS != null,
    structureCount: houseSites.length,
    vehicleCount: ASSET_VEHICLE_INSTANCES.length,
  });
  const VEHICLE_TIRE_RADIUS_M = Math.max(
    0,
    paramNumber('vehicleTireRadiusM', VEHICLE_MODEL.tireDiameterM * 0.5)
  );
  const VEHICLE_TERRAIN_LIFT_M = VEHICLE_MODEL.altOffsetM + VEHICLE_TIRE_RADIUS_M;
  const vehicleGroup = new THREE.Group();
  vehicleGroup.name = 'patria-amv';
  terrainRoot.add(vehicleGroup);
  const vehicleMarkerLayer = new THREE.Group();
  vehicleMarkerLayer.name = 'vehicle-markers';
  vehicleMarkerLayer.visible = false;
  vehicleMarkerLayer.renderOrder = 1002;
  terrainRoot.add(vehicleMarkerLayer);
  const VEHICLE_MARKER_MAP_SCALE = THREE.MathUtils.clamp(
    paramNumber('vehicleMarkerMapScale', 1.0),
    0.02,
    2
  );
  const vehicleMarkerColor = 0xff2d55;
  const vehicleMarker = (function createVehicleMarker() {
    const marker = new THREE.Group();
    marker.name = 'vehicle-marker-amv';
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, HOUSE_MARKER_HEIGHT),
      ]),
      new THREE.LineBasicMaterial({
        color: vehicleMarkerColor,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.95,
      })
    );
    line.renderOrder = 1002;
    const halo = new THREE.Mesh(
      houseMarkerHaloGeo,
      new THREE.MeshBasicMaterial({
        color: vehicleMarkerColor,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
      })
    );
    halo.position.z = HOUSE_MARKER_HEIGHT;
    halo.renderOrder = 1003;
    const dot = new THREE.Mesh(
      houseMarkerDotGeo,
      new THREE.MeshBasicMaterial({
        color: vehicleMarkerColor,
        depthTest: false,
        depthWrite: false,
      })
    );
    dot.position.z = HOUSE_MARKER_HEIGHT;
    dot.renderOrder = 1004;
    const label = createHouseLabelSprite('AMV', vehicleMarkerColor);
    label.position.set(0, 0, HOUSE_MARKER_HEIGHT + 900);
    label.renderOrder = 1005;
    marker.add(line, halo, dot, label);
    return marker;
  })();
  vehicleMarkerLayer.add(vehicleMarker);
  // Vehicle lighting — directional + ambient, synced to Takram sunDirection
  const vehicleSunLight = new THREE.DirectionalLight(0xffffff, 3.0);
  vehicleSunLight.name = 'vehicle-sun-light';
  vehicleSunLight.castShadow = false;
  vehicleGroup.add(vehicleSunLight);
  vehicleGroup.add(vehicleSunLight.target);
  const vehicleAmbientLight = new THREE.AmbientLight(0x8090b0, 1.0);
  vehicleGroup.add(vehicleAmbientLight);
  const VEHICLE_SHADOW_MAP_SIZE = 1024;
  const VEHICLE_SHADOW_LIGHT_DISTANCE = 250;
  const VEHICLE_SHADOW_MIN_RADIUS = 60;
  const VEHICLE_SHADOW_MAX_RADIUS = 180;
  const VEHICLE_SHADOW_MIN_SUN_PROJECTION = 0.2;
  const VEHICLE_SHADOW_TEXEL_SNAP = true;
  const VEHICLE_SHADOW_GROUND_ANCHOR = THREE.MathUtils.clamp(
    paramNumber('vehicleShadowGroundAnchor', 1.0),
    0,
    1
  );
  // Aggressive default so the vehicle shadow is clearly legible on bright ortho textures.
  const VEHICLE_SHADOW_OPACITY = THREE.MathUtils.clamp(paramNumber('vehicleShadowOpacity', 0.95), 0, 1);
  let vehicleShadowRadius = 100;
  const vehicleShadowReceiverMaterial = new THREE.ShadowMaterial({
    color: 0x000000,
    transparent: true,
    opacity: VEHICLE_SHADOW_OPACITY,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  vehicleShadowReceiverMaterial.toneMapped = false;
  const vehicleShadowReceiverLayer = new THREE.Group();
  vehicleShadowReceiverLayer.name = 'vehicle-shadow-receivers';
  vehicleShadowReceiverLayer.renderOrder = 25;
  vehicleShadowReceiverLayer.visible = false;
  terrainRoot.add(vehicleShadowReceiverLayer);
  const vehicleShadowReceivers = new Map();
  const vehicleShadowCasterLight = new THREE.DirectionalLight(0xffffff, 1.0);
  vehicleShadowCasterLight.name = 'vehicle-shadow-light';
  vehicleShadowCasterLight.castShadow = true;
  vehicleShadowCasterLight.visible = false;
  vehicleShadowCasterLight.shadow.mapSize.set(VEHICLE_SHADOW_MAP_SIZE, VEHICLE_SHADOW_MAP_SIZE);
  vehicleShadowCasterLight.shadow.bias = -0.00008;
  vehicleShadowCasterLight.shadow.normalBias = 0.04;
  vehicleShadowCasterLight.shadow.camera.near = 20;
  vehicleShadowCasterLight.shadow.camera.far = 700;
  terrainRoot.add(vehicleShadowCasterLight);
  terrainRoot.add(vehicleShadowCasterLight.target);
  const vehicleShadowCenterLocal = new THREE.Vector3();
  const vehicleShadowCenterWorld = new THREE.Vector3();
  const vehicleShadowCenterLight = new THREE.Vector3();
  const vehicleShadowSnappedLight = new THREE.Vector3();
  const vehicleShadowSnappedWorld = new THREE.Vector3();
  const vehicleShadowSnapOffsetWorld = new THREE.Vector3();
  const vehicleShadowSnapOffsetLocal = new THREE.Vector3();
  const vehicleLoader = new GLTFLoader();
  const vehicleDownRaycaster = new THREE.Raycaster();
  const vehicleDownDirection = up.clone().negate().normalize();
  const vehicleTargetWorld = new THREE.Vector3();
  const vehicleTargetLocal = new THREE.Vector3();
  let vehicleSnapPending = true;
  let vehicleLoaded = false;
  let vehicleControlActive = false;
  let vehicleSavedStatePending = null;
  let lastVehicleSnapAttemptAt = 0;
  let vehicleAwaitingInitialSnap = false;
  let vehicleRestoreRequiresDepth = false;
  let vehicleRestoreDepthTarget = -1;
  let vehicleGroundZTarget = null;
  let vehicleVerticalVelocity = 0;
  let vehicleHeadingRad = THREE.MathUtils.degToRad(VEHICLE_MODEL.headingDeg);
  let vehicleBodyLengthM = VEHICLE_MODEL.realLengthM;
  let vehicleBodyWidthM = Math.max(2, VEHICLE_MODEL.realLengthM * 0.35);
  let vehicleLastContactDepth = -1;
  let vehicleLastContactTileId = null;
  const vehicleUpRaycaster = new THREE.Raycaster();
  const vehicleUpDirection = up.clone().normalize();
  let vehicleMeshes = [];
  let vehicleHeadlightSpots = [];
  const VEHICLE_DRIVE_SPEED = paramNumber('vehicleDriveSpeed', 24);
  const VEHICLE_ACCEL = paramNumber('vehicleAccel', 24);      // m/s² throttle
  const VEHICLE_BRAKE = paramNumber('vehicleBrake', 3);       // m/s² engine brake (coast-down)
  const VEHICLE_STEER_SPEED = paramNumber('vehicleSteerSpeed', 1.5);
  let vehicleSpeed = 0; // current vehicle speed in m/s
  let VEHICLE_CAMERA_FOLLOW_DISTANCE = paramNumber('vehicleCamDistance', 38);
  let VEHICLE_CAMERA_FOLLOW_HEIGHT = paramNumber('vehicleCamHeight', 12);
  const VEHICLE_CAMERA_LOOK_HEIGHT = paramNumber('vehicleCamLookHeight', 2.2);
  const VEHICLE_CAMERA_ORBIT_SENS = paramNumber('vehicleCamOrbitSens', MOUSE_SENS);
  const VEHICLE_CAMERA_ORBIT_PITCH_MIN = THREE.MathUtils.degToRad(
    paramNumber('vehicleCamPitchMinDeg', -20)
  );
  const VEHICLE_CAMERA_ORBIT_PITCH_MAX = THREE.MathUtils.degToRad(
    paramNumber('vehicleCamPitchMaxDeg', 70)
  );
  const VEHICLE_SNAP_IDLE_MS = Math.max(250, paramNumber('vehicleSnapIdleMs', 1000));
  const VEHICLE_SNAP_PENDING_MS = Math.max(50, paramNumber('vehicleSnapPendingMs', 120));
  const VEHICLE_RESTORE_MIN_DEPTH = Math.max(0, Math.floor(paramNumber('vehicleRestoreMinDepth', 12)));
  const VEHICLE_SUSPENSION_HZ = Math.max(0.1, paramNumber('vehicleSuspensionHz', 1.8));
  const VEHICLE_SUSPENSION_DAMPING_RATIO = Math.max(0.1, paramNumber('vehicleSuspensionDampingRatio', 0.72));
  const VEHICLE_SUSPENSION_MAX_VEL = Math.max(1, paramNumber('vehicleSuspensionMaxVel', 12));
  const VEHICLE_REFINEMENT_BOUNCE = THREE.MathUtils.clamp(
    paramNumber('vehicleRefinementBounce', 0.35),
    0,
    2
  );
  const VEHICLE_RESNAP_MARGIN_M = Math.max(3, paramNumber('vehicleResnapMarginM', 14));
  const VEHICLE_ORIENTATION_RESPONSE = Math.max(1, paramNumber('vehicleOrientationResponse', 10));
  const VEHICLE_SLOPE_PROBE_LENGTH_SCALE = THREE.MathUtils.clamp(
    paramNumber('vehicleSlopeProbeLengthScale', 0.34),
    0.1,
    0.55
  );
  const VEHICLE_SLOPE_PROBE_WIDTH_SCALE = THREE.MathUtils.clamp(
    paramNumber('vehicleSlopeProbeWidthScale', 0.45),
    0.2,
    0.7
  );
  const vehicleFollowLocal = new THREE.Vector3();
  const vehicleFollowWorld = new THREE.Vector3();
  const VEHICLE_LOG_STYLE = 'color:#ffbf00;font-weight:600;';
  const vehicleGroundNormal = new THREE.Vector3(0, 0, 1);
  const vehicleDesiredForward = new THREE.Vector3();
  const vehicleDesiredRight = new THREE.Vector3();
  const vehicleOrientationMatrix = new THREE.Matrix4();
  const vehicleOrientationTargetQuat = new THREE.Quaternion();
  const vehicleSnapPrevQuat = new THREE.Quaternion();
  const vehicleInvQuat = new THREE.Quaternion();
  const vehicleNormalMatrix = new THREE.Matrix3();
  const vehicleTerrainInverse = new THREE.Matrix4();
  const vehicleProbeLongitudinal = new THREE.Vector3();
  const vehicleProbeLateral = new THREE.Vector3();
  const vehicleProbeNormalWorld = new THREE.Vector3();
  const vehicleProbeNormalLocal = new THREE.Vector3();
  const vehicleLookTargetLocal = new THREE.Vector3();
  const vehicleLookTargetWorld = new THREE.Vector3();
  const vehicleLookDirLocal = new THREE.Vector3();
  const VEHICLE_TEXTURE_ANISOTROPY = Math.max(
    1,
    Math.floor(paramNumber('vehicleTextureAnisotropy', 8))
  );
  let vehicleCameraOrbitYaw = 0;
  let vehicleCameraOrbitPitch = Math.atan2(
    VEHICLE_CAMERA_FOLLOW_HEIGHT,
    VEHICLE_CAMERA_FOLLOW_DISTANCE
  );
  
  function vehicleConsoleLog(message, ...args) {
    console.log(`%c[VEHICLE] ${message}`, VEHICLE_LOG_STYLE, ...args);
  }
  
  function vehicleConsoleWarn(message, ...args) {
    console.warn(`%c[VEHICLE] ${message}`, VEHICLE_LOG_STYLE, ...args);
  }
  
  function applyVehicleTextureSampling(texture) {
    if (!texture || !texture.isTexture) return;
    const maxAniso = rendererTextureAnisotropy(renderer);
    texture.anisotropy = Math.max(1, Math.min(maxAniso, VEHICLE_TEXTURE_ANISOTROPY));
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
  }
  
  function applyVehicleMaterialSampling(material) {
    if (!material) return;
    applyVehicleTextureSampling(material.map);
    applyVehicleTextureSampling(material.normalMap);
    applyVehicleTextureSampling(material.roughnessMap);
    applyVehicleTextureSampling(material.metalnessMap);
    applyVehicleTextureSampling(material.aoMap);
    applyVehicleTextureSampling(material.emissiveMap);
    applyVehicleTextureSampling(material.alphaMap);
  }
  
  function vehicleLocalToLatLon(x, y) {
    return terrainVehicleLocalToLatLon(x, y, anchorLat, anchorLon);
  }
  
  function getVehicleStateSnapshot() {
    return vehicleStateSnapshot({
      loaded: vehicleLoaded,
      position: vehicleGroup.position,
      headingRad: vehicleHeadingRad,
      anchorLat,
      anchorLon,
    });
  }
  
  function sampleBestVehicleTerrainHit(localX = vehicleGroup.position.x, localY = vehicleGroup.position.y, terrainMeshes = null) {
    if (!vehicleLoaded) {
      return { hit: null, depth: -1, tileId: null };
    }
    const targets = terrainMeshes ?? houseTerrainMeshes();
    if (targets.length === 0) {
      return { hit: null, depth: -1, tileId: null };
    }
    vehicleTargetLocal.set(localX, localY, 20000);
    vehicleTargetWorld.copy(vehicleTargetLocal);
    terrainRoot.localToWorld(vehicleTargetWorld);
    vehicleDownRaycaster.set(vehicleTargetWorld, vehicleDownDirection);
    const terrainHits = vehicleDownRaycaster.intersectObjects(targets);
    if (terrainHits.length === 0) {
      return { hit: null, depth: -1, tileId: null };
    }
    let bestHit = null;
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
  
  function terrainDirectionFromWorld(worldDir, out) {
    vehicleTerrainInverse.copy(terrainRoot.matrixWorld).invert();
    out.copy(worldDir).transformDirection(vehicleTerrainInverse).normalize();
  }
  
  function updateVehicleOrientationTargetFromGround() {
    vehicleDesiredForward.set(-Math.sin(vehicleHeadingRad), Math.cos(vehicleHeadingRad), 0);
    vehicleDesiredForward.addScaledVector(
      vehicleGroundNormal,
      -vehicleDesiredForward.dot(vehicleGroundNormal)
    );
    if (vehicleDesiredForward.lengthSq() < 1e-8) {
      vehicleDesiredForward.set(0, 1, 0);
    } else {
      vehicleDesiredForward.normalize();
    }
    vehicleDesiredRight.crossVectors(vehicleDesiredForward, vehicleGroundNormal);
    if (vehicleDesiredRight.lengthSq() < 1e-8) {
      vehicleDesiredRight.set(1, 0, 0);
    } else {
      vehicleDesiredRight.normalize();
    }
    vehicleOrientationMatrix.makeBasis(
      vehicleDesiredRight,
      vehicleDesiredForward,
      vehicleGroundNormal
    );
    vehicleOrientationTargetQuat.setFromRotationMatrix(vehicleOrientationMatrix);
  }
  
  function updateVehicleGroundNormalFromTerrain(centerHit, terrainMeshes) {
    let normalReady = false;
    const headingForward = vehicleDesiredForward.set(-Math.sin(vehicleHeadingRad), Math.cos(vehicleHeadingRad), 0).normalize();
    const headingRight = vehicleDesiredRight.set(Math.cos(vehicleHeadingRad), Math.sin(vehicleHeadingRad), 0).normalize();
    const probeForwardM = Math.max(1.0, vehicleBodyLengthM * VEHICLE_SLOPE_PROBE_LENGTH_SCALE);
    const probeRightM = Math.max(0.8, vehicleBodyWidthM * VEHICLE_SLOPE_PROBE_WIDTH_SCALE);
    const centerX = vehicleGroup.position.x;
    const centerY = vehicleGroup.position.y;
    const front = sampleBestVehicleTerrainHit(
      centerX + headingForward.x * probeForwardM,
      centerY + headingForward.y * probeForwardM,
      terrainMeshes
    );
    const back = sampleBestVehicleTerrainHit(
      centerX - headingForward.x * probeForwardM,
      centerY - headingForward.y * probeForwardM,
      terrainMeshes
    );
    const right = sampleBestVehicleTerrainHit(
      centerX + headingRight.x * probeRightM,
      centerY + headingRight.y * probeRightM,
      terrainMeshes
    );
    const left = sampleBestVehicleTerrainHit(
      centerX - headingRight.x * probeRightM,
      centerY - headingRight.y * probeRightM,
      terrainMeshes
    );
    if (front.hit && back.hit && right.hit && left.hit) {
      vehicleProbeLongitudinal.subVectors(front.hit.point, back.hit.point);
      vehicleProbeLateral.subVectors(right.hit.point, left.hit.point);
      if (
        vehicleProbeLongitudinal.lengthSq() > 1e-6 &&
        vehicleProbeLateral.lengthSq() > 1e-6
      ) {
        vehicleProbeNormalWorld.crossVectors(vehicleProbeLateral, vehicleProbeLongitudinal);
        if (vehicleProbeNormalWorld.lengthSq() > 1e-8) {
          vehicleProbeNormalWorld.normalize();
          if (vehicleProbeNormalWorld.dot(up) < 0) {
            vehicleProbeNormalWorld.multiplyScalar(-1);
          }
          terrainDirectionFromWorld(vehicleProbeNormalWorld, vehicleProbeNormalLocal);
          vehicleGroundNormal.copy(vehicleProbeNormalLocal);
          normalReady = true;
        }
      }
    }
    if (!normalReady && centerHit?.face && centerHit.object) {
      vehicleNormalMatrix.getNormalMatrix(centerHit.object.matrixWorld);
      vehicleProbeNormalWorld
        .copy(centerHit.face.normal)
        .applyNormalMatrix(vehicleNormalMatrix)
        .normalize();
      if (vehicleProbeNormalWorld.dot(up) < 0) {
        vehicleProbeNormalWorld.multiplyScalar(-1);
      }
      terrainDirectionFromWorld(vehicleProbeNormalWorld, vehicleProbeNormalLocal);
      vehicleGroundNormal.copy(vehicleProbeNormalLocal);
      normalReady = true;
    }
    if (!normalReady) {
      vehicleGroundNormal.copy(up);
    }
    vehicleGroundNormal.normalize();
  }
  
  function vehicleNearTileBbox(bbox) {
    if (!vehicleLoaded || !Array.isArray(bbox) || bbox.length !== 4) return false;
    const x = vehicleGroup.position.x;
    const y = vehicleGroup.position.y;
    return (
      x >= bbox[0] - VEHICLE_RESNAP_MARGIN_M &&
      x <= bbox[2] + VEHICLE_RESNAP_MARGIN_M &&
      y >= bbox[1] - VEHICLE_RESNAP_MARGIN_M &&
      y <= bbox[3] + VEHICLE_RESNAP_MARGIN_M
    );
  }
  
  function requestVehicleTerrainResnap(reason = 'terrain-update') {
    if (!vehicleLoaded) return;
    if (vehicleSnapPending) return;
    vehicleSnapPending = true;
    // bootLog('vehicle.resnap.requested', { reason });
  }
  
  function setVehicleGroundTarget(nextZ, options = {}) {
    const {
      immediate = false,
      resetVelocity = false,
    } = options;
    if (!Number.isFinite(nextZ)) return;
    vehicleGroundZTarget = nextZ;
    if (resetVelocity) {
      vehicleVerticalVelocity = 0;
    }
    if (immediate) {
      vehicleGroup.position.z = nextZ;
    }
    vehicleMarker.position.z = vehicleGroup.position.z + HOUSE_MARKER_BASE_LIFT;
  }
  
  function updateVehicleSuspension(dt) {
    if (!vehicleLoaded || !Number.isFinite(vehicleGroundZTarget)) return;
    const suspension = stepSuspension({
      dt, position: vehicleGroup.position.z, target: vehicleGroundZTarget,
      velocity: vehicleVerticalVelocity, frequency: VEHICLE_SUSPENSION_HZ,
      dampingRatio: VEHICLE_SUSPENSION_DAMPING_RATIO,
      maxVelocity: VEHICLE_SUSPENSION_MAX_VEL,
    });
    vehicleGroup.position.z = suspension.position;
    vehicleVerticalVelocity = suspension.velocity;
    updateVehicleOrientationTargetFromGround();
    const orientationAlpha = 1 - Math.exp(-VEHICLE_ORIENTATION_RESPONSE * suspension.stepDt);
    vehicleGroup.quaternion.slerp(vehicleOrientationTargetQuat, orientationAlpha);
    vehicleMarker.position.z = vehicleGroup.position.z + HOUSE_MARKER_BASE_LIFT;
  }
  
  function createVehicleSaveSnapshot(options = {}) {
    const { snapToGround = false, bypassSnapThrottle = false } = options;
    if (snapToGround && vehicleLoaded) {
      vehicleSnapPending = true;
      snapVehicleToTerrain({ forceImmediate: true, bypassThrottle: bypassSnapThrottle });
    }
    const state = getVehicleStateSnapshot();
    if (state == null) return null;
    if (Number.isFinite(vehicleGroundZTarget)) {
      state.z = Number(vehicleGroundZTarget.toFixed(3));
    }
    const terrainSample = sampleBestVehicleTerrainHit();
    if (terrainSample.depth >= 0) state.terrainDepth = terrainSample.depth;
    if (terrainSample.tileId) state.terrainTileId = terrainSample.tileId;
    return state;
  }
  
  const vehiclePersistence = createVehiclePersistenceRuntime({
    endpoint: VEHICLE_STATE_ENDPOINT,
    timeoutMs: VEHICLE_SAVE_FETCH_TIMEOUT_MS,
    failureCooldownMs: VEHICLE_SAVE_FAILURE_COOLDOWN_MS,
    createSnapshot: createVehicleSaveSnapshot,
    bootLog,
  });
  const saveVehicleState = vehiclePersistence.save;
  const throttledVehicleSave = vehiclePersistence.throttledSave;
  
  function loadVehicleState() {
    const state = ASSET_VEHICLE_INSTANCES.length > 0 ? ASSET_VEHICLE_INSTANCES[0] : null;
    if (state == null) {
      bootLog('vehicle.state.load.empty');
      return null;
    }
    const normalized = normalizeSavedVehicleState(state);
    if (normalized == null) {
      bootLog('vehicle.state.load.invalid', { state }, 'error');
      return null;
    }
    vehicleSavedStatePending = normalized;
    return vehicleSavedStatePending;
  }
  
  function loadVehicleModel() {
    vehicleLoader.load(
      VEHICLE_MODEL.url,
      gltf => {
        const model = gltf.scene;
        model.rotation.x = Math.PI * 0.5; // Y-up → Z-up
        // Keep original PBR materials for proper lighting
        model.traverse(obj => {
          if (obj.isMesh) {
            obj.castShadow = true;
            obj.receiveShadow = true;
            if (Array.isArray(obj.material)) {
              for (const material of obj.material) {
                applyVehicleMaterialSampling(material);
              }
            } else {
              applyVehicleMaterialSampling(obj.material);
            }
          }
        });
        // Measure model bounding box to compute real-world scale
        const bbox = new THREE.Box3().setFromObject(model);
        const modelSize = new THREE.Vector3();
        bbox.getSize(modelSize);
        // longest axis = model's "length" — scale so it equals realLengthM
        const modelLength = Math.max(modelSize.x, modelSize.y, modelSize.z);
        const vehicleScale = modelLength > 0
          ? VEHICLE_MODEL.realLengthM / modelLength
          : 1;
        const scaledDims = [
          modelSize.x * vehicleScale,
          modelSize.y * vehicleScale,
          modelSize.z * vehicleScale,
        ].sort((a, b) => b - a);
        vehicleBodyLengthM = scaledDims[0];
        vehicleBodyWidthM = scaledDims[1];
        const scaledSpan = modelLength * vehicleScale;
        vehicleShadowRadius = THREE.MathUtils.clamp(
          scaledSpan * 12,
          VEHICLE_SHADOW_MIN_RADIUS,
          VEHICLE_SHADOW_MAX_RADIUS
        );
        // Shift model so its bottom (min z) sits at z=0 in vehicleGroup local space
        model.position.z -= bbox.min.z;
        vehicleConsoleLog(`model bbox: ${modelSize.x.toFixed(2)} x ${modelSize.y.toFixed(2)} x ${modelSize.z.toFixed(2)}, longest=${modelLength.toFixed(2)}, scale=${vehicleScale.toFixed(4)}, bottomOffset=${bbox.min.z.toFixed(2)}`);
        vehicleGroup.add(model);
        // ── Headlights ──────────────────────────────────────────────────
        if (VEHICLE_HEADLIGHTS != null && _vehicleSeedInstance.headlightsOn === true) {
          const localScale = vehicleScale !== 0 ? vehicleScale : 1;
          const hlColor = VEHICLE_HEADLIGHTS.color;
          const hlIntensity = VEHICLE_HEADLIGHTS.intensity;
          const hlAngle = THREE.MathUtils.degToRad(VEHICLE_HEADLIGHTS.angleDeg);
          const hlPenumbra = VEHICLE_HEADLIGHTS.penumbra;
          const hlDistance = VEHICLE_HEADLIGHTS.distanceM;
          const hlDecay = VEHICLE_HEADLIGHTS.decay;
          const hlFrontY = (vehicleBodyLengthM * VEHICLE_HEADLIGHTS.mountFrontRatio) / localScale;
          const hlHeight = VEHICLE_HEADLIGHTS.mountHeightM / localScale;
          const hlSpacing = VEHICLE_HEADLIGHTS.mountSpacingM / localScale;
          const hlTargetY = hlFrontY + (VEHICLE_HEADLIGHTS.targetForwardM / localScale);
          const hlTargetZ = VEHICLE_HEADLIGHTS.targetHeightM / localScale;
          vehicleHeadlightSpots = [];
          for (const side of [-1, 1]) {
            const hl = new THREE.SpotLight(hlColor, hlIntensity, hlDistance, hlAngle, hlPenumbra, hlDecay);
            hl.position.set(side * hlSpacing, hlFrontY, hlHeight);
            hl.castShadow = false;
            const target = new THREE.Object3D();
            target.position.set(side * hlSpacing * VEHICLE_HEADLIGHTS.targetXScale, hlTargetY, hlTargetZ);
            vehicleGroup.add(target);
            hl.target = target;
            vehicleGroup.add(hl);
            vehicleHeadlightSpots.push(hl);
          }
        }
        // Collect vehicle meshes for upward raycast collision
        vehicleMeshes = [];
        model.traverse(obj => { if (obj.isMesh) vehicleMeshes.push(obj); });
        const savedState = vehicleSavedStatePending;
        const startLat = Number.isFinite(savedState?.lat) ? savedState.lat : VEHICLE_MODEL.lat;
        const startLon = Number.isFinite(savedState?.lon) ? savedState.lon : VEHICLE_MODEL.lon;
        const startHeadingDeg = Number.isFinite(savedState?.headingDeg)
          ? savedState.headingDeg
          : VEHICLE_MODEL.headingDeg;
        const startZ = Number.isFinite(savedState?.z) ? savedState.z : (VEHICLE_MODEL.z ?? 0);
        const local = houseLocalFromLatLon(startLat, startLon);
        vehicleHeadingRad = THREE.MathUtils.degToRad(startHeadingDeg);
        vehicleGroundNormal.copy(up);
        updateVehicleOrientationTargetFromGround();
        vehicleGroup.position.set(local.x, local.y, startZ);
        vehicleGroup.quaternion.copy(vehicleOrientationTargetQuat);
        vehicleGroup.scale.setScalar(vehicleScale);
        vehicleLoaded = true;
        vehicleSnapPending = true;
        vehicleAwaitingInitialSnap = true;
        vehicleRestoreRequiresDepth = Boolean(savedState);
        vehicleRestoreDepthTarget = Number.isFinite(savedState?.terrainDepth)
          ? savedState.terrainDepth
          : VEHICLE_RESTORE_MIN_DEPTH;
        vehicleGroundZTarget = Number.isFinite(startZ) ? startZ : null;
        vehicleVerticalVelocity = 0;
        vehicleLastContactDepth = -1;
        vehicleLastContactTileId = null;
        vehicleGroup.visible = false;
        vehicleMarker.position.set(local.x, local.y, HOUSE_MARKER_BASE_LIFT);
        bootLog('vehicle.load.success', {
          url: VEHICLE_MODEL.url,
          modelLength: modelLength.toFixed(2),
          scale: vehicleScale.toFixed(4),
          shadowRadiusM: Number(vehicleShadowRadius.toFixed(1)),
          terrainLiftM: Number(VEHICLE_TERRAIN_LIFT_M.toFixed(3)),
          startLat: Number(startLat.toFixed(8)),
          startLon: Number(startLon.toFixed(8)),
          startHeadingDeg: Number(startHeadingDeg.toFixed(3)),
          startZ: Number(startZ.toFixed(3)),
          restoreDepthTarget: vehicleRestoreDepthTarget,
        });
      },
      undefined,
      error => {
        vehicleConsoleWarn('load failed:', error);
        bootLog('vehicle.load.error', { message: error?.message ?? String(error) });
      }
    );
  }
  
  const _vehicleSunLocal = new THREE.Vector3();
  function syncVehicleSunLight() {
    if (!vehicleLoaded) return;
    // sunDirection is in ECEF; convert to terrainRoot local (ENU-ish)
    _vehicleSunLocal.set(
      getSunDirection().dot(east),
      getSunDirection().dot(north),
      getSunDirection().dot(up)
    ).normalize();
    // Convert from terrainRoot local into vehicleGroup local so vehicle lighting follows slope tilt.
    vehicleInvQuat.copy(vehicleGroup.quaternion).invert();
    _vehicleSunLocal.applyQuaternion(vehicleInvQuat);
    // Position directional light
    vehicleSunLight.target.position.set(0, 0, 0);
    vehicleSunLight.position.set(
      _vehicleSunLocal.x * 40,
      _vehicleSunLocal.y * 40,
      _vehicleSunLocal.z * 40
    );
  }
  
  function createVehicleShadowReceiverFromTerrainMesh(terrainMesh) {
    const receiver = new THREE.Mesh(terrainMesh.geometry, vehicleShadowReceiverMaterial);
    receiver.position.copy(terrainMesh.position);
    receiver.quaternion.copy(terrainMesh.quaternion);
    receiver.scale.copy(terrainMesh.scale);
    receiver.receiveShadow = true;
    receiver.castShadow = false;
    receiver.frustumCulled = true;
    receiver.renderOrder = 25;
    receiver.userData.vehicleShadowTileId = terrainMesh.userData.tileId;
    receiver.userData.sourceGeometry = terrainMesh.geometry;
    return receiver;
  }
  
  function clearVehicleShadowReceivers() {
    for (const receiver of vehicleShadowReceivers.values()) {
      vehicleShadowReceiverLayer.remove(receiver);
    }
    vehicleShadowReceivers.clear();
  }
  
  function syncVehicleShadowReceivers() {
    if (!vehicleLoaded || !vehicleGroup.visible || controls.mapMode) {
      clearVehicleShadowReceivers();
      return;
    }
    // The light's orthographic square is rotated into the sun frame. Project
    // a conservative circumscribed circle onto the ground so low sun keeps
    // enough receiving terrain without cloning the entire resident heatmap.
    const sunUp = Math.abs(getSunDirection().dot(up));
    const receiverRadius = vehicleShadowRadius * Math.SQRT2
      / Math.max(VEHICLE_SHADOW_MIN_SUN_PROJECTION, sunUp);
    const activeTileIds = new Set();
    const terrainMeshes = houseTerrainMeshes();
    for (const terrainMesh of terrainMeshes) {
      const tileId = terrainMesh.userData?.tileId;
      if (!tileId) continue;
      if (!terrainBboxIntersectsCircle(
        terrainMesh.userData?.bbox,
        vehicleGroup.position.x,
        vehicleGroup.position.y,
        receiverRadius,
      )) continue;
      activeTileIds.add(tileId);
      const existing = vehicleShadowReceivers.get(tileId);
      if (existing) {
        if (existing.userData.sourceGeometry !== terrainMesh.geometry) {
          vehicleShadowReceiverLayer.remove(existing);
          vehicleShadowReceivers.delete(tileId);
        } else {
          continue;
        }
      }
      if (vehicleShadowReceivers.has(tileId)) {
        continue;
      }
      const receiver = createVehicleShadowReceiverFromTerrainMesh(terrainMesh);
      vehicleShadowReceivers.set(tileId, receiver);
      vehicleShadowReceiverLayer.add(receiver);
    }
    for (const [tileId, receiver] of vehicleShadowReceivers) {
      if (activeTileIds.has(tileId)) continue;
      vehicleShadowReceiverLayer.remove(receiver);
      vehicleShadowReceivers.delete(tileId);
    }
  }
  
  function updateVehicleShadowSystem() {
    if (!vehicleLoaded || controls.mapMode) {
      vehicleShadowCasterLight.visible = false;
      vehicleShadowReceiverLayer.visible = false;
      return;
    }
    const sunUp = getSunDirection().dot(up);
    if (sunUp <= 0.01) {
      vehicleShadowCasterLight.visible = false;
      vehicleShadowReceiverLayer.visible = false;
      return;
    }
    if (vehicleShadowReceivers.size === 0) {
      vehicleShadowCasterLight.visible = false;
      vehicleShadowReceiverLayer.visible = false;
      return;
    }
  
    _vehicleSunLocal.set(
      getSunDirection().dot(east),
      getSunDirection().dot(north),
      getSunDirection().dot(up)
    ).normalize();
  
    vehicleShadowCenterLocal.copy(vehicleGroup.position);
    if (Number.isFinite(vehicleGroundZTarget)) {
      vehicleShadowCenterLocal.z = THREE.MathUtils.lerp(
        vehicleShadowCenterLocal.z,
        vehicleGroundZTarget,
        VEHICLE_SHADOW_GROUND_ANCHOR
      );
    }
    const shadowCenter = vehicleShadowCenterLocal;
    vehicleShadowCasterLight.visible = true;
    vehicleShadowCasterLight.position
      .copy(shadowCenter)
      .addScaledVector(_vehicleSunLocal, VEHICLE_SHADOW_LIGHT_DISTANCE + vehicleShadowRadius);
    vehicleShadowCasterLight.target.position.copy(shadowCenter);
    vehicleShadowCasterLight.target.updateMatrixWorld(true);
    vehicleShadowCasterLight.updateMatrixWorld(true);
  
    const shadowCamera = vehicleShadowCasterLight.shadow.camera;
    shadowCamera.left = -vehicleShadowRadius;
    shadowCamera.right = vehicleShadowRadius;
    shadowCamera.top = vehicleShadowRadius;
    shadowCamera.bottom = -vehicleShadowRadius;
    shadowCamera.near = 20;
    shadowCamera.far = VEHICLE_SHADOW_LIGHT_DISTANCE + vehicleShadowRadius * 4;
    shadowCamera.updateProjectionMatrix();
    shadowCamera.updateMatrixWorld(true);
  
    if (VEHICLE_SHADOW_TEXEL_SNAP) {
      vehicleShadowCenterWorld.copy(shadowCenter);
      terrainRoot.localToWorld(vehicleShadowCenterWorld);
      vehicleShadowCenterLight.copy(vehicleShadowCenterWorld).applyMatrix4(shadowCamera.matrixWorldInverse);
      const texelSizeX = (shadowCamera.right - shadowCamera.left) / Math.max(1, vehicleShadowCasterLight.shadow.mapSize.x);
      const texelSizeY = (shadowCamera.top - shadowCamera.bottom) / Math.max(1, vehicleShadowCasterLight.shadow.mapSize.y);
      vehicleShadowSnappedLight.set(
        Math.round(vehicleShadowCenterLight.x / texelSizeX) * texelSizeX,
        Math.round(vehicleShadowCenterLight.y / texelSizeY) * texelSizeY,
        vehicleShadowCenterLight.z
      );
      vehicleShadowSnappedWorld.copy(vehicleShadowSnappedLight).applyMatrix4(shadowCamera.matrixWorld);
      vehicleShadowSnapOffsetWorld.copy(vehicleShadowSnappedWorld).sub(vehicleShadowCenterWorld);
      if (vehicleShadowSnapOffsetWorld.lengthSq() > 0) {
        vehicleShadowSnapOffsetLocal.copy(vehicleShadowCenterWorld).add(vehicleShadowSnapOffsetWorld);
        terrainRoot.worldToLocal(vehicleShadowSnapOffsetLocal);
        vehicleShadowSnapOffsetLocal.sub(vehicleShadowCenterLocal);
        vehicleShadowCasterLight.position.add(vehicleShadowSnapOffsetLocal);
        vehicleShadowCasterLight.target.position.add(vehicleShadowSnapOffsetLocal);
        vehicleShadowCasterLight.target.updateMatrixWorld(true);
        vehicleShadowCasterLight.updateMatrixWorld(true);
      }
    }
  
    vehicleShadowReceiverMaterial.opacity = VEHICLE_SHADOW_OPACITY;
    vehicleShadowCasterLight.shadow.needsUpdate = true;
    vehicleShadowReceiverLayer.visible = true;
  }
  
  function snapVehicleToTerrain(options = {}) {
    const { forceImmediate = false, bypassThrottle = false } = options;
    if (!vehicleLoaded) return;
    const now = performance.now();
    const minInterval = vehicleSnapPending ? VEHICLE_SNAP_PENDING_MS : VEHICLE_SNAP_IDLE_MS;
    if (!bypassThrottle && now - lastVehicleSnapAttemptAt < minInterval) return;
    lastVehicleSnapAttemptAt = now;
    const terrainMeshes = houseTerrainMeshes();
    if (terrainMeshes.length === 0 || vehicleMeshes.length === 0) return;
    const terrainSample = sampleBestVehicleTerrainHit(
      vehicleGroup.position.x,
      vehicleGroup.position.y,
      terrainMeshes
    );
    if (!terrainSample.hit) return;
    const fallbackHit = terrainSample.hit;
    const depth = tileDepthFromId(terrainSample.hit.object?.userData?.tileId);
    const selectedTileId = terrainSample.hit.object?.userData?.tileId ?? null;
    const bestMinDepthHit = depth >= vehicleRestoreDepthTarget ? terrainSample.hit : null;
    const selectedHit = vehicleRestoreRequiresDepth
      ? bestMinDepthHit
      : fallbackHit;
    if (!selectedHit) {
      // Wait for finer terrain under the vehicle before finalizing restore.
      return;
    }
    updateVehicleGroundNormalFromTerrain(selectedHit, terrainMeshes);
    updateVehicleOrientationTargetFromGround();
    const terrainPoint = selectedHit.point.clone();
    // Step 2: temporarily position vehicle high above terrain
    vehicleTargetLocal.copy(terrainPoint);
    terrainRoot.worldToLocal(vehicleTargetLocal);
    const alignImmediately = forceImmediate || vehicleAwaitingInitialSnap;
    const preSnapZ = vehicleGroup.position.z;
    vehicleSnapPrevQuat.copy(vehicleGroup.quaternion);
    vehicleGroup.quaternion.copy(vehicleOrientationTargetQuat);
    vehicleGroup.position.z = vehicleTargetLocal.z + 50; // well above ground
    vehicleGroup.updateMatrixWorld(true);
    // Step 3: raycast UP from terrain surface to find vehicle bottom
    vehicleUpRaycaster.set(terrainPoint, vehicleUpDirection);
    const vehicleHits = vehicleUpRaycaster.intersectObjects(vehicleMeshes);
    let groundedZ = vehicleTargetLocal.z + VEHICLE_TERRAIN_LIFT_M;
    if (vehicleHits.length === 0) {
      // Fallback: just use terrain height + small offset
      groundedZ = vehicleTargetLocal.z + VEHICLE_TERRAIN_LIFT_M;
    } else {
      // The gap between terrain and vehicle bottom
      const gap = vehicleHits[0].distance;
      groundedZ = vehicleGroup.position.z - gap + VEHICLE_TERRAIN_LIFT_M;
    }
    if (!alignImmediately) {
      vehicleGroup.position.z = preSnapZ;
      vehicleGroup.quaternion.copy(vehicleSnapPrevQuat);
    } else {
      vehicleGroup.quaternion.copy(vehicleOrientationTargetQuat);
    }
    const prevDepth = vehicleLastContactDepth;
    const prevTargetZ = vehicleGroundZTarget;
    setVehicleGroundTarget(
      groundedZ,
      { immediate: alignImmediately, resetVelocity: forceImmediate }
    );
    const depthRefined = Number.isFinite(depth) && depth > prevDepth;
    if (depthRefined && Number.isFinite(prevTargetZ)) {
      const dz = groundedZ - prevTargetZ;
      if (Math.abs(dz) > 0.005) {
        vehicleVerticalVelocity += dz * VEHICLE_REFINEMENT_BOUNCE;
        vehicleVerticalVelocity = THREE.MathUtils.clamp(
          vehicleVerticalVelocity,
          -VEHICLE_SUSPENSION_MAX_VEL,
          VEHICLE_SUSPENSION_MAX_VEL
        );
      }
    }
    vehicleSnapPending = false;
    vehicleRestoreRequiresDepth = false;
    vehicleRestoreDepthTarget = -1;
    vehicleLastContactDepth = Number.isFinite(depth) ? depth : vehicleLastContactDepth;
    vehicleLastContactTileId = selectedTileId;
    if (vehicleAwaitingInitialSnap) {
      vehicleAwaitingInitialSnap = false;
      vehicleGroup.visible = true;
    }
  }
  
  function updateVehicleFollowCamera() {
    if (!vehicleLoaded) return;
    const heading = vehicleHeadingRad;
    const forwardX = -Math.sin(heading);
    const forwardY = Math.cos(heading);
    const rightX = Math.cos(heading);
    const rightY = Math.sin(heading);
    const radius = Math.sqrt(
      VEHICLE_CAMERA_FOLLOW_DISTANCE * VEHICLE_CAMERA_FOLLOW_DISTANCE +
      VEHICLE_CAMERA_FOLLOW_HEIGHT * VEHICLE_CAMERA_FOLLOW_HEIGHT
    );
    const horizontalRadius = radius * Math.cos(vehicleCameraOrbitPitch);
    const verticalOffset = radius * Math.sin(vehicleCameraOrbitPitch);
    const backScale = Math.cos(vehicleCameraOrbitYaw);
    const sideScale = Math.sin(vehicleCameraOrbitYaw);
    // Compute offset in vehicle-local frame (forward=+Y, right=+X, up=+Z)
    const localOffX = sideScale * horizontalRadius;
    const localOffY = -backScale * horizontalRadius;
    const localOffZ = verticalOffset;
    // Rotate by vehicle orientation so camera tilts with the vehicle on slopes
    vehicleFollowLocal.set(localOffX, localOffY, localOffZ);
    vehicleFollowLocal.applyQuaternion(vehicleGroup.quaternion);
    vehicleFollowLocal.add(vehicleGroup.position);
    vehicleLookTargetLocal.set(
      vehicleGroup.position.x,
      vehicleGroup.position.y,
      vehicleGroup.position.z + VEHICLE_CAMERA_LOOK_HEIGHT
    );
    vehicleFollowWorld.copy(vehicleFollowLocal);
    terrainRoot.localToWorld(vehicleFollowWorld);
    vehicleLookTargetWorld.copy(vehicleLookTargetLocal);
    terrainRoot.localToWorld(vehicleLookTargetWorld);
    camera.position.copy(vehicleFollowWorld);
    camera.up.copy(up);
    camera.lookAt(vehicleLookTargetWorld);
    vehicleLookDirLocal
      .copy(vehicleLookTargetLocal)
      .sub(vehicleFollowLocal)
      .normalize();
    controls.yaw = Math.atan2(-vehicleLookDirLocal.x, vehicleLookDirLocal.y);
    controls.pitch = Math.asin(THREE.MathUtils.clamp(vehicleLookDirLocal.z, -1, 1));
  }
  
  function setVehicleControlActive(nextActive, reason = 'manual', options = {}) {
    const { skipExitSave = false } = options;
    const requested = Boolean(nextActive);
    if (requested && (!vehicleLoaded || controls.mapMode)) {
      return false;
    }
    const wasActive = vehicleControlActive;
    const next = requested;
    if (vehicleControlActive === next) {
      return vehicleControlActive;
    }
    vehicleControlActive = next;
    if (vehicleControlActive) {
      controls.speed = 0;
      controls.strafeSpeed = 0;
      vehicleCameraOrbitYaw = 0;
      vehicleCameraOrbitPitch = THREE.MathUtils.clamp(
        Math.atan2(VEHICLE_CAMERA_FOLLOW_HEIGHT, VEHICLE_CAMERA_FOLLOW_DISTANCE),
        VEHICLE_CAMERA_ORBIT_PITCH_MIN,
        VEHICLE_CAMERA_ORBIT_PITCH_MAX
      );
      controls.yaw = vehicleHeadingRad;
      updateVehicleFollowCamera();
    }
    if (wasActive && !vehicleControlActive) {
      controls.speed = 0; // stop camera drift when exiting vehicle mode
      controls.strafeSpeed = 0;
    }
    if (wasActive && !vehicleControlActive && vehicleLoaded && !skipExitSave) {
      saveVehicleState(`exit-${reason}`, {
        snapToGround: true,
        requireGroundedZ: false,
        bypassSnapThrottle: true,
      });
    }
    bootLog('vehicle.control', {
      active: vehicleControlActive,
      reason,
    });
    return vehicleControlActive;
  }
  
  function tryEnterVehicleControlFromPointer(event) {
    if (controls.mapMode || !vehicleLoaded || vehicleMeshes.length === 0) {
      return false;
    }
    mouseNDC.x = (event.clientX / windowImpl.innerWidth) * 2 - 1;
    mouseNDC.y = -(event.clientY / windowImpl.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouseNDC, camera);
    const hits = raycaster.intersectObjects(vehicleMeshes, false);
    if (hits.length === 0) {
      return false;
    }
    return setVehicleControlActive(true, 'right-click-vehicle');
  }
  // ── Patria AMV diesel audio ─────────────────────────────────────────────
  // Non-positional audio with manual distance-based volume (avoids ECEF panner issues)
  const audioListener = new THREE.AudioListener();
  camera.add(audioListener);
  const dieselSound = new THREE.Audio(audioListener);
  dieselSound.setLoop(true);
  dieselSound.setVolume(0);
  const DIESEL_MAX_VOL = 0;
  const DIESEL_FULL_DIST = 15;   // full volume within 15m
  const DIESEL_ZERO_DIST = 150;  // silent beyond 150m
  
  function updateDieselVolume() {
    if (!dieselSound.isPlaying) return;
    const camWorld = new THREE.Vector3();
    const vehWorld = new THREE.Vector3();
    camera.getWorldPosition(camWorld);
    vehicleGroup.getWorldPosition(vehWorld);
    const dist = camWorld.distanceTo(vehWorld);
    if (dist <= DIESEL_FULL_DIST) {
      dieselSound.setVolume(DIESEL_MAX_VOL);
    } else if (dist >= DIESEL_ZERO_DIST) {
      dieselSound.setVolume(0);
    } else {
      const t = (dist - DIESEL_FULL_DIST) / (DIESEL_ZERO_DIST - DIESEL_FULL_DIST);
      dieselSound.setVolume(DIESEL_MAX_VOL * (1 - t * t));
    }
  }
  
  const audioLoader = new THREE.AudioLoader();
  audioLoader.load('/audio/diesel_idle.mp3', buffer => {
    dieselSound.setBuffer(buffer);
    const startAudio = () => {
      if (!dieselSound.isPlaying) {
        dieselSound.play();
      }
      windowImpl.removeEventListener('click', startAudio);
      windowImpl.removeEventListener('keydown', startAudio);
    };
    windowImpl.addEventListener('click', startAudio);
    windowImpl.addEventListener('keydown', startAudio);
    bootLog('vehicle.audio.loaded', { duration: buffer.duration.toFixed(1) });
  }, undefined, error => {
    console.warn('[VEHICLE] audio load failed:', error);
  });
  // ── end Patria AMV ──────────────────────────────────────────────────────
  
  const runtime = {
    vehicleGroup, vehicleMarkerLayer, vehicleMarker, dieselSound,
    VEHICLE_MARKER_MAP_SCALE, VEHICLE_DRIVE_SPEED, VEHICLE_ACCEL,
    VEHICLE_BRAKE, VEHICLE_STEER_SPEED, VEHICLE_CAMERA_ORBIT_SENS,
    VEHICLE_CAMERA_ORBIT_PITCH_MIN, VEHICLE_CAMERA_ORBIT_PITCH_MAX,
    VEHICLE_CAMERA_FOLLOW_HEIGHT, VEHICLE_CAMERA_FOLLOW_DISTANCE,
    DIESEL_MAX_VOL, DIESEL_FULL_DIST, DIESEL_ZERO_DIST,
    loadVehicleState, loadVehicleModel, saveVehicleState, throttledVehicleSave,
    requestVehicleTerrainResnap, vehicleNearTileBbox, snapVehicleToTerrain,
    syncVehicleSunLight, syncVehicleShadowReceivers, updateVehicleShadowSystem,
    updateVehicleSuspension, updateVehicleFollowCamera, updateDieselVolume,
    setVehicleControlActive, tryEnterVehicleControlFromPointer,
  };
  Object.defineProperties(runtime, {
    vehicleControlActive: { get: () => vehicleControlActive },
    vehicleHeadingRad: { get: () => vehicleHeadingRad, set: value => { vehicleHeadingRad = value; } },
    vehicleSpeed: { get: () => vehicleSpeed, set: value => { vehicleSpeed = value; } },
    vehicleCameraOrbitYaw: { get: () => vehicleCameraOrbitYaw, set: value => { vehicleCameraOrbitYaw = value; } },
    vehicleCameraOrbitPitch: { get: () => vehicleCameraOrbitPitch, set: value => { vehicleCameraOrbitPitch = value; } },
    vehicleLoaded: { get: () => vehicleLoaded },
    vehicleSnapPending: { get: () => vehicleSnapPending },
    vehicleLastContactDepth: { get: () => vehicleLastContactDepth },
    vehicleGroundNormal: { get: () => vehicleGroundNormal },
    vehicleHeadlightSpots: { get: () => vehicleHeadlightSpots },
  });
  return runtime;
}
