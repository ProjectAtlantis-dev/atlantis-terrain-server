import { scoreTextureTiles } from './terrain-tile-runtime.js';

export function createTerrainTextureController({
  terrainRoot, deferredTiles, textureStreamer, meshRuntime, lifecycle,
  priorityForTile, getVisibilityDistance, isCovered, applyMaterial,
  getWaterMask, isMaterialOverlayActive = () => false, log,
  onMaterialApplied = () => {},
  scheduleFrame = callback => requestAnimationFrame(callback),
  applicationsPerFrame = 4,
}) {
  const findMesh = tileId => terrainRoot.children.find(child => child.userData.tileId === tileId);
  const pendingApplications = new Map();
  let applicationFramePending = false;
  let desiredTileIds = new Set();

  function applyTexture(mesh, tile, texture) {
    const rebuilt = meshRuntime.rebuildWithTexture(mesh, tile, texture);
    applyMaterial(rebuilt, texture);
    rebuilt.userData.waterMask = getWaterMask(tile.id) || null;
    onMaterialApplied(rebuilt);
    return rebuilt;
  }

  function drainApplications() {
    applicationFramePending = false;
    let remaining = applicationsPerFrame;
    for (const [tileId, pending] of pendingApplications) {
      if (remaining-- <= 0) break;
      pendingApplications.delete(tileId);
      const { tile, texture, logArrival } = pending;
      if (!desiredTileIds.has(tileId)) {
        if (textureStreamer.texCache.get(tileId) === texture) textureStreamer.texCache.delete(tileId);
        textureStreamer.texSource.delete(tileId);
        texture.dispose?.();
        continue;
      }
      if (deferredTiles.has(tileId)) {
        if (logArrival) log(tileId, 'cached + materialize (was deferred)');
        meshRuntime.materialize(tileId, texture);
      } else {
        const mesh = findMesh(tileId);
        if (mesh) {
          if (logArrival) log(tileId, 'cached + applied to existing mesh');
          applyTexture(mesh, tile, texture);
        } else if (logArrival) {
          log(tileId, 'cached but NO mesh in scene');
        }
      }
      lifecycle.evictCoveredAncestors(tileId);
    }
    if (pendingApplications.size > 0) scheduleApplicationFrame();
  }

  function scheduleApplicationFrame() {
    if (applicationFramePending) return;
    applicationFramePending = true;
    scheduleFrame(drainApplications);
  }

  function enqueueApplication(tile, texture, logArrival = false) {
    if (!desiredTileIds.has(tile.id)) {
      if (textureStreamer.texCache.get(tile.id) === texture) textureStreamer.texCache.delete(tile.id);
      textureStreamer.texSource.delete(tile.id);
      texture.dispose?.();
      return;
    }
    pendingApplications.set(tile.id, { tile, texture, logArrival });
    scheduleApplicationFrame();
  }

  function updateTerrainTextures(tiles) {
    const meshById = new Map();
    for (const child of terrainRoot.children) {
      if (child.userData.tileId) meshById.set(child.userData.tileId, child);
    }
    const { tileIds, scored } = scoreTextureTiles(
      tiles, priorityForTile, Math.log(getVisibilityDistance()),
    );
    desiredTileIds = new Set(scored.map(item => item.tile.id));

    for (const id of [...deferredTiles.keys()]) {
      const texture = textureStreamer.texCache.get(id);
      if (!texture || pendingApplications.has(id)) continue;
      const tile = deferredTiles.get(id);
      if (tile) enqueueApplication(tile, texture);
    }

    for (const tile of tiles) {
      if (!tile.id) continue;
      const texture = textureStreamer.texCache.get(tile.id);
      if (!texture) continue;
      textureStreamer.requestWaterMask(tile.id);
      if (deferredTiles.has(tile.id) || pendingApplications.has(tile.id)) continue;
      const mesh = meshById.get(tile.id);
      if (!mesh) continue;
      if (!isMaterialOverlayActive() && mesh.material.map !== texture) {
        log(tile.id, `apply cached tex (src=${textureStreamer.texSource.get(tile.id) || '?'})`);
      }
      meshById.set(tile.id, applyTexture(mesh, tile, texture));
    }

    textureStreamer.pump(scored, {
      isCovered,
      onPlaceholder: ({ tileId, texture }) => {
        const mesh = findMesh(tileId);
        if (!mesh) return;
        applyMaterial(mesh, texture);
        onMaterialApplied(mesh);
      },
      onTexture: ({ tileId, tile, texture }) => {
        enqueueApplication(tile, texture, true);
      },
    });
    lifecycle.sweepStaleParents(tiles, tileIds);
  }

  updateTerrainTextures.reset = () => {
    desiredTileIds.clear();
    for (const { texture } of pendingApplications.values()) texture.dispose?.();
    pendingApplications.clear();
    applicationFramePending = false;
  };
  return updateTerrainTextures;
}
