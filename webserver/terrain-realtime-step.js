export const MAX_REALTIME_STEP_SECONDS = 0.05;
export const MAX_REALTIME_STEPS_PER_FRAME = 10;

/**
 * Advance movement through all elapsed wall time before the next render.
 *
 * Normal frame delays are split into small, stable simulation steps. Very
 * long delays still consume the full elapsed interval, but use a bounded
 * number of steps so resuming a backgrounded tab cannot lock up the UI.
 */
export function advanceRealtimeMovement(
  elapsedSeconds,
  step,
  {
    maxStepSeconds = MAX_REALTIME_STEP_SECONDS,
    maxSteps = MAX_REALTIME_STEPS_PER_FRAME,
  } = {},
) {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return 0;
  if (typeof step !== 'function') throw new TypeError('step must be a function');
  if (!Number.isFinite(maxStepSeconds) || maxStepSeconds <= 0) {
    throw new RangeError('maxStepSeconds must be positive');
  }
  if (!Number.isInteger(maxSteps) || maxSteps <= 0) {
    throw new RangeError('maxSteps must be a positive integer');
  }

  const stepCount = Math.min(maxSteps, Math.max(1, Math.ceil(elapsedSeconds / maxStepSeconds)));
  const stepSeconds = elapsedSeconds / stepCount;
  for (let index = 0; index < stepCount; index += 1) step(stepSeconds);
  return stepCount;
}
