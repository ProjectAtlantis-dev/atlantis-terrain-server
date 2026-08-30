const DEFAULT_RETRY_BASE_MS = 5000;
const DEFAULT_RETRY_MAX_MS = 60000;

/**
 * Shared availability gate for the classifier compatibility route.
 *
 * The replacement terrain server is expected to expose this route eventually.
 * Until then, one request probes it and every other tile waits behind that
 * probe. A 404 opens a retryable circuit instead of producing one browser
 * error per resident tile; exponential probes automatically recover once the
 * server route lands.
 */
export function createClassifierRouteRuntime({
  fetchImpl = (...args) => fetch(...args),
  log = () => {},
  now = () => Date.now(),
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  retryMaxMs = DEFAULT_RETRY_MAX_MS,
} = {}) {
  let available = null;
  let probe = null;
  let consecutiveFailures = 0;
  let retryAtMs = 0;

  function openCircuit(reason) {
    available = false;
    consecutiveFailures += 1;
    const retryInMs = Math.min(
      retryMaxMs,
      retryBaseMs * (2 ** Math.min(consecutiveFailures - 1, 16)),
    );
    retryAtMs = now() + retryInMs;
    log('classifier-route', `unavailable (${reason}); probing again in ${retryInMs}ms`);
    return { available: false, response: null, retryInMs };
  }

  function acceptResponse(response, tileId) {
    // Under the original contract, a known route with no applicable class map
    // answers 204 (or X-Classifier-Status: missing). A 404 therefore means the
    // compatibility route itself is absent, not that this one tile is absent.
    if (response?.status === 404) return openCircuit('http 404');
    available = true;
    consecutiveFailures = 0;
    retryAtMs = 0;
    return { available: true, response, tileId };
  }

  function startProbe(url, tileId) {
    probe = fetchImpl(url)
      .then(response => acceptResponse(response, tileId))
      .catch(error => openCircuit(error?.message ?? String(error)))
      .finally(() => { probe = null; });
    return probe;
  }

  function fetchResponse(url, tileId) {
    if (available === true) {
      return fetchImpl(url).then(response => acceptResponse(response, tileId));
    }
    if (now() < retryAtMs) {
      return Promise.resolve({ available: false, response: null });
    }
    const activeProbe = probe ?? startProbe(url, tileId);
    return activeProbe.then(result => {
      if (!result.available || result.tileId === tileId) return result;
      return fetchImpl(url).then(response => acceptResponse(response, tileId));
    });
  }

  return {
    fetchResponse,
    getStatus: () => ({
      available,
      probing: probe != null,
      consecutiveFailures,
      retryAtMs,
    }),
  };
}
