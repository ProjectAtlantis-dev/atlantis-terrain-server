export const PROCGEN_TILE_DEPTH = 12;
export const PROCGEN_WINDOW_RADIUS = 1;
export const PROCGEN_WINDOW_TILE_COUNT = 9;

export function parseTileId(id) {
  const match = /^(\d+)-(\d+)-(\d+)$/.exec(id ?? '');
  if (!match) return null;
  return { depth: Number(match[1]), col: Number(match[2]), row: Number(match[3]) };
}

function tileKey(col, row) {
  return `${PROCGEN_TILE_DEPTH}-${col}-${row}`;
}

// Convert any quadtree source tile containing (x,y) to the fixed procgen
// address and bbox. A refinement from d12 to d13+ therefore cannot look like
// player movement to the chunk streamer.
export function canonicalTileFromSource(source, x, y) {
  if (!source) return null;
  const width = source.xMax - source.xMin;
  const height = source.yMax - source.yMin;
  let col;
  let row;
  let xMin;
  let yMin;
  let tileWidth;
  let tileHeight;

  if (source.depth >= PROCGEN_TILE_DEPTH) {
    const factor = 2 ** (source.depth - PROCGEN_TILE_DEPTH);
    col = Math.floor(source.col / factor);
    row = Math.floor(source.row / factor);
    tileWidth = width * factor;
    tileHeight = height * factor;
    xMin = source.xMin - (source.col - col * factor) * width;
    yMin = source.yMin - (source.row - row * factor) * height;
  } else {
    const factor = 2 ** (PROCGEN_TILE_DEPTH - source.depth);
    tileWidth = width / factor;
    tileHeight = height / factor;
    const childCol = Math.max(0, Math.min(factor - 1, Math.floor((x - source.xMin) / tileWidth)));
    const childRow = Math.max(0, Math.min(factor - 1, Math.floor((y - source.yMin) / tileHeight)));
    col = source.col * factor + childCol;
    row = source.row * factor + childRow;
    xMin = source.xMin + childCol * tileWidth;
    yMin = source.yMin + childRow * tileHeight;
  }

  return {
    id: tileKey(col, row),
    col,
    row,
    xMin,
    yMin,
    xMax: xMin + tileWidth,
    yMax: yMin + tileHeight,
    width: tileWidth,
    height: tileHeight,
  };
}

export function windowDescriptors(center) {
  const result = [];
  const maxIndex = (2 ** PROCGEN_TILE_DEPTH) - 1;
  for (let dy = -PROCGEN_WINDOW_RADIUS; dy <= PROCGEN_WINDOW_RADIUS; dy++) {
    for (let dx = -PROCGEN_WINDOW_RADIUS; dx <= PROCGEN_WINDOW_RADIUS; dx++) {
      const col = center.col + dx;
      const row = center.row + dy;
      if (col < 0 || row < 0 || col > maxIndex || row > maxIndex) continue;
      const xMin = center.xMin + dx * center.width;
      const yMin = center.yMin + dy * center.height;
      result.push({
        id: tileKey(col, row),
        col,
        row,
        xMin,
        yMin,
        xMax: xMin + center.width,
        yMax: yMin + center.height,
        width: center.width,
        height: center.height,
      });
    }
  }
  return result;
}

export function diffWindows(previousCenter, nextCenter) {
  const previous = new Set(windowDescriptors(previousCenter).map(tile => tile.id));
  const next = new Set(windowDescriptors(nextCenter).map(tile => tile.id));
  return {
    retained: [...next].filter(id => previous.has(id)),
    loaded: [...next].filter(id => !previous.has(id)),
    unloaded: [...previous].filter(id => !next.has(id)),
  };
}
