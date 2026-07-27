import assert from 'node:assert/strict';
import test from 'node:test';

import { createTerrainGpuProfileControl } from '../terrain-gpu-profile-control.js';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

test('browser starts, drains, and reports a Flask-controlled GPU profile', async () => {
  const reports = [];
  const controls = [
    {
      profileId: 'profile-1',
      status: 'starting',
      desiredEnabled: true,
      sampleInterval: 4,
    },
    {
      profileId: 'profile-1',
      status: 'stopping',
      desiredEnabled: false,
      sampleInterval: 4,
    },
  ];
  let pendingQueries = 1;
  const intervals = [];
  const profiler = {
    supported: true,
    clearCalled: 0,
    enabled: false,
    clear() { this.clearCalled += 1; },
    setSampleInterval(value) { intervals.push(value); },
    setEnabled(value) { this.enabled = value; return value; },
    getSummary() {
      return {
        supported: true,
        enabled: this.enabled,
        pendingQueries,
        wholeFrameAverageMs: 6.5,
        passes: { scene: { averageMs: 4.5 } },
      };
    },
  };
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/report')) {
      reports.push(JSON.parse(options.body));
      return jsonResponse({ ok: true });
    }
    return jsonResponse(controls.shift());
  };
  const windowRef = {
    setTimeout() { return 1; },
    clearTimeout() {},
  };
  let now = 0;
  const control = createTerrainGpuProfileControl({
    profiler,
    backend: 'webgl',
    fetchImpl,
    windowRef,
    performanceRef: { now: () => now },
    waitForFrame: async () => {
      now += 16;
      pendingQueries = 0;
    },
  });

  await control.poll();
  assert.equal(profiler.clearCalled, 1);
  assert.equal(profiler.enabled, true);
  assert.equal(reports[0].phase, 'running');

  await control.poll();
  assert.equal(profiler.enabled, false);
  assert.deepEqual(intervals, [4, Number.MAX_SAFE_INTEGER]);
  assert.equal(reports[1].phase, 'complete');
  assert.equal(reports[1].result.pendingQueries, 0);
});

test('browser reports an unsupported renderer instead of starting', async () => {
  const reports = [];
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/report')) {
      reports.push(JSON.parse(options.body));
      return jsonResponse({ ok: true });
    }
    return jsonResponse({
      profileId: 'profile-webgpu',
      status: 'starting',
      desiredEnabled: true,
      sampleInterval: 10,
    });
  };
  const control = createTerrainGpuProfileControl({
    profiler: null,
    backend: 'webgpu',
    fetchImpl,
    windowRef: { setTimeout() { return 1; }, clearTimeout() {} },
  });

  await control.poll();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].phase, 'error');
  assert.match(reports[0].error, /webgpu/);
});

test('browser retries a completed result report without re-draining', async () => {
  let reportAttempts = 0;
  let summaryCalls = 0;
  const profiler = {
    supported: true,
    clear() {},
    setSampleInterval() {},
    setEnabled(value) { return value; },
    getSummary() {
      summaryCalls += 1;
      return {
        supported: true,
        pendingQueries: 0,
        wholeFrameAverageMs: 7,
        passes: {},
      };
    },
  };
  const controls = [
    {
      profileId: 'retry-profile',
      status: 'starting',
      desiredEnabled: true,
      sampleInterval: 2,
    },
    {
      profileId: 'retry-profile',
      status: 'stopping',
      desiredEnabled: false,
      sampleInterval: 2,
    },
    {
      profileId: 'retry-profile',
      status: 'stopping',
      desiredEnabled: false,
      sampleInterval: 2,
    },
  ];
  const fetchImpl = async (url, options = {}) => {
    if (!url.endsWith('/report')) return jsonResponse(controls.shift());
    const body = JSON.parse(options.body);
    if (body.phase === 'complete') {
      reportAttempts += 1;
      if (reportAttempts === 1) return jsonResponse({}, 503);
    }
    return jsonResponse({ ok: true });
  };
  const control = createTerrainGpuProfileControl({
    profiler,
    backend: 'webgl',
    fetchImpl,
    windowRef: { setTimeout() { return 1; }, clearTimeout() {} },
  });

  await control.poll();
  await control.poll();
  const callsAfterDrain = summaryCalls;
  await control.poll();

  assert.equal(reportAttempts, 2);
  assert.equal(summaryCalls, callsAfterDrain);
});
