const DEFAULT_HITCH_MS = 50;
const DEFAULT_HISTORY_SIZE = 64;
const DEFAULT_LONG_TASK_HISTORY = 128;

/**
 * Detect main-thread stalls in the render loop and attribute them.
 *
 * The interval between two consecutive frame starts splits cleanly into two
 * parts: the work the previous frame did inside render(), and the gap after
 * render() returned. Anything in the gap ran outside the loop — fetch
 * callbacks, setInterval maintenance, image decode completion, or GC — so the
 * split is what separates "our frame is too slow" from "something else seized
 * the thread". Long task entries falling inside the gap name the culprit when
 * the browser is willing to say.
 *
 * Context counters are sampled every frame and reported as a delta across the
 * hitch, so a stall can be tied to the tiles, textures, or shader programs
 * that appeared while it happened.
 */
export function createTerrainHitchDetector({
  hitchMs = DEFAULT_HITCH_MS,
  historySize = DEFAULT_HISTORY_SIZE,
  longTaskHistorySize = DEFAULT_LONG_TASK_HISTORY,
  sampleContext = null,
  performanceObserver = null,
} = {}) {
  if (!Number.isFinite(hitchMs) || hitchMs <= 0) {
    throw new RangeError('hitchMs must be positive');
  }
  if (!Number.isInteger(historySize) || historySize <= 0) {
    throw new RangeError('historySize must be a positive integer');
  }

  const hitches = [];
  const longTasks = [];
  let enabled = false;
  let frames = 0;
  let previousStartMs = null;
  let previousEndMs = null;
  let previousContext = null;
  let observer = null;
  let droppedLongTasks = 0;
  let worstIntervalMs = 0;
  let totalHitchMs = 0;
  let contextErrorCount = 0;
  let contextLastError = null;
  let observerError = null;

  function readContext() {
    if (typeof sampleContext !== 'function') return null;
    try {
      const snapshot = sampleContext();
      return snapshot == null ? null : { ...snapshot };
    } catch (error) {
      contextErrorCount += 1;
      contextLastError = error?.message ?? String(error);
      return null;
    }
  }

  function contextDelta(before, after) {
    if (before == null || after == null) return null;
    const delta = {};
    for (const key of Object.keys(after)) {
      const from = before[key];
      const to = after[key];
      if (typeof from !== 'number' || typeof to !== 'number') continue;
      if (to === from) continue;
      delta[key] = to - from;
    }
    return Object.keys(delta).length === 0 ? null : delta;
  }

  function longTasksOverlapping(startMs, endMs) {
    return longTasks
      .filter(task => task.startMs < endMs && task.startMs + task.durationMs > startMs)
      .map(task => ({ ...task }));
  }

  function recordLongTask(entry) {
    longTasks.push(entry);
    if (longTasks.length > longTaskHistorySize) {
      longTasks.splice(0, longTasks.length - longTaskHistorySize);
      droppedLongTasks += 1;
    }
  }

  function startObserver() {
    if (observer != null || typeof performanceObserver !== 'function') return;
    try {
      observer = performanceObserver(entries => {
        for (const entry of entries) {
          recordLongTask({
            startMs: entry.startTime,
            durationMs: entry.duration,
            name: entry.name ?? 'unknown',
            attribution: Array.isArray(entry.attribution)
              ? entry.attribution
                .map(item => item?.name ?? item?.containerName ?? null)
                .filter(Boolean)
              : [],
          });
        }
      });
    } catch (error) {
      observer = null;
      observerError = error?.message ?? String(error);
    }
  }

  function stopObserver() {
    try {
      observer?.disconnect?.();
    } catch (error) {
      observerError = error?.message ?? String(error);
    }
    observer = null;
  }

  function frameStart(nowMs) {
    if (!enabled || !Number.isFinite(nowMs)) return null;
    frames += 1;
    const context = readContext();
    let hitch = null;

    if (previousStartMs != null && previousEndMs != null) {
      const intervalMs = nowMs - previousStartMs;
      if (intervalMs > worstIntervalMs) worstIntervalMs = intervalMs;
      if (intervalMs >= hitchMs) {
        const workMs = Math.max(0, previousEndMs - previousStartMs);
        const gapMs = Math.max(0, nowMs - previousEndMs);
        hitch = {
          frame: frames - 1,
          atMs: previousStartMs,
          intervalMs,
          workMs,
          gapMs,
          // The larger half is what actually stole the frame. Ties fall to
          // in-frame because render() is the side we can instrument further.
          source: workMs >= gapMs ? 'in-frame' : 'off-loop',
          context: contextDelta(previousContext, context),
          longTasks: longTasksOverlapping(previousEndMs, nowMs),
        };
        hitches.push(hitch);
        if (hitches.length > historySize) hitches.splice(0, hitches.length - historySize);
        totalHitchMs += intervalMs;
      }
    }

    previousStartMs = nowMs;
    previousContext = context;
    return hitch;
  }

  function frameEnd(nowMs) {
    if (!enabled || !Number.isFinite(nowMs)) return;
    previousEndMs = nowMs;
  }

  function getReport() {
    const inFrame = hitches.filter(hitch => hitch.source === 'in-frame');
    const offLoop = hitches.filter(hitch => hitch.source === 'off-loop');
    const worstHitch = hitches.reduce(
      (worst, hitch) => (worst == null || hitch.intervalMs > worst.intervalMs ? hitch : worst),
      null,
    );
    return {
      enabled,
      hitchMs,
      frames,
      hitchCount: hitches.length,
      inFrameCount: inFrame.length,
      offLoopCount: offLoop.length,
      worstIntervalMs,
      totalHitchMs,
      droppedLongTasks,
      longTaskObserver: observer != null,
      observerError,
      contextErrorCount,
      contextLastError,
      worstHitch: worstHitch == null ? null : { ...worstHitch },
      hitches: hitches.map(hitch => ({ ...hitch })),
    };
  }

  return {
    frameStart,
    frameEnd,
    getReport,
    get enabled() { return enabled; },
    setEnabled(value) {
      const next = Boolean(value);
      if (next === enabled) return enabled;
      enabled = next;
      if (enabled) startObserver();
      else stopObserver();
      // A stale boundary would charge the first frame after a pause with all
      // the idle time in between.
      previousStartMs = null;
      previousEndMs = null;
      previousContext = null;
      return enabled;
    },
    clear() {
      hitches.length = 0;
      longTasks.length = 0;
      frames = 0;
      droppedLongTasks = 0;
      worstIntervalMs = 0;
      totalHitchMs = 0;
      contextErrorCount = 0;
      contextLastError = null;
      previousStartMs = null;
      previousEndMs = null;
      previousContext = null;
    },
    dispose() {
      stopObserver();
      hitches.length = 0;
      longTasks.length = 0;
    },
  };
}
