// A depth-12 footprint is ~270 tiles and an oscillation swaps most of them, so
// the useful working set is thousands of grids once a session revisits ground.
// At roughly 250 KB per tile a full cache is ~2.5 GB of vertex buffers, which
// is the cheaper side of the trade against rebuilding grids mid-flight.
// Eviction is O(1) and lookups are keyed, so the cap costs nothing until the
// memory is actually claimed; watch `overflowDrops` to tell whether it binds.
const DEFAULT_MAX_ENTRIES = 10000;

function sameBbox(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * Retain terrain geometry for tiles that leave the resident set.
 *
 * LOD transitions evict and re-admit the same tiles repeatedly — a camera
 * holding altitude over undulating terrain crosses a depth threshold every few
 * seconds, and each crossing used to dispose a few hundred grids and rebuild
 * them from scratch on the way back. Rebuilding is the expensive half: every
 * vertex is coloured individually, the index list is grown by push, and
 * computeVertexNormals walks every triangle.
 *
 * Parking that work costs a few hundred KB per tile, which is a trade worth
 * making on any machine with memory to spare.
 *
 * Geometry is only revived for an exact match. Seam repair means the same tile
 * id can legitimately carry a different heightmap after a neighbour changes
 * LOD, and a re-centred frame offset shifts every bbox, so a stale grid would
 * render visibly wrong edges or land in the wrong place.
 */
export function createTerrainGeometryCache({
  maxEntries = DEFAULT_MAX_ENTRIES,
} = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 0) {
    throw new RangeError('maxEntries must be a non-negative integer');
  }
  // Insertion order is the eviction order; re-parking a tile refreshes it.
  const entries = new Map();
  let hits = 0;
  let misses = 0;
  let staleDrops = 0;
  let overflowDrops = 0;

  function disposeEntry(entry) {
    entry?.geometry?.dispose?.();
  }

  function drop(tileId) {
    const entry = entries.get(tileId);
    if (entry == null) return false;
    entries.delete(tileId);
    disposeEntry(entry);
    return true;
  }

  return {
    get size() { return entries.size; },

    park(mesh) {
      if (maxEntries === 0) return false;
      const data = mesh?.userData;
      const geometry = mesh?.geometry;
      if (
        geometry == null
        || data?.tileId == null
        || typeof data.heightmapPayload !== 'string'
        || !Array.isArray(data.bbox)
      ) return false;

      // A second mesh for the same tile supersedes whatever was parked.
      drop(data.tileId);
      entries.set(data.tileId, {
        geometry,
        heightmapPayload: data.heightmapPayload,
        bbox: [...data.bbox],
        resolution: data.resolution,
        skirtDepth: data.skirtDepth,
      });

      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        const evicted = entries.get(oldest);
        entries.delete(oldest);
        disposeEntry(evicted);
        overflowDrops += 1;
      }
      return true;
    },

    take(tile) {
      const entry = entries.get(tile?.id);
      if (entry == null) {
        misses += 1;
        return null;
      }
      // Only the grid's shape has to match. Elevations are rewritten in place
      // on revival, which matters because seam repair gives the same tile a
      // fresh heightmap on almost every response — matching payloads exactly
      // made the cache miss precisely when a LOD oscillation needed it.
      if (
        entry.resolution !== tile.resolution
        || !sameBbox(entry.bbox, tile.bbox)
      ) {
        drop(tile.id);
        staleDrops += 1;
        misses += 1;
        return null;
      }
      entries.delete(tile.id);
      hits += 1;
      return {
        ...entry,
        payloadMatches: entry.heightmapPayload === tile.heightmap,
      };
    },

    discard(tileId) { return drop(tileId); },

    clear() {
      for (const entry of entries.values()) disposeEntry(entry);
      entries.clear();
    },

    stats() {
      return {
        size: entries.size,
        maxEntries,
        hits,
        misses,
        staleDrops,
        overflowDrops,
        hitRate: hits + misses === 0 ? 0 : hits / (hits + misses),
      };
    },
  };
}
