import { findCoveredTileAncestors } from './tile-coverage.js';

function parseTileId(tileId) {
  const match = /^(\d+)-(\d+)-(\d+)$/.exec(tileId || '');
  return match ? { depth: Number(match[1]), col: Number(match[2]), row: Number(match[3]) } : null;
}

export function createTileLifecycle({ terrainRoot, disposeScatter, log, onSceneMutated = () => {} }) {
  function evict(mesh) {
    if (!mesh) return;
    terrainRoot.remove(mesh);
    disposeScatter(mesh);
    mesh.geometry?.dispose();
    if (Array.isArray(mesh.material)) {
      for (const material of mesh.material) material?.dispose?.();
    } else {
      mesh.material?.dispose?.();
    }
    onSceneMutated();
  }

  function evictCoveredAncestors(childTileId) {
    const resident = new Map();
    for (const mesh of terrainRoot.children) {
      if (!mesh.isMesh || !mesh.userData.tileId) continue;
      resident.set(mesh.userData.tileId, Boolean(mesh.material?.map));
    }
    for (const ancestorId of findCoveredTileAncestors(childTileId, resident)) {
      const mesh = terrainRoot.children.find(
        child => child.isMesh && child.userData.tileId === ancestorId,
      );
      if (!mesh) continue;
      log(ancestorId, `evicted — eager complete descendant coverage (triggered by ${childTileId})`);
      evict(mesh);
    }
  }

  function replaceForMaterialized(mesh, currentTileIds) {
    const tileId = mesh.userData.tileId;
    const bbox = mesh.userData.bbox;
    for (const existing of [...terrainRoot.children]) {
      if (!existing.isMesh) continue;
      const existingId = existing.userData.tileId;
      let reason = null;
      if (existingId === tileId) {
        reason = 'replaced by textured self';
      } else if (bbox && !currentTileIds.has(existingId)) {
        const existingBox = existing.userData.bbox;
        if (existingBox && bbox[0] <= existingBox[0] && bbox[2] >= existingBox[2]
            && bbox[1] <= existingBox[1] && bbox[3] >= existingBox[3]) {
          reason = `contained by ${tileId}`;
        }
      }
      if (!reason) continue;
      log(existingId || '?', `evicted — ${reason}`);
      evict(existing);
    }
    terrainRoot.add(mesh);
    onSceneMutated();
  }

  function sweepStaleParents(tiles, currentTileIds) {
    const meshById = new Map();
    const covered = new Set();
    let maxDepth = 0;
    for (const mesh of terrainRoot.children) {
      if (!mesh.isMesh || !mesh.userData.tileId) continue;
      const id = mesh.userData.tileId;
      meshById.set(id, mesh);
      const address = parseTileId(id);
      if (address) maxDepth = Math.max(maxDepth, address.depth);
      if (mesh.material?.map) covered.add(id);
    }

    // Collapse complete textured quadrants bottom-up once. The previous code
    // rebuilt and recursively searched the full resident map for every current
    // child, which blocked the browser for hundreds of milliseconds on a
    // 1,500-mesh scene.
    const descendantCovered = new Set();
    for (let depth = maxDepth; depth > 0; depth--) {
      const quadrantsByParent = new Map();
      for (const id of covered) {
        const address = parseTileId(id);
        if (!address || address.depth !== depth) continue;
        const parentId = `${depth - 1}-${Math.floor(address.col / 2)}-${Math.floor(address.row / 2)}`;
        const quadrant = (address.col & 1) * 2 + (address.row & 1);
        let quadrants = quadrantsByParent.get(parentId);
        if (!quadrants) quadrantsByParent.set(parentId, quadrants = new Set());
        quadrants.add(quadrant);
      }
      for (const [parentId, quadrants] of quadrantsByParent) {
        if (quadrants.size !== 4) continue;
        descendantCovered.add(parentId);
        covered.add(parentId);
      }
    }

    const staleIds = new Set();
    for (const parentId of descendantCovered) {
      if (meshById.has(parentId) && !currentTileIds.has(parentId)) staleIds.add(parentId);
    }
    for (const parentId of staleIds) {
      const parent = meshById.get(parentId);
      if (!parent) continue;
      const reason = parent.material?.map
        ? 'evicted — stale parent (children now textured)'
        : 'evicted — stale noTex parent (children now textured)';
      log(parentId, reason);
      evict(parent);
    }
    return staleIds.size;
  }

  return { evict, evictCoveredAncestors, replaceForMaterialized, sweepStaleParents };
}
