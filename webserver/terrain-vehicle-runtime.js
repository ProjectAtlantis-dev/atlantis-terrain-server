import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { rendererTextureAnisotropy } from './terrain-texture-streamer.js';
import { tileDepthFromId } from './terrain-tile-runtime.js';
import {
  AIRCRAFT_CAMERA_MODES,
  createAircraftState,
  setupAircraftModelParts,
  stepAircraftFlight,
  toggleAircraftEngine,
  updateAircraftVisuals,
} from './terrain-aircraft-runtime.js';
import { applyV22Materials, loadV22TextureSet } from './terrain-v22-materials.js';
import {
  createVehiclePersistenceRuntime,
  normalizeSavedVehicleState,
  stepSuspension,
  terrainBboxIntersectsCircle,
  vehicleLocalToLatLon as terrainVehicleLocalToLatLon,
  vehicleStateSnapshot,
} from './terrain-vehicle.js';
import {
  createVehicleTurretRig,
  createVehicleWheelRig,
  discoverVehicleParts,
  spinVehicleWheelRig,
  summarizeVehicleTurretRig,
  summarizeVehicleWheelRig,
} from './terrain-vehicle-parts.js';

const DEFAULT_VEHICLE_INSTANCE_ID = 'amv-01';

export function createTerrainVehicleRuntime({
  vehicleDefinition: VEHICLE_DEFINITION,
  vehicleDefinitions: VEHICLE_DEFINITIONS = {},
  vehicleHeadlights: VEHICLE_HEADLIGHTS,
  assetVehicleInstances: ASSET_VEHICLE_INSTANCES,
  startupAssetsResponse,
  houseSites,
  vehicleStateEndpoint: VEHICLE_STATE_ENDPOINT,
  vehicleSaveTimeoutMs: VEHICLE_SAVE_FETCH_TIMEOUT_MS,
  vehicleSaveFailureCooldownMs: VEHICLE_SAVE_FAILURE_COOLDOWN_MS,
  vehiclePersistenceEnabled = true,
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
  onMutated = () => {},
  windowImpl = globalThis.window,
} = {}) {
  // ── Patria AMV vehicle ──────────────────────────────────────────────────
  const _vehicleSeedInstance = ASSET_VEHICLE_INSTANCES.find(instance => (
    VEHICLE_DEFINITIONS?.[instance?.definitionId]?.vehicleType !== 'aircraft'
  )) ?? {};
  const GROUND_VEHICLE_DEFINITION = (
    VEHICLE_DEFINITIONS?.[_vehicleSeedInstance.definitionId] ?? VEHICLE_DEFINITION
  );
  const VEHICLE_MODEL = {
    url: (typeof GROUND_VEHICLE_DEFINITION.url === 'string' && GROUND_VEHICLE_DEFINITION.url.trim() !== '')
      ? GROUND_VEHICLE_DEFINITION.url
      : '/models/patria_amv.glb',
    lat: Number.isFinite(_vehicleSeedInstance.lat) ? _vehicleSeedInstance.lat : anchorLat,
    lon: Number.isFinite(_vehicleSeedInstance.lon) ? _vehicleSeedInstance.lon : anchorLon,
    headingDeg: Number.isFinite(_vehicleSeedInstance.headingDeg) ? _vehicleSeedInstance.headingDeg : 0,
    z: Number.isFinite(_vehicleSeedInstance.z) ? _vehicleSeedInstance.z : 0,
    realLengthM: Number.isFinite(GROUND_VEHICLE_DEFINITION.realLengthM) ? GROUND_VEHICLE_DEFINITION.realLengthM : 7.7,
    tireDiameterM: paramNumber(
      'vehicleTireDiameterM',
      Number.isFinite(GROUND_VEHICLE_DEFINITION.tireDiameterM)
        ? GROUND_VEHICLE_DEFINITION.tireDiameterM
        : 1.27
    ),
    altOffsetM: Number.isFinite(GROUND_VEHICLE_DEFINITION.altOffsetM) ? GROUND_VEHICLE_DEFINITION.altOffsetM : 0.05,
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
  const aircraftEntries = [];
  const aircraftMeshOwners = new Map();
  let activeAircraft = null;
  let vehicleSelected = false;
  let aircraftLoadStarted = false;

  function createAircraftMarker(entryId, displayName) {
    const marker = new THREE.Group();
    marker.name = `vehicle-marker-${entryId}`;
    const color = 0x5ac8fa;
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, HOUSE_MARKER_HEIGHT),
      ]),
      new THREE.LineBasicMaterial({
        color, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95,
      }),
    );
    const halo = new THREE.Mesh(
      houseMarkerHaloGeo,
      new THREE.MeshBasicMaterial({
        color, depthTest: false, depthWrite: false, transparent: true,
        opacity: 0.85, side: THREE.DoubleSide,
      }),
    );
    halo.position.z = HOUSE_MARKER_HEIGHT;
    const dot = new THREE.Mesh(
      houseMarkerDotGeo,
      new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false }),
    );
    dot.position.z = HOUSE_MARKER_HEIGHT;
    const label = createHouseLabelSprite(displayName || 'VTOL', color);
    label.position.set(0, 0, HOUSE_MARKER_HEIGHT + 900);
    marker.add(line, halo, dot, label);
    return marker;
  }

  for (const instance of ASSET_VEHICLE_INSTANCES) {
    const definition = VEHICLE_DEFINITIONS?.[instance?.definitionId];
    if (definition?.vehicleType !== 'aircraft') continue;
    const id = typeof instance.id === 'string' && instance.id.trim()
      ? instance.id.trim()
      : `aircraft-${aircraftEntries.length + 1}`;
    const group = new THREE.Group();
    group.name = id;
    group.visible = false;
    terrainRoot.add(group);
    const marker = createAircraftMarker(id, definition.displayName);
    vehicleMarkerLayer.add(marker);
    const entry = createAircraftState({ id, definition, instance, group, marker });
    entry.sunLight = new THREE.DirectionalLight(0xffffff, 3);
    entry.sunLight.castShadow = false;
    group.add(entry.sunLight, entry.sunLight.target, new THREE.AmbientLight(0x8090b0, 1));
    aircraftEntries.push(entry);
  }
  bootLog('vehicle.registry.ready', {
    groundCount: _vehicleSeedInstance?.id ? 1 : 0,
    aircraftCount: aircraftEntries.length,
    ids: [
      ...(_vehicleSeedInstance?.id ? [_vehicleSeedInstance.id] : []),
      ...aircraftEntries.map(entry => entry.id),
    ],
  });
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
  let terrainDepthCeiling = 12;
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
  let vehicleCollisionMeshes = [];
  let vehicleWheelRig = null;
  let vehicleTurretRig = null;
  let vehicleTurretControlActive = false;
  let vehicleTurretYawRad = 0;
  let vehicleTurretPitchRad = 0;
  let vehicleFireHeld = false;
  let vehicleFireRuntime = null;
  let vehicleFireRuntimePromise = null;
  const vehicleFireState = {
    id: _vehicleSeedInstance.id ?? DEFAULT_VEHICLE_INSTANCE_ID,
    lastFireAt: -Infinity,
  };
  let vehicleHeadlightSpots = [];
  const TURRET_MOUSE_SENSITIVITY = paramNumber('vehicleTurretMouseSensitivity', MOUSE_SENS);
  const TURRET_PITCH_MIN = THREE.MathUtils.degToRad(-12);
  const TURRET_PITCH_MAX = THREE.MathUtils.degToRad(42);
  const TURRET_CAMERA_BEHIND_M = 0.8;
  const TURRET_CAMERA_ABOVE_M = 0.35;
  const vehicleBarrelTipLocal = new THREE.Vector3();
  const vehicleTurretDirectionLocal = new THREE.Vector3();
  const vehicleTurretOriginLocal = new THREE.Vector3();
  const vehicleTurretCameraLocal = new THREE.Vector3();
  const vehicleTurretLookLocal = new THREE.Vector3();
  const vehicleTurretCameraWorld = new THREE.Vector3();
  const vehicleTurretLookWorld = new THREE.Vector3();
  const vehicleTurretUpLocal = new THREE.Vector3();
  const VEHICLE_DRIVE_SPEED = paramNumber('vehicleDriveSpeed', 24);
  const VEHICLE_ACCEL = paramNumber('vehicleAccel', 24);      // m/s² throttle
  const VEHICLE_BRAKE = paramNumber('vehicleBrake', 3);       // m/s² engine brake (coast-down)
  const VEHICLE_STEER_SPEED = paramNumber('vehicleSteerSpeed', 1.5);
  const VEHICLE_CAMERA_MODES = Object.freeze([
    Object.freeze({ name: 'CLOSE', dist: 15, height: 5 }),
    Object.freeze({ name: 'MEDIUM', dist: 25, height: 8 }),
    Object.freeze({ name: 'FAR', dist: 38, height: 12 }),
  ]);
  let vehicleSpeed = 0; // current vehicle speed in m/s
  let VEHICLE_CAMERA_FOLLOW_DISTANCE = paramNumber('vehicleCamDistance', 38);
  let VEHICLE_CAMERA_FOLLOW_HEIGHT = paramNumber('vehicleCamHeight', 12);
  let vehicleCameraModeIndex = VEHICLE_CAMERA_MODES.findIndex(mode => (
    mode.dist === VEHICLE_CAMERA_FOLLOW_DISTANCE
    && mode.height === VEHICLE_CAMERA_FOLLOW_HEIGHT
  ));
  if (vehicleCameraModeIndex < 0) vehicleCameraModeIndex = VEHICLE_CAMERA_MODES.length - 1;
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

  const aircraftGroundOrigin = new THREE.Vector3();
  const aircraftGroundLocal = new THREE.Vector3();
  const aircraftCameraLocal = new THREE.Vector3();
  const aircraftLookLocal = new THREE.Vector3();
  const aircraftCameraWorld = new THREE.Vector3();
  const aircraftLookWorld = new THREE.Vector3();
  const aircraftHeadingQuaternion = new THREE.Quaternion();
  const aircraftLocalUp = new THREE.Vector3(0, 0, 1);

  function sampleAircraftGroundZ(entry) {
    const targets = houseTerrainMeshes();
    if (targets.length === 0) return entry.lastKnownGroundZ;
    aircraftGroundOrigin.set(entry.group.position.x, entry.group.position.y, 20000);
    terrainRoot.localToWorld(aircraftGroundOrigin);
    vehicleDownRaycaster.set(aircraftGroundOrigin, vehicleDownDirection);
    const hit = vehicleDownRaycaster.intersectObjects(targets, false)[0];
    if (!hit) return entry.lastKnownGroundZ;
    aircraftGroundLocal.copy(hit.point);
    terrainRoot.worldToLocal(aircraftGroundLocal);
    return aircraftGroundLocal.z;
  }

  function loadAircraftModels() {
    if (aircraftLoadStarted || aircraftEntries.length === 0) return;
    aircraftLoadStarted = true;
    const v22Textures = loadV22TextureSet();
    for (const entry of aircraftEntries) {
      vehicleLoader.load(
        entry.definition.url,
        gltf => {
          const model = gltf.scene;
          const rotation = entry.definition.modelRotationDeg;
          if (Array.isArray(rotation) && rotation.length === 3) {
            model.rotation.set(...rotation.map(THREE.MathUtils.degToRad));
          } else {
            model.rotation.x = Math.PI * 0.5;
          }
          const materials = applyV22Materials(model, v22Textures);
          model.traverse(object => {
            if (!object.isMesh) return;
            object.castShadow = true;
            object.receiveShadow = true;
            const objectMaterials = Array.isArray(object.material)
              ? object.material
              : [object.material];
            for (const material of objectMaterials) applyVehicleMaterialSampling(material);
          });
          const bounds = new THREE.Box3().setFromObject(model);
          const size = new THREE.Vector3();
          bounds.getSize(size);
          const modelLength = Math.max(size.x, size.y, size.z);
          const scale = modelLength > 0 ? entry.definition.realLengthM / modelLength : 1;
          model.position.z -= bounds.min.z;
          entry.group.add(model);
          entry.group.scale.setScalar(scale);
          entry.meshes = [];
          model.traverse(object => {
            if (!object.isMesh) return;
            entry.meshes.push(object);
            aircraftMeshOwners.set(object, entry);
          });
          const latitude = Number.isFinite(Number(entry.instance.lat))
            ? Number(entry.instance.lat)
            : anchorLat;
          const longitude = Number.isFinite(Number(entry.instance.lon))
            ? Number(entry.instance.lon)
            : anchorLon;
          const local = houseLocalFromLatLon(latitude, longitude);
          entry.group.position.set(local.x, local.y, Number(entry.instance.z) || 0);
          entry.marker.position.set(local.x, local.y, HOUSE_MARKER_BASE_LIFT);
          entry.loaded = true;
          entry.group.visible = true;
          entry.altitudeAGL = Math.max(
            0,
            entry.group.position.z - (sampleAircraftGroundZ(entry) ?? 0),
          );
          const parts = setupAircraftModelParts(entry, model, bootLog);
          updateAircraftVisuals(entry, 0);
          bootLog('vehicle.load.success', {
            id: entry.id,
            vehicleType: 'aircraft',
            url: entry.definition.url,
            scale: Number(scale.toFixed(5)),
            parts,
            materials,
          });
          onMutated();
        },
        undefined,
        error => bootLog('vehicle.load.error', {
          id: entry.id,
          vehicleType: 'aircraft',
          message: error?.message ?? String(error),
        }, 'error'),
      );
    }
  }

  function updateAircraftFlight(input, dt) {
    if (!activeAircraft?.loaded || !vehicleControlActive) return false;
    stepAircraftFlight(activeAircraft, input, dt, sampleAircraftGroundZ(activeAircraft));
    if (
      input.forward || input.back || input.left || input.right || input.climb || input.descend ||
      Math.abs(activeAircraft.forwardSpeedMs) > 0.01 ||
      Math.abs(activeAircraft.verticalSpeedMs) > 0.01
    ) {
      throttledVehicleSave('flight-throttle');
    }
    return true;
  }

  function updateAircraftSystems(dt) {
    for (const entry of aircraftEntries) {
      if (!entry.loaded) continue;
      updateAircraftVisuals(entry, dt);
      entry.marker.position.set(
        entry.group.position.x,
        entry.group.position.y,
        entry.group.position.z + HOUSE_MARKER_BASE_LIFT,
      );
    }
  }

  function updateAircraftFollowCamera(entry = activeAircraft) {
    if (!entry?.loaded) return;
    const mode = AIRCRAFT_CAMERA_MODES[entry.cameraModeIndex] ?? AIRCRAFT_CAMERA_MODES[1];
    const radius = Math.hypot(mode.dist, mode.height) * entry.cameraZoom;
    const horizontalRadius = radius * Math.cos(entry.cameraOrbitPitch);
    aircraftCameraLocal.set(
      Math.sin(entry.cameraOrbitYaw) * horizontalRadius,
      -Math.cos(entry.cameraOrbitYaw) * horizontalRadius,
      radius * Math.sin(entry.cameraOrbitPitch),
    );
    aircraftHeadingQuaternion.setFromAxisAngle(aircraftLocalUp, entry.headingRad);
    aircraftCameraLocal.applyQuaternion(aircraftHeadingQuaternion).add(entry.group.position);
    aircraftLookLocal.copy(entry.group.position).addScaledVector(aircraftLocalUp, 2);
    aircraftCameraWorld.copy(aircraftCameraLocal);
    terrainRoot.localToWorld(aircraftCameraWorld);
    aircraftLookWorld.copy(aircraftLookLocal);
    terrainRoot.localToWorld(aircraftLookWorld);
    camera.position.copy(aircraftCameraWorld);
    camera.up.copy(up);
    camera.lookAt(aircraftLookWorld);
    const lookDirection = aircraftLookLocal.clone().sub(aircraftCameraLocal).normalize();
    controls.yaw = Math.atan2(-lookDirection.x, lookDirection.y);
    controls.pitch = Math.asin(THREE.MathUtils.clamp(lookDirection.z, -1, 1));
  }

  function toggleControlledAircraftEngine() {
    if (!activeAircraft?.loaded || !vehicleControlActive) return false;
    const running = toggleAircraftEngine(activeAircraft);
    bootLog('vehicle.aircraft.engine', { id: activeAircraft.id, running });
    return running;
  }

  function cycleVehicleCameraMode(reason = 'manual') {
    if (!vehicleControlActive || vehicleTurretControlActive) return false;
    if (activeAircraft != null) {
      activeAircraft.cameraModeIndex = (
        activeAircraft.cameraModeIndex + 1
      ) % AIRCRAFT_CAMERA_MODES.length;
      activeAircraft.cameraZoom = 1;
      bootLog('vehicle.camera.mode', {
        id: activeAircraft.id,
        mode: AIRCRAFT_CAMERA_MODES[activeAircraft.cameraModeIndex].name,
        reason,
      });
    } else {
      vehicleCameraModeIndex = (vehicleCameraModeIndex + 1) % VEHICLE_CAMERA_MODES.length;
      const mode = VEHICLE_CAMERA_MODES[vehicleCameraModeIndex];
      VEHICLE_CAMERA_FOLLOW_DISTANCE = mode.dist;
      VEHICLE_CAMERA_FOLLOW_HEIGHT = mode.height;
      vehicleCameraOrbitPitch = THREE.MathUtils.clamp(
        Math.atan2(mode.height, mode.dist),
        VEHICLE_CAMERA_ORBIT_PITCH_MIN,
        VEHICLE_CAMERA_ORBIT_PITCH_MAX,
      );
      bootLog('vehicle.camera.mode', {
        id: _vehicleSeedInstance.id ?? DEFAULT_VEHICLE_INSTANCE_ID,
        mode: mode.name,
        reason,
      });
    }
    updateVehicleFollowCamera();
    onMutated();
    return true;
  }

  function getSelectedVehicleStatus() {
    if (!vehicleSelected) return null;
    if (activeAircraft != null) {
      return {
        selected: true,
        loaded: activeAircraft.loaded,
        active: vehicleControlActive,
        displayName: activeAircraft.definition.displayName || 'VTOL',
        speedMps: activeAircraft.forwardSpeedMs,
        hasLights: false,
        hasTurret: false,
        turretActive: false,
        isAircraft: true,
        engineRunning: activeAircraft.engineRunning,
        rotorSpool: activeAircraft.rotorSpool,
        altitudeAGL: activeAircraft.altitudeAGL,
        verticalSpeedMs: activeAircraft.verticalSpeedMs,
        flightRegime: activeAircraft.flightRegime,
        cameraMode: AIRCRAFT_CAMERA_MODES[activeAircraft.cameraModeIndex]?.name ?? 'CUSTOM',
      };
    }
    return {
      selected: true,
      loaded: vehicleLoaded,
      active: vehicleControlActive,
      displayName: GROUND_VEHICLE_DEFINITION.displayName || 'Vehicle',
      speedMps: vehicleSpeed,
      hasLights: vehicleHeadlightSpots.length > 0,
      hasTurret: vehicleTurretRig?.gunPivot != null,
      turretActive: vehicleTurretControlActive,
      isAircraft: false,
      engineRunning: false,
      rotorSpool: 0,
      altitudeAGL: 0,
      verticalSpeedMs: 0,
      flightRegime: 'GROUND',
      cameraMode: VEHICLE_CAMERA_MODES[vehicleCameraModeIndex]?.name ?? 'CUSTOM',
    };
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

  function updateVehicleWheelSpin(dt) {
    if (!vehicleLoaded || vehicleWheelRig == null) return false;
    return spinVehicleWheelRig(
      vehicleWheelRig,
      vehicleSpeed * Math.max(0, Number(dt) || 0),
      VEHICLE_TIRE_RADIUS_M,
    );
  }
  
  function createVehicleSaveSnapshot(options = {}) {
    const { snapToGround = false, bypassSnapThrottle = false } = options;
    if (snapToGround && vehicleLoaded) {
      vehicleSnapPending = true;
      snapVehicleToTerrain({ forceImmediate: true, bypassThrottle: bypassSnapThrottle });
    }
    const state = getVehicleStateSnapshot();
    if (state == null) return null;
    state.vehicleId = _vehicleSeedInstance.id ?? DEFAULT_VEHICLE_INSTANCE_ID;
    state.vehicleType = 'ground';
    if (Number.isFinite(vehicleGroundZTarget)) {
      state.z = Number(vehicleGroundZTarget.toFixed(3));
    }
    const terrainSample = sampleBestVehicleTerrainHit();
    if (terrainSample.depth >= 0) state.terrainDepth = terrainSample.depth;
    if (terrainSample.tileId) state.terrainTileId = terrainSample.tileId;
    return state;
  }
  
  const vehiclePersistence = vehiclePersistenceEnabled
    ? createVehiclePersistenceRuntime({
        endpoint: VEHICLE_STATE_ENDPOINT,
        timeoutMs: VEHICLE_SAVE_FETCH_TIMEOUT_MS,
        failureCooldownMs: VEHICLE_SAVE_FAILURE_COOLDOWN_MS,
        createSnapshot: createVehicleSaveSnapshot,
        bootLog,
      })
    : {
        save: async () => false,
        throttledSave() {},
      };
  const aircraftPersistence = new Map(aircraftEntries.map(entry => [
    entry.id,
    vehiclePersistenceEnabled
      ? createVehiclePersistenceRuntime({
          endpoint: VEHICLE_STATE_ENDPOINT,
          timeoutMs: VEHICLE_SAVE_FETCH_TIMEOUT_MS,
          failureCooldownMs: VEHICLE_SAVE_FAILURE_COOLDOWN_MS,
          createSnapshot: () => {
            const state = vehicleStateSnapshot({
              loaded: entry.loaded,
              position: entry.group.position,
              headingRad: entry.headingRad,
              anchorLat,
              anchorLon,
            });
            if (state == null) return null;
            state.vehicleId = entry.id;
            state.vehicleType = 'aircraft';
            return state;
          },
          bootLog,
        })
      : { save: async () => false, throttledSave() {} },
  ]));

  function selectedVehiclePersistence() {
    return activeAircraft == null
      ? vehiclePersistence
      : aircraftPersistence.get(activeAircraft.id);
  }

  function saveVehicleState(reason = 'manual', options = {}) {
    return selectedVehiclePersistence()?.save(reason, options) ?? Promise.resolve(false);
  }

  function throttledVehicleSave(reason = 'movement-throttle') {
    selectedVehiclePersistence()?.throttledSave(reason);
  }
  
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
    // Keep the terrain/AMV first paint fast. Aircraft and its texture set are
    // loaded after the initial vehicle request has had time to complete.
    const scheduleAircraftLoad = windowImpl.setTimeout ?? globalThis.setTimeout;
    scheduleAircraftLoad(loadAircraftModels, 1200);
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
        // Use the live Patria wheel rig: the source meshes contain multiple
        // wheels, so rotate eight vertex clusters around their own centres.
        // Grounding uses only the static body meshes so wheel animation cannot
        // move the collision floor underneath the vehicle.
        const vehicleParts = discoverVehicleParts(model, GROUND_VEHICLE_DEFINITION);
        vehicleWheelRig = createVehicleWheelRig(THREE, vehicleParts);
        const wheelSummary = summarizeVehicleWheelRig(vehicleWheelRig);
        bootLog('vehicle.wheels.rigged', wheelSummary,
          wheelSummary.clusterCount === 8 && wheelSummary.skipped.length === 0
            ? 'info'
            : 'warn');
        vehicleTurretRig = createVehicleTurretRig(THREE, vehicleParts);
        const turretSummary = summarizeVehicleTurretRig(vehicleTurretRig);
        bootLog('vehicle.turret.rigged', turretSummary,
          turretSummary.warnings.length > 0 ? 'warn' : 'info');
        const animatedWheelMeshes = new Set(vehicleParts.wheels);
        vehicleCollisionMeshes = [];
        model.traverse(obj => {
          if (obj.isMesh && !animatedWheelMeshes.has(obj)) vehicleCollisionMeshes.push(obj);
        });
        // Keep all meshes selectable, including the animated wheels.
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
        vehicleRestoreDepthTarget = Math.min(
          Number.isFinite(savedState?.terrainDepth)
            ? savedState.terrainDepth
            : VEHICLE_RESTORE_MIN_DEPTH,
          terrainDepthCeiling,
        );
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
    // sunDirection is in ECEF; convert to terrainRoot local (ENU-ish)
    _vehicleSunLocal.set(
      getSunDirection().dot(east),
      getSunDirection().dot(north),
      getSunDirection().dot(up)
    ).normalize();
    if (vehicleLoaded) {
      // Convert from terrainRoot local into vehicleGroup local so vehicle lighting follows slope tilt.
      vehicleInvQuat.copy(vehicleGroup.quaternion).invert();
      const groundLightDirection = _vehicleSunLocal.clone().applyQuaternion(vehicleInvQuat);
      vehicleSunLight.target.position.set(0, 0, 0);
      vehicleSunLight.position.copy(groundLightDirection).multiplyScalar(40);
    }
    for (const entry of aircraftEntries) {
      if (!entry.loaded) continue;
      vehicleInvQuat.copy(entry.group.quaternion).invert();
      const aircraftLightDirection = _vehicleSunLocal.clone().applyQuaternion(vehicleInvQuat);
      entry.sunLight.target.position.set(0, 0, 0);
      entry.sunLight.position.copy(aircraftLightDirection).multiplyScalar(40);
    }
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
    if (terrainMeshes.length === 0 || vehicleCollisionMeshes.length === 0) return;
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
    const vehicleHits = vehicleUpRaycaster.intersectObjects(vehicleCollisionMeshes);
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

  function updateVehicleTurretRig() {
    if (!vehicleLoaded || vehicleTurretRig == null) return;
    if (vehicleTurretRig.turretPivot) {
      vehicleTurretRig.turretPivot.rotation.z = vehicleTurretYawRad;
    }
    if (vehicleTurretRig.gunPivot) {
      vehicleTurretRig.gunPivot.rotation.x = vehicleTurretPitchRad;
    }
    vehicleGroup.updateWorldMatrix(true, true);
  }

  function getVehicleBarrelTipTerrainLocal(target) {
    if (vehicleTurretRig?.gunPivot == null) return target.copy(vehicleGroup.position);
    target.copy(vehicleTurretRig.barrelTipLocal);
    vehicleTurretRig.gunPivot.localToWorld(target);
    terrainRoot.worldToLocal(target);
    return target;
  }

  function getVehicleTurretDirectionLocal(target) {
    if (vehicleTurretRig?.gunPivot == null) {
      return target.set(0, 1, 0).applyQuaternion(vehicleGroup.quaternion).normalize();
    }
    const origin = vehicleTurretOriginLocal.set(0, 0, 0);
    target.set(0, 1, 0);
    vehicleTurretRig.gunPivot.localToWorld(origin);
    vehicleTurretRig.gunPivot.localToWorld(target);
    terrainRoot.worldToLocal(origin);
    terrainRoot.worldToLocal(target);
    return target.sub(origin).normalize();
  }

  function updateVehicleTurretCamera() {
    if (!vehicleLoaded || !vehicleTurretControlActive) return;
    getVehicleBarrelTipTerrainLocal(vehicleBarrelTipLocal);
    getVehicleTurretDirectionLocal(vehicleTurretDirectionLocal);
    vehicleTurretCameraLocal.copy(vehicleBarrelTipLocal)
      .addScaledVector(vehicleTurretDirectionLocal, -TURRET_CAMERA_BEHIND_M);
    vehicleTurretUpLocal.set(0, 0, 1).applyQuaternion(vehicleGroup.quaternion).normalize();
    vehicleTurretCameraLocal.addScaledVector(vehicleTurretUpLocal, TURRET_CAMERA_ABOVE_M);
    vehicleTurretLookLocal.copy(vehicleBarrelTipLocal)
      .addScaledVector(vehicleTurretDirectionLocal, 500);
    vehicleTurretCameraWorld.copy(vehicleTurretCameraLocal);
    terrainRoot.localToWorld(vehicleTurretCameraWorld);
    vehicleTurretLookWorld.copy(vehicleTurretLookLocal);
    terrainRoot.localToWorld(vehicleTurretLookWorld);
    camera.position.copy(vehicleTurretCameraWorld);
    camera.up.copy(up);
    camera.lookAt(vehicleTurretLookWorld);
  }

  function setVehicleTurretControlActive(nextActive, reason = 'manual') {
    const available = vehicleTurretRig?.turretPivot != null
      && vehicleTurretRig?.gunPivot != null;
    const next = Boolean(nextActive)
      && available
      && vehicleControlActive
      && activeAircraft == null;
    if (vehicleTurretControlActive === next) return vehicleTurretControlActive;
    vehicleTurretControlActive = next;
    if (next) {
      renderer.domElement.requestPointerLock?.();
    } else if (globalThis.document?.pointerLockElement === renderer.domElement) {
      globalThis.document.exitPointerLock?.();
    }
    if (!next) {
      vehicleFireHeld = false;
      vehicleFireRuntime?.stop?.();
    }
    bootLog('vehicle.turret.control', { active: next, available, reason });
    onMutated();
    return next;
  }

  function aimVehicleTurret(movementX, movementY) {
    if (!vehicleTurretControlActive) return false;
    vehicleTurretYawRad -= movementX * TURRET_MOUSE_SENSITIVITY;
    vehicleTurretPitchRad = THREE.MathUtils.clamp(
      vehicleTurretPitchRad - movementY * TURRET_MOUSE_SENSITIVITY,
      TURRET_PITCH_MIN,
      TURRET_PITCH_MAX,
    );
    return true;
  }

  async function ensureVehicleFireRuntime() {
    if (vehicleFireRuntime != null) return vehicleFireRuntime;
    if (vehicleFireRuntimePromise == null) {
      vehicleFireRuntimePromise = import('./terrain-vehicle-fire.js').then(module => {
        vehicleFireRuntime = module.createVehicleFireRuntime({
          terrainRoot,
          camera,
          getTerrainTargets: houseTerrainMeshes,
          bootLog,
        });
        return vehicleFireRuntime;
      });
    }
    return vehicleFireRuntimePromise;
  }

  function setVehicleFireHeld(held) {
    if (!vehicleTurretControlActive || !vehicleControlActive || activeAircraft != null) {
      vehicleFireHeld = false;
      return false;
    }
    vehicleFireHeld = Boolean(held);
    if (vehicleFireHeld) {
      void ensureVehicleFireRuntime().then(runtime => {
        if (!vehicleFireHeld || !vehicleTurretControlActive) return;
        runtime.primeAudio();
        getVehicleBarrelTipTerrainLocal(vehicleBarrelTipLocal);
        runtime.fire(vehicleFireState, vehicleBarrelTipLocal);
      });
    }
    return vehicleFireHeld;
  }

  function updateVehicleCombat(dt) {
    updateVehicleTurretRig();
    if (vehicleFireHeld && vehicleTurretControlActive && vehicleFireRuntime != null) {
      getVehicleBarrelTipTerrainLocal(vehicleBarrelTipLocal);
      vehicleFireRuntime.fire(vehicleFireState, vehicleBarrelTipLocal);
    }
    vehicleFireRuntime?.update?.(dt);
  }

  function updateVehicleFollowCamera() {
    if (vehicleTurretControlActive && activeAircraft == null) {
      updateVehicleTurretCamera();
      return;
    }
    if (activeAircraft != null) {
      updateAircraftFollowCamera(activeAircraft);
      return;
    }
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
    const selectedLoaded = activeAircraft?.loaded ?? vehicleLoaded;
    if (requested && (!selectedLoaded || controls.mapMode)) {
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
      if (activeAircraft != null) {
        const mode = AIRCRAFT_CAMERA_MODES[activeAircraft.cameraModeIndex]
          ?? AIRCRAFT_CAMERA_MODES[1];
        activeAircraft.cameraOrbitYaw = 0;
        activeAircraft.cameraOrbitPitch = Math.atan2(mode.height, mode.dist);
        controls.yaw = activeAircraft.headingRad;
      } else {
        vehicleCameraOrbitYaw = 0;
        vehicleCameraOrbitPitch = THREE.MathUtils.clamp(
          Math.atan2(VEHICLE_CAMERA_FOLLOW_HEIGHT, VEHICLE_CAMERA_FOLLOW_DISTANCE),
          VEHICLE_CAMERA_ORBIT_PITCH_MIN,
          VEHICLE_CAMERA_ORBIT_PITCH_MAX
        );
        controls.yaw = vehicleHeadingRad;
      }
      updateVehicleFollowCamera();
    }
    if (wasActive && !vehicleControlActive) {
      setVehicleTurretControlActive(false, `vehicle-exit-${reason}`);
      vehicleTurretYawRad = 0;
      vehicleTurretPitchRad = 0;
      updateVehicleTurretRig();
      controls.speed = 0; // stop camera drift when exiting vehicle mode
      controls.strafeSpeed = 0;
    }
    if (wasActive && !vehicleControlActive && activeAircraft == null && vehicleLoaded && !skipExitSave) {
      saveVehicleState(`exit-${reason}`, {
        snapToGround: true,
        requireGroundedZ: false,
        bypassSnapThrottle: true,
      });
    }
    bootLog('vehicle.control', {
      active: vehicleControlActive,
      id: activeAircraft?.id ?? _vehicleSeedInstance.id ?? DEFAULT_VEHICLE_INSTANCE_ID,
      vehicleType: activeAircraft == null ? 'ground' : 'aircraft',
      reason,
    });
    return vehicleControlActive;
  }
  
  function tryEnterVehicleControlFromPointer(event) {
    return trySelectVehicleFromPointer(event, { activate: true });
  }

  function pointerVehicleEntry(event) {
    const selectableMeshes = [
      ...(vehicleLoaded ? vehicleMeshes : []),
      ...aircraftEntries.flatMap(entry => entry.loaded ? entry.meshes : []),
    ];
    if (controls.mapMode || selectableMeshes.length === 0) {
      return null;
    }
    mouseNDC.x = (event.clientX / windowImpl.innerWidth) * 2 - 1;
    mouseNDC.y = -(event.clientY / windowImpl.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouseNDC, camera);
    const hits = raycaster.intersectObjects(selectableMeshes, false);
    if (hits.length === 0) {
      return null;
    }
    return aircraftMeshOwners.get(hits[0].object) ?? {
      id: _vehicleSeedInstance.id ?? DEFAULT_VEHICLE_INSTANCE_ID,
      vehicleType: 'ground',
    };
  }

  function trySelectVehicleFromPointer(event, { activate = false } = {}) {
    const entry = pointerVehicleEntry(event);
    if (entry == null) return false;
    const nextAircraft = entry.vehicleType === 'aircraft' ? entry : null;
    if (vehicleControlActive && nextAircraft !== activeAircraft) {
      setVehicleControlActive(false, 'selection-changed');
    }
    activeAircraft = nextAircraft;
    vehicleSelected = true;
    bootLog('vehicle.selection', {
      id: entry.id,
      vehicleType: entry.vehicleType,
      reason: activate ? 'right-click-pointer' : 'left-click-pointer',
      activate,
    });
    onMutated();
    return activate ? setVehicleControlActive(true, 'right-click-vehicle') : true;
  }

  function selectVehicle(vehicleId, reason = 'manual') {
    const groundId = _vehicleSeedInstance.id ?? DEFAULT_VEHICLE_INSTANCE_ID;
    const nextAircraft = aircraftEntries.find(entry => entry.id === vehicleId) ?? null;
    if (vehicleId !== groundId && nextAircraft == null) return false;
    if (vehicleControlActive && nextAircraft !== activeAircraft) {
      setVehicleControlActive(false, 'selection-changed');
    }
    activeAircraft = nextAircraft;
    vehicleSelected = true;
    bootLog('vehicle.selection', { id: vehicleId, reason });
    onMutated();
    return true;
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
  
  function setTerrainDepthCeiling(value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 20) return false;
    terrainDepthCeiling = parsed;
    if (vehicleRestoreRequiresDepth) {
      const savedDepth = Number(vehicleSavedStatePending?.terrainDepth);
      const requestedDepth = Number.isFinite(savedDepth)
        ? savedDepth
        : VEHICLE_RESTORE_MIN_DEPTH;
      vehicleRestoreDepthTarget = Math.min(requestedDepth, terrainDepthCeiling);
    }
    enqueueClientLog('info', 'vehicle.terrain-depth-ceiling', {
      terrainDepthCeiling,
      restoreDepthTarget: vehicleRestoreDepthTarget,
    });
    return true;
  }

  const runtime = {
    vehicleMarkerLayer, dieselSound,
    VEHICLE_MARKER_MAP_SCALE, VEHICLE_DRIVE_SPEED, VEHICLE_ACCEL,
    VEHICLE_BRAKE, VEHICLE_STEER_SPEED, VEHICLE_CAMERA_ORBIT_SENS,
    VEHICLE_CAMERA_ORBIT_PITCH_MIN, VEHICLE_CAMERA_ORBIT_PITCH_MAX,
    DIESEL_MAX_VOL, DIESEL_FULL_DIST, DIESEL_ZERO_DIST,
    loadVehicleState, loadVehicleModel, saveVehicleState, throttledVehicleSave,
    setTerrainDepthCeiling,
    requestVehicleTerrainResnap, vehicleNearTileBbox, snapVehicleToTerrain,
    syncVehicleSunLight, syncVehicleShadowReceivers, updateVehicleShadowSystem,
    updateVehicleSuspension, updateVehicleWheelSpin, updateVehicleFollowCamera, updateDieselVolume,
    updateVehicleCombat, setVehicleTurretControlActive, aimVehicleTurret, setVehicleFireHeld,
    updateAircraftFlight, updateAircraftSystems, toggleControlledAircraftEngine,
    cycleVehicleCameraMode, getSelectedVehicleStatus,
    setVehicleControlActive, selectVehicle,
    trySelectVehicleFromPointer, tryEnterVehicleControlFromPointer,
    getVehicleWheelRigSummary: () => summarizeVehicleWheelRig(vehicleWheelRig),
    getVehicleTurretRigSummary: () => summarizeVehicleTurretRig(vehicleTurretRig),
    requiresContinuousRender: () => aircraftEntries.some(entry => (
      entry.engineRunning || Math.abs(entry.rotorAngularVelocity) > 1e-4
    )),
    getVehicleFireSummary: () => vehicleFireRuntime?.summary?.() ?? {
      shotsFired: 0,
      activeTracers: 0,
      activeImpacts: 0,
      muzzleVisible: false,
    },
    getVehicleRegistry: () => [
      {
        id: _vehicleSeedInstance.id ?? 'amv-01',
        vehicleType: 'ground',
        loaded: vehicleLoaded,
        visible: vehicleGroup.visible,
        meshCount: vehicleMeshes.length,
        position: vehicleGroup.position.toArray(),
      },
      ...aircraftEntries.map(entry => ({
        id: entry.id,
        vehicleType: 'aircraft',
        loaded: entry.loaded,
        visible: entry.group.visible,
        meshCount: entry.meshes.length,
        position: entry.group.position.toArray(),
        engineRunning: entry.engineRunning,
        rotorSpool: entry.rotorSpool,
        flightRegime: entry.flightRegime,
      })),
    ],
  };
  Object.defineProperties(runtime, {
    vehicleControlActive: { get: () => vehicleControlActive },
    vehicleTurretControlActive: { get: () => vehicleTurretControlActive },
    vehicleType: { get: () => activeAircraft == null ? 'ground' : 'aircraft' },
    vehicleGroup: { get: () => activeAircraft?.group ?? vehicleGroup },
    vehicleMarker: { get: () => activeAircraft?.marker ?? vehicleMarker },
    vehicleHeadingRad: {
      get: () => activeAircraft?.headingRad ?? vehicleHeadingRad,
      set: value => {
        if (activeAircraft != null) activeAircraft.headingRad = value;
        else vehicleHeadingRad = value;
      },
    },
    vehicleSpeed: {
      get: () => activeAircraft?.forwardSpeedMs ?? vehicleSpeed,
      set: value => {
        if (activeAircraft != null) activeAircraft.forwardSpeedMs = value;
        else vehicleSpeed = value;
      },
    },
    vehicleCameraOrbitYaw: {
      get: () => activeAircraft?.cameraOrbitYaw ?? vehicleCameraOrbitYaw,
      set: value => {
        if (activeAircraft != null) activeAircraft.cameraOrbitYaw = value;
        else vehicleCameraOrbitYaw = value;
      },
    },
    vehicleCameraOrbitPitch: {
      get: () => activeAircraft?.cameraOrbitPitch ?? vehicleCameraOrbitPitch,
      set: value => {
        if (activeAircraft != null) activeAircraft.cameraOrbitPitch = value;
        else vehicleCameraOrbitPitch = value;
      },
    },
    VEHICLE_CAMERA_FOLLOW_DISTANCE: {
      get: () => activeAircraft != null
        ? (AIRCRAFT_CAMERA_MODES[activeAircraft.cameraModeIndex]?.dist ?? 40) * activeAircraft.cameraZoom
        : VEHICLE_CAMERA_FOLLOW_DISTANCE,
      set: value => {
        if (activeAircraft != null) {
          const base = AIRCRAFT_CAMERA_MODES[activeAircraft.cameraModeIndex]?.dist ?? 40;
          activeAircraft.cameraZoom = THREE.MathUtils.clamp(value / base, 0.4, 4);
        } else VEHICLE_CAMERA_FOLLOW_DISTANCE = value;
      },
    },
    VEHICLE_CAMERA_FOLLOW_HEIGHT: {
      get: () => activeAircraft != null
        ? (AIRCRAFT_CAMERA_MODES[activeAircraft.cameraModeIndex]?.height ?? 15) * activeAircraft.cameraZoom
        : VEHICLE_CAMERA_FOLLOW_HEIGHT,
      set: value => {
        if (activeAircraft != null) {
          const base = AIRCRAFT_CAMERA_MODES[activeAircraft.cameraModeIndex]?.height ?? 15;
          activeAircraft.cameraZoom = THREE.MathUtils.clamp(value / base, 0.4, 4);
        } else VEHICLE_CAMERA_FOLLOW_HEIGHT = value;
      },
    },
    vehicleLoaded: { get: () => activeAircraft?.loaded ?? vehicleLoaded },
    vehicleSnapPending: {
      get: () => vehicleSnapPending,
      set: value => { vehicleSnapPending = Boolean(value); },
    },
    vehicleLastContactDepth: { get: () => vehicleLastContactDepth },
    vehicleGroundNormal: { get: () => activeAircraft == null ? vehicleGroundNormal : aircraftLocalUp },
    vehicleHeadlightSpots: { get: () => activeAircraft == null ? vehicleHeadlightSpots : [] },
  });
  return runtime;
}
