export function selectHystereticCenter(value, currentCenter, {
  step = 192,
  hysteresis = 16,
} = {}) {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) {
    return null;
  }
  if (!Number.isFinite(currentCenter)) {
    return Math.round(value / step) * step;
  }
  const half = step * 0.5 + Math.max(0, Number(hysteresis) || 0);
  if (Math.abs(value - currentCenter) <= half) return currentCenter;
  return Math.round(value / step) * step;
}

export function selectProcgenWindowCenter({
  x,
  y,
  currentX = null,
  currentY = null,
  step = 192,
  hysteresis = 16,
} = {}) {
  const centerX = selectHystereticCenter(x, currentX, { step, hysteresis });
  const centerY = selectHystereticCenter(y, currentY, { step, hysteresis });
  if (centerX == null || centerY == null) return null;
  return { centerX, centerY };
}
