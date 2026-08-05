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
  const detailNames = [];
  let activeQuery = null;
  let activeName = null;
  let activeLevel = null;
  let activeParent = null;
  let activeRenderInfo = null;
  let activeDimensions = null;
  let frame = 0;
  let samplingFrame = false;
  let samplingWholeFrame = false;
  let samplingLevel = null;
  let samplingDetailName = null;
  let sampledFrameCount = 0;
  let sampledDetailCount = 0;
  let isEnabled = Boolean(enabled && supported);
  let interval = Math.max(1, Math.round(sampleInterval));
  let maxHistory = Math.max(1, Math.round(historySize));
  let disjointCount = 0;
  let cleanupErrorCount = 0;
  let previousInfoAutoReset = null;

  function restoreRenderInfoReset() {
    if (previousInfoAutoReset == null || renderer?.info == null) return;
    renderer.info.autoReset = previousInfoAutoReset;
    previousInfoAutoReset = null;
  }

  function clearPending() {
    if (activeQuery != null) {
      try {
        gl.endQuery(extension.TIME_ELAPSED_EXT);
      } catch (error) {
        cleanupErrorCount += 1;
      }
      gl.deleteQuery(activeQuery);
    }
    activeQuery = null;
    activeName = null;
    activeLevel = null;
    activeParent = null;
    activeRenderInfo = null;
    activeDimensions = null;
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
        level: item.level,
        parent: item.parent,
        width: item.dimensions?.width ?? 0,
        height: item.dimensions?.height ?? 0,
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
      // Timer queries cannot be nested. Alternate aggregate composer timings
      // with whole-frame timing and detail timings so an instrumented effect
      // can expose its internal passes without hiding its aggregate cost.
      const phase = sampledFrameCount % 3;
      samplingWholeFrame = phase === 2;
      samplingLevel = phase === 0 ? 'detail' : 'top';
      samplingDetailName = samplingLevel === 'detail' && detailNames.length > 0
        ? detailNames[sampledDetailCount++ % detailNames.length]
        : null;
      if (samplingWholeFrame) beginPass('whole-frame');
    }
  }

  function endFrame() {
    if (activeQuery != null) endPass();
    samplingFrame = false;
    samplingWholeFrame = false;
    samplingLevel = null;
    samplingDetailName = null;
    restoreRenderInfoReset();
  }

  function beginPass(name, {
    level = 'top',
    parent = null,
    dimensions = null,
  } = {}) {
    if (
      !samplingFrame
      || activeQuery != null
      || (samplingWholeFrame && name !== 'whole-frame')
      || (!samplingWholeFrame && level !== samplingLevel)
      || (level === 'detail' && name !== samplingDetailName)
    ) return false;
    const query = gl.createQuery();
    if (query == null) return false;
    activeQuery = query;
    activeName = name;
    activeLevel = level;
    activeParent = parent;
    activeRenderInfo = renderInfoSnapshot(renderer);
    activeDimensions = dimensions ?? {
      width: gl.drawingBufferWidth ?? 0,
      height: gl.drawingBufferHeight ?? 0,
    };
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
      dimensions: activeDimensions,
      level: activeLevel,
      parent: activeParent,
    });
    activeQuery = null;
    activeName = null;
    activeLevel = null;
    activeParent = null;
    activeRenderInfo = null;
    activeDimensions = null;
  }

  function wrapMethod(target, methodName, name, options = {}) {
    if (options.level === 'detail' && !detailNames.includes(name)) {
      detailNames.push(name);
    }
    const method = target[methodName].bind(target);
    target[methodName] = (...args) => {
      // ShaderPass.render(renderer, input, output) exposes the actual target.
      // This distinguishes Takram's quarter-resolution march from its
      // full-resolution temporal resolve in resized-window profiles.
      const outputTarget = args[2];
      const dimensions = outputTarget?.width > 0 && outputTarget?.height > 0
        ? { width: outputTarget.width, height: outputTarget.height }
        : null;
      if (!beginPass(name, { ...options, dimensions })) return method(...args);
      try {
        return method(...args);
      } finally {
        endPass();
      }
    };
    return target;
  }

  function wrapPass(pass, name, options = {}) {
    return wrapMethod(pass, 'render', name, options);
  }

  function getSummary() {
    const passes = {};
    let measuredTotalMs = 0;
    for (const [name, history] of histories) {
      const durations = history.map(sample => sample.ms);
      const latest = history.at(-1);
      const megapixels = history.map(sample => (
        (sample.width ?? 0) * (sample.height ?? 0) / 1e6
      ));
      const msPerMegapixel = history.flatMap((sample, index) => (
        megapixels[index] > 0 ? [sample.ms / megapixels[index]] : []
      ));
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
        latestWidth: latest.width ?? 0,
        latestHeight: latest.height ?? 0,
        averageMegapixels: mean(megapixels),
        averageMsPerMegapixel: msPerMegapixel.length > 0
          ? mean(msPerMegapixel)
          : null,
        level: latest.level ?? 'top',
        parent: latest.parent ?? null,
      };
      if (name !== 'whole-frame' && summary.level !== 'detail') {
        measuredTotalMs += summary.averageMs;
      }
      passes[name] = summary;
    }
    for (const summary of Object.values(passes)) {
      const parentAverage = summary.parent != null
        ? passes[summary.parent]?.averageMs
        : null;
      summary.percent = parentAverage > 0
        ? summary.averageMs / parentAverage * 100
        : measuredTotalMs > 0
          ? summary.averageMs / measuredTotalMs * 100
          : 0;
    }
    if (passes['whole-frame'] != null) passes['whole-frame'].percent = 100;
    return {
      supported,
      enabled: isEnabled,
      sampleInterval: interval,
      pendingQueries: pending.length,
      disjointCount,
      cleanupErrorCount,
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
    wrapMethod,
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
      cleanupErrorCount = 0;
    },
    getSummary,
    dispose() {
      clearPending();
      restoreRenderInfoReset();
      histories.clear();
    },
  };
}
