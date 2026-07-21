import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FAST_TIME_SCALE,
  getFastTimeRange,
  zonedDateParts,
} from '../terrain-game-clock.js';

test('fast time spans 03:00 to 03:00 on the following Nuuk-local day', () => {
  const { startMs, endMs } = getFastTimeRange(new Date('2025-07-01T12:00:00Z'));

  assert.deepEqual(zonedDateParts(new Date(startMs)), {
    year: 2025, month: 7, day: 1, hour: 3, minute: 0, second: 0,
  });
  assert.deepEqual(zonedDateParts(new Date(endMs)), {
    year: 2025, month: 7, day: 2, hour: 3, minute: 0, second: 0,
  });
  assert.equal((endMs - startMs) / FAST_TIME_SCALE, 144_000);
});
