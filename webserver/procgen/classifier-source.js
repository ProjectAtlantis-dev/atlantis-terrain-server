// Produce finest-to-coarsest classifier candidates for a resident render tile.
// The caller probes these once when entering an area and latches the first
// available page. A later render-LOD refinement therefore cannot reshuffle an
// already-visible population, while leaving and re-entering can adopt a newly
// available finer classifier page.
export function classifierSourceCandidates(tile) {
  const depth = Number(tile?.depth);
  const col = Number(tile?.col);
  const row = Number(tile?.row);
  const xMin = Number(tile?.xMin);
  const yMin = Number(tile?.yMin);
  const xMax = Number(tile?.xMax);
  const yMax = Number(tile?.yMax);
  if (![depth, col, row, xMin, yMin, xMax, yMax].every(Number.isFinite)
      || depth < 0 || col < 0 || row < 0 || xMax <= xMin || yMax <= yMin) {
    return [];
  }

  const width = xMax - xMin;
  const height = yMax - yMin;
  const candidates = [];
  for (let sourceDepth = Math.floor(depth); sourceDepth >= 0; sourceDepth--) {
    const levelsUp = Math.floor(depth) - sourceDepth;
    const scale = 2 ** levelsUp;
    const sourceCol = Math.floor(col / scale);
    const sourceRow = Math.floor(row / scale);
    const colWithinSource = Math.floor(col) - sourceCol * scale;
    const rowWithinSource = Math.floor(row) - sourceRow * scale;
    const sourceXMin = xMin - colWithinSource * width;
    const sourceYMin = yMin - rowWithinSource * height;
    candidates.push({
      id: `${sourceDepth}-${sourceCol}-${sourceRow}`,
      depth: sourceDepth,
      col: sourceCol,
      row: sourceRow,
      xMin: sourceXMin,
      yMin: sourceYMin,
      xMax: sourceXMin + width * scale,
      yMax: sourceYMin + height * scale,
    });
  }
  return candidates;
}

// Exact union-coverage check for axis-aligned classifier pages. Edge lists
// partition the requested bounds into cells whose coverage cannot change
// internally, so one midpoint test per cell is sufficient.
export function classifierSourcesCoverBounds(sources, bounds) {
  if (!Array.isArray(sources) || !bounds) return false;
  const { xMin, yMin, xMax, yMax } = bounds;
  if (![xMin, yMin, xMax, yMax].every(Number.isFinite)
      || xMax <= xMin || yMax <= yMin) return false;
  const relevant = sources.filter(source => (
    source?.fields
    && source.xMax > xMin && source.xMin < xMax
    && source.yMax > yMin && source.yMin < yMax
  ));
  if (relevant.length === 0) return false;
  const xs = new Set([xMin, xMax]);
  const ys = new Set([yMin, yMax]);
  for (const source of relevant) {
    xs.add(Math.max(xMin, Math.min(xMax, source.xMin)));
    xs.add(Math.max(xMin, Math.min(xMax, source.xMax)));
    ys.add(Math.max(yMin, Math.min(yMax, source.yMin)));
    ys.add(Math.max(yMin, Math.min(yMax, source.yMax)));
  }
  const xEdges = [...xs].sort((a, b) => a - b);
  const yEdges = [...ys].sort((a, b) => a - b);
  for (let yi = 0; yi < yEdges.length - 1; yi++) {
    for (let xi = 0; xi < xEdges.length - 1; xi++) {
      const x = (xEdges[xi] + xEdges[xi + 1]) * 0.5;
      const y = (yEdges[yi] + yEdges[yi + 1]) * 0.5;
      if (!relevant.some(source => (
        x >= source.xMin && x <= source.xMax
        && y >= source.yMin && y <= source.yMax
      ))) return false;
    }
  }
  return true;
}
