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
