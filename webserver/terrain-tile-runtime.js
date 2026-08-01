import { terrainTileDepth } from './terrain-tile-address.js';

const EARTH_RADIUS_M = 6371000;

export function terrainHorizonDistance(altitude) {
  const alt = Math.max(25, altitude);
  return Math.sqrt(2 * EARTH_RADIUS_M * alt);
}

export function terrainVisibilityDistance(altitude) {
  const alt = Math.max(25, altitude);
  const horizon = terrainHorizonDistance(alt);
  return Math.min(horizon, 30000 + alt * 12);
}

export function tileDepthFromId(tileId) {
  return terrainTileDepth(tileId);
}

export function terrainFogDistance(altitude) {
  const alt = Math.max(25, altitude);
  const horizon = terrainHorizonDistance(alt);
  return Math.min(horizon, 15000 + alt * 8);
}

export function textureRetryDelay(attempt, baseMs = 2000, maxMs = 30000) {
  return Math.min(baseMs * Math.pow(1.5, Math.max(0, attempt - 1)), maxMs);
}

export function scoreTextureTiles(tiles, priorityForTile, maxPriority, refinementBias = 0.12) {
  const scored = [];
  for (const tile of tiles) {
    if (!tile?.id || !tile?.bbox) continue;
    const priority = priorityForTile(tile);
    if (priority <= maxPriority) {
      scored.push({
        tile,
        prio: priority,
        score: priority - Math.max(0, tileDepthFromId(tile.id)) * refinementBias,
      });
    }
  }
  // Refine within a nearby tile band before spending capacity on another
  // coarse covering tile. Spatial priority remains dominant over large gaps.
  scored.sort((a, b) => a.score - b.score || a.prio - b.prio);
  return { scored };
}

export function createTileHistory({ emit, maxTiles = 1000, maxEvents = 40 }) {
  const history = new Map();
  const log = (tileId, message) => {
    if (!history.has(tileId)) {
      if (history.size >= maxTiles) history.delete(history.keys().next().value);
      history.set(tileId, []);
    }
    const timestamp = (performance.now() / 1000).toFixed(1);
    const events = history.get(tileId);
    events.push(`${timestamp}s ${message}`);
    if (events.length > maxEvents) events.shift();
    // Evictions were promoted to info so they would survive the client
    // logger's info threshold, but LOD oscillation evicts a few hundred tiles
    // per response — enough that this became the largest log source in the
    // app, and every entry pays a stringify/parse clone from inside retire().
    //
    // The durable signal is kept elsewhere: fetchTiles.diff carries `released`
    // as the per-response eviction count, and `history` below retains the
    // per-tile trail for the tile inspector at any level. Only the redundant
    // per-tile transmission is dropped.
    emit({ tileId, msg: message, ts: `${timestamp}s` }, 'debug');
  };
  return { history, log };
}
