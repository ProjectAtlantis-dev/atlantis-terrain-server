export function buildTerrainTilesRequest({
  lat,
  lon,
  altitude,
  heading,
  range,
  pass,
  previewMaxDepth,
  isFirstLoad,
  frameOffsetReady,
  originX,
  originY,
  cameraSnapshot = {},
}) {
  const preview = pass === 1;
  let url = `/api/tiles?lat=${lat}&lon=${lon}&alt=${altitude}&heading=${heading}&range=${range}`;
  if (preview) url += `&maxDepth=${previewMaxDepth}`;
  if (!isFirstLoad || frameOffsetReady) url += `&ox=${originX}&oy=${originY}`;
  return {
    url,
    logDetails: {
      pass,
      passLabel: preview ? 'preview' : 'full',
      isFirstLoad,
      requestLat: lat,
      requestLon: lon,
      requestAltM: altitude,
      headingRad: heading,
      maxDepth: preview ? previewMaxDepth : null,
      ...cameraSnapshot,
    },
  };
}

export function diffTerrainTileIds(tiles, currentTileIds) {
  const nextTileIds = new Set(tiles.map(tile => tile.id));
  return {
    nextTileIds,
    added: [...nextTileIds].filter(id => !currentTileIds.has(id)),
    removed: [...currentTileIds].filter(id => !nextTileIds.has(id)),
  };
}

export function prioritizeTerrainBuildCandidates(tiles, addedIds, priorityForTile) {
  return tiles
    .filter(tile => addedIds.has(tile.id) && tile.heightmap)
    .map(tile => ({ tile, prio: priorityForTile(tile) }))
    .sort((a, b) => a.prio - b.prio);
}
