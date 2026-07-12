import * as THREE from 'three';

export function createTerrainHouseConfiguration({ definition, instances, source, bootLog = () => {} }) {
  const model = {
    url: typeof definition?.url === 'string' ? definition.url.trim() : '',
    altOffsetM: Number.isFinite(definition?.altOffsetM) ? definition.altOffsetM : 0.4,
    hotReloadMs: Math.max(500, Number.isFinite(definition?.hotReloadMs) ? definition.hotReloadMs : 2000),
    enabled: Boolean(definition?.enabled),
  };
  if (!model.url) {
    model.enabled = false;
    bootLog('house.config.missing_model_url', { source }, 'warn');
  }
  return {
    model,
    sites: Array.isArray(instances) ? instances.slice() : [],
  };
}

export function terrainHouseLocalPosition(lat, lon, anchorLat, anchorLon) {
  return {
    x: (lon - anchorLon) * 111320 * Math.cos(anchorLat * Math.PI / 180),
    y: (lat - anchorLat) * 111320,
  };
}

export function terrainHouseShadowCoverage(houses, {
  baseRadius = 900,
  radiusPadding = 600,
  maxRadius = 7000,
} = {}) {
  if (houses.length === 0) return null;
  let sumX = 0, sumY = 0, sumZ = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const house of houses) {
    const { x, y, z } = house.group.position;
    sumX += x; sumY += y; sumZ += z;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  const span = Math.max(maxX - minX, maxY - minY);
  const shadowRadius = Math.max(baseRadius, Math.min(maxRadius,
    baseRadius + span * 0.6 + radiusPadding));
  return {
    centerX: sumX / houses.length,
    centerY: sumY / houses.length,
    centerZ: sumZ / houses.length,
    minX, minY, maxX, maxY, shadowRadius,
  };
}

export function createTerrainHouseMarkerRuntime({
  documentRef = document,
  markerHeight = 5000,
  baseLift = 5,
  colors = [0xff3b30, 0xff9500, 0xffcc00, 0x34c759, 0x0a84ff, 0xbf5af2],
} = {}) {
  const dotGeometry = new THREE.SphereGeometry(240, 14, 12);
  const haloGeometry = new THREE.RingGeometry(330, 470, 24);
  const labelCache = new Map();

  function createLabel(labelText, color) {
    const cacheKey = `${labelText}:${color}`;
    const cached = labelCache.get(cacheKey);
    if (cached) return cached.clone();
    const canvas = documentRef.createElement('canvas');
    canvas.width = 256;
    canvas.height = 128;
    const context = canvas.getContext('2d');
    if (context == null) {
      const fallback = new THREE.Sprite(new THREE.SpriteMaterial({
        color, depthTest: false, depthWrite: false,
      }));
      fallback.scale.set(1200, 600, 1);
      labelCache.set(cacheKey, fallback);
      return fallback.clone();
    }
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = 'rgba(0,0,0,0.55)';
    context.fillRect(12, 20, canvas.width - 24, 88);
    context.strokeStyle = '#ffffff';
    context.lineWidth = 3;
    context.strokeRect(12, 20, canvas.width - 24, 88);
    context.fillStyle = '#ffffff';
    context.font = 'bold 54px ui-monospace, Menlo, monospace';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(labelText, canvas.width / 2, 64);
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texture, transparent: true, depthTest: false, depthWrite: false, color,
    }));
    sprite.scale.set(1500, 750, 1);
    labelCache.set(cacheKey, sprite);
    return sprite.clone();
  }

  function createBeaconMarker({ name, label, color }) {
    const marker = new THREE.Group();
    marker.name = name;
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, markerHeight),
      ]),
      new THREE.LineBasicMaterial({
        color, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95,
      }),
    );
    line.renderOrder = 1002;
    const halo = new THREE.Mesh(haloGeometry, new THREE.MeshBasicMaterial({
      color, depthTest: false, depthWrite: false, transparent: true,
      opacity: 0.85, side: THREE.DoubleSide,
    }));
    halo.position.z = markerHeight;
    halo.renderOrder = 1003;
    const dot = new THREE.Mesh(dotGeometry, new THREE.MeshBasicMaterial({
      color, depthTest: false, depthWrite: false,
    }));
    dot.position.z = markerHeight;
    dot.renderOrder = 1004;
    const labelSprite = createLabel(label, color);
    labelSprite.position.set(0, 0, markerHeight + 900);
    labelSprite.renderOrder = 1005;
    marker.add(line, halo, dot, labelSprite);
    return marker;
  }

  function createHouseInstances({ sites, houseLayer, markerLayer }) {
    const instances = sites.map((site, index) => {
      const group = new THREE.Group();
      group.name = `house-${site.id}`;
      group.userData = { houseId: site.id, tileId: site.tileId };
      houseLayer.add(group);
      const marker = createBeaconMarker({
        name: `house-marker-${site.id}`,
        label: site.id.replace('nuuk-', ''),
        color: colors[index % colors.length],
      });
      marker.userData = { houseId: site.id };
      markerLayer.add(marker);
      return {
        site, group, marker, localShadowMesh: null, localShadowDebugMesh: null,
        hasModel: false, snapPending: true,
      };
    });
    return { instances, byId: new Map(instances.map(house => [house.site.id, house])) };
  }

  function updateHouseMarkerPosition(house) {
    if (house.marker == null) return;
    house.marker.position.set(
      house.group.position.x, house.group.position.y, house.group.position.z + baseLift,
    );
  }

  return { createBeaconMarker, createHouseInstances, updateHouseMarkerPosition };
}
