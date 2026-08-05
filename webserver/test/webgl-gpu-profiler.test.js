import assert from 'node:assert/strict';
import test from 'node:test';

import { createWebGLGpuProfiler } from '../webgl-gpu-profiler.js';

function createFakeRenderer({ supported = true } = {}) {
  let nextQueryId = 1;
  let activeQuery = null;
  const deleted = [];
  const extension = supported
    ? { TIME_ELAPSED_EXT: 0x88BF, GPU_DISJOINT_EXT: 0x8FBB }
    : null;
  const gl = {
    drawingBufferWidth: 1920,
    drawingBufferHeight: 1080,
    QUERY_RESULT_AVAILABLE: 0x8867,
    QUERY_RESULT: 0x8866,
    getExtension: name => name === 'EXT_disjoint_timer_query_webgl2' ? extension : null,
    createQuery: () => ({ id: nextQueryId++, available: true, durationNs: 2_500_000 }),
    beginQuery(_target, query) { activeQuery = query; },
    endQuery() { activeQuery = null; },
    deleteQuery(query) { deleted.push(query.id); },
    getParameter: () => false,
    getQueryParameter(query, parameter) {
      return parameter === this.QUERY_RESULT_AVAILABLE ? query.available : query.durationNs;
    },
  };
  return {
    renderer: {
      info: {
        autoReset: true,
        render: { calls: 0, triangles: 0, points: 0, lines: 0 },
        reset() {
          Object.assign(this.render, { calls: 0, triangles: 0, points: 0, lines: 0 });
        },
      },
      getContext: () => gl,
    },
    gl,
    deleted,
    get activeQuery() { return activeQuery; },
  };
}

test('GPU profiler samples wrapped passes without synchronously waiting for results', () => {
  const fake = createFakeRenderer();
  const profiler = createWebGLGpuProfiler(fake.renderer, {
    enabled: true,
    sampleInterval: 1,
  });
  const pass = profiler.wrapPass({
    render() {
      fake.renderer.info.render.calls += 3;
      fake.renderer.info.render.triangles += 120;
    },
  }, 'scene');

  profiler.beginFrame();
  pass.render();
  profiler.endFrame();
  assert.equal(profiler.getSummary().pendingQueries, 1);

  profiler.beginFrame();
  const summary = profiler.getSummary();
  assert.equal(summary.supported, true);
  assert.equal(summary.passes.scene.latestMs, 2.5);
  assert.equal(summary.passes.scene.averageCalls, 3);
  assert.equal(summary.passes.scene.averageTriangles, 120);
  assert.equal(summary.passes.scene.latestWidth, 1920);
  assert.equal(summary.passes.scene.latestHeight, 1080);
  assert.ok(Math.abs(summary.passes.scene.averageMegapixels - 2.0736) < 1e-9);
  assert.ok(Math.abs(summary.passes.scene.averageMsPerMegapixel - (2.5 / 2.0736)) < 1e-9);
  assert.equal(summary.passes.scene.percent, 100);
  assert.deepEqual(fake.deleted, [1]);

  pass.render();
  profiler.endFrame();
  profiler.beginFrame();
  const summaryWithWholeFrame = profiler.getSummary();
  assert.equal(summaryWithWholeFrame.wholeFrameAverageMs, 2.5);
  assert.equal(summaryWithWholeFrame.passes['whole-frame'].averageMs, 2.5);
  profiler.endFrame();
});

test('GPU profiler remains inert when timer queries are unavailable', () => {
  const fake = createFakeRenderer({ supported: false });
  const profiler = createWebGLGpuProfiler(fake.renderer, { enabled: true, sampleInterval: 1 });
  let renders = 0;
  const pass = profiler.wrapPass({ render() { renders += 1; } }, 'scene');

  profiler.beginFrame();
  pass.render();
  profiler.endFrame();

  assert.equal(renders, 1);
  assert.deepEqual(profiler.getSummary(), {
    supported: false,
    enabled: false,
    sampleInterval: 1,
    pendingQueries: 0,
    disjointCount: 0,
    cleanupErrorCount: 0,
    measuredTotalAverageMs: 0,
    wholeFrameAverageMs: null,
    passes: {},
  });
});

test('GPU profiler exposes query cleanup failures', () => {
  const fake = createFakeRenderer();
  const profiler = createWebGLGpuProfiler(fake.renderer, {
    enabled: true,
    sampleInterval: 1,
  });
  // The second sampled frame is the whole-frame query, which remains active
  // until endFrame. Disabling mid-frame forces clearPending to close it.
  profiler.beginFrame();
  profiler.endFrame();
  profiler.beginFrame();
  fake.gl.endQuery = () => { throw new Error('lost WebGL context'); };

  profiler.setEnabled(false);

  assert.equal(profiler.getSummary().cleanupErrorCount, 1);
});

test('GPU profiler alternates aggregate and nested detail pass samples', () => {
  const fake = createFakeRenderer();
  const profiler = createWebGLGpuProfiler(fake.renderer, {
    enabled: true,
    sampleInterval: 1,
  });
  const detail = profiler.wrapPass({ render() {} }, 'takram.cloud-march', {
    level: 'detail',
    parent: 'clouds+aerial-perspective',
  });
  const aggregate = profiler.wrapPass({
    render() { detail.render(); },
  }, 'clouds+aerial-perspective');

  // Aggregate phase: the outer pass owns the query, detail remains inert.
  profiler.beginFrame();
  aggregate.render();
  profiler.endFrame();

  // Whole-frame phase: neither wrapper attempts a nested query.
  profiler.beginFrame();
  aggregate.render();
  profiler.endFrame();

  // Detail phase: aggregate remains inert and the Takram stage owns the query.
  profiler.beginFrame();
  aggregate.render();
  profiler.endFrame();

  // Poll all three results.
  profiler.beginFrame();
  const summary = profiler.getSummary();
  assert.equal(summary.passes['clouds+aerial-perspective'].averageMs, 2.5);
  assert.equal(summary.passes['takram.cloud-march'].averageMs, 2.5);
  assert.equal(summary.passes['takram.cloud-march'].level, 'detail');
  assert.equal(
    summary.passes['takram.cloud-march'].parent,
    'clouds+aerial-perspective',
  );
  assert.equal(summary.passes['takram.cloud-march'].percent, 100);
  assert.equal(summary.measuredTotalAverageMs, 2.5);
  profiler.endFrame();
});

test('GPU profiler can instrument non-render methods', () => {
  const fake = createFakeRenderer();
  const profiler = createWebGLGpuProfiler(fake.renderer, {
    enabled: true,
    sampleInterval: 1,
  });
  let updates = 0;
  const simulation = profiler.wrapMethod({
    update() {
      updates += 1;
      fake.renderer.info.render.calls += 2;
    },
  }, 'update', 'water.fft');

  profiler.beginFrame();
  simulation.update();
  profiler.endFrame();
  profiler.beginFrame();

  const summary = profiler.getSummary();
  assert.equal(updates, 1);
  assert.equal(summary.passes['water.fft'].averageMs, 2.5);
  assert.equal(summary.passes['water.fft'].averageCalls, 2);
  profiler.endFrame();
});
