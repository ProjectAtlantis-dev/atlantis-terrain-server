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

function clearGroup(group) {
  while (group.children.length) {
    const child = group.children[0];
    group.remove(child);
    child.geometry?.dispose?.();
    child.material?.dispose?.();
  }
}

function rebuildOutlines(group, tileIds, meshById, color, renderOrder) {
  clearGroup(group);
  for (const tileId of tileIds) {
    const bbox = meshById.get(tileId)?.userData?.bbox;
    if (!Array.isArray(bbox) || bbox.length !== 4) continue;
    const [xMin, yMin, xMax, yMax] = bbox;
    const points = [
      new THREE.Vector3(xMin, yMin, 50), new THREE.Vector3(xMax, yMin, 50),
      new THREE.Vector3(xMax, yMax, 50), new THREE.Vector3(xMin, yMax, 50),
      new THREE.Vector3(xMin, yMin, 50),
    ];
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color, depthTest: false }),
    );
    line.renderOrder = renderOrder;
    group.add(line);
  }
}

export function createTerrainOutlineController({
  terrainRoot, pendingGroup, enhancedGroup, pending, inflight, textureSource,
}) {
  let lastPendingKey = '';
  let lastEnhancedKey = '';

  function meshIndex() {
    return new Map(
      terrainRoot.children
        .filter(child => child.userData?.tileId)
        .map(child => [child.userData.tileId, child]),
    );
  }

  function updatePending() {
    const tileIds = [...new Set([...pending.keys(), ...inflight.keys()])].sort();
    const key = tileIds.join(',');
    if (key === lastPendingKey) return false;
    lastPendingKey = key;
    rebuildOutlines(pendingGroup, tileIds, meshIndex(), 0xff88cc, 998);
    return true;
  }

  function updateEnhanced() {
    const tileIds = [...textureSource]
      .filter(([, source]) => source.includes('enhanced') || source === 'upscaled')
      .map(([tileId]) => tileId)
      .sort();
    const key = tileIds.join(',');
    if (key === lastEnhancedKey) return false;
    lastEnhancedKey = key;
    rebuildOutlines(enhancedGroup, tileIds, meshIndex(), 0x44aaff, 997);
    return true;
  }

  return { updatePending, updateEnhanced };
}
