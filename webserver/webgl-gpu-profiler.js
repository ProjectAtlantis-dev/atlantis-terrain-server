const DEFAULT_SAMPLE_INTERVAL = 30;
const DEFAULT_HISTORY_SIZE = 60;
const MAX_PENDING_QUERIES = 32;

function renderInfoSnapshot(renderer) {
  const render = renderer?.info?.render;
  return {
    calls: render?.calls ?? 0,
    triangles: render?.triangles ?? 0,
    points: render?.points ?? 0,
    lines: render?.lines ?? 0,
  };
}

function renderInfoDelta(before, after) {
  return Object.fromEntries(
    Object.keys(before).map(key => [key, Math.max(0, after[key] - before[key])]),
  );
}

function mean(values) {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Low-overhead, asynchronous EXT_disjoint_timer_query_webgl2 profiler.
 * A sampled frame times every registered composer pass; query results are
 * collected later so profiling never waits for the GPU.
 */
export function createWebGLGpuProfiler(renderer, {
  enabled = false,
  sampleInterval = DEFAULT_SAMPLE_INTERVAL,
  historySize = DEFAULT_HISTORY_SIZE,
} = {}) {
  const gl = renderer.getContext();
  const extension = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const supported = extension != null
    && typeof gl.createQuery === 'function'
    && typeof gl.beginQuery === 'function';
  const histories = new Map();
  const pending = [];
  let activeQuery = null;
  let activeName = null;
  let activeRenderInfo = null;
  let frame = 0;
  let samplingFrame = false;
  let samplingWholeFrame = false;
  let sampledFrameCount = 0;
  let isEnabled = Boolean(enabled && supported);
  let interval = Math.max(1, Math.round(sampleInterval));
  let maxHistory = Math.max(1, Math.round(historySize));
  let disjointCount = 0;
  let previousInfoAutoReset = null;

  function restoreRenderInfoReset() {
    if (previousInfoAutoReset == null || renderer?.info == null) return;
    renderer.info.autoReset = previousInfoAutoReset;
    previousInfoAutoReset = null;
  }

  function clearPending() {
    if (activeQuery != null) {
      try { gl.endQuery(extension.TIME_ELAPSED_EXT); } catch (_) {}
      gl.deleteQuery(activeQuery);
    }
    activeQuery = null;
    activeName = null;
    activeRenderInfo = null;
    for (const item of pending) gl.deleteQuery(item.query);
    pending.length = 0;
  }

  function poll() {
    if (!supported || pending.length === 0) return;
    if (gl.getParameter(extension.GPU_DISJOINT_EXT)) {
      disjointCount += 1;
      clearPending();
      return;
    }
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const item = pending[index];
      if (!gl.getQueryParameter(item.query, gl.QUERY_RESULT_AVAILABLE)) continue;
      const durationNs = gl.getQueryParameter(item.query, gl.QUERY_RESULT);
      gl.deleteQuery(item.query);
      pending.splice(index, 1);
      if (!Number.isFinite(durationNs)) continue;
      const history = histories.get(item.name) ?? [];
      history.push({
        frame: item.frame,
        ms: durationNs / 1e6,
        ...item.renderInfo,
      });
      if (history.length > maxHistory) history.splice(0, history.length - maxHistory);
      histories.set(item.name, history);
    }
  }

  function beginFrame() {
    frame += 1;
    poll();
    samplingFrame = isEnabled
      && activeQuery == null
      && pending.length <= MAX_PENDING_QUERIES - 4
      && frame % interval === 0;
    if (samplingFrame && renderer?.info != null) {
      previousInfoAutoReset = renderer.info.autoReset;
      renderer.info.autoReset = false;
      renderer.info.reset?.();
    }
    if (samplingFrame) {
      sampledFrameCount += 1;
      samplingWholeFrame = sampledFrameCount % 2 === 0;
      if (samplingWholeFrame) beginPass('whole-frame');
    }
  }

  function endFrame() {
    if (activeQuery != null) endPass();
    samplingFrame = false;
    samplingWholeFrame = false;
    restoreRenderInfoReset();
  }

  function beginPass(name) {
    if (
      !samplingFrame
      || activeQuery != null
      || (samplingWholeFrame && name !== 'whole-frame')
    ) return false;
    const query = gl.createQuery();
    if (query == null) return false;
    activeQuery = query;
    activeName = name;
    activeRenderInfo = renderInfoSnapshot(renderer);
    gl.beginQuery(extension.TIME_ELAPSED_EXT, query);
    return true;
  }

  function endPass() {
    if (activeQuery == null) return;
    gl.endQuery(extension.TIME_ELAPSED_EXT);
    pending.push({
      query: activeQuery,
      name: activeName,
      frame,
      renderInfo: renderInfoDelta(activeRenderInfo, renderInfoSnapshot(renderer)),
    });
    activeQuery = null;
    activeName = null;
    activeRenderInfo = null;
  }

  function wrapPass(pass, name) {
    const render = pass.render.bind(pass);
    pass.render = (...args) => {
      if (!beginPass(name)) return render(...args);
      try {
        return render(...args);
      } finally {
        endPass();
      }
    };
    return pass;
  }

  function getSummary() {
    const passes = {};
    let measuredTotalMs = 0;
    for (const [name, history] of histories) {
      const durations = history.map(sample => sample.ms);
      const latest = history.at(-1);
      const summary = {
        samples: history.length,
        latestMs: latest.ms,
        averageMs: mean(durations),
        maxMs: Math.max(...durations),
        averageCalls: mean(history.map(sample => sample.calls)),
        averageTriangles: mean(history.map(sample => sample.triangles)),
        latestCalls: latest.calls,
        latestTriangles: latest.triangles,
        latestFrame: latest.frame,
      };
      if (name !== 'whole-frame') measuredTotalMs += summary.averageMs;
      passes[name] = summary;
    }
    for (const summary of Object.values(passes)) {
      summary.percent = measuredTotalMs > 0 ? summary.averageMs / measuredTotalMs * 100 : 0;
    }
    if (passes['whole-frame'] != null) passes['whole-frame'].percent = 100;
    return {
      supported,
      enabled: isEnabled,
      sampleInterval: interval,
      pendingQueries: pending.length,
      disjointCount,
      measuredTotalAverageMs: measuredTotalMs,
      wholeFrameAverageMs: passes['whole-frame']?.averageMs ?? null,
      passes,
    };
  }

  return {
    get supported() { return supported; },
    beginFrame,
    endFrame,
    wrapPass,
    setEnabled(value) {
      isEnabled = Boolean(value && supported);
      if (!isEnabled) {
        clearPending();
        restoreRenderInfoReset();
      }
      return isEnabled;
    },
    setSampleInterval(value) {
      if (!Number.isFinite(value) || value < 1) throw new RangeError('sample interval must be at least 1 frame');
      interval = Math.round(value);
      return interval;
    },
    clear() {
      clearPending();
      restoreRenderInfoReset();
      histories.clear();
      disjointCount = 0;
    },
    getSummary,
    dispose() {
      clearPending();
      restoreRenderInfoReset();
      histories.clear();
    },
  };
}
