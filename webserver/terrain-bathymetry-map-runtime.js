import * as THREE from 'three';

const DEFAULT_RANGE_M = 2000;
const DEFAULT_POLL_MS = 5000;
const DEFAULT_MOVE_REFRESH_M = 250;

const COVERAGE_COLOR = 0x00d8ff;
const HEALTH_COLORS = {
  white: new THREE.Color(0xf4f4f5),
  yellow: new THREE.Color(0xffe45c),
  red: new THREE.Color(0xff1800),
};
const HEALTH_ORDER = ['white', 'yellow', 'red'];
const COVERAGE_CLIP_SEGMENTS = 128;
const CIRCLE_MARKER_TEXTURE_SIZE = 32;
const DEFAULT_HOVER_RADIUS_PX = 16;
const hoverLocal = new THREE.Vector3();
const hoverProjected = new THREE.Vector3();

function createCircleMarkerTexture() {
  const size = CIRCLE_MARKER_TEXTURE_SIZE;
  const data = new Uint8Array(size * size * 4);
  const center = size / 2;
  const radius = size * 0.43;
  const feather = 1.25;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x + 0.5 - center, y + 0.5 - center);
      const alpha = Math.max(0, Math.min(1, (radius + feather - distance) / feather));
      const index = (y * size + x) * 4;
      data[index] = 255;
      data[index + 1] = 255;
      data[index + 2] = 255;
      data[index + 3] = Math.round(alpha * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function addPointMarkers(group, positions, colors, {
  shape,
  renderOrder,
} = {}) {
  if (positions.length === 0) return;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position', new THREE.BufferAttribute(new Float32Array(positions), 3),
  );
  geometry.setAttribute(
    'color', new THREE.BufferAttribute(new Float32Array(colors), 3),
  );
  const materialOptions = {
    size: 8,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
    blending: THREE.NormalBlending,
  };
  if (shape === 'circle') {
    materialOptions.map = createCircleMarkerTexture();
    materialOptions.alphaTest = 0.01;
  }
  const points = new THREE.Points(
    geometry,
    new THREE.PointsMaterial(materialOptions),
  );
  points.userData.isBathymetrySoundings = true;
  points.userData.bathymetryMarkerShape = shape;
  points.renderOrder = renderOrder;
  group.add(points);
}

export function soundingHealthColor(health) {
  return HEALTH_COLORS[health] || HEALTH_COLORS.white;
}

function soundingHealth(health) {
  return Object.hasOwn(HEALTH_COLORS, health) ? health : 'white';
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function meters(value) {
  const number = finiteNumber(value);
  if (number == null) return '—';
  return `${number.toFixed(1)} m`;
}

function comparableDepths(sounding) {
  if (sounding?.comparisonMethod !== 'corner_rms') {
    return [sounding?.depthM, sounding?.modeledDepthM];
  }
  const observedCorners = Array.isArray(sounding?.evidenceCornersM)
    ? sounding.evidenceCornersM
    : [];
  const modeledCorners = Array.isArray(sounding?.modeledCornersM)
    ? sounding.modeledCornersM
    : [];
  const pairs = observedCorners
    .map((observed, index) => [
      finiteNumber(observed),
      finiteNumber(modeledCorners[index]),
    ])
    .filter(([observed, modeled]) => observed != null && modeled != null);
  if (!pairs.length) {
    return [sounding?.depthM, sounding?.modeledDepthM];
  }
  return [
    pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length,
    pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length,
  ];
}

export function bathymetrySoundingTooltipHtml(sounding) {
  const observedLabel = sounding?.kind === 'at_least'
    ? 'Observed ≥'
    : 'Observed';
  const [observedDepth, modeledDepth] = comparableDepths(sounding);
  return [
    `${observedLabel}: <b>${meters(observedDepth)}</b>`,
    `Model: <b>${meters(modeledDepth)}</b>`,
  ].join('<br>');
}

export function nearestBathymetrySounding(
  group,
  camera,
  {
    clientX,
    clientY,
    left = 0,
    top = 0,
    width,
    height,
    maxDistancePx = DEFAULT_HOVER_RADIUS_PX,
  },
) {
  const entries = group?.userData?.bathymetrySoundingHits;
  if (
    !group?.visible
    || !Array.isArray(entries)
    || entries.length === 0
    || !camera
    || !Number.isFinite(width)
    || !Number.isFinite(height)
    || width <= 0
    || height <= 0
  ) return null;
  group.updateWorldMatrix?.(true, false);
  camera.updateMatrixWorld?.();
  let nearest = null;
  let nearestDistance = Math.max(0, Number(maxDistancePx) || 0);
  for (const entry of entries) {
    hoverLocal.fromArray(entry.position).applyMatrix4(group.matrixWorld);
    hoverProjected.copy(hoverLocal).project(camera);
    if (hoverProjected.z < -1 || hoverProjected.z > 1) continue;
    const screenX = left + (hoverProjected.x + 1) * width / 2;
    const screenY = top + (1 - hoverProjected.y) * height / 2;
    const distancePx = Math.hypot(screenX - clientX, screenY - clientY);
    if (distancePx > nearestDistance) continue;
    if (
      nearest
      && Math.abs(distancePx - nearestDistance) < 1e-6
      && HEALTH_ORDER.indexOf(soundingHealth(entry.sounding.health))
        < HEALTH_ORDER.indexOf(soundingHealth(nearest.sounding.health))
    ) continue;
    nearest = { sounding: entry.sounding, distancePx, screenX, screenY };
    nearestDistance = distancePx;
  }
  return nearest;
}

function clipPolygonAgainstEdge(polygon, edgeStart, edgeEnd) {
  const result = [];
  const edgeX = edgeEnd[0] - edgeStart[0];
  const edgeY = edgeEnd[1] - edgeStart[1];
  const side = point => (
    edgeX * (point[1] - edgeStart[1])
    - edgeY * (point[0] - edgeStart[0])
  );
  for (let i = 0; i < polygon.length; i += 1) {
    const current = polygon[i];
    const previous = polygon[(i + polygon.length - 1) % polygon.length];
    const currentSide = side(current);
    const previousSide = side(previous);
    const currentInside = currentSide >= 0;
    const previousInside = previousSide >= 0;
    if (currentInside !== previousInside) {
      const denominator = previousSide - currentSide;
      const t = denominator === 0 ? 0 : previousSide / denominator;
      result.push([
        previous[0] + (current[0] - previous[0]) * t,
        previous[1] + (current[1] - previous[1]) * t,
      ]);
    }
    if (currentInside) result.push(current);
  }
  return result;
}

function coveragePolygon(bbox, clipCircle) {
  const [rawX0, rawY0, rawX1, rawY1] = bbox.map(Number);
  if (![rawX0, rawY0, rawX1, rawY1].every(Number.isFinite)) return [];
  const x0 = Math.min(rawX0, rawX1);
  const y0 = Math.min(rawY0, rawY1);
  const x1 = Math.max(rawX0, rawX1);
  const y1 = Math.max(rawY0, rawY1);
  let polygon = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  if (!clipCircle) return polygon;

  const centerX = Number(clipCircle.x);
  const centerY = Number(clipCircle.y);
  const radius = Number(clipCircle.radius);
  if (![centerX, centerY, radius].every(Number.isFinite) || radius <= 0) return [];
  const radiusSquared = radius * radius;
  const nearestX = Math.max(x0, Math.min(x1, centerX));
  const nearestY = Math.max(y0, Math.min(y1, centerY));
  if ((nearestX - centerX) ** 2 + (nearestY - centerY) ** 2 > radiusSquared) {
    return [];
  }
  const entirelyInside = polygon.every(([x, y]) => (
    (x - centerX) ** 2 + (y - centerY) ** 2 <= radiusSquared
  ));
  if (entirelyInside) return polygon;

  // Only boundary footprints pay for clipping. The inscribed polygon keeps
  // every generated fragment strictly within the requested circular map.
  for (let i = 0; i < COVERAGE_CLIP_SEGMENTS && polygon.length; i += 1) {
    const angle0 = 2 * Math.PI * i / COVERAGE_CLIP_SEGMENTS;
    const angle1 = 2 * Math.PI * (i + 1) / COVERAGE_CLIP_SEGMENTS;
    polygon = clipPolygonAgainstEdge(
      polygon,
      [centerX + radius * Math.cos(angle0), centerY + radius * Math.sin(angle0)],
      [centerX + radius * Math.cos(angle1), centerY + radius * Math.sin(angle1)],
    );
  }
  return polygon;
}

export function buildBathymetryMapGroup(payload, {
  offsetX = 0,
  offsetY = 0,
  exaggeration = 1,
  clipCircle = null,
} = {}) {
  const group = new THREE.Group();
  group.userData.isBathymetryMap = true;

  const coverage = Array.isArray(payload?.coverage) ? payload.coverage : [];
  const coveragePositions = [];
  const coverageIndices = [];
  for (const item of coverage) {
    if (!Array.isArray(item.bbox) || item.bbox.length !== 4) continue;
    const polygon = coveragePolygon(item.bbox, clipCircle);
    if (polygon.length < 3) continue;
    const start = coveragePositions.length / 3;
    const z = 2 * exaggeration;
    for (const [x, y] of polygon) {
      coveragePositions.push(x + offsetX, y + offsetY, z);
    }
    for (let i = 1; i < polygon.length - 1; i += 1) {
      coverageIndices.push(start, start + i, start + i + 1);
    }
  }
  if (coverageIndices.length) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(coveragePositions), 3),
    );
    geometry.setIndex(coverageIndices);
    const material = new THREE.MeshBasicMaterial({
      color: COVERAGE_COLOR,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.isBathymetryCoverage = true;
    mesh.renderOrder = 90;
    group.add(mesh);
  }

  const soundings = Array.isArray(payload?.soundings) ? payload.soundings : [];
  const soundingHits = [];
  const linePositions = [];
  const lineColors = [];
  const markerBatches = {
    actual: Object.fromEntries(
      HEALTH_ORDER.map(health => [health, { positions: [], colors: [] }]),
    ),
    sounding: Object.fromEntries(
      HEALTH_ORDER.map(health => [health, { positions: [], colors: [] }]),
    ),
  };
  for (const sounding of soundings) {
    const x = Number(sounding.x) + offsetX;
    const y = Number(sounding.y) + offsetY;
    const depth = Math.max(0, Number(sounding.depthM)) * exaggeration;
    if (![x, y, depth].every(Number.isFinite)) continue;
    const isActual = sounding.kind === 'actual';
    const health = soundingHealth(sounding.health);
    const color = soundingHealthColor(health);
    soundingHits.push({
      sounding,
      position: [x, y, 3 * exaggeration],
    });
    linePositions.push(x, y, 3 * exaggeration, x, y, -depth);
    lineColors.push(color.r, color.g, color.b, color.r, color.g, color.b);
    const batch = markerBatches[isActual ? 'actual' : 'sounding'][health];
    batch.positions.push(x, y, -depth);
    batch.colors.push(color.r, color.g, color.b);
  }
  if (linePositions.length) {
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute(
      'position', new THREE.BufferAttribute(new Float32Array(linePositions), 3),
    );
    lineGeometry.setAttribute(
      'color', new THREE.BufferAttribute(new Float32Array(lineColors), 3),
    );
    const lines = new THREE.LineSegments(
      lineGeometry,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        depthTest: true,
        depthWrite: false,
        toneMapped: false,
        blending: THREE.NormalBlending,
      }),
    );
    lines.userData.isBathymetrySoundings = true;
    lines.renderOrder = 91;
    group.add(lines);

    for (let index = 0; index < HEALTH_ORDER.length; index += 1) {
      const health = HEALTH_ORDER[index];
      const actual = markerBatches.actual[health];
      const sounding = markerBatches.sounding[health];
      addPointMarkers(group, actual.positions, actual.colors, {
        shape: 'circle',
        renderOrder: 92 + index * 2,
      });
      addPointMarkers(group, sounding.positions, sounding.colors, {
        shape: 'square',
        renderOrder: 93 + index * 2,
      });
    }
  }
  group.userData.bathymetrySoundingHits = soundingHits;
  return group;
}

function disposeGroup(group) {
  if (!group) return;
  group.traverse(child => {
    child.geometry?.dispose?.();
    child.material?.map?.dispose?.();
    child.material?.dispose?.();
  });
}

export function createTerrainBathymetryMapRuntime({
  terrainRoot,
  pipelineState,
  exaggeration = 1,
  rangeM = DEFAULT_RANGE_M,
  pollMs = DEFAULT_POLL_MS,
  moveRefreshM = DEFAULT_MOVE_REFRESH_M,
  fetchImpl = (...args) => fetch(...args),
  setIntervalImpl = (...args) => setInterval(...args),
  clearIntervalImpl = timer => clearInterval(timer),
  onChanged = () => {},
  requestRender = () => {},
  log = () => {},
}) {
  let active = false;
  let fetching = false;
  let group = null;
  let timer = null;
  let lastQueryX = null;
  let lastQueryY = null;
  let movementRefreshQueued = false;
  let counts = { coverage: 0, soundings: 0 };

  function replaceGroup(next) {
    if (group) {
      terrainRoot.remove(group);
      disposeGroup(group);
    }
    group = next;
    terrainRoot.add(group);
    onChanged();
    requestRender();
  }

  async function refresh() {
    if (
      !active || fetching || !pipelineState.ready
      || !pipelineState.frameOffsetReady
      || !Number.isFinite(pipelineState.cameraStereoX)
      || !Number.isFinite(pipelineState.cameraStereoY)
    ) return;
    fetching = true;
    const queryX = pipelineState.cameraStereoX;
    const queryY = pipelineState.cameraStereoY;
    lastQueryX = queryX;
    lastQueryY = queryY;
    const originX = pipelineState.originX;
    const originY = pipelineState.originY;
    const offsetX = pipelineState.frameOffsetX;
    const offsetY = pipelineState.frameOffsetY;
    try {
      const url = '/api/bathymetry-map'
        + `?sx=${queryX}&sy=${queryY}`
        + `&range=${rangeM}`
        + `&ox=${originX}&oy=${originY}`;
      const response = await fetchImpl(url);
      if (!response.ok) throw new Error(`http ${response.status}`);
      const payload = await response.json();
      counts = {
        coverage: Number(payload.coverageCount) || 0,
        soundings: Number(payload.soundingCount) || 0,
      };
      replaceGroup(buildBathymetryMapGroup(payload, {
        offsetX,
        offsetY,
        exaggeration,
        clipCircle: {
          x: queryX - originX,
          y: queryY - originY,
          radius: rangeM,
        },
      }));
      log('bathymetry-map', `coverage=${counts.coverage} soundings=${counts.soundings}`);
    } catch (error) {
      log('bathymetry-map', `overlay unavailable: ${error?.message ?? error}`);
    } finally {
      fetching = false;
      onChanged();
      if (movementRefreshQueued) {
        movementRefreshQueued = false;
        sync();
      }
    }
  }

  function sync() {
    if (
      !active
      || !Number.isFinite(pipelineState.cameraStereoX)
      || !Number.isFinite(pipelineState.cameraStereoY)
    ) return undefined;
    const distance = lastQueryX == null || lastQueryY == null
      ? Infinity
      : Math.hypot(
          pipelineState.cameraStereoX - lastQueryX,
          pipelineState.cameraStereoY - lastQueryY,
        );
    if (distance < Math.max(0, Number(moveRefreshM) || 0)) return undefined;
    if (fetching) {
      movementRefreshQueued = true;
      return undefined;
    }
    return refresh();
  }

  function setActive(value) {
    active = Boolean(value);
    if (active) {
      if (timer == null) timer = setIntervalImpl(refresh, pollMs);
      refresh();
    } else {
      if (timer != null) clearIntervalImpl(timer);
      timer = null;
      if (group) group.visible = false;
      onChanged();
      requestRender();
    }
    return active;
  }

  return {
    refresh,
    sync,
    setActive,
    toggle: () => setActive(!active),
    get active() { return active; },
    get counts() { return { ...counts }; },
    get group() { return group; },
  };
}
