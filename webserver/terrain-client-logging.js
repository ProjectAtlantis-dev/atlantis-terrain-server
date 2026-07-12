export function createTerrainClientLogger({
  sceneMode,
  endpoint = '/api/client_log',
  enabled = true,
  batchSize = 40,
  maxQueue = 600,
  flushMs = 800,
  windowRef = window,
  navigatorRef = navigator,
  fetchImpl = fetch,
  performanceRef = performance,
} = {}) {
  const queue = [];
  const bootEvents = [];
  const bootStartMs = performanceRef.now();
  let inFlight = false;
  let flushTimer = null;

  function safeDetails(details) {
    if (details === undefined) return undefined;
    try {
      return JSON.parse(JSON.stringify(details));
    } catch (_) {
      try {
        return { nonSerializable: true, text: String(details) };
      } catch (__ignored) {
        return { nonSerializable: true };
      }
    }
  }

  function trimQueue() {
    if (queue.length > maxQueue) {
      queue.splice(0, queue.length - maxQueue);
    }
  }

  function scheduleFlush(delayMs = flushMs) {
    if (!enabled || flushTimer != null) return;
    flushTimer = windowRef.setTimeout(() => {
      flushTimer = null;
      flush();
    }, delayMs);
  }

  function flush({ useBeacon = false } = {}) {
    if (!enabled || inFlight || queue.length === 0) return;
    const batch = queue.splice(0, batchSize);
    const body = JSON.stringify({ sceneMode, entries: batch });
    if (useBeacon && navigatorRef.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      if (!navigatorRef.sendBeacon(endpoint, blob)) queue.unshift(...batch);
      return;
    }
    inFlight = true;
    fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    })
      .then(response => {
        if (!response.ok) throw new Error(`client log status ${response.status}`);
      })
      .catch(error => {
        console.error('[CLIENT LOG] post failed', {
          endpoint,
          error: error?.message ?? String(error),
        });
        queue.unshift(...batch);
        trimQueue();
      })
      .finally(() => {
        inFlight = false;
        if (queue.length > 0) scheduleFlush(250);
      });
  }

  function enqueue(level, phase, details) {
    if (!enabled) return;
    const entry = { ts: new Date().toISOString(), level, phase };
    const normalized = safeDetails(details);
    if (normalized !== undefined) entry.details = normalized;
    queue.push(entry);
    trimQueue();
    if (queue.length >= batchSize) flush();
    else scheduleFlush();
  }

  function memorySnapshot() {
    const memory = performanceRef.memory;
    if (!memory) return null;
    return {
      jsHeapMB: Number((memory.usedJSHeapSize / (1024 * 1024)).toFixed(1)),
      jsHeapLimitMB: Number((memory.jsHeapSizeLimit / (1024 * 1024)).toFixed(1)),
    };
  }

  function bootLog(phase, details, level = 'info') {
    const elapsedMs = Number((performanceRef.now() - bootStartMs).toFixed(1));
    const entry = { elapsedMs, phase, level };
    if (details !== undefined) entry.details = details;
    const memory = memorySnapshot();
    if (memory != null) entry.memory = memory;
    bootEvents.push(entry);
    if (bootEvents.length > 300) bootEvents.shift();
    const compactDetails = { elapsedMs };
    if (details !== undefined) compactDetails.details = details;
    if (memory != null) compactDetails.memory = memory;
    enqueue(level, phase, compactDetails);
  }

  windowRef.addEventListener('beforeunload', () => flush({ useBeacon: true }));
  windowRef.addEventListener('error', event => bootLog('window.error', {
    message: event.message,
    source: event.filename,
    line: event.lineno,
    column: event.colno,
    stack: event.error?.stack ?? null,
  }, 'error'));
  windowRef.addEventListener('unhandledrejection', event => {
    const reason = event.reason;
    bootLog('window.unhandledrejection', {
      message: reason?.message ?? String(reason),
      stack: reason?.stack ?? null,
    }, 'error');
  });

  return {
    bootEvents,
    bootLog,
    enqueueClientLog: enqueue,
    flushClientLogQueue: flush,
    getBootEvents: () => bootEvents.slice(),
  };
}
