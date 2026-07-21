export const FAST_TIME_SCALE = 10 * 60;
export const GAME_CLOCK_TIME_ZONE = 'America/Nuuk';

const dateTimeFormatters = new Map();

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
