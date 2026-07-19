import { viewHeadingChanged } from './terrain-priority.js';

/**
 * Debounce view-priority rebuilds while the camera is turning. The currently
 * active terrain request is allowed to finish; only the final settled heading
 * becomes a new demand generation.
 */
export function createTerrainHeadingDemandController({
  initialHeading,
  threshold,
  settleMs,
  onCommit,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = timer => clearTimeout(timer),
}) {
  let committedHeading = initialHeading;
  let observedHeading = initialHeading;
  let timer = null;

  function cancelPending() {
    if (timer != null) cancel(timer);
    timer = null;
  }

  function synchronize(heading) {
    cancelPending();
    committedHeading = heading;
    observedHeading = heading;
  }

  function observe(heading, { ready = true } = {}) {
    if (!Number.isFinite(heading)) return false;
    if (!ready) {
      synchronize(heading);
      return false;
    }
    if (!viewHeadingChanged(observedHeading, heading, 1e-6)) return false;
    observedHeading = heading;
    cancelPending();
    if (!viewHeadingChanged(committedHeading, observedHeading, threshold)) return false;
    timer = schedule(() => {
      timer = null;
      const previousHeading = committedHeading;
      committedHeading = observedHeading;
      onCommit(previousHeading, committedHeading);
    }, settleMs);
    return true;
  }

  return {
    observe,
    synchronize,
    cancel: cancelPending,
    get committedHeading() { return committedHeading; },
    get observedHeading() { return observedHeading; },
  };
}
