type Level = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const rawLevel = (process.env.ASSET_LOG_LEVEL ?? "info").trim().toLowerCase();
const minLevel: Level = (rawLevel === "debug" || rawLevel === "info" || rawLevel === "warn" || rawLevel === "error")
  ? rawLevel
  : "info";

const forceColorRaw = (process.env.FORCE_COLOR ?? "").trim().toLowerCase();
const forceColorEnabled = forceColorRaw !== "" && forceColorRaw !== "0" && forceColorRaw !== "false";
const COLOR_ENABLED = forceColorEnabled || Boolean(process.stdout.isTTY);

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
};

const JSON_TOKEN_RE =
  /("(?:[^"\\]|\\.)*")\s*:|("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;

function color(text: string, code: string): string {
  if (!COLOR_ENABLED) {
    return text;
  }
  return `${code}${text}${ANSI.reset}`;
}

function levelTag(level: Level): string {
  const upper = level.toUpperCase();
  if (level === "debug") {
    return color(upper, ANSI.cyan);
  }
  if (level === "info") {
    return color(upper, ANSI.green);
  }
  if (level === "warn") {
    return color(upper, ANSI.yellow);
  }
  return color(upper, ANSI.red);
}

function colorizeJson(text: string): string {
  if (!COLOR_ENABLED) {
    return text;
  }
  return text.replace(JSON_TOKEN_RE, (match, key, stringVal, numberVal, boolNullVal) => {
    if (key != null) {
      return `${ANSI.cyan}${key}${ANSI.reset}:`;
    }
    if (stringVal != null) {
      return `${ANSI.yellow}${stringVal}${ANSI.reset}`;
    }
    if (numberVal != null) {
      return `${ANSI.green}${numberVal}${ANSI.reset}`;
    }
    if (boolNullVal != null) {
      return `${ANSI.magenta}${boolNullVal}${ANSI.reset}`;
    }
    return match;
  });
}

function normalizeMeta(meta: unknown): unknown {
  if (meta instanceof Error) {
    return {
      name: meta.name,
      message: meta.message,
      stack: meta.stack,
    };
  }
  return meta;
}

function splitPhase(meta: unknown): { phase: string | null; payload: unknown } {
  if (meta != null && typeof meta === "object" && !Array.isArray(meta)) {
    const obj = meta as Record<string, unknown>;
    const rawPhase = obj.phase;
    const phase = typeof rawPhase === "string" && rawPhase.trim() !== ""
      ? rawPhase.trim()
      : null;
    if (phase != null) {
      const payload = { ...obj };
      delete payload.phase;
      return { phase, payload };
    }
  }
  return { phase: null, payload: meta };
}

function formatMeta(meta: unknown): string {
  if (meta == null) {
    return "";
  }
  const normalized = normalizeMeta(meta);
  try {
    const pretty = JSON.stringify(normalized, null, 2);
    if (pretty == null) {
      return String(normalized);
    }
    return colorizeJson(pretty);
  } catch {
    try {
      return String(normalized);
    } catch {
      return "[unserializable]";
    }
  }
}

function shouldLog(level: Level): boolean {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[minLevel];
}

function emit(level: Level, message: string, meta?: unknown): void {
  if (!shouldLog(level)) {
    return;
  }

  const ts = new Date().toISOString();
  const tsText = COLOR_ENABLED ? color(ts, ANSI.dim) : ts;
  const tag = levelTag(level);
  const { phase, payload } = splitPhase(meta);
  const phaseText = phase == null ? "" : ` ${color(phase, ANSI.magenta)}`;
  const prefix = `[${tsText}] [ASSETSERVER] [${tag}]${phaseText}`;
  const formattedMeta = meta === undefined ? "" : formatMeta(payload);
  const line = formattedMeta
    ? `${prefix} ${message} ${formattedMeta}`
    : `${prefix} ${message}`;

  if (level === "warn") {
    console.warn(line);
    return;
  }
  if (level === "error") {
    console.error(line);
    return;
  }
  console.log(line);
}

export const log = {
  debug(message: string, meta?: unknown): void {
    emit("debug", message, meta);
  },
  info(message: string, meta?: unknown): void {
    emit("info", message, meta);
  },
  warn(message: string, meta?: unknown): void {
    emit("warn", message, meta);
  },
  error(message: string, meta?: unknown): void {
    emit("error", message, meta);
  },
};
