import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FAST_TIME_SCALE,
  getFastTimeRange,
  parseGameClockSnapshot,
  serializeGameClockSnapshot,
  zonedDateParts,
} from '../terrain-game-clock.js';

test('game clock snapshots preserve timestamp and transport state', () => {
  for (const snapshot of [
    {
      gameTimeMs: 1_751_371_200_000,
      running: false,
      timeScale: 1,
      stopGameTimeMs: null,
    },
    {
      gameTimeMs: 1_751_371_260_000,
      running: true,
      timeScale: FAST_TIME_SCALE,
      stopGameTimeMs: 1_751_457_600_000,
    },
  ]) {
    const serialized = serializeGameClockSnapshot(snapshot);
    assert.deepEqual(parseGameClockSnapshot(serialized, {
      fallbackGameTimeMs: 0,
    }), snapshot);
  }
});

test('legacy timestamp-only game clock snapshots resume running', () => {
  assert.deepEqual(parseGameClockSnapshot('1751371200000', {
    fallbackGameTimeMs: 0,
  }), {
    gameTimeMs: 1_751_371_200_000,
    running: true,
    timeScale: 1,
    stopGameTimeMs: null,
  });
});

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
