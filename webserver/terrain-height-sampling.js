/**
 * Sample the same piecewise-planar surface rendered by terrain-mesh-builder.
 *
 * Each grid quad is indexed as (a,b,d) and (b,f,d). Bilinear interpolation
 * would instead create a curved saddle between the four vertices, which can
 * place grounded props visibly above or below the rendered triangles.
 */
export function sampleTriangulatedHeight(heightmap, resolution, gridColumn, gridRow) {
  if (!(heightmap instanceof Float32Array) || resolution < 2) return Number.NaN;

  const column = Math.max(0, Math.min(resolution - 1, gridColumn));
  const row = Math.max(0, Math.min(resolution - 1, gridRow));
  const column0 = Math.min(resolution - 2, Math.floor(column));
  const row0 = Math.min(resolution - 2, Math.floor(row));
  const columnFraction = column - column0;
  const rowFraction = row - row0;
  const index00 = row0 * resolution + column0;
  const height00 = heightmap[index00];
  const height10 = heightmap[index00 + 1];
  const height01 = heightmap[index00 + resolution];
  const height11 = heightmap[index00 + resolution + 1];

  if (columnFraction + rowFraction <= 1) {
    return height00
      + columnFraction * (height10 - height00)
      + rowFraction * (height01 - height00);
  }
  return height10 * (1 - rowFraction)
    + height01 * (1 - columnFraction)
    + height11 * (columnFraction + rowFraction - 1);
}
