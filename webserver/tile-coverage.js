import {
  formatTerrainTileId,
  parseTerrainTileId,
} from './terrain-tile-address.js';

export function hasCompleteTerrainTileCoverage(
  tileId,
  residentTextures,
  { excludeTileIds = [] } = {},
) {
  const tile = parseTerrainTileId(tileId);
  if (!tile) return false;
  const resident = new Map(residentTextures);
  for (const excludedId of excludeTileIds) resident.delete(excludedId);
  let maxDepth = tile.depth;
  for (const id of resident.keys()) {
    const address = parseTerrainTileId(id);
    if (address) maxDepth = Math.max(maxDepth, address.depth);
  }

  const memo = new Map();
  const covered = (depth, col, row) => {
    const id = formatTerrainTileId(depth, col, row);
    if (memo.has(id)) return memo.get(id);
    if (resident.get(id) === true) return true;
    if (depth >= maxDepth) return false;
    for (let dx = 0; dx < 2; dx++) {
      for (let dy = 0; dy < 2; dy++) {
        if (!covered(depth + 1, col * 2 + dx, row * 2 + dy)) {
          memo.set(id, false);
          return false;
        }
      }
    }
    memo.set(id, true);
    return true;
  };

  return covered(tile.depth, tile.col, tile.row);
}
