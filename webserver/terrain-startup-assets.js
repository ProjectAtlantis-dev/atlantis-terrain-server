export function defaultTerrainStartupAssets() {
  return {
    vehicle_definition: {},
    vehicle_instances: [],
  };
}

export function normalizeTerrainStartupAssets(payload) {
  const normalized = defaultTerrainStartupAssets();
  if (payload == null || typeof payload !== 'object') return normalized;

  if (payload.vehicle_definition != null && typeof payload.vehicle_definition === 'object') {
    normalized.vehicle_definition = { ...payload.vehicle_definition };
  }
  if (Array.isArray(payload.vehicle_instances)) {
    normalized.vehicle_instances = payload.vehicle_instances
      .filter(value => value != null && typeof value === 'object')
      .map(value => ({ ...value }));
  }
  return normalized;
}

export async function loadTerrainStartupAssets({
  endpoint,
  timeoutMs = 1500,
  bootLog = () => {},
  fetchImpl = (...args) => fetch(...args),
  AbortControllerImpl = globalThis.AbortController,
  setTimeoutImpl = (...args) => globalThis.setTimeout(...args),
  clearTimeoutImpl = handle => globalThis.clearTimeout(handle),
} = {}) {
  const fallback = {
    source: 'defaults',
    schemaVersion: 4,
    seeded: null,
    ...defaultTerrainStartupAssets(),
  };
  try {
    const controller = typeof AbortControllerImpl === 'function'
      ? new AbortControllerImpl()
      : null;
    const timeoutHandle = controller != null
      ? setTimeoutImpl(() => controller.abort(), timeoutMs)
      : null;
    const response = await fetchImpl(endpoint, {
      cache: 'no-store',
      signal: controller?.signal,
    }).finally(() => {
      if (timeoutHandle != null) clearTimeoutImpl(timeoutHandle);
    });
    if (!response.ok) throw new Error(`assets endpoint status ${response.status}`);

    const payload = await response.json();
    const normalized = normalizeTerrainStartupAssets(payload);
    const source = typeof payload?.source === 'string' ? payload.source : 'metadata';
    const schemaVersion = Number.isFinite(payload?.schemaVersion) ? payload.schemaVersion : 4;
    bootLog('assets.fetch.ok', {
      endpoint,
      status: response.status,
      source,
      schemaVersion,
      vehicleCount: normalized.vehicle_instances.length,
    });
    return {
      source,
      schemaVersion,
      seeded: payload?.seeded ?? null,
      ...normalized,
    };
  } catch (error) {
    const details = {
      endpoint,
      timeoutMs,
      timedOut: error?.name === 'AbortError',
      error: error?.message ?? String(error),
    };
    bootLog('assets.fetch.fallback', details, 'warn');
    console.warn('[ASSETS] startup fallback', details);
    return fallback;
  }
}
