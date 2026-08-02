const DEFAULT_MAX_ENTRIES = 4000;

/**
 * Retain decoded elevation samples so the server can stop re-sending them.
 *
 * The tile endpoint has always returned every heightmap in the footprint on
 * every poll, so a stationary camera re-received the same ~4.5 MB of float32
 * roughly once a second — measured at 80% redundant across a real flight.
 *
 * Omission is only safe if the client can still reconstruct what it claimed to
 * know, so this cache is the authority for that claim: the residency map sent
 * upstream is built from these entries, never from resident meshes. A mesh can
 * be evicted, its geometry parked, or its payload superseded independently, and
 * none of that should convince the server to withhold samples the client can no
 * longer produce.
 *
 * Entries are keyed by tile id and validated by digest, which the server
 * computes over the seam-repaired bytes it actually sends — the same identity
 * the geometry cache uses.
 */
export function createTerrainSampleCache({
  maxEntries = DEFAULT_MAX_ENTRIES,
  evictionGate = null,
} = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 0) {
    throw new RangeError('maxEntries must be a non-negative integer');
  }
  const entries = new Map();
  let hits = 0;
  let misses = 0;

  function evictOverflow() {
    if (evictionGate?.enabled === false) return;
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }
  evictionGate?.onChange?.(enabled => {
    if (enabled) evictOverflow();
  });

  return {
    get size() { return entries.size; },

    store(tileId, digest, samples) {
      if (maxEntries === 0) return false;
      if (
        typeof tileId !== 'string'
        || typeof digest !== 'string'
        || !(samples instanceof Float32Array)
      ) return false;
      // Copy: the decoded samples are views over the response buffer, and
      // retaining one would pin the entire multi-megabyte payload in memory.
      entries.delete(tileId);
      entries.set(tileId, { digest, samples: samples.slice() });
      evictOverflow();
      return true;
    },

    /** Samples for a tile whose server digest matches what is held. */
    take(tileId, digest) {
      const entry = entries.get(tileId);
      if (entry == null || entry.digest !== digest) {
        misses += 1;
        return null;
      }
      // Refresh recency so a tile in continuous view is not evicted.
      entries.delete(tileId);
      entries.set(tileId, entry);
      hits += 1;
      return entry.samples;
    },

    /** Residency map sent upstream: tile id to the digest held for it. */
    residency() {
      const known = {};
      for (const [tileId, entry] of entries) known[tileId] = entry.digest;
      return known;
    },

    /**
     * Freeze the residency claim and its reconstruction data for one request.
     *
     * Cache capacity can turn over while the server is producing a response.
     * Holding these entry references makes every digest advertised by this
     * request reconstructible even if the live LRU evicts it meanwhile. The
     * Float32Arrays are already cache-owned copies, so this does not copy the
     * sample payload again.
     */
    snapshot() {
      const heldEntries = new Map(entries);
      const known = {};
      for (const [tileId, entry] of heldEntries) known[tileId] = entry.digest;
      return {
        known,
        take(tileId, digest) {
          const entry = heldEntries.get(tileId);
          if (entry == null || entry.digest !== digest) {
            misses += 1;
            return null;
          }
          hits += 1;
          return entry.samples;
        },
      };
    },

    clear() { entries.clear(); },

    stats() {
      return {
        size: entries.size,
        maxEntries,
        hits,
        misses,
        hitRate: hits + misses === 0 ? 0 : hits / (hits + misses),
      };
    },
  };
}
