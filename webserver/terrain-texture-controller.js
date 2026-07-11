import { scoreTextureTiles } from './terrain-tile-runtime.js';

export function createTerrainTextureController({
  terrainRoot, deferredTiles, textureStreamer, meshRuntime, lifecycle,
  priorityForTile, getVisibilityDistance, isCovered, applyMaterial,
  getWaterMask, isMaterialOverlayActive = () => false, log,
  onMaterialApplied = () => {},
}) {
  const findMesh = tileId => terrainRoot.children.find(child => child.userData.tileId === tileId);

  function applyTexture(mesh, tile, texture) {
    const rebuilt = meshRuntime.rebuildWithTexture(mesh, tile, texture);
    applyMaterial(rebuilt, texture);
    rebuilt.userData.waterMask = getWaterMask(tile.id) || null;
    onMaterialApplied(rebuilt);
    return rebuilt;
  }

  return function updateTerrainTextures(tiles) {
    const meshById = new Map();
    for (const child of terrainRoot.children) {
      if (child.userData.tileId) meshById.set(child.userData.tileId, child);
    }
    const { tileIds, scored } = scoreTextureTiles(
      tiles, priorityForTile, Math.log(getVisibilityDistance()),
    );

    for (const id of [...deferredTiles.keys()]) {
      const texture = textureStreamer.texCache.get(id);
      if (texture) meshRuntime.materialize(id, texture);
    }

    for (const tile of tiles) {
      if (!tile.id) continue;
      const texture = textureStreamer.texCache.get(tile.id);
      if (!texture) continue;
      textureStreamer.requestWaterMask(tile.id);
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
        if (deferredTiles.has(tileId)) {
          log(tileId, 'cached + materialize (was deferred)');
          meshRuntime.materialize(tileId, texture);
        } else {
          const mesh = findMesh(tileId);
          if (mesh) {
            log(tileId, 'cached + applied to existing mesh');
            applyTexture(mesh, tile, texture);
          } else {
            log(tileId, 'cached but NO mesh in scene');
          }
        }
        lifecycle.evictCoveredAncestors(tileId);
      },
    });
    lifecycle.sweepStaleParents(tiles, tileIds);
  };
}
