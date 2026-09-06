const CACHE_NAME = 'terrain-coverage-v1';

async function readSnapshot(url) {
  const cache = await globalThis.caches?.open(CACHE_NAME);
  const response = await cache?.match(url);
  return response ? response.json() : null;
}

async function writeSnapshot(url, snapshot) {
  const cache = await globalThis.caches?.open(CACHE_NAME);
  await cache?.put(url, new Response(JSON.stringify(snapshot), {
    headers: { 'Content-Type': 'application/json' },
  }));
}

// Cured tiles are durable evidence. A later inventory can add cures and update
// provisional tiles without losing previously observed cures.
export function mergeCoverageInventory(previous, incoming) {
  if (!Number.isInteger(incoming?.cureDepth) || !Array.isArray(incoming.tiles)) {
    throw new Error('Invalid coverage inventory');
  }
  const tiles = new Map(incoming.tiles.map(tile => [tile.tile, tile]));
  if (previous?.cureDepth === incoming.cureDepth) {
    for (const tile of previous.tiles) {
      if (tile.status === 'cured' && tiles.get(tile.tile)?.status !== 'cured') {
        tiles.set(tile.tile, tile);
      }
    }
  }
  const summary = { ...incoming.summary, cured: 0, partial: 0, coarse: 0 };
  for (const tile of tiles.values()) {
    if (tile.depth < incoming.cureDepth) summary.coarse++;
    else if (tile.depth === incoming.cureDepth) {
      summary[tile.status === 'cured' ? 'cured' : 'partial']++;
    }
  }
  return { ...incoming, tiles: [...tiles.values()], summary };
}

export function createCoverageResource({
  url,
  maxAge = 30_000,
  merge = (_previous, incoming) => incoming,
  onData,
  fetchImpl = globalThis.fetch,
  read = readSnapshot,
  write = writeSnapshot,
  now = () => Date.now(),
}) {
  let snapshot = null;
  let restored = false;
  let pending = null;

  async function update(force) {
    if (!restored) {
      restored = true;
      try {
        const saved = await read(url);
        if (saved && Number.isFinite(saved.updatedAt)) {
          snapshot = { ...saved, data: merge(null, saved.data) };
        }
      } catch {
        // Storage can be unavailable, full, or left with an obsolete payload.
      }
      if (snapshot) onData(snapshot.data, { cached: true });
    }
    if (!force && snapshot && now() - snapshot.updatedAt < maxAge) return;

    const response = await fetchImpl(url, {
      cache: 'no-cache',
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) throw new Error(`${url} status ${response.status}`);
    const data = merge(snapshot?.data, await response.json());
    snapshot = { data, updatedAt: now() };
    onData(data, { cached: false });
    try {
      await write(url, snapshot);
    } catch {
      // Keep the in-memory snapshot even when persistent storage is denied.
    }
  }

  return {
    load({ force = false } = {}) {
      if (!pending) pending = update(force).finally(() => { pending = null; });
      return pending;
    },
  };
}
