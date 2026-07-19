import * as THREE from 'three';

export function collectTerrainDebugMeshes(root, target = []) {
  target.length = 0;
  root.traverse(object => {
    if (object.isMesh && object.userData?.tileId) target.push(object);
  });
  return target;
}

export function summarizeTerrainMesh(mesh) {
  const image = mesh.material?.map?.image;
  return {
    tileId: mesh.userData?.tileId ?? '?',
    hasTexture: Boolean(mesh.material?.map),
    textureSize: image != null ? `${image.width}x${image.height}` : '-',
    color: mesh.material?.color != null ? `#${mesh.material.color.getHexString()}` : '-',
    bbox: mesh.userData?.bbox,
  };
}

function disposeMaterial(material) {
  if (Array.isArray(material)) {
    for (const value of material) value?.dispose?.();
  } else {
    material?.dispose?.();
  }
}

export function createTerrainHoverOutlineController({ terrainRoot, onChanged = () => {} }) {
  let outline = null;
  let tileId = null;

  function clear() {
    if (outline == null) return false;
    terrainRoot.remove(outline);
    outline.geometry?.dispose?.();
    disposeMaterial(outline.material);
    outline = null;
    tileId = null;
    return true;
  }

  function show(mesh) {
    const nextTileId = mesh?.userData?.tileId ?? null;
    if (nextTileId != null && nextTileId === tileId && outline != null) return false;

    let changed = clear();
    if (mesh == null) {
      if (changed) onChanged();
      return changed;
    }

    const bbox = mesh.userData?.bbox;
    let bounds;
    if (Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite)) {
      bounds = bbox.map(Number);
    } else {
      const box = new THREE.Box3().setFromObject(mesh);
      if (box.isEmpty()) {
        if (changed) onChanged();
        return changed;
      }
      bounds = [box.min.x, box.min.y, box.max.x, box.max.y];
    }

    const [xMin, yMin, xMax, yMax] = bounds;
    const points = [
      new THREE.Vector3(xMin, yMin, 50), new THREE.Vector3(xMax, yMin, 50),
      new THREE.Vector3(xMax, yMax, 50), new THREE.Vector3(xMin, yMax, 50),
      new THREE.Vector3(xMin, yMin, 50),
    ];
    outline = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: 0xff0000, depthTest: false }),
    );
    outline.renderOrder = 999;
    terrainRoot.add(outline);
    tileId = nextTileId;
    changed = true;
    onChanged();
    return changed;
  }

  return { show, clear, get outline() { return outline; }, get tileId() { return tileId; } };
}

const SEAM_COLORS = Object.freeze({
  healthy: 0x64748b,
  warning: 0xf59e0b,
  bad: 0xff1744,
  unknown: 0x94a3b8,
});

function tileDepth(tileId) {
  const depth = Number.parseInt(String(tileId).split('-', 1)[0], 10);
  return Number.isInteger(depth) ? depth : null;
}

function gridResolution(mesh) {
  const explicit = Number(mesh?.userData?.resolution);
  if (Number.isInteger(explicit) && explicit > 1) return explicit;
  const vertexCount = mesh?.geometry?.getAttribute?.('position')?.count;
  if (!Number.isInteger(vertexCount)) return null;
  // Terrain meshes contain r*r surface vertices plus 8*r skirt vertices.
  const inferred = Math.round(Math.sqrt(vertexCount + 16) - 4);
  return inferred * inferred + 8 * inferred === vertexCount ? inferred : null;
}

function edgeSampler(mesh, side) {
  const position = mesh?.geometry?.getAttribute?.('position');
  const normal = mesh?.geometry?.getAttribute?.('normal');
  const resolution = gridResolution(mesh);
  if (!position || !resolution) return null;
  const indexAt = (along, component) => {
    const sample = Math.min(resolution - 1, Math.max(0, along));
    const low = Math.floor(sample);
    const high = Math.ceil(sample);
    const vertexIndex = edgeIndex(side, low, resolution);
    const nextVertexIndex = edgeIndex(side, high, resolution);
    const amount = sample - low;
    const attribute = component === 'z' ? position : normal;
    if (!attribute) return null;
    if (component === 'z') {
      return attribute.getZ(vertexIndex) * (1 - amount) + attribute.getZ(nextVertexIndex) * amount;
    }
    const a = new THREE.Vector3(
      attribute.getX(vertexIndex), attribute.getY(vertexIndex), attribute.getZ(vertexIndex),
    );
    const b = new THREE.Vector3(
      attribute.getX(nextVertexIndex), attribute.getY(nextVertexIndex), attribute.getZ(nextVertexIndex),
    );
    return a.lerp(b, amount).normalize();
  };
  return (amount, component) => indexAt(amount * (resolution - 1), component);
}

function edgeIndex(side, along, resolution) {
  if (side === 'west') return along * resolution;
  if (side === 'east') return along * resolution + resolution - 1;
  if (side === 'south') return along;
  return (resolution - 1) * resolution + along;
}

function samplePosition(bbox, side, x, y) {
  if (side === 'west' || side === 'east') return (y - bbox[1]) / (bbox[3] - bbox[1]);
  return (x - bbox[0]) / (bbox[2] - bbox[0]);
}

function sharedBoundary(a, b, tolerance) {
  const [ax0, ay0, ax1, ay1] = a.bbox;
  const [bx0, by0, bx1, by1] = b.bbox;
  const vertical = (x, aSide, bSide) => {
    const start = Math.max(ay0, by0), end = Math.min(ay1, by1);
    return end - start > tolerance ? { aSide, bSide, start: [x, start], end: [x, end] } : null;
  };
  const horizontal = (y, aSide, bSide) => {
    const start = Math.max(ax0, bx0), end = Math.min(ax1, bx1);
    return end - start > tolerance ? { aSide, bSide, start: [start, y], end: [end, y] } : null;
  };
  if (Math.abs(ax1 - bx0) <= tolerance) return vertical((ax1 + bx0) / 2, 'east', 'west');
  if (Math.abs(ax0 - bx1) <= tolerance) return vertical((ax0 + bx1) / 2, 'west', 'east');
  if (Math.abs(ay1 - by0) <= tolerance) return horizontal((ay1 + by0) / 2, 'north', 'south');
  if (Math.abs(ay0 - by1) <= tolerance) return horizontal((ay0 + by1) / 2, 'south', 'north');
  return null;
}

function measureBoundary(a, b, boundary) {
  const sampleA = edgeSampler(a.mesh, boundary.aSide);
  const sampleB = edgeSampler(b.mesh, boundary.bSide);
  if (!sampleA || !sampleB) return { maxHeightGap: null, maxNormalAngle: null };
  let maxHeightGap = 0, maxNormalAngle = 0;
  for (let index = 0; index <= 32; index += 1) {
    const amount = index / 32;
    const x = boundary.start[0] + (boundary.end[0] - boundary.start[0]) * amount;
    const y = boundary.start[1] + (boundary.end[1] - boundary.start[1]) * amount;
    const amountA = samplePosition(a.bbox, boundary.aSide, x, y);
    const amountB = samplePosition(b.bbox, boundary.bSide, x, y);
    const zA = sampleA(amountA, 'z'), zB = sampleB(amountB, 'z');
    maxHeightGap = Math.max(maxHeightGap, Math.abs(zA - zB));
    const normalA = sampleA(amountA, 'normal'), normalB = sampleB(amountB, 'normal');
    if (normalA && normalB) {
      const angle = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(normalA.dot(normalB), -1, 1)));
      maxNormalAngle = Math.max(maxNormalAngle, angle);
    }
  }
  return { maxHeightGap, maxNormalAngle };
}

function seamSeverity(maxHeightGap, maxNormalAngle) {
  if (maxHeightGap == null) return 'unknown';
  if (maxHeightGap > 1 || maxNormalAngle > 20) return 'bad';
  if (maxHeightGap > 0.05 || maxNormalAngle > 5) return 'warning';
  return 'healthy';
}

export function analyzeTerrainSeams(meshes) {
  const entries = meshes.map(mesh => ({
    mesh,
    tileId: mesh.userData?.tileId,
    bbox: mesh.userData?.bbox?.map(Number),
  })).filter(entry => entry.tileId && entry.bbox?.length === 4 && entry.bbox.every(Number.isFinite));
  const scale = entries.reduce((largest, entry) => Math.max(
    largest, entry.bbox[2] - entry.bbox[0], entry.bbox[3] - entry.bbox[1],
  ), 1);
  const tolerance = scale * 1e-7;
  const seams = [];
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const a = entries[left], b = entries[right];
      const boundary = sharedBoundary(a, b, tolerance);
      if (!boundary) continue;
      const measurements = measureBoundary(a, b, boundary);
      const depthA = tileDepth(a.tileId), depthB = tileDepth(b.tileId);
      const severity = seamSeverity(measurements.maxHeightGap, measurements.maxNormalAngle);
      seams.push({
        ...boundary, ...measurements, severity,
        tileA: a.tileId, tileB: b.tileId,
        depthDelta: depthA == null || depthB == null ? null : Math.abs(depthA - depthB),
        color: SEAM_COLORS[severity],
      });
    }
  }
  return seams;
}

export function formatTerrainSeamDiagnostic(seam) {
  const gap = seam.maxHeightGap == null ? 'not measured' : `${seam.maxHeightGap.toFixed(2)}m gap`;
  const normals = seam.maxNormalAngle == null ? '' : ` · ${seam.maxNormalAngle.toFixed(1)}° normals`;
  const lod = seam.depthDelta > 0 ? ` · cross-LOD Δ${seam.depthDelta}` : ' · same LOD';
  return `${seam.aSide} ↔ ${seam.bSide}: ${seam.tileB} · ${gap}${normals}${lod}`;
}

export function createTerrainMapGridController({
  terrainRoot,
  renderOrder = 996,
} = {}) {
  // Color encodes measured seam health, never tile identity or LOD.
  const material = new THREE.LineBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  let lines = null;
  let lastKey = '';
  let visible = false;
  let diagnostics = [];

  function clear() {
    if (!lines) return;
    terrainRoot.remove(lines);
    lines.geometry?.dispose?.();
    lines = null;
  }

  function update(meshes) {
    const entries = meshes
      .map(mesh => ({ tileId: mesh.userData?.tileId, bbox: mesh.userData?.bbox }))
      .filter(entry => (
        entry.tileId && Array.isArray(entry.bbox) && entry.bbox.length === 4 &&
        entry.bbox.every(Number.isFinite)
      ))
      .sort((a, b) => String(a.tileId).localeCompare(String(b.tileId)));
    const key = entries.map(entry => `${entry.tileId}:${entry.bbox.join(',')}`).join('|');
    if (key === lastKey) return false;
    lastKey = key;
    clear();
    if (entries.length === 0) {
      diagnostics = [];
      return true;
    }

    diagnostics = analyzeTerrainSeams(meshes);
    const positions = new Float32Array(diagnostics.length * 2 * 3);
    const colors = new Float32Array(diagnostics.length * 2 * 3);
    let offset = 0;
    for (const seam of diagnostics) {
      const segment = [...seam.start, 60, ...seam.end, 60];
      positions.set(segment, offset);
      const edgeColor = new THREE.Color(seam.color);
      for (let index = 0; index < 2; index += 1) {
        colors.set([edgeColor.r, edgeColor.g, edgeColor.b], offset + index * 3);
      }
      offset += segment.length;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    lines = new THREE.LineSegments(geometry, material);
    lines.visible = visible;
    lines.renderOrder = renderOrder;
    lines.frustumCulled = false;
    terrainRoot.add(lines);
    return true;
  }

  function setVisible(next) {
    visible = Boolean(next);
    if (lines) lines.visible = visible;
  }

  function dispose() {
    clear();
    material.dispose();
  }

  function diagnosticsForTile(tileId) {
    return diagnostics
      .filter(seam => seam.tileA === tileId || seam.tileB === tileId)
      .map(seam => seam.tileA === tileId ? seam : {
        ...seam,
        tileA: seam.tileB, tileB: seam.tileA,
        aSide: seam.bSide, bSide: seam.aSide,
      })
      .sort((a, b) => ['bad', 'warning', 'unknown', 'healthy'].indexOf(a.severity)
        - ['bad', 'warning', 'unknown', 'healthy'].indexOf(b.severity));
  }

  return { diagnosticsForTile, dispose, setVisible, update, get diagnostics() { return diagnostics; }, get lines() { return lines; } };
}
