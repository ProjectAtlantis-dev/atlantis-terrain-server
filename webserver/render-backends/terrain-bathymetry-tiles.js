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
    if (tile.userData?.terrainBathymetryReady === false) {
      // A DEM may arrive minutes before its coastline/connectivity mask. Its
      // provisional sign-based surface can be a near-zero ocean plate. Keep
      // it out of the depth target so uncovered pixels retain alpha zero and
      // both water shaders use their deliberate -5 m fallback instead.
      tile.layers.disable(TERRAIN_BATHYMETRY_LAYER);
    } else {
      tile.layers.set(TERRAIN_BATHYMETRY_LAYER);
    }
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
