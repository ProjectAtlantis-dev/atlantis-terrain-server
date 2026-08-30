import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatBacklogAge,
  summarizeDemandBacklog,
} from '../terrain-demand-backlog.js';

test('terrain demand backlog reports idle without lane work', () => {
  assert.deepEqual(
    (({ severity, text }) => ({ severity, text }))(
      summarizeDemandBacklog({ lanes: {} }),
    ),
    { severity: 'idle', text: 'idle' },
  );
});

test('terrain backlog exposes starvation age, stale ownership, and drops', () => {
  const summary = summarizeDemandBacklog({
    lanes: {
      texture: {
        claimedActiveCount: 2,
        staleActiveCount: 1,
        pendingCount: 19,
        retryableFailureCount: 2,
        terminalFailureCount: 0,
        oldestActiveAgeMs: 12_000,
        oldestPendingAgeMs: 45_500,
        totals: { dropped: 31, ignored: 7 },
      },
    },
  });
  assert.equal(summary.severity, 'starved');
  assert.match(summary.text, /tex 2a\/19q oldest q 46s, a 12s/);
  assert.match(summary.text, /1 stale-active/);
  assert.match(summary.text, /31 superseded/);
  assert.match(summary.text, /7 stale HTTP ignored/);
});

test('terrain backlog formats ages compactly', () => {
  assert.equal(formatBacklogAge(2300), '2.3s');
  assert.equal(formatBacklogAge(72_000), '1.2m');
});
