export const FAST_TIME_SCALE = 10 * 60;
export const GAME_CLOCK_TIME_ZONE = 'America/Nuuk';

const dateTimeFormatters = new Map();

export function parseGameClockSnapshot(
  rawValue,
  { fallbackGameTimeMs, defaultTimeScale = 1 } = {},
) {
  const fallback = {
    gameTimeMs: fallbackGameTimeMs,
    running: true,
    timeScale: defaultTimeScale,
    stopGameTimeMs: null,
  };
  if (rawValue == null || rawValue === '') return fallback;

  let saved;
  try {
    saved = JSON.parse(rawValue);
  } catch {
    return fallback;
  }

  // Older builds stored only the timestamp under game-clock-ms. Treat those
  // snapshots as running because they predate persisted transport state.
  if (Number.isFinite(saved)) {
    return { ...fallback, gameTimeMs: saved };
  }
  if (!saved || typeof saved !== 'object' || !Number.isFinite(saved.gameTimeMs)) {
    return fallback;
  }

  return {
    gameTimeMs: saved.gameTimeMs,
    running: typeof saved.running === 'boolean' ? saved.running : true,
    timeScale: Number.isFinite(saved.timeScale) && saved.timeScale > 0
      ? saved.timeScale
      : defaultTimeScale,
    stopGameTimeMs: Number.isFinite(saved.stopGameTimeMs)
      ? saved.stopGameTimeMs
      : null,
  };
}

export function serializeGameClockSnapshot({
  gameTimeMs,
  running,
  timeScale,
  stopGameTimeMs,
}) {
  return JSON.stringify({
    version: 1,
    gameTimeMs,
    running: Boolean(running),
    timeScale,
    stopGameTimeMs: Number.isFinite(stopGameTimeMs) ? stopGameTimeMs : null,
  });
}

function formatterFor(timeZone) {
  let formatter = dateTimeFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    });
    dateTimeFormatters.set(timeZone, formatter);
  }
  return formatter;
}

export function zonedDateParts(date, timeZone = GAME_CLOCK_TIME_ZONE) {
  return Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, Number(part.value)]),
  );
}

// Convert an unambiguous wall-clock time to an instant. Iterating the offset
// also keeps this correct when the selected date and the initial UTC guess are
// on opposite sides of a daylight-saving transition.
export function zonedDateTimeMs(parts, timeZone = GAME_CLOCK_TIME_ZONE) {
  const wallTimeMs = Date.UTC(
    parts.year, parts.month - 1, parts.day,
    parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0,
  );
  let instantMs = wallTimeMs;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedDateParts(new Date(instantMs), timeZone);
    const actualWallTimeMs = Date.UTC(
      actual.year, actual.month - 1, actual.day,
      actual.hour, actual.minute, actual.second,
    );
    const correctedMs = instantMs + wallTimeMs - actualWallTimeMs;
    if (correctedMs === instantMs) break;
    instantMs = correctedMs;
  }
  return instantMs;
}

export function getFastTimeRange(date, timeZone = GAME_CLOCK_TIME_ZONE) {
  const local = zonedDateParts(date, timeZone);
  const followingDate = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  const next = {
    year: followingDate.getUTCFullYear(),
    month: followingDate.getUTCMonth() + 1,
    day: followingDate.getUTCDate(),
  };
  return {
    startMs: zonedDateTimeMs({ ...local, hour: 3, minute: 0, second: 0 }, timeZone),
    endMs: zonedDateTimeMs({ ...next, hour: 3, minute: 0, second: 0 }, timeZone),
  };
}
