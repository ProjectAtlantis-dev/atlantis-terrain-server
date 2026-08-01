// Browser-side terrain quadtree addressing. Keep this root extent in sync
// with flaskserver/terrain_config.py; all browser bbox math routes through
// this module so there is only one client owner.
export const TILE_GRID_ROOT_BBOX = Object.freeze([
  -1239041.5,
  -3346077.5,
  1460958.5,
  -646077.5,
]);

const MAX_SAFE_TILE_DEPTH = 30;
const TILE_ID_PATTERN = /^(\d+)-(\d+)-(\d+)$/;

export function formatTerrainTileId(depth, col, row) {
  return `${depth}-${col}-${row}`;
}

// Residency sweeps parse the same few hundred ids tens of thousands of times
// per response — every eviction candidate re-walks the desired set and the
// resident coverage map. The id space is small and the result is immutable, so
// memoizing turns that back into a map lookup. Frozen because callers share
// one instance per id.
const parsedTileIds = new Map();
const PARSED_TILE_ID_CACHE_MAX = 20000;

export function parseTerrainTileId(tileId) {
  if (typeof tileId !== 'string') return null;
  const cached = parsedTileIds.get(tileId);
  if (cached !== undefined) return cached;
  const parsed = parseTerrainTileIdUncached(tileId);
  // A flat reset keeps this O(1); the working set is far below the cap and a
  // cold rebuild costs one parse per live id.
  if (parsedTileIds.size >= PARSED_TILE_ID_CACHE_MAX) parsedTileIds.clear();
  parsedTileIds.set(tileId, parsed);
  return parsed;
}

function parseTerrainTileIdUncached(tileId) {
  const match = TILE_ID_PATTERN.exec(tileId.trim());
  if (!match) return null;
  const depth = Number(match[1]);
  const col = Number(match[2]);
  const row = Number(match[3]);
  if (depth > MAX_SAFE_TILE_DEPTH) return null;
  const tilesPerAxis = 2 ** depth;
  if (col >= tilesPerAxis || row >= tilesPerAxis) return null;
  return Object.freeze({
    depth,
    col,
    row,
    id: formatTerrainTileId(depth, col, row),
  });
}

export function terrainTileDepth(tileId, fallback = -1) {
  return parseTerrainTileId(tileId)?.depth ?? fallback;
}

export function terrainTileBbox(address, rootBbox = TILE_GRID_ROOT_BBOX) {
  const parsed = typeof address === 'string'
    ? parseTerrainTileId(address)
    : parseTerrainTileId(formatTerrainTileId(
        address?.depth,
        address?.col,
        address?.row,
      ));
  if (!parsed) return null;
  const tilesPerAxis = 2 ** parsed.depth;
  const width = (rootBbox[2] - rootBbox[0]) / tilesPerAxis;
  const height = (rootBbox[3] - rootBbox[1]) / tilesPerAxis;
  const xMin = rootBbox[0] + parsed.col * width;
  const yMin = rootBbox[1] + parsed.row * height;
  return [xMin, yMin, xMin + width, yMin + height];
}

export function isTerrainTileAncestor(
  ancestorTileId,
  descendantTileId,
  { allowSelf = false } = {},
) {
  const ancestor = parseTerrainTileId(ancestorTileId);
  const descendant = parseTerrainTileId(descendantTileId);
  if (!ancestor || !descendant) return false;
  if (descendant.depth < ancestor.depth) return false;
  if (!allowSelf && descendant.depth === ancestor.depth) return false;
  const divisor = 2 ** (descendant.depth - ancestor.depth);
  return (
    Math.floor(descendant.col / divisor) === ancestor.col
    && Math.floor(descendant.row / divisor) === ancestor.row
  );
}

