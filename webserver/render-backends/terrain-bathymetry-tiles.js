import { parseTerrainTileId } from '../terrain-tile-address.js';
import { TERRAIN_BATHYMETRY_LAYER } from './terrain-render-contract.js';

export function prepareTerrainTilesForBathymetry(
  terrainRoot,
  {
    onPrepare = () => {},
    onRestore = () => {},
  } = {},
) {
  const restore = [];
  for (const tile of terrainRoot?.children ?? []) {
    const address = parseTerrainTileId(tile.userData?.tileId);
    if (!tile.isMesh || !address) continue;
    const state = {
      tile,
      layerMask: tile.layers.mask,
      renderOrder: tile.renderOrder,
    };
    restore.push(state);
    tile.layers.set(TERRAIN_BATHYMETRY_LAYER);
    // Parents establish fallback coverage first; finer tiles overwrite them
    // even where the coarse shoreline is geometrically higher.
    tile.renderOrder = address.depth;
    onPrepare(tile, state);
  }
  return () => {
    for (const state of restore) {
      state.tile.layers.mask = state.layerMask;
      state.tile.renderOrder = state.renderOrder;
      onRestore(state.tile, state);
    }
  };
}

