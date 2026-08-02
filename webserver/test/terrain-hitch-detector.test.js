import test from 'node:test';
import assert from 'node:assert/strict';

import { createTerrainHitchDetector } from '../terrain-hitch-detector.js';

function runFrames(detector, frames) {
  for (const [startMs, endMs] of frames) {
    detector.frameStart(startMs);
    detector.frameEnd(endMs);
  }
}

test('reports no hitches while frames stay under the threshold', () => {
  const detector = createTerrainHitchDetector({ hitchMs: 50 });
  detector.setEnabled(true);
  runFrames(detector, [[0, 8], [16, 24], [32, 40], [48, 56]]);

  const report = detector.getReport();
  assert.equal(report.hitchCount, 0);
  assert.equal(report.frames, 4);
  assert.ok(report.worstIntervalMs < 50);
});

test('blames in-frame work when render() itself ran long', () => {
  const detector = createTerrainHitchDetector({ hitchMs: 50 });
  detector.setEnabled(true);
  // Frame 2 spends 120ms inside render() before the next frame starts.
  runFrames(detector, [[0, 8], [16, 136], [140, 148]]);

  const report = detector.getReport();
  assert.equal(report.hitchCount, 1);
  assert.equal(report.inFrameCount, 1);
  assert.equal(report.offLoopCount, 0);

  const [hitch] = report.hitches;
  assert.equal(hitch.source, 'in-frame');
  assert.equal(hitch.intervalMs, 124);
  assert.equal(hitch.workMs, 120);
  assert.equal(hitch.gapMs, 4);
});

test('blames off-loop work when the thread was seized between frames', () => {
  const detector = createTerrainHitchDetector({ hitchMs: 50 });
  detector.setEnabled(true);
  // render() was quick, but 180ms elapsed before the next frame began.
  runFrames(detector, [[0, 8], [16, 24], [204, 212]]);

  const report = detector.getReport();
  assert.equal(report.hitchCount, 1);
  assert.equal(report.offLoopCount, 1);

  const [hitch] = report.hitches;
  assert.equal(hitch.source, 'off-loop');
  assert.equal(hitch.workMs, 8);
  assert.equal(hitch.gapMs, 180);
});

test('attaches the context delta accumulated across a hitch', () => {
  let programs = 10;
  let tiles = 4;
  const detector = createTerrainHitchDetector({
    hitchMs: 50,
    sampleContext: () => ({ programs, tiles }),
  });
  detector.setEnabled(true);

  detector.frameStart(0);
  detector.frameEnd(8);
  // Six new shader programs and three tiles appeared during the stall.
  programs += 6;
  tiles += 3;
  detector.frameStart(200);
  detector.frameEnd(208);

  const [hitch] = detector.getReport().hitches;
  assert.deepEqual(hitch.context, { programs: 6, tiles: 3 });
});

test('omits the context delta when nothing changed', () => {
  const detector = createTerrainHitchDetector({
    hitchMs: 50,
    sampleContext: () => ({ programs: 10 }),
  });
  detector.setEnabled(true);
  runFrames(detector, [[0, 8], [200, 208]]);

  const [hitch] = detector.getReport().hitches;
  assert.equal(hitch.context, null);
});

test('survives a throwing context sampler', () => {
  const detector = createTerrainHitchDetector({
    hitchMs: 50,
    sampleContext: () => { throw new Error('renderer disposed'); },
  });
  detector.setEnabled(true);
  runFrames(detector, [[0, 8], [200, 208]]);

  const report = detector.getReport();
  assert.equal(report.hitchCount, 1);
  assert.equal(report.hitches[0].context, null);
});

test('attaches long tasks that overlap the off-loop gap', () => {
  let emit = null;
  const detector = createTerrainHitchDetector({
    hitchMs: 50,
    performanceObserver: callback => {
      emit = callback;
      return { disconnect() {} };
    },
  });
  detector.setEnabled(true);

  detector.frameStart(0);
  detector.frameEnd(8);
  emit([
    { name: 'self', duration: 150, startTime: 20, attribution: [{ name: 'decode' }] },
    // Well after the gap closes — must not be attributed to this hitch.
    { name: 'self', duration: 10, startTime: 900, attribution: [] },
  ]);
  detector.frameStart(200);

  const [hitch] = detector.getReport().hitches;
  assert.equal(hitch.longTasks.length, 1);
  assert.equal(hitch.longTasks[0].durationMs, 150);
  assert.deepEqual(hitch.longTasks[0].attribution, ['decode']);
});

test('does not charge the first frame after re-enabling with idle time', () => {
  const detector = createTerrainHitchDetector({ hitchMs: 50 });
  detector.setEnabled(true);
  runFrames(detector, [[0, 8]]);

  detector.setEnabled(false);
  detector.setEnabled(true);
  // Ten seconds of idle passed while disabled; this must not read as a hitch.
  runFrames(detector, [[10000, 10008], [10016, 10024]]);

  assert.equal(detector.getReport().hitchCount, 0);
});

test('ignores frames while disabled', () => {
  const detector = createTerrainHitchDetector({ hitchMs: 50 });
  runFrames(detector, [[0, 8], [500, 508]]);

  const report = detector.getReport();
  assert.equal(report.frames, 0);
  assert.equal(report.hitchCount, 0);
});

test('bounds retained hitches to the history size', () => {
  const detector = createTerrainHitchDetector({ hitchMs: 50, historySize: 3 });
  detector.setEnabled(true);
  for (let index = 0; index < 10; index += 1) {
    detector.frameStart(index * 200);
    detector.frameEnd(index * 200 + 8);
  }

  const report = detector.getReport();
  assert.equal(report.hitches.length, 3);
  assert.equal(report.hitchCount, 3);
  // Counters keep accumulating even though samples are dropped.
  assert.equal(report.frames, 10);
});

test('worstHitch tracks the largest interval seen', () => {
  const detector = createTerrainHitchDetector({ hitchMs: 50 });
  detector.setEnabled(true);
  runFrames(detector, [[0, 8], [100, 108], [400, 408], [460, 468]]);

  const report = detector.getReport();
  assert.equal(report.worstHitch.intervalMs, 300);
  assert.equal(report.worstIntervalMs, 300);
});

test('clear() resets counters and samples', () => {
  const detector = createTerrainHitchDetector({ hitchMs: 50 });
  detector.setEnabled(true);
  runFrames(detector, [[0, 8], [200, 208]]);
  detector.clear();

  const report = detector.getReport();
  assert.equal(report.hitchCount, 0);
  assert.equal(report.frames, 0);
  assert.equal(report.worstIntervalMs, 0);
});

test('rejects a non-positive threshold', () => {
  assert.throws(() => createTerrainHitchDetector({ hitchMs: 0 }), RangeError);
});
