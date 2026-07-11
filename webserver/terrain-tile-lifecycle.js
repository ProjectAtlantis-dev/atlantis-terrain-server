import { findCoveredTileAncestors } from './tile-coverage.js';

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
    const resident = new Map();
    for (const mesh of terrainRoot.children) {
      if (!mesh.isMesh || !mesh.userData.tileId) continue;
      meshById.set(mesh.userData.tileId, mesh);
      resident.set(mesh.userData.tileId, Boolean(mesh.material?.map));
    }
    const staleIds = new Set();
    for (const childId of currentTileIds) {
      if (resident.get(childId) !== true) continue;
      for (const ancestorId of findCoveredTileAncestors(childId, resident)) {
        if (!currentTileIds.has(ancestorId)) staleIds.add(ancestorId);
      }
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
