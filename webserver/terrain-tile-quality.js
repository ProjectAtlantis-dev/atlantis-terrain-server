const PARENT_DEM_SOURCES = new Set([
  'parent_resampled',
  'unmasked_parent_resampled',
  'clobbered_parent_resampled',
]);

export function classifyDemSource(source) {
  const raw = typeof source === 'string' ? source : '';
  if (PARENT_DEM_SOURCES.has(raw)) {
    return {
      kind: 'parent_dem', synthetic: true, retryable: true,
      terminal: false, retryState: 'ready', source: raw,
    };
  }
  if (raw === 'procedural') {
    return {
      kind: 'procedural', synthetic: true, retryable: false,
      terminal: true, retryState: 'terminal', source: raw,
    };
  }
  if (!raw || raw === 'empty' || raw === 'pending') {
    return {
      kind: 'missing', synthetic: false, retryable: true,
      terminal: false, retryState: 'ready', source: raw,
    };
  }
  if (raw === 'no_data') {
    return {
      kind: 'missing', synthetic: false, retryable: false,
      terminal: true, retryState: 'terminal', source: raw,
    };
  }
  return {
    kind: 'measured', synthetic: false, retryable: false,
    terminal: true, retryState: 'terminal', source: raw,
  };
}

export function classifyTextureTile(tile) {
  const status = tile?.texStatus || 'missing';
  if (tile?.texIsPlaceholder || status === 'ancestor_fallback') {
    return {
      kind: 'parent_image', synthetic: true, retryable: true,
      terminal: false, retryState: 'ready', status,
    };
  }
  if (status === 'fetching') {
    return {
      kind: 'missing', synthetic: false, retryable: true,
      terminal: false, retryState: 'inflight', status,
    };
  }
  if (status === 'ready') {
    return {
      kind: 'image', synthetic: false, retryable: false,
      terminal: true, retryState: 'terminal', status,
    };
  }
  return {
    kind: 'missing', synthetic: false, retryable: true,
    terminal: false, retryState: 'ready', status,
  };
}

export function retryableSyntheticDemCount(tiles) {
  if (!Array.isArray(tiles)) return 0;
  return tiles.reduce((count, tile) => {
    const quality = classifyDemSource(tile?.source);
    return count + Number(quality.synthetic && quality.retryable);
  }, 0);
}

const DEM_QUALITY_RANK = Object.freeze({
  missing: 0,
  procedural: 1,
  parent_dem: 2,
  measured: 3,
});

const TEXTURE_QUALITY_RANK = Object.freeze({
  missing: 0,
  parent_image: 1,
  image: 2,
});

const DEM_FIELDS = ['source', 'resolution', 'heightmap'];
const TEXTURE_FIELDS = [
  'hasTexture', 'texAvailable', 'texStatus', 'texIsPlaceholder',
  'texAncestorId', 'texIsFetching',
];

/**
 * Admit late response data without allowing it to redefine the tile set.
 * Only exact IDs in the current browser demand can be upgraded, and DEM and
 * imagery quality are compared independently so one channel cannot regress
 * the other.
 */
export function mergeTerrainTilesAgainstCurrentTileSet(currentTiles, incomingTiles) {
  const current = Array.isArray(currentTiles) ? currentTiles : [];
  const incoming = Array.isArray(incomingTiles) ? incomingTiles : [];
  const incomingById = new Map(incoming.map(tile => [tile?.id, tile]));
  const currentIds = new Set(current.map(tile => tile?.id));
  const rejectedTileIds = incoming
    .map(tile => tile?.id)
    .filter(id => id != null && !currentIds.has(id));
  const acceptedTileIds = [];
  let demUpgraded = 0;
  let textureUpgraded = 0;

  const tiles = current.map(tile => {
    const candidate = incomingById.get(tile?.id);
    if (!candidate) return tile;
    let merged = tile;
    let upgraded = false;
    const currentDemRank = DEM_QUALITY_RANK[classifyDemSource(tile.source).kind] ?? 0;
    const incomingDemRank = DEM_QUALITY_RANK[classifyDemSource(candidate.source).kind] ?? 0;
    if (incomingDemRank > currentDemRank) {
      merged = { ...merged };
      for (const field of DEM_FIELDS) merged[field] = candidate[field];
      demUpgraded += 1;
      upgraded = true;
    }
    const currentTextureRank = TEXTURE_QUALITY_RANK[classifyTextureTile(tile).kind] ?? 0;
    const incomingTextureRank = TEXTURE_QUALITY_RANK[classifyTextureTile(candidate).kind] ?? 0;
    if (incomingTextureRank > currentTextureRank) {
      if (merged === tile) merged = { ...merged };
      for (const field of TEXTURE_FIELDS) merged[field] = candidate[field];
      textureUpgraded += 1;
      upgraded = true;
    }
    if (upgraded) acceptedTileIds.push(tile.id);
    return merged;
  });

  return {
    tiles,
    acceptedTileIds,
    rejectedTileIds,
    demUpgraded,
    textureUpgraded,
  };
}
