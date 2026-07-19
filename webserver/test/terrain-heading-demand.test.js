import assert from 'node:assert/strict';
import test from 'node:test';

import { createTerrainHeadingDemandController } from '../terrain-heading-demand.js';

test('heading demand waits for turning to settle and commits only the final heading', () => {
  const scheduled = new Map();
  const commits = [];
  let nextTimer = 1;
  const controller = createTerrainHeadingDemandController({
    initialHeading: 0,
    threshold: 2 * Math.PI / 180,
    settleMs: 200,
    onCommit: (previous, next) => commits.push([previous, next]),
    schedule(callback, delay) {
      const id = nextTimer++;
      scheduled.set(id, { callback, delay });
      return id;
    },
    cancel(id) { scheduled.delete(id); },
  });

  controller.observe(0.04);
  assert.equal(scheduled.size, 1);
  controller.observe(0.08);
  assert.equal(scheduled.size, 1);
  controller.observe(0.12);
  assert.equal(scheduled.size, 1);
  assert.deepEqual(commits, []);

  const pending = [...scheduled.values()][0];
  assert.equal(pending.delay, 200);
  pending.callback();
  assert.deepEqual(commits, [[0, 0.12]]);
});

test('heading demand preserves boot synchronization and ignores sub-threshold turns', () => {
  let scheduled = 0;
  const controller = createTerrainHeadingDemandController({
    initialHeading: 0,
    threshold: 0.1,
    settleMs: 200,
    onCommit() { throw new Error('unexpected commit'); },
    schedule() { scheduled += 1; return scheduled; },
    cancel() {},
  });

  controller.observe(1, { ready: false });
  controller.observe(1.05);
  assert.equal(controller.committedHeading, 1);
  assert.equal(scheduled, 0);
});
