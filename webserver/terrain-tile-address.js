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

export function parseTerrainTileId(tileId) {
  if (typeof tileId !== 'string') return null;
  const match = TILE_ID_PATTERN.exec(tileId.trim());
  if (!match) return null;
  const depth = Number(match[1]);
  const col = Number(match[2]);
  const row = Number(match[3]);
  if (depth > MAX_SAFE_TILE_DEPTH) return null;
  const tilesPerAxis = 2 ** depth;
  if (col >= tilesPerAxis || row >= tilesPerAxis) return null;
  return {
    depth,
    col,
    row,
    id: formatTerrainTileId(depth, col, row),
  };
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

