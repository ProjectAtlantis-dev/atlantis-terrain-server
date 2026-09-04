export function normalizeTerrainStartupAssets(payload) {
  if (payload == null || typeof payload !== 'object') {
    throw new TypeError('asset catalog response must be an object');
  }
  if (typeof payload.source !== 'string' || payload.source.trim() === '') {
    throw new TypeError('asset catalog source must be a non-empty string');
  }
  if (!Number.isInteger(payload.schemaVersion)) {
    throw new TypeError('asset catalog schemaVersion must be an integer');
  }
  const definition = payload.vehicle_definition;
  if (definition == null || typeof definition !== 'object') {
    throw new TypeError('asset catalog vehicle_definition must be an object');
  }
  for (const key of ['realLengthM', 'tireDiameterM', 'altOffsetM']) {
    if (!Number.isFinite(definition[key])) {
      throw new TypeError(`asset catalog vehicle_definition.${key} must be finite`);
    }
  }
  if (typeof definition.url !== 'string' || definition.url.trim() === '') {
    throw new TypeError('asset catalog vehicle_definition.url must be a non-empty string');
  }
  if (!Array.isArray(payload.vehicle_instances) || payload.vehicle_instances.length === 0) {
    throw new TypeError('asset catalog must contain at least one vehicle instance');
  }
  const vehicleInstances = payload.vehicle_instances.map((value, index) => {
    if (value == null || typeof value !== 'object') {
      throw new TypeError(`asset catalog vehicle_instances[${index}] must be an object`);
    }
    if (typeof value.id !== 'string' || value.id.trim() === '') {
      throw new TypeError(`asset catalog vehicle_instances[${index}].id must be non-empty`);
    }
    for (const key of ['lat', 'lon', 'headingDeg', 'z']) {
      if (!Number.isFinite(value[key])) {
        throw new TypeError(`asset catalog vehicle_instances[${index}].${key} must be finite`);
      }
    }
    if (typeof value.headlightsOn !== 'boolean') {
      throw new TypeError(
        `asset catalog vehicle_instances[${index}].headlightsOn must be boolean`,
      );
    }
    return { ...value };
  });
  return {
    source: payload.source,
    schemaVersion: payload.schemaVersion,
    vehicle_definition: { ...definition },
    vehicle_instances: vehicleInstances,
  };
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
    bootLog('assets.fetch.ok', {
      endpoint,
      status: response.status,
      source: normalized.source,
      schemaVersion: normalized.schemaVersion,
      vehicleCount: normalized.vehicle_instances.length,
    });
    return normalized;
  } catch (error) {
    const details = {
      endpoint,
      timeoutMs,
      timedOut: error?.name === 'AbortError',
      error: error?.message ?? String(error),
    };
    bootLog('assets.fetch.failed', details, 'error');
    console.error('[ASSETS] startup failed', details);
    throw error;
  }
}
