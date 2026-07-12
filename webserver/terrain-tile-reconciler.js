import { diffTerrainTileIds, prioritizeTerrainBuildCandidates } from './terrain-tile-fetch.js';

const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

function applyDepthOffset(mesh, tileId) {
  const depth = Number.parseInt(tileId.split('-')[0], 10);
  mesh.material.polygonOffset = true;
  mesh.material.polygonOffsetFactor = -depth;
  mesh.material.polygonOffsetUnits = -depth;
}

export function reconcileTerrainTiles({
  tiles,
  currentTileIds,
  deferredTiles,
  terrainRoot,
  lifecycle,
  priorityForTile,
  textureCache,
  materialize,
  buildMesh,
  log,
  buildBudget = 200,
  prepareUntexturedMesh = () => {},
  onMeshAdded = () => {},
  onDiff = () => {},
}) {
  const { nextTileIds, added, removed } = diffTerrainTileIds(tiles, currentTileIds);
  let purged = 0;
  for (const id of deferredTiles.keys()) {
    if (!nextTileIds.has(id)) {
      deferredTiles.delete(id);
      purged += 1;
    }
  }

  const staleRemoved = lifecycle.sweepStaleParents(tiles, nextTileIds);
  for (const mesh of terrainRoot.children) {
    const tileId = mesh.userData?.tileId;
    if (!mesh.isMesh || !tileId) continue;
    if (nextTileIds.has(tileId) && mesh.material?.map && !mesh.material.polygonOffset) {
      applyDepthOffset(mesh, tileId);
      mesh.material.needsUpdate = true;
    }
  }
  onDiff({
    added: added.length,
    removed: removed.length,
    purgedDeferred: purged,
    sceneMeshes: terrainRoot.children.filter(mesh => mesh.isMesh).length,
  });

  if (added.length > 0) {
    const existingIds = new Set(
      terrainRoot.children.map(mesh => mesh.userData?.tileId).filter(Boolean),
    );
    const candidates = prioritizeTerrainBuildCandidates(tiles, new Set(added), priorityForTile);
    let built = 0;
    for (const { tile } of candidates) {
      if (existingIds.has(tile.id)) continue;
      const cachedTexture = textureCache.get(tile.id);
      if (cachedTexture) {
        deferredTiles.set(tile.id, tile);
        if (built < buildBudget) {
          log(tile.id, 'added — immediate build (cached tex)');
          materialize(tile.id, cachedTexture);
          built += 1;
        } else {
          log(tile.id, `added — deferred (build budget exceeded, built=${built}/${buildBudget})`);
        }
        continue;
      }

      deferredTiles.set(tile.id, tile);
      const hasStaleCoverage = terrainRoot.children.some(mesh => (
        mesh.isMesh && mesh.material?.map && mesh.userData?.bbox && overlaps(mesh.userData.bbox, tile.bbox)
      ));
      if (hasStaleCoverage) {
        log(tile.id, 'added — deferred (stale coverage exists)');
      } else if (built < buildBudget) {
        log(tile.id, 'added — untextured fallback (no stale coverage)');
        const mesh = buildMesh(tile);
        if (mesh) {
          applyDepthOffset(mesh, tile.id);
          prepareUntexturedMesh(mesh);
          terrainRoot.add(mesh);
          onMeshAdded(mesh);
        }
        built += 1;
      }
    }
  }

  return {
    nextTileIds,
    added,
    removed,
    purged,
    staleRemoved,
    sceneMeshes: terrainRoot.children.filter(mesh => mesh.isMesh).length,
    deferred: deferredTiles.size,
  };
}
