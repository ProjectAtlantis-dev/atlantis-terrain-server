const DEFAULT_ENDPOINT = '/api/gpu-profile';
const DEFAULT_POLL_MS = 500;
const DRAIN_SAMPLE_INTERVAL = Number.MAX_SAFE_INTEGER;
const DRAIN_TIMEOUT_MS = 2000;

function nextAnimationFrame(windowRef) {
  return new Promise(resolve => {
    if (typeof windowRef.requestAnimationFrame === 'function') {
      windowRef.requestAnimationFrame(resolve);
    } else {
      windowRef.setTimeout(resolve, 16);
    }
  });
}

export function createTerrainGpuProfileControl({
  profiler,
  cpuProfiler = null,
  backend,
  endpoint = DEFAULT_ENDPOINT,
  pollMs = DEFAULT_POLL_MS,
  fetchImpl = fetch,
  windowRef = window,
  performanceRef = performance,
  waitForFrame = () => nextAnimationFrame(windowRef),
  log = () => {},
} = {}) {
  let activeProfile = null;
  let timer = null;
  let stopped = false;
  let polling = false;

  async function request(path = '', options = {}) {
    const response = await fetchImpl(`${endpoint}${path}`, {
      cache: 'no-store',
      ...options,
      headers: {
        ...(options.body == null ? {} : { 'Content-Type': 'application/json' }),
        ...options.headers,
      },
    });
    if (!response.ok) {
      const error = new Error(
        `GPU profile control ${path || 'poll'} failed (${response.status})`,
      );
      error.status = response.status;
      error.path = path;
      throw error;
    }
    return response.json();
  }

  async function report(profileId, phase, details = {}) {
    return request('/report', {
      method: 'POST',
      body: JSON.stringify({
        profileId,
        phase,
        client: {
          backend,
          supported: Boolean(profiler?.supported),
        },
        ...details,
      }),
    });
  }

  async function begin(control) {
    const { profileId, sampleInterval } = control;
    if (profiler == null) {
      await report(profileId, 'error', {
        error: `GPU pass timing is unavailable on the ${backend} backend`,
      });
      return;
    }

    profiler.clear();
    cpuProfiler?.clear();
    cpuProfiler?.setEnabled(true);
    profiler.setSampleInterval(sampleInterval);
    const enabled = profiler.setEnabled(true);
    const summary = profiler.getSummary();
    if (!enabled || !summary.supported) {
      cpuProfiler?.setEnabled(false);
      await report(profileId, 'error', {
        error: 'EXT_disjoint_timer_query_webgl2 is unavailable in this browser',
        result: summary,
      });
      return;
    }

    activeProfile = {
      profileId,
      stopping: false,
      acknowledged: false,
      result: null,
    };
    await report(profileId, 'running');
    activeProfile.acknowledged = true;
    log('gpu-profile.running', { profileId, sampleInterval });
  }

  async function finish(control) {
    if (activeProfile == null) return;
    if (!activeProfile.stopping) {
      activeProfile.stopping = true;
      profiler.setSampleInterval(DRAIN_SAMPLE_INTERVAL);

      const deadline = performanceRef.now() + DRAIN_TIMEOUT_MS;
      let summary = profiler.getSummary();
      while (summary.pendingQueries > 0 && performanceRef.now() < deadline) {
        await waitForFrame();
        summary = profiler.getSummary();
      }

      profiler.setEnabled(false);
      cpuProfiler?.setEnabled(false);
      activeProfile.result = cpuProfiler == null
        ? summary
        : { ...summary, cpu: cpuProfiler.getSummary() };
    }

    const profileId = activeProfile.profileId;
    const summary = activeProfile.result;
    await report(profileId, 'complete', { result: summary });
    activeProfile = null;
    log('gpu-profile.complete', {
      profileId,
      pendingQueries: summary.pendingQueries,
      wholeFrameAverageMs: summary.wholeFrameAverageMs,
    });
  }

  async function applyControl(control) {
    if (
      control.desiredEnabled
      && control.profileId != null
      && activeProfile?.profileId !== control.profileId
    ) {
      await begin(control);
      return;
    }
    if (
      control.desiredEnabled
      && activeProfile?.profileId === control.profileId
      && !activeProfile.acknowledged
    ) {
      await report(control.profileId, 'running');
      activeProfile.acknowledged = true;
      return;
    }
    if (
      !control.desiredEnabled
      && control.status === 'stopping'
      && activeProfile?.profileId === control.profileId
    ) {
      await finish(control);
    }
  }

  function schedule() {
    if (stopped || timer != null) return;
    timer = windowRef.setTimeout(() => {
      timer = null;
      poll();
    }, pollMs);
  }

  async function poll() {
    if (stopped || polling) return;
    polling = true;
    try {
      await applyControl(await request());
    } catch (error) {
      const unavailable = error?.status === 404 && error?.path === '';
      if (unavailable) stopped = true;
      log(unavailable ? 'gpu-profile.unavailable' : 'gpu-profile.control-error', {
        message: error?.message ?? String(error),
      });
    } finally {
      polling = false;
      schedule();
    }
  }

  return {
    start() {
      stopped = false;
      poll();
    },
    stop() {
      stopped = true;
      if (timer != null) windowRef.clearTimeout(timer);
      timer = null;
    },
    poll,
  };
}
