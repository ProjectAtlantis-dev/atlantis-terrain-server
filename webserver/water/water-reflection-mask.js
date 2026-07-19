export const NORTH_CLIFF_REFLECTION_MAX_PADDING_M = 750;
export const NORTH_CLIFF_SLOPE_START = 0.12;
export const NORTH_CLIFF_SLOPE_FULL = 0.70;

function smoothstep(edge0, edge1, value) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function northCliffReflectionPaddingForSlope(
  slope,
  maxPadding = NORTH_CLIFF_REFLECTION_MAX_PADDING_M,
) {
  return Math.max(0, maxPadding) * smoothstep(
    NORTH_CLIFF_SLOPE_START,
    NORTH_CLIFF_SLOPE_FULL,
    Math.max(0, slope),
  );
}

export function northCliffReflectionKeepForDistance(
  slope,
  distance,
  maxPadding = NORTH_CLIFF_REFLECTION_MAX_PADDING_M,
) {
  const padding = northCliffReflectionPaddingForSlope(slope, maxPadding);
  if (padding <= 0) return 1;
  const cliffWeight = padding / Math.max(0, maxPadding);
  return 1 - cliffWeight * (1 - smoothstep(0, padding, Math.max(0, distance)));
}
