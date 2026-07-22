import { headingForward2D } from './terrain-priority.js';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/**
 * Predict a bounded manifest focus along current horizontal motion.
 * The actual camera remains inside the server's much larger visible range;
 * this focus only moves refinement and page priority toward time-to-arrival.
 */
export function predictTerrainStreamingFocus({
  x,
  y,
  heading,
  speedMps,
  minLookaheadSeconds = 4,
  maxLookaheadSeconds = 20,
  maxLookaheadMetres = 5000,
}) {
  const speed = Number.isFinite(speedMps) ? Math.max(0, speedMps) : 0;
  const direction = headingForward2D(Number.isFinite(heading) ? heading : 0);
  const lookaheadSeconds = clamp(
    minLookaheadSeconds + speed / 12,
    minLookaheadSeconds,
    maxLookaheadSeconds,
  );
  const lookaheadMetres = Math.min(speed * lookaheadSeconds, maxLookaheadMetres);
  return {
    x: x + direction.x * lookaheadMetres,
    y: y + direction.y * lookaheadMetres,
    directionX: direction.x,
    directionY: direction.y,
    speedMps: speed,
    lookaheadSeconds,
    lookaheadMetres,
  };
}

export function predictiveRefetchDecision({
  focusX,
  focusY,
  lastFocusX,
  lastFocusY,
  nowMs,
  lastTriggerMs,
  distanceThreshold = 1200,
  triggerIntervalMs = 1000,
}) {
  const displacement = Math.hypot(focusX - lastFocusX, focusY - lastFocusY);
  const intervalElapsed = nowMs - lastTriggerMs >= triggerIntervalMs;
  const shouldFetch = displacement >= distanceThreshold && intervalElapsed;
  return {
    displacement,
    shouldFetch,
    nextTriggerMs: shouldFetch ? nowMs : lastTriggerMs,
  };
}
