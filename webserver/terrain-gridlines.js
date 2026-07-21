import * as THREE from 'three';

export const GRIDLINES_COLOR = 0x14e6ff;

function appendEdge(positions, attribute, resolution, indexAt, matrix, halfWidth) {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  for (let index = 0; index < resolution - 1; index += 1) {
    const first = indexAt(index);
    const second = indexAt(index + 1);
    a.fromBufferAttribute(attribute, first).applyMatrix4(matrix);
    b.fromBufferAttribute(attribute, second).applyMatrix4(matrix);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length <= 1e-9) continue;
    const offsetX = -dy / length * halfWidth;
    const offsetY = dx / length * halfWidth;
    const az = a.z + 0.5;
    const bz = b.z + 0.5;
    positions.push(
      a.x + offsetX, a.y + offsetY, az,
      a.x - offsetX, a.y - offsetY, az,
      b.x + offsetX, b.y + offsetY, bz,
      b.x + offsetX, b.y + offsetY, bz,
      a.x - offsetX, a.y - offsetY, az,
      b.x - offsetX, b.y - offsetY, bz,
    );
  }
}

export function createTerrainGridlinesController({
  terrainRoot,
  renderOrder = 997,
  width = 12,
} = {}) {
  const material = new THREE.MeshBasicMaterial({
    color: GRIDLINES_COLOR,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
  const halfWidth = Math.max(0.1, Number(width) / 2);
  let lines = null;
  let lastKey = '';
  let visible = false;

  function clear() {
    if (!lines) return;
    terrainRoot.remove(lines);
    lines.geometry.dispose();
    lines = null;
  }

  function update() {
    const meshes = terrainRoot.children.filter(mesh => (
      mesh.isMesh
      && mesh.userData?.tileId
      && Number.isInteger(mesh.userData?.resolution)
      && mesh.geometry?.getAttribute?.('position')
    ));
    const key = meshes
      .map(mesh => `${mesh.userData.tileId}:${mesh.geometry.uuid}:${mesh.geometry.version ?? 0}`)
      .sort()
      .join('|');
    if (key === lastKey) return false;
    lastKey = key;
    clear();
    if (meshes.length === 0) return true;

    const positions = [];
    for (const mesh of meshes) {
      const attribute = mesh.geometry.getAttribute('position');
      const resolution = mesh.userData.resolution;
      mesh.updateMatrix();
      appendEdge(positions, attribute, resolution, index => index, mesh.matrix, halfWidth);
      appendEdge(
        positions, attribute, resolution,
        index => (resolution - 1) * resolution + index,
        mesh.matrix, halfWidth,
      );
      appendEdge(
        positions, attribute, resolution,
        index => index * resolution,
        mesh.matrix, halfWidth,
      );
      appendEdge(
        positions, attribute, resolution,
        index => index * resolution + resolution - 1,
        mesh.matrix, halfWidth,
      );
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    lines = new THREE.Mesh(geometry, material);
    lines.visible = visible;
    lines.renderOrder = renderOrder;
    lines.frustumCulled = false;
    terrainRoot.add(lines);
    return true;
  }

  function setVisible(next) {
    visible = Boolean(next);
    if (visible) update();
    if (lines) lines.visible = visible;
  }

  function dispose() {
    clear();
    material.dispose();
  }

  return { dispose, setVisible, update, get lines() { return lines; } };
}
