export const CLASSIFIER_GRID_COLOR = 'rgba(20, 230, 255, 0.9)';

/** Paint a crisp inset border into a classifier-mode tile texture. */
export function paintClassifierGridBorder(context, width, height, {
  color = CLASSIFIER_GRID_COLOR,
  lineWidth = Math.max(2, Math.round(Math.min(width, height) / 128)),
} = {}) {
  if (!context || width <= 0 || height <= 0 || lineWidth <= 0) return 0;
  const thickness = Math.min(Math.round(lineWidth), Math.ceil(width / 2), Math.ceil(height / 2));
  context.fillStyle = color;
  context.fillRect(0, 0, width, thickness);
  context.fillRect(0, height - thickness, width, thickness);
  context.fillRect(0, thickness, thickness, Math.max(0, height - thickness * 2));
  context.fillRect(width - thickness, thickness, thickness, Math.max(0, height - thickness * 2));
  return thickness;
}
