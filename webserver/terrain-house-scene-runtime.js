import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  createTerrainHouseConfiguration, createTerrainHouseMarkerRuntime,
  createTerrainHouseModelController, disposeTerrainHouseTree,
  markTerrainHousesNeedSnap, terrainHouseLocalPosition,
  terrainHouseShadowCoverage, terrainHouseZSummary,
} from './terrain-house-runtime.js';

export function createTerrainHouseSceneRuntime({
  structureDefinition: STRUCTURE_DEFINITION, startupAssetsResponse,
  renderer, terrainRoot, controls, camera, mapCam,
  mouseNDC, raycaster, up, east, north, anchorLat, anchorLon,
  paramNumber, bootLog, getSunDirection, windowImpl = globalThis.window,
} = {}) {
  const { model: HOUSE_MODEL, sites: houseSites } = createTerrainHouseConfiguration({
    definition: STRUCTURE_DEFINITION,
    instances: startupAssetsResponse.structure_instances,
    source: startupAssetsResponse.source,
    bootLog,
  });
  const HOUSE_SHADOW_MODE_RAW = 'shadowmap';
  const HOUSE_SHADOW_MODE = HOUSE_SHADOW_MODE_RAW === 'local' ? 'local' : 'shadowmap';
  const HOUSE_USE_LOCAL_SHADOWS = HOUSE_SHADOW_MODE === 'local';
  const HOUSE_USE_SHADOW_MAP = HOUSE_SHADOW_MODE === 'shadowmap';
  const HOUSE_LOCAL_SHADOW_DEBUG = true;
  const HOUSE_SHADOW_SNAPSHOT_ENABLED = false;
  const HOUSE_PROBE_CONSOLE = false;
  const houseLayer = new THREE.Group();
  houseLayer.name = 'nuuk-houses';
  terrainRoot.add(houseLayer);
  const houseShadowReceiverLayer = new THREE.Group();
  houseShadowReceiverLayer.name = 'nuuk-house-shadow-receivers';
  houseShadowReceiverLayer.renderOrder = 26;
  houseShadowReceiverLayer.visible = false;
  terrainRoot.add(houseShadowReceiverLayer);
  const houseMarkerLayer = new THREE.Group();
  houseMarkerLayer.name = 'nuuk-house-markers';
  houseMarkerLayer.visible = false;
  houseMarkerLayer.renderOrder = 1002;
  terrainRoot.add(houseMarkerLayer);
  const houseLoader = new GLTFLoader();
  const houseDownRaycaster = new THREE.Raycaster();
  const houseDownDirection = up.clone().negate().normalize();
  const houseTargetWorld = new THREE.Vector3();
  const houseTargetLocal = new THREE.Vector3();
  const houseSnapTargets = [];
  const houseShadowCenterLocal = new THREE.Vector3();
  const houseShadowLightDirection = new THREE.Vector3();
  const houseShadowLightDirectionLocal = new THREE.Vector3();
  let houseModelTemplate = null;
  let shadowMapReadyLogged = false;
  let houseShadowGateReason = 'init';
  let lastHouseShadowGateReason = 'init';
  const HOUSE_SHADOW_LOG_MS = HOUSE_SHADOW_SNAPSHOT_ENABLED
    ? Math.max(200, paramNumber('houseShadowLogMs', 2000))
    : 0;
  let lastHouseShadowLogAt = 0;
  const _lastHouseShadowPos = new THREE.Vector3();
  const _lastHouseShadowDir = new THREE.Vector3();
  let _lastHouseShadowRadius = 0;
  const HOUSE_SHADOW_MOVE_THRESHOLD = 0.5; // meters — ignore sub-pixel jitter
  const houseLocalShadowDirection = new THREE.Vector2();
  const HOUSE_MARKER_HEIGHT = 5000;
  const HOUSE_MARKER_BASE_LIFT = 5;
  const HOUSE_MARKER_COLORS = [0xff3b30, 0xff9500, 0xffcc00, 0x34c759, 0x0a84ff, 0xbf5af2];
  const HOUSE_SHADOW_MAP_SIZE = 2048;
  const HOUSE_SHADOW_BASE_RADIUS = 900;
  const HOUSE_SHADOW_RADIUS_PADDING = 600;
  const HOUSE_SHADOW_MAX_RADIUS = 7000;
  const HOUSE_SHADOW_LIGHT_DISTANCE = 10000;
  const HOUSE_SHADOW_OPACITY = THREE.MathUtils.clamp(paramNumber('houseShadowOpacity', 0.78), 0, 1);
  const HOUSE_LOCAL_SHADOW_WIDTH = paramNumber('houseLocalShadowWidth', 14);
  const HOUSE_LOCAL_SHADOW_LENGTH = paramNumber('houseLocalShadowLength', 20);
  const HOUSE_LOCAL_SHADOW_Z = paramNumber('houseLocalShadowZ', 0.03);
  const HOUSE_LOCAL_SHADOW_OPACITY = paramNumber('houseLocalShadowOpacity', 0.34);
  const HOUSE_LOCAL_SHADOW_DEBUG_HOVER_M = paramNumber('houseLocalShadowDebugHoverM', 10);
  const HOUSE_LOCAL_SHADOW_ANGLE_OFFSET_RAD = THREE.MathUtils.degToRad(
    paramNumber('houseLocalShadowAngleOffsetDeg', 90)
  );
  const HOUSE_LOCAL_SHADOW_MAX_STRETCH = 3.2;
  const HOUSE_LOCAL_SHADOW_MIN_SUN = 0.02;
  const houseShadowReceiverMaterial = new THREE.ShadowMaterial({
    color: 0x000000,
    transparent: true,
    opacity: HOUSE_SHADOW_OPACITY,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  houseShadowReceiverMaterial.toneMapped = false;
  const houseShadowReceivers = new Map();
  const houseShadowCasterLight = new THREE.DirectionalLight(0xffffff, 1.0);
  houseShadowCasterLight.name = 'nuuk-house-shadow-light';
  houseShadowCasterLight.castShadow = true;
  houseShadowCasterLight.visible = HOUSE_USE_SHADOW_MAP;
  houseShadowCasterLight.shadow.mapSize.set(HOUSE_SHADOW_MAP_SIZE, HOUSE_SHADOW_MAP_SIZE);
  houseShadowCasterLight.shadow.bias = -0.00008;
  houseShadowCasterLight.shadow.normalBias = 0.05;
  houseShadowCasterLight.shadow.camera.near = 50;
  houseShadowCasterLight.shadow.camera.far = 80000;
  terrainRoot.add(houseShadowCasterLight);
  terrainRoot.add(houseShadowCasterLight.target);
  const houseMarkerDotGeo = new THREE.SphereGeometry(240, 14, 12);
  const houseMarkerHaloGeo = new THREE.RingGeometry(330, 470, 24);
  const houseMarkerTextCache = new Map();
  
  function createLocalShadowTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (ctx == null) {
      return null;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const gradient = ctx.createRadialGradient(128, 128, 18, 128, 128, 120);
    gradient.addColorStop(0.0, 'rgba(0,0,0,0.86)');
    gradient.addColorStop(0.45, 'rgba(0,0,0,0.44)');
    gradient.addColorStop(1.0, 'rgba(0,0,0,0.0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.premultiplyAlpha = true;
    return texture;
  }
  
  const houseLocalShadowTexture = createLocalShadowTexture();
  
  function createHouseLocalShadowMesh() {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: 0x000000,
        map: houseLocalShadowTexture,
        transparent: true,
        opacity: HOUSE_LOCAL_SHADOW_OPACITY,
        depthTest: false,
        depthWrite: false,
        blending: THREE.MultiplyBlending,
        premultipliedAlpha: true,
        toneMapped: true,
        side: THREE.DoubleSide,
      })
    );
    mesh.frustumCulled = false;
    mesh.renderOrder = 30;
    mesh.userData.houseShadowProbeIgnore = true;
    return mesh;
  }
  
  function createHouseLocalShadowDebugMesh() {
    const group = new THREE.Group();
    group.visible = false;
  
    const fill = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: 0xff2d7a,
        transparent: true,
        opacity: 0.22,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      })
    );
    fill.renderOrder = 31;
  
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)),
      new THREE.LineBasicMaterial({
        color: 0x00e5ff,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      })
    );
    outline.renderOrder = 32;
  
    const beacon = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, HOUSE_LOCAL_SHADOW_DEBUG_HOVER_M),
      ]),
      new THREE.LineBasicMaterial({
        color: 0x00e5ff,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      })
    );
    beacon.renderOrder = 33;
  
    group.add(fill, outline, beacon);
    group.traverse(object => {
      object.userData.houseShadowProbeIgnore = true;
    });
    group.frustumCulled = false;
    return group;
  }
  
  const computeHouseShadowCoverage = loadedHouses => terrainHouseShadowCoverage(loadedHouses, {
    baseRadius: HOUSE_SHADOW_BASE_RADIUS,
    radiusPadding: HOUSE_SHADOW_RADIUS_PADDING,
    maxRadius: HOUSE_SHADOW_MAX_RADIUS,
  });
  function createHouseLabelSprite(labelText, colorHex) {
    const cacheKey = `${labelText}:${colorHex}`;
    const cached = houseMarkerTextCache.get(cacheKey);
    if (cached) return cached.clone();
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (ctx == null) {
      const fallback = new THREE.Sprite(new THREE.SpriteMaterial({ color: colorHex, depthTest: false, depthWrite: false }));
      fallback.scale.set(1200, 600, 1);
      houseMarkerTextCache.set(cacheKey, fallback);
      return fallback.clone();
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(12, 20, canvas.width - 24, 88);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.strokeRect(12, 20, canvas.width - 24, 88);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 54px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(labelText, canvas.width / 2, 64);
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        color: colorHex,
      })
    );
    sprite.scale.set(1500, 750, 1);
    houseMarkerTextCache.set(cacheKey, sprite);
    return sprite.clone();
  }
  
  const houseMarkerRuntime = createTerrainHouseMarkerRuntime({
    markerHeight: HOUSE_MARKER_HEIGHT,
    baseLift: HOUSE_MARKER_BASE_LIFT,
    colors: HOUSE_MARKER_COLORS,
  });
  const { instances: houseInstances, byId: houseById } = houseMarkerRuntime.createHouseInstances({
    sites: houseSites,
    houseLayer,
    markerLayer: houseMarkerLayer,
  });
  let housesRuntimeVisible = HOUSE_MODEL.enabled;
  
  function setHousesRuntimeVisible(nextVisible, reason = 'manual') {
    housesRuntimeVisible = Boolean(nextVisible);
    houseLayer.visible = housesRuntimeVisible;
    if (!housesRuntimeVisible) {
      houseMarkerLayer.visible = false;
      houseShadowReceiverLayer.visible = false;
      houseShadowCasterLight.visible = false;
      bootLog('house.visibility', { visible: false, reason });
      return;
    }
    bootLog('house.visibility', { visible: true, reason });
    if (HOUSE_USE_SHADOW_MAP) {
      houseShadowCasterLight.visible = true;
    }
    if (!houseInstances.some(house => house.hasModel)) {
      markHousesNeedSnap();
      loadHouseModel('toggle-on');
    }
  }
  
  function findHouseForObject(object) {
    let cursor = object;
    while (cursor != null) {
      const houseId = cursor.userData?.houseId;
      if (houseId != null) {
        return houseById.get(houseId) ?? null;
      }
      cursor = cursor.parent;
    }
    return null;
  }
  
  function collectHouseModelMeshes() {
    const meshes = [];
    for (const house of houseInstances) {
      if (!house.hasModel) continue;
      house.group.traverse(object => {
        if (!object.isMesh) return;
        if (object.userData?.houseShadowProbeIgnore) return;
        meshes.push(object);
      });
    }
    return meshes;
  }
  
  function collectHouseLocalShadowMeshes() {
    const meshes = [];
    for (const house of houseInstances) {
      if (!house.localShadowMesh) continue;
      meshes.push(house.localShadowMesh);
    }
    return meshes;
  }
  
  function _roundPoint(point) {
    return {
      x: Number(point.x.toFixed(3)),
      y: Number(point.y.toFixed(3)),
      z: Number(point.z.toFixed(3)),
    };
  }
  
  function probeHouseShadowIntersections(event) {
    if (HOUSE_PROBE_CONSOLE) {
      console.log('[HOUSE PROBE] click', {
        x: event.clientX,
        y: event.clientY,
        mapMode: controls.mapMode,
        shadowMode: HOUSE_SHADOW_MODE,
        houseEnabled: HOUSE_MODEL.enabled,
        housesVisible: housesRuntimeVisible,
      });
    }
    if (!HOUSE_MODEL.enabled || !housesRuntimeVisible) return;
    const houseMeshes = collectHouseModelMeshes();
    const localShadowMeshes = collectHouseLocalShadowMeshes();
    const receiverTargets = houseShadowReceiverLayer.visible ? [...houseShadowReceivers.values()] : [];
    if (houseMeshes.length === 0 && localShadowMeshes.length === 0 && receiverTargets.length === 0) return;
  
    mouseNDC.x = (event.clientX / windowImpl.innerWidth) * 2 - 1;
    mouseNDC.y = -(event.clientY / windowImpl.innerHeight) * 2 + 1;
    const activeCamera = controls.mapMode ? mapCam : camera;
    raycaster.setFromCamera(mouseNDC, activeCamera);
  
    const houseHits = raycaster.intersectObjects(houseMeshes, false);
    const localShadowHits = raycaster.intersectObjects(localShadowMeshes, false);
    const receiverHits = receiverTargets.length > 0
      ? raycaster.intersectObjects(receiverTargets, false)
      : [];
    if (houseHits.length === 0 && localShadowHits.length === 0 && receiverHits.length === 0) return;
  
    const houseHit = houseHits[0] ?? null;
    let house = houseHit ? findHouseForObject(houseHit.object) : null;
    const localShadowHit = localShadowHits[0] ?? null;
    if (house == null && localShadowHit?.object?.userData?.houseId) {
      house = houseById.get(localShadowHit.object.userData.houseId) ?? null;
    }
    const receiverHit = receiverHits[0] ?? null;
  
    const payload = {
      houseId: house?.site?.id ?? null,
      tileId: house?.site?.tileId ?? null,
      shadowMode: HOUSE_SHADOW_MODE,
      gateReason: houseShadowGateReason,
      mapMode: controls.mapMode,
      click: { x: event.clientX, y: event.clientY },
      rayOrigin: _roundPoint(raycaster.ray.origin),
      rayDirection: _roundPoint(raycaster.ray.direction),
      houseHit: houseHit
        ? {
            count: houseHits.length,
            distance: Number(houseHit.distance.toFixed(3)),
            point: _roundPoint(houseHit.point),
            objectName: houseHit.object.name || houseHit.object.type,
            castShadow: Boolean(houseHit.object.castShadow),
            receiveShadow: Boolean(houseHit.object.receiveShadow),
          }
        : {
            count: 0,
            distance: null,
            point: null,
            objectName: null,
            castShadow: null,
            receiveShadow: null,
          },
      localShadow: {
        enabled: HOUSE_USE_LOCAL_SHADOWS,
        meshVisible: house ? Boolean(house.localShadowMesh?.visible) : null,
        hitCount: localShadowHits.length,
        hitDistance: localShadowHit ? Number(localShadowHit.distance.toFixed(3)) : null,
        hitPoint: localShadowHit ? _roundPoint(localShadowHit.point) : null,
        hitHouseId: localShadowHit?.object?.userData?.houseId ?? null,
      },
      shadowMap: {
        enabled: HOUSE_USE_SHADOW_MAP,
        receiverLayerVisible: houseShadowReceiverLayer.visible,
        receiverCount: houseShadowReceivers.size,
        hitCount: receiverHits.length,
        hitDistance: receiverHit ? Number(receiverHit.distance.toFixed(3)) : null,
        hitPoint: receiverHit ? _roundPoint(receiverHit.point) : null,
        hitReceiverTileId: receiverHit?.object?.userData?.houseShadowTileId ?? null,
      },
    };
  
    bootLog('house.shadow.click_probe', payload);
    if (HOUSE_PROBE_CONSOLE) {
      console.log('[HOUSE PROBE] hit', {
        houseId: house?.site?.id ?? null,
        houseHits: houseHits.length,
        localShadowHits: localShadowHits.length,
        receiverHits: receiverHits.length,
      });
    }
    flushClientLogQueue();
  }
  
  const updateHouseMarkerPosition = houseMarkerRuntime.updateHouseMarkerPosition;
  
  function houseLocalFromLatLon(lat, lon) {
    return terrainHouseLocalPosition(lat, lon, anchorLat, anchorLon);
  }
  
  function houseTerrainMeshes() {
    const meshes = [];
    for (const child of terrainRoot.children) {
      if (!child.isMesh) continue;
      if (!child.userData?.tileId) continue;
      meshes.push(child);
    }
    return meshes;
  }
  
  function createHouseShadowReceiverFromTerrainMesh(terrainMesh) {
    const receiver = new THREE.Mesh(terrainMesh.geometry, houseShadowReceiverMaterial);
    receiver.position.copy(terrainMesh.position);
    receiver.quaternion.copy(terrainMesh.quaternion);
    receiver.scale.copy(terrainMesh.scale);
    receiver.receiveShadow = true;
    receiver.castShadow = false;
    receiver.frustumCulled = false;
    receiver.renderOrder = 26;
    receiver.userData.houseShadowTileId = terrainMesh.userData.tileId;
    receiver.userData.sourceGeometry = terrainMesh.geometry;
    return receiver;
  }
  
  function clearHouseShadowReceivers() {
    for (const receiver of houseShadowReceivers.values()) {
      houseShadowReceiverLayer.remove(receiver);
    }
    houseShadowReceivers.clear();
  }
  
  function syncHouseShadowReceivers() {
    if (!HOUSE_MODEL.enabled) {
      clearHouseShadowReceivers();
      return;
    }
    const activeTileIds = new Set();
    const terrainMeshes = houseTerrainMeshes();
    for (const terrainMesh of terrainMeshes) {
      const tileId = terrainMesh.userData?.tileId;
      if (!tileId) continue;
      activeTileIds.add(tileId);
      const existing = houseShadowReceivers.get(tileId);
      if (existing) {
        if (existing.userData.sourceGeometry !== terrainMesh.geometry) {
          houseShadowReceiverLayer.remove(existing);
          houseShadowReceivers.delete(tileId);
        } else {
          continue;
        }
      }
      if (houseShadowReceivers.has(tileId)) {
        continue;
      }
      const receiver = createHouseShadowReceiverFromTerrainMesh(terrainMesh);
      houseShadowReceivers.set(tileId, receiver);
      houseShadowReceiverLayer.add(receiver);
    }
    for (const [tileId, receiver] of houseShadowReceivers) {
      if (activeTileIds.has(tileId)) continue;
      houseShadowReceiverLayer.remove(receiver);
      houseShadowReceivers.delete(tileId);
    }
  }
  
  function updateHouseShadowSystem() {
    const setGate = reason => {
      houseShadowGateReason = reason;
      if (lastHouseShadowGateReason !== reason) {
        lastHouseShadowGateReason = reason;
        houseShadowReceiverMaterial.needsUpdate = true;
        bootLog('house.shadow.gate', { reason });
      }
    };
  
    if (!HOUSE_USE_SHADOW_MAP) {
      setGate('shadowmap-disabled');
      houseShadowCasterLight.visible = false;
      houseShadowReceiverLayer.visible = false;
      return;
    }
    if (!HOUSE_MODEL.enabled) {
      setGate('disabled');
      houseShadowCasterLight.visible = false;
      houseShadowReceiverLayer.visible = false;
      return;
    }
    if (controls.mapMode) {
      setGate('map-mode');
      houseShadowCasterLight.visible = false;
      houseShadowReceiverLayer.visible = false;
      return;
    }
  
    const loadedHouses = houseInstances.filter(
      house => house.hasModel && house.group.children.length > 0
    );
    const sunUp = getSunDirection().dot(up);
    const coverage = computeHouseShadowCoverage(loadedHouses);
    if (coverage == null) {
      setGate('no-house-coverage');
      houseShadowCasterLight.visible = false;
      houseShadowReceiverLayer.visible = false;
      return;
    }
    if (sunUp <= 0.01) {
      setGate('sun-below-horizon');
      houseShadowCasterLight.visible = false;
      houseShadowReceiverLayer.visible = false;
      return;
    }
    if (houseShadowReceivers.size === 0) {
      setGate('no-shadow-receivers');
      houseShadowCasterLight.visible = false;
      houseShadowReceiverLayer.visible = false;
      return;
    }
  
    setGate('active');
    houseShadowCasterLight.visible = true;
    houseShadowCenterLocal.set(coverage.centerX, coverage.centerY, coverage.centerZ);
    const shadowRadius = coverage.shadowRadius;
    houseShadowLightDirection.copy(getSunDirection()).normalize();
    houseShadowLightDirectionLocal.set(
      houseShadowLightDirection.dot(east),
      houseShadowLightDirection.dot(north),
      houseShadowLightDirection.dot(up)
    ).normalize();
    houseShadowCasterLight.position
      .copy(houseShadowCenterLocal)
      .addScaledVector(houseShadowLightDirectionLocal, HOUSE_SHADOW_LIGHT_DISTANCE + shadowRadius);
    houseShadowCasterLight.target.position.copy(houseShadowCenterLocal);
    houseShadowCasterLight.target.updateMatrixWorld(true);
    houseShadowCasterLight.updateMatrixWorld(true);
  
    const shadowCamera = houseShadowCasterLight.shadow.camera;
    shadowCamera.left = -shadowRadius;
    shadowCamera.right = shadowRadius;
    shadowCamera.top = shadowRadius;
    shadowCamera.bottom = -shadowRadius;
    shadowCamera.near = 100;
    shadowCamera.far = HOUSE_SHADOW_LIGHT_DISTANCE + shadowRadius * 4;
    shadowCamera.updateProjectionMatrix();
  
    houseShadowReceiverMaterial.opacity = HOUSE_SHADOW_OPACITY;
    // Debounce: only re-render shadow map when light moved meaningfully
    const posDelta = _lastHouseShadowPos.distanceTo(houseShadowCasterLight.position);
    const dirDelta = _lastHouseShadowDir.distanceTo(houseShadowLightDirectionLocal);
    const radiusDelta = Math.abs(shadowRadius - _lastHouseShadowRadius);
    if (posDelta > HOUSE_SHADOW_MOVE_THRESHOLD || dirDelta > 0.001 || radiusDelta > 0.5) {
      houseShadowCasterLight.shadow.needsUpdate = true;
      _lastHouseShadowPos.copy(houseShadowCasterLight.position);
      _lastHouseShadowDir.copy(houseShadowLightDirectionLocal);
      _lastHouseShadowRadius = shadowRadius;
    }
    houseShadowReceiverLayer.visible = true;
  }
  
  function updateHouseLocalShadows() {
    if (!HOUSE_MODEL.enabled || !HOUSE_USE_LOCAL_SHADOWS || controls.mapMode) {
      houseShadowGateReason = controls.mapMode ? 'local-map-mode' : 'local-disabled';
      for (const house of houseInstances) {
        if (house.localShadowMesh) house.localShadowMesh.visible = false;
        if (house.localShadowDebugMesh) house.localShadowDebugMesh.visible = false;
      }
      return;
    }
    const sunUp = getSunDirection().dot(up);
    if (sunUp <= HOUSE_LOCAL_SHADOW_MIN_SUN) {
      houseShadowGateReason = 'local-sun-below';
      for (const house of houseInstances) {
        if (house.localShadowMesh) house.localShadowMesh.visible = false;
        if (house.localShadowDebugMesh) house.localShadowDebugMesh.visible = false;
      }
      return;
    }
    houseLocalShadowDirection.set(
      -getSunDirection().dot(east),
      -getSunDirection().dot(north)
    );
    const horiz = houseLocalShadowDirection.length();
    if (horiz <= 1e-6) {
      houseShadowGateReason = 'local-no-horizontal';
      for (const house of houseInstances) {
        if (house.localShadowMesh) house.localShadowMesh.visible = false;
        if (house.localShadowDebugMesh) house.localShadowDebugMesh.visible = false;
      }
      return;
    }
    houseShadowGateReason = 'local-active';
    houseLocalShadowDirection.multiplyScalar(1 / horiz);
  
    const stretch = THREE.MathUtils.clamp(
      1 / Math.max(sunUp, 0.2),
      1,
      HOUSE_LOCAL_SHADOW_MAX_STRETCH
    );
    const worldAngle = Math.atan2(houseLocalShadowDirection.y, houseLocalShadowDirection.x);
    const baseOpacity = THREE.MathUtils.clamp(
      HOUSE_LOCAL_SHADOW_OPACITY * (0.72 + 0.35 * sunUp),
      0.2,
      0.45
    );
  
    for (const house of houseInstances) {
      const shadowMesh = house.localShadowMesh;
      const debugMesh = house.localShadowDebugMesh;
      if (!shadowMesh || !house.hasModel) {
        if (shadowMesh) shadowMesh.visible = false;
        if (debugMesh) debugMesh.visible = false;
        continue;
      }
      const localAngle = worldAngle - house.group.rotation.z + HOUSE_LOCAL_SHADOW_ANGLE_OFFSET_RAD;
      const scale = house.site.scale;
      const width = HOUSE_LOCAL_SHADOW_WIDTH * scale;
      const length = HOUSE_LOCAL_SHADOW_LENGTH * scale * stretch;
      const offset = (length - width) * 0.32;
      shadowMesh.rotation.z = localAngle;
      shadowMesh.scale.set(length, width, 1);
      shadowMesh.position.set(
        Math.cos(localAngle) * offset,
        Math.sin(localAngle) * offset,
        -HOUSE_MODEL.altOffsetM + HOUSE_LOCAL_SHADOW_Z
      );
      if (shadowMesh.material) {
        shadowMesh.material.opacity = baseOpacity;
      }
      shadowMesh.visible = true;
      if (debugMesh) {
        debugMesh.rotation.z = localAngle;
        debugMesh.scale.set(length, width, 1);
        debugMesh.position.set(
          Math.cos(localAngle) * offset,
          Math.sin(localAngle) * offset,
          -HOUSE_MODEL.altOffsetM + HOUSE_LOCAL_SHADOW_Z + 0.02
        );
        debugMesh.visible = true;
      }
    }
  }
  
  function makeTakramHouseMaterial(sourceMaterial) {
    const material = new THREE.MeshBasicMaterial({
      color:
        sourceMaterial?.color != null ? sourceMaterial.color.clone() : new THREE.Color(0xffffff),
      map: sourceMaterial?.map ?? null,
      transparent: Boolean(sourceMaterial?.transparent),
      opacity: sourceMaterial?.opacity ?? 1,
      side: sourceMaterial?.side ?? THREE.FrontSide,
      alphaTest: sourceMaterial?.alphaTest ?? 0,
    });
    material.toneMapped = true;
    return material;
  }
  
  function applyHouseTakramMaterials(root) {
    root.traverse(object => {
      if (!object.isMesh) return;
      if (Array.isArray(object.material)) {
        object.material = object.material.map(makeTakramHouseMaterial);
      } else {
        object.material = makeTakramHouseMaterial(object.material);
      }
    });
  }
  
  function applyHousePlanarPlacement(house) {
    const local = houseLocalFromLatLon(house.site.lat, house.site.lon);
    house.group.position.set(local.x, local.y, house.group.position.z);
    house.group.rotation.set(0, 0, THREE.MathUtils.degToRad(house.site.headingDeg));
    house.group.scale.setScalar(house.site.scale);
    updateHouseMarkerPosition(house);
  }
  
  function snapHouseToTerrain(house, terrainTargets) {
    if (!HOUSE_MODEL.enabled || terrainTargets.length === 0) {
      return false;
    }
    houseTargetLocal.copy(house.group.position);
    houseTargetLocal.z = 20000;
    houseTargetWorld.copy(houseTargetLocal);
    terrainRoot.localToWorld(houseTargetWorld);
    houseDownRaycaster.set(houseTargetWorld, houseDownDirection);
    const hits = houseDownRaycaster.intersectObjects(terrainTargets);
    if (hits.length === 0) {
      return false;
    }
    houseTargetLocal.copy(hits[0].point);
    terrainRoot.worldToLocal(houseTargetLocal);
    house.group.position.z = houseTargetLocal.z + HOUSE_MODEL.altOffsetM;
    updateHouseMarkerPosition(house);
    return true;
  }
  
  const disposeHouseTree = disposeTerrainHouseTree;
  
  function clearHouseVisuals() {
    const seenGeometries = new Set();
    const seenMaterials = new Set();
    for (const house of houseInstances) {
      while (house.group.children.length > 0) {
        const child = house.group.children[house.group.children.length - 1];
        house.group.remove(child);
        disposeHouseTree(child, seenGeometries, seenMaterials);
      }
      house.localShadowMesh = null;
      house.localShadowDebugMesh = null;
      house.hasModel = false;
    }
  }
  
  function instantiateHousesFromTemplate() {
    clearHouseVisuals();
    if (houseModelTemplate == null) {
      return;
    }
    for (const house of houseInstances) {
      const localShadow = createHouseLocalShadowMesh();
      localShadow.userData.houseId = house.site.id;
      house.group.add(localShadow);
      house.localShadowMesh = localShadow;
      if (HOUSE_LOCAL_SHADOW_DEBUG) {
        const localShadowDebugMesh = createHouseLocalShadowDebugMesh();
        localShadowDebugMesh.userData.houseId = house.site.id;
        house.group.add(localShadowDebugMesh);
        house.localShadowDebugMesh = localShadowDebugMesh;
      }
      const model = houseModelTemplate.clone(true);
      // glTF assets are y-up; terrainRoot local space is z-up.
      model.rotation.x = Math.PI * 0.5;
      applyHouseTakramMaterials(model);
      model.traverse(object => {
        if (!object.isMesh) return;
        object.frustumCulled = false;
        object.castShadow = HOUSE_USE_SHADOW_MAP;
        object.receiveShadow = false;
        if (HOUSE_USE_SHADOW_MAP) {
          const shadowDepthMaterial = new THREE.MeshDepthMaterial({
            depthPacking: THREE.RGBADepthPacking,
            side: THREE.DoubleSide,
          });
          shadowDepthMaterial.map = object.material?.map ?? null;
          shadowDepthMaterial.alphaTest = object.material?.alphaTest ?? 0;
          shadowDepthMaterial.depthTest = true;
          shadowDepthMaterial.depthWrite = true;
          object.customDepthMaterial = shadowDepthMaterial;
        }
      });
      house.group.add(model);
      house.hasModel = true;
      applyHousePlanarPlacement(house);
      house.snapPending = true;
    }
  }
  
  const markHousesNeedSnap = () => markTerrainHousesNeedSnap(houseInstances);
  
  function snapPendingHouses() {
    if (!HOUSE_MODEL.enabled || houseInstances.length === 0) {
      return;
    }
    houseSnapTargets.length = 0;
    houseSnapTargets.push(...houseTerrainMeshes());
    if (houseSnapTargets.length === 0) {
      return;
    }
    for (const house of houseInstances) {
      if (!house.snapPending) continue;
      house.snapPending = !snapHouseToTerrain(house, houseSnapTargets);
    }
  }
  
  const houseZSummary = () => terrainHouseZSummary(houseInstances);
  
  function houseShadowDebugSummary() {
    const loadedHouses = houseInstances.filter(
      house => house.hasModel && house.group.children.length > 0
    );
    let casterMeshCount = 0;
    let customDepthCount = 0;
    let localShadowMeshCount = 0;
    let localShadowVisibleCount = 0;
    let localShadowDebugMeshCount = 0;
    let localShadowDebugVisibleCount = 0;
    for (const house of loadedHouses) {
      if (house.localShadowMesh) {
        localShadowMeshCount += 1;
        if (house.localShadowMesh.visible) {
          localShadowVisibleCount += 1;
        }
      }
      if (house.localShadowDebugMesh) {
        localShadowDebugMeshCount += 1;
        if (house.localShadowDebugMesh.visible) {
          localShadowDebugVisibleCount += 1;
        }
      }
      house.group.traverse(object => {
        if (!object.isMesh) return;
        if (object.castShadow) casterMeshCount += 1;
        if (object.customDepthMaterial) customDepthCount += 1;
      });
    }
    const loadedHouseCount = loadedHouses.length;
    const coverage = computeHouseShadowCoverage(loadedHouses);
    const shadowCamera = houseShadowCasterLight.shadow.camera;
    const span = shadowCamera.right - shadowCamera.left;
    const map = houseShadowCasterLight.shadow.map;
    const mapSize = houseShadowCasterLight.shadow.mapSize;
    const sunUp = getSunDirection().dot(up);
    return {
      shadowMode: HOUSE_SHADOW_MODE,
      localShadowEnabled: HOUSE_USE_LOCAL_SHADOWS,
      localShadowDebugEnabled: HOUSE_LOCAL_SHADOW_DEBUG,
      shadowMapEnabled: HOUSE_USE_SHADOW_MAP,
      enabled: HOUSE_MODEL.enabled,
      mapMode: controls.mapMode,
      gateReason: houseShadowGateReason,
      gateMapMode: controls.mapMode,
      gateCoverageMissing: coverage == null,
      gateSunBelow: sunUp <= 0.01,
      gateNoReceivers: houseShadowReceivers.size === 0,
      rendererShadowEnabled: renderer.shadowMap.enabled,
      rendererShadowAutoUpdate: renderer.shadowMap.autoUpdate,
      lightVisible: houseShadowCasterLight.visible,
      lightCastShadow: houseShadowCasterLight.castShadow,
      receiverVisible: houseShadowReceiverLayer.visible,
      receiverCount: houseShadowReceivers.size,
      loadedHouseCount,
      localShadowMeshCount,
      localShadowVisibleCount,
      localShadowDebugMeshCount,
      localShadowDebugVisibleCount,
      casterMeshCount,
      customDepthCount,
      shadowMapSize: mapSize.x,
      shadowMapActual: map ? { width: map.width, height: map.height } : null,
      shadowCameraNear: Number(shadowCamera.near.toFixed(2)),
      shadowCameraFar: Number(shadowCamera.far.toFixed(2)),
      shadowSpanM: Number(span.toFixed(1)),
      approxTexelM: Number((span / mapSize.x).toFixed(3)),
      lightPos: {
        x: Number(houseShadowCasterLight.position.x.toFixed(1)),
        y: Number(houseShadowCasterLight.position.y.toFixed(1)),
        z: Number(houseShadowCasterLight.position.z.toFixed(1)),
      },
      lightTarget: {
        x: Number(houseShadowCasterLight.target.position.x.toFixed(1)),
        y: Number(houseShadowCasterLight.target.position.y.toFixed(1)),
        z: Number(houseShadowCasterLight.target.position.z.toFixed(1)),
      },
      sunUp: Number(sunUp.toFixed(4)),
    };
  }
  
  function maybeLogHouseShadowSnapshot(nowMs) {
    if (!HOUSE_MODEL.enabled || HOUSE_SHADOW_LOG_MS <= 0) {
      return;
    }
    if (nowMs - lastHouseShadowLogAt < HOUSE_SHADOW_LOG_MS) {
      return;
    }
    lastHouseShadowLogAt = nowMs;
    bootLog('house.shadow.snapshot', houseShadowDebugSummary());
  }
  
  const houseModelController = createTerrainHouseModelController({
    model: HOUSE_MODEL,
    loader: houseLoader,
    instanceCount: houseInstances.length,
    bootLog,
    onTemplate: template => {
      houseModelTemplate = template;
      instantiateHousesFromTemplate();
    },
    onLoaded: snapPendingHouses,
  });
  const loadHouseModel = houseModelController.load;
  const pollHouseModelSignature = houseModelController.pollSignature;
  const updateHouseHotReload = houseModelController.updateHotReload;
  const runtime = {
    HOUSE_MODEL, HOUSE_SHADOW_MODE, HOUSE_USE_SHADOW_MAP,
    HOUSE_MARKER_HEIGHT, HOUSE_MARKER_BASE_LIFT,
    houseLayer, houseShadowReceiverLayer, houseMarkerLayer,
    houseShadowReceivers, houseShadowCasterLight,
    houseMarkerDotGeo, houseMarkerHaloGeo, houseSites, houseInstances,
    createHouseLabelSprite, houseLocalFromLatLon, houseTerrainMeshes,
    setHousesRuntimeVisible, markHousesNeedSnap, loadHouseModel,
    pollHouseModelSignature, updateHouseHotReload, snapPendingHouses,
    syncHouseShadowReceivers, updateHouseShadowSystem, updateHouseLocalShadows,
    probeHouseShadowIntersections, houseZSummary, houseShadowDebugSummary,
    maybeLogHouseShadowSnapshot, houseModelController,
  };
  Object.defineProperties(runtime, {
    housesRuntimeVisible: { get: () => housesRuntimeVisible, set: value => { housesRuntimeVisible = Boolean(value); } },
    shadowMapReadyLogged: { get: () => shadowMapReadyLogged, set: value => { shadowMapReadyLogged = Boolean(value); } },
  });
  return runtime;
}

