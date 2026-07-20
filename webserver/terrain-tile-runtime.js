export function terrainVisibilityDistance(altitude) {
  const alt = Math.max(25, altitude);
  const horizon = Math.sqrt(2 * 6371000 * alt);
  return Math.min(horizon, 30000 + alt * 12);
}

export function tileDepthFromId(tileId) {
  if (typeof tileId !== 'string') return -1;
  const depth = Number.parseInt(tileId.split('-')[0], 10);
  return Number.isFinite(depth) ? depth : -1;
}

export function terrainFogDistance(altitude) {
  const alt = Math.max(25, altitude);
  const horizon = Math.sqrt(2 * 6371000 * alt);
  return Math.min(horizon, 15000 + alt * 8);
}

export function textureRetryDelay(attempt, baseMs = 2000, maxMs = 30000) {
  return Math.min(baseMs * Math.pow(1.5, Math.max(0, attempt - 1)), maxMs);
}

export function scoreTextureTiles(tiles, priorityForTile, maxPriority, refinementBias = 0.12) {
  const tileIds = new Set();
  const scored = [];
  for (const tile of tiles) {
    if (!tile?.id || !tile?.bbox) continue;
    tileIds.add(tile.id);
    const priority = priorityForTile(tile);
    if (priority <= maxPriority) {
      scored.push({
        tile,
        prio: priority,
        score: priority - Math.max(0, tileDepthFromId(tile.id)) * refinementBias,
      });
    }
  }
  // Refine within a nearby heatmap band before spending capacity on another
  // coarse covering tile. Spatial priority remains dominant over large gaps.
  scored.sort((a, b) => a.score - b.score || a.prio - b.prio);
  return { tileIds, scored };
}

export function createTileHistory({ getPass, emit, maxTiles = 1000, maxEvents = 40 }) {
  const history = new Map();
  const log = (tileId, message) => {
    if (!history.has(tileId)) {
      if (history.size >= maxTiles) history.delete(history.keys().next().value);
      history.set(tileId, []);
    }
    const pass = getPass();
    const passTag = pass === 1 ? '[P1-preview]' : '[P2-full]';
    const timestamp = (performance.now() / 1000).toFixed(1);
    const events = history.get(tileId);
    events.push(`${timestamp}s ${passTag} ${message}`);
    if (events.length > maxEvents) events.shift();
    // Normal tile chatter is intentionally debug-only, but evictions must be
    // durable diagnostics. The client logger defaults to an info threshold,
    // which previously meant every eviction vanished before reaching
    // client_debug.log and its live ring.
    const level = message.startsWith('evict') ? 'info' : 'debug';
    emit({ tileId, pass, msg: message, ts: `${timestamp}s` }, level);
  };
  return { history, log };
}
