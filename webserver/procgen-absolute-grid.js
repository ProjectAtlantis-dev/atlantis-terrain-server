/** Build a camera-window-independent candidate grid in absolute metres. */
export function absoluteScatterGrid({ centerX, centerZ, worldSize, cellSize }) {
  if (![centerX, centerZ, worldSize, cellSize].every(Number.isFinite)
      || worldSize <= 0 || cellSize <= 0) {
    throw new RangeError('absoluteScatterGrid requires finite positive sizes');
  }
  const half = worldSize * 0.5;
  // One guard cell on each edge lets jitter cover the window without changing
  // candidate identity when the camera window moves relative to the grid.
  const gridCount = Math.ceil(worldSize / cellSize) + 2;
  const baseCellX = Math.floor((centerX - half) / cellSize) - 1;
  const baseCellZ = Math.floor((centerZ - half) / cellSize) - 1;
  return {
    gridCount,
    baseCellX,
    baseCellZ,
    localOffsetX: baseCellX * cellSize - centerX,
    localOffsetZ: baseCellZ * cellSize - centerZ,
    cellSize,
    half,
  };
}

export function absoluteCandidateCell(grid, column, row) {
  return {
    x: grid.baseCellX + column,
    z: grid.baseCellZ + row,
  };
}

export function candidateLocalPosition(grid, cell, jitterX, jitterZ) {
  return {
    x: cell.x * grid.cellSize + jitterX * grid.cellSize
      - (grid.baseCellX * grid.cellSize - grid.localOffsetX),
    z: cell.z * grid.cellSize + jitterZ * grid.cellSize
      - (grid.baseCellZ * grid.cellSize - grid.localOffsetZ),
  };
}

export function candidateInsideGridWindow(grid, localPosition) {
  return Math.abs(localPosition.x) <= grid.half
    && Math.abs(localPosition.z) <= grid.half;
}
