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

export function createTerrainMapGridController({
  terrainRoot,
  color = 0x9aa2aa,
  renderOrder = 996,
} = {}) {
  const material = new THREE.LineBasicMaterial({ color, depthTest: false });
  let lines = null;
  let lastKey = '';
  let visible = false;

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
    if (entries.length === 0) return true;

    const positions = new Float32Array(entries.length * 8 * 3);
    let offset = 0;
    for (const { bbox: [xMin, yMin, xMax, yMax] } of entries) {
      const corners = [
        xMin, yMin, 50, xMax, yMin, 50,
        xMax, yMin, 50, xMax, yMax, 50,
        xMax, yMax, 50, xMin, yMax, 50,
        xMin, yMax, 50, xMin, yMin, 50,
      ];
      positions.set(corners, offset);
      offset += corners.length;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
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

  return { dispose, setVisible, update, get lines() { return lines; } };
}
