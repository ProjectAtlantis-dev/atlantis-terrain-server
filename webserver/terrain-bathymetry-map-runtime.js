import * as THREE from 'three';

const DEFAULT_RANGE_M = 50000;
const DEFAULT_POLL_MS = 5000;

const COVERAGE_COLOR = 0x00d8ff;
const ACTUAL_COLOR = new THREE.Color(0xfff06a);
const LOWER_BOUND_COLOR = new THREE.Color(0xff8a3d);

export function buildBathymetryMapGroup(payload, {
  offsetX = 0,
  offsetY = 0,
  exaggeration = 1,
} = {}) {
  const group = new THREE.Group();
  group.userData.isBathymetryMap = true;

  const coverage = Array.isArray(payload?.coverage) ? payload.coverage : [];
  const coveragePositions = [];
  const coverageIndices = [];
  for (const item of coverage) {
    if (!Array.isArray(item.bbox) || item.bbox.length !== 4) continue;
    const [x0, y0, x1, y1] = item.bbox;
    const start = coveragePositions.length / 3;
    const z = 2 * exaggeration;
    coveragePositions.push(
      x0 + offsetX, y0 + offsetY, z,
      x1 + offsetX, y0 + offsetY, z,
      x1 + offsetX, y1 + offsetY, z,
      x0 + offsetX, y1 + offsetY, z,
    );
    coverageIndices.push(start, start + 1, start + 2, start, start + 2, start + 3);
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
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.isBathymetryCoverage = true;
    mesh.renderOrder = 90;
    group.add(mesh);
  }

  const soundings = Array.isArray(payload?.soundings) ? payload.soundings : [];
  const linePositions = [];
  const lineColors = [];
  const pointPositions = [];
  const pointColors = [];
  for (const sounding of soundings) {
    const x = Number(sounding.x) + offsetX;
    const y = Number(sounding.y) + offsetY;
    const depth = Math.max(0, Number(sounding.depthM)) * exaggeration;
    if (![x, y, depth].every(Number.isFinite)) continue;
    const color = sounding.kind === 'actual' ? ACTUAL_COLOR : LOWER_BOUND_COLOR;
    linePositions.push(x, y, 3 * exaggeration, x, y, -depth);
    lineColors.push(color.r, color.g, color.b, color.r, color.g, color.b);
    pointPositions.push(x, y, -depth);
    pointColors.push(color.r, color.g, color.b);
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
        vertexColors: true, transparent: true, opacity: 0.9, depthTest: false,
      }),
    );
    lines.userData.isBathymetrySoundings = true;
    lines.renderOrder = 91;
    group.add(lines);

    const pointGeometry = new THREE.BufferGeometry();
    pointGeometry.setAttribute(
      'position', new THREE.BufferAttribute(new Float32Array(pointPositions), 3),
    );
    pointGeometry.setAttribute(
      'color', new THREE.BufferAttribute(new Float32Array(pointColors), 3),
    );
    const points = new THREE.Points(
      pointGeometry,
      new THREE.PointsMaterial({
        size: 8,
        sizeAttenuation: false,
        vertexColors: true,
        depthTest: false,
      }),
    );
    points.userData.isBathymetrySoundings = true;
    points.renderOrder = 92;
    group.add(points);
  }
  return group;
}

function disposeGroup(group) {
  if (!group) return;
  group.traverse(child => {
    child.geometry?.dispose?.();
    child.material?.dispose?.();
  });
}

export function createTerrainBathymetryMapRuntime({
  terrainRoot,
  pipelineState,
  exaggeration = 1,
  rangeM = DEFAULT_RANGE_M,
  pollMs = DEFAULT_POLL_MS,
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
      || !Number.isFinite(pipelineState.lastFetchX)
      || !Number.isFinite(pipelineState.lastFetchY)
    ) return;
    fetching = true;
    try {
      const url = '/api/bathymetry-map'
        + `?sx=${pipelineState.lastFetchX}&sy=${pipelineState.lastFetchY}`
        + `&range=${rangeM}`
        + `&ox=${pipelineState.originX}&oy=${pipelineState.originY}`;
      const response = await fetchImpl(url);
      if (!response.ok) throw new Error(`http ${response.status}`);
      const payload = await response.json();
      counts = {
        coverage: Number(payload.coverageCount) || 0,
        soundings: Number(payload.soundingCount) || 0,
      };
      replaceGroup(buildBathymetryMapGroup(payload, {
        offsetX: pipelineState.frameOffsetX,
        offsetY: pipelineState.frameOffsetY,
        exaggeration,
      }));
      log('bathymetry-map', `coverage=${counts.coverage} soundings=${counts.soundings}`);
    } catch (error) {
      log('bathymetry-map', `overlay unavailable: ${error?.message ?? error}`);
    } finally {
      fetching = false;
      onChanged();
    }
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
    setActive,
    toggle: () => setActive(!active),
    get active() { return active; },
    get counts() { return { ...counts }; },
    get group() { return group; },
  };
}
