import {
  formatTerrainTileId,
  parseTerrainTileId,
} from './terrain-tile-address.js';

export function terrainCureAncestorId(tileId, cureDepth) {
  const tile = parseTerrainTileId(tileId);
  if (!tile || !Number.isInteger(cureDepth) || cureDepth < 0) return null;
  if (tile.depth < cureDepth) return null;
  const shift = tile.depth - cureDepth;
  return formatTerrainTileId(
    cureDepth,
    Math.floor(tile.col / (2 ** shift)),
    Math.floor(tile.row / (2 ** shift)),
  );
}

export function createTerrainCureStatusRuntime({
  endpoint = '/api/coverage/cure.json',
  refreshMs = 30_000,
  fetchImpl = fetch,
  now = () => Date.now(),
  onError = () => {},
} = {}) {
  let cureDepth = null;
  let tiles = new Map();
  let state = 'idle';
  let lastLoadedAt = -Infinity;
  let pending = null;
  let error = null;

  async function load({ force = false } = {}) {
    if (pending) return pending;
    if (!force && state === 'ready' && now() - lastLoadedAt < refreshMs) {
      return null;
    }
    state = 'loading';
    error = null;
    pending = fetchImpl(endpoint, { cache: 'no-store' })
      .then(response => {
        if (!response.ok) throw new Error(`coverage cure status ${response.status}`);
        return response.json();
      })
      .then(inventory => {
        if (!Number.isInteger(inventory?.cureDepth)) {
          throw new Error('coverage cure inventory has no valid cureDepth');
        }
        cureDepth = inventory.cureDepth;
        tiles = new Map((inventory.tiles ?? []).map(tile => [tile.tile, tile]));
        state = 'ready';
        lastLoadedAt = now();
      })
      .catch(loadError => {
        state = 'error';
        error = loadError;
        onError(loadError);
      })
      .finally(() => { pending = null; });
    return pending;
  }

  function statusFor(tileId) {
    if (state === 'idle' || (state === 'ready' && now() - lastLoadedAt >= refreshMs)) {
      void load();
    }
    if (state === 'idle' || state === 'loading') return { state: 'loading' };
    if (state === 'error') return { state: 'error', message: error?.message ?? String(error) };
    const tile = parseTerrainTileId(tileId);
    if (!tile) return { state: 'invalid' };
    if (tile.depth < cureDepth) {
      return { state: 'coarse', cureDepth, tileId };
    }
    const cureTileId = terrainCureAncestorId(tileId, cureDepth);
    const cureTile = tiles.get(cureTileId);
    if (!cureTile) return { state: 'uncached', cureDepth, cureTileId };
    return {
      state: cureTile.status === 'cured' ? 'cured' : 'partial',
      cureDepth,
      cureTileId,
      dem: Boolean(cureTile.dem),
      coastline: Boolean(cureTile.coastline),
      texture: cureTile.texture ?? null,
    };
  }

  return { load, statusFor };
}
