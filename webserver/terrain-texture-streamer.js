import * as THREE from 'three';

import { textureRetryDelay } from './terrain-tile-runtime.js';

export function rendererTextureAnisotropy(renderer) {
  try {
    if (typeof renderer?.getMaxAnisotropy === 'function') {
      return renderer.getMaxAnisotropy();
    }
    if (typeof renderer?.capabilities?.getMaxAnisotropy === 'function') {
      return renderer.capabilities.getMaxAnisotropy();
    }
  } catch (_) {}
  return 1;
}

export function createTextureStreamer({
  log,
  maxInflight = 120,
  maxDormant = 256,
  repollBatch = 8,
  retryBaseMs = 2000,
  retryMaxMs = 30000,
  retryErrorMs = 3000,
  fetchImpl = (...args) => fetch(...args),
  decodeImage = (...args) => createImageBitmap(...args),
  getTextureAnisotropy = () => 1,
  now = () => performance.now(),
  queueMicrotaskImpl = callback => queueMicrotask(callback),
  scheduleRetryWake = (callback, delay) => setTimeout(callback, delay),
  cancelRetryWake = timer => clearTimeout(timer),
}) {
  const texCache = new Map();
  const texSource = new Map();
  const texInflight = new Map();
  const texFetching = new Set();
  const texRetryAtMs = new Map();
  const texRetryCount = new Map();
  const dormantTextures = new Map();
  const staleTextures = new Set();
  let version = Date.now();
  let roadDebug = false;
  let waterDebug = false;
  let hydroDebug = false;
  let activeDemand = null;
  let refillPending = false;
  let retryWakeTimer = null;
  let retryWakeAtMs = Infinity;

  function advanceVersion() {
    version = Math.max(version + 1, Date.now());
    return version;
  }

  function configureTerrainTexture(texture) {
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    let available = 1;
    try {
      available = Number(getTextureAnisotropy());
    } catch (_) {}
    texture.anisotropy = Number.isFinite(available)
      ? Math.max(1, Math.min(8, available))
      : 1;
  }

  function claimTile(tileId) {
    dormantTextures.delete(tileId);
  }

  function evictDormantOverflow() {
    while (dormantTextures.size > maxDormant) {
      const tileId = dormantTextures.keys().next().value;
      const texture = dormantTextures.get(tileId);
      dormantTextures.delete(tileId);
      if (texCache.get(tileId) !== texture) continue;
      texCache.delete(tileId);
      texSource.delete(tileId);
      texture?.dispose?.();
    }
  }

  function retainDormantTexture(tileId) {
    const texture = texCache.get(tileId);
    if (!texture) return false;
    dormantTextures.delete(tileId);
    dormantTextures.set(tileId, texture);
    evictDormantOverflow();
    return true;
  }

  function scheduleRefill() {
    if (refillPending || activeDemand == null) return;
    refillPending = true;
    queueMicrotaskImpl(() => {
      refillPending = false;
      if (activeDemand != null) fillAvailableSlots();
    });
  }

  function clearRetryWake() {
    if (retryWakeTimer != null) cancelRetryWake(retryWakeTimer);
    retryWakeTimer = null;
    retryWakeAtMs = Infinity;
  }

  function scheduleNextRetryWake() {
    if (activeDemand == null) {
      clearRetryWake();
      return;
    }
    let nextAt = Infinity;
    for (const { tile } of activeDemand.scored) {
      if (texCache.has(tile.id) || texInflight.has(tile.id)) continue;
      const retryAt = texRetryAtMs.get(tile.id);
      if (Number.isFinite(retryAt)) nextAt = Math.min(nextAt, retryAt);
    }
    if (!Number.isFinite(nextAt)) {
      clearRetryWake();
      return;
    }
    if (retryWakeTimer != null && retryWakeAtMs <= nextAt) return;
    clearRetryWake();
    retryWakeAtMs = nextAt;
    retryWakeTimer = scheduleRetryWake(() => {
      retryWakeTimer = null;
      retryWakeAtMs = Infinity;
      fillAvailableSlots();
    }, Math.max(0, nextAt - now()));
    retryWakeTimer?.unref?.();
  }

  function fillAvailableSlots() {
    const demand = activeDemand;
    if (demand == null) return;
    const { scored, isCovered, onPlaceholder, onTexture } = demand;
    const currentTime = now();
    let repolls = repollBatch;
    for (const { tile } of scored) {
      if (texInflight.size >= maxInflight) break;
      const tileId = tile.id;
      if (texCache.has(tileId) || texInflight.has(tileId)) continue;
      if (texFetching.has(tileId)) {
        if ((texRetryAtMs.get(tileId) ?? 0) > currentTime || repolls <= 0) continue;
        repolls -= 1;
        texFetching.delete(tileId);
      }
      if ((texRetryAtMs.get(tileId) ?? 0) > currentTime) continue;
      texRetryAtMs.delete(tileId);
      if (isCovered(tile)) continue;

      const controller = new AbortController();
      texInflight.set(tileId, controller);
      const debugQuery = `${roadDebug ? '&roadDebug=1' : ''}`
        + `${waterDebug ? '&waterDebug=1' : ''}`
        + `${hydroDebug ? '&hydroDebug=1' : ''}`;
      fetchImpl(`/api/texture/${tileId}.jpg?v=${version}${debugQuery}`, { signal: controller.signal })
        .then(response => {
          texInflight.delete(tileId);
          if (response.status === 202) {
            const attempt = (texRetryCount.get(tileId) || 0) + 1;
            texRetryCount.set(tileId, attempt);
            const delay = textureRetryDelay(attempt, retryBaseMs, retryMaxMs);
            log(tileId, `fetch -> 202 (server fetching, retry #${attempt} in ${(delay / 1000).toFixed(1)}s)`);
            texFetching.add(tileId);
            texRetryAtMs.set(tileId, now() + delay);
            return null;
          }
          if (!response.ok) {
            log(tileId, `fetch -> HTTP ${response.status}`);
            throw new Error(response.status);
          }
          const ancestorId = response.headers.get('X-Tex-Ancestor');
          const source = response.headers.get('X-Tex-Source') || '';
          return response.blob()
            .then(blob => decodeImage(blob, { imageOrientation: 'flipY' }))
            .then(bitmap => ({ bitmap, ancestorId, source }));
        })
        .then(result => {
          if (!result) return;
          const { bitmap, ancestorId, source } = result;
          texFetching.delete(tileId);
          texRetryAtMs.delete(tileId);
          log(tileId, `fetch -> ${bitmap.width}x${bitmap.height}${ancestorId ? ` ANCESTOR=${ancestorId}` : ''} src=${source}`);
          const texture = new THREE.Texture(bitmap);
          texture.flipY = false;
          texture.colorSpace = THREE.SRGBColorSpace;
          configureTerrainTexture(texture);
          texture.needsUpdate = true;
          if (ancestorId) {
            const attempt = (texRetryCount.get(tileId) || 0) + 1;
            texRetryCount.set(tileId, attempt);
            const delay = textureRetryDelay(attempt, retryBaseMs, retryMaxMs);
            log(tileId, `ancestor crop from ${ancestorId} — placeholder applied, retry #${attempt} in ${(delay / 1000).toFixed(1)}s)`);
            texFetching.add(tileId);
            texRetryAtMs.set(tileId, now() + delay);
            onPlaceholder({ tileId, tile, texture, ancestorId });
            return;
          }
          texRetryCount.delete(tileId);
          claimTile(tileId);
          texCache.set(tileId, texture);
          texSource.set(tileId, source);
          onTexture({ tileId, tile, texture, source });
        })
        .catch(error => {
          texInflight.delete(tileId);
          texRetryAtMs.set(tileId, now() + retryErrorMs);
          if (error.name !== 'AbortError') {
            log(tileId, `fetch error: ${error.message} (retry in ${retryErrorMs}ms)`);
            console.warn(`[TEX] ${tileId}:`, error.message);
          }
        })
        .finally(scheduleRefill);
    }
    scheduleNextRetryWake();
  }

  function pump(scored, handlers) {
    activeDemand = { scored, ...handlers };
    fillAvailableSlots();
  }

  function clearTileRequestState(tileId) {
    texInflight.get(tileId)?.abort();
    texInflight.delete(tileId);
    texFetching.delete(tileId);
    texRetryAtMs.delete(tileId);
    texRetryCount.delete(tileId);
  }

  function takeCachedTexture(tileId) {
    const texture = texCache.get(tileId);
    texCache.delete(tileId);
    texSource.delete(tileId);
    dormantTextures.delete(tileId);
    return texture;
  }

  function discardTexture(tileId, expectedTexture = null) {
    const cached = texCache.get(tileId);
    if (cached && (!expectedTexture || cached === expectedTexture)) {
      const texture = takeCachedTexture(tileId);
      staleTextures.delete(texture);
      texture?.dispose?.();
      return true;
    }
    if (!expectedTexture) return false;
    const wasStale = staleTextures.delete(expectedTexture);
    expectedTexture.dispose?.();
    return wasStale;
  }

  function releaseTileDemand(tileId) {
    // Ordinary browser-demand motion removes scene residency, not cached paint.
    // Retaining the decoded texture makes a heading reversal an immediate
    // materialization instead of a grey fetch/decode/repaint cycle.
    clearTileRequestState(tileId);
    retainDormantTexture(tileId);
  }

  function abortAll() {
    activeDemand = null;
    clearRetryWake();
    for (const controller of texInflight.values()) controller.abort();
    texInflight.clear();
    texFetching.clear();
    texRetryAtMs.clear();
    texRetryCount.clear();
    advanceVersion();
  }

  function invalidateDebugVariants() {
    abortAll();
    for (const [tileId, texture] of texCache) {
      if (dormantTextures.has(tileId)) texture.dispose?.();
      else staleTextures.add(texture);
    }
    texCache.clear();
    texSource.clear();
    dormantTextures.clear();
  }

  function setDebugVariant(kind, enabled) {
    const next = Boolean(enabled);
    const current = kind === 'road'
      ? roadDebug
      : kind === 'water'
        ? waterDebug
        : hydroDebug;
    if (current === next) return current;
    if (kind === 'road') roadDebug = next;
    else if (kind === 'water') waterDebug = next;
    else hydroDebug = next;
    invalidateDebugVariants();
    return next;
  }

  function setRoadDebug(enabled) {
    return setDebugVariant('road', enabled);
  }

  function setWaterDebug(enabled) {
    return setDebugVariant('water', enabled);
  }

  function setHydroDebug(enabled) {
    return setDebugVariant('hydro', enabled);
  }

  function releaseStaleTexture(texture) {
    if (!texture || !staleTextures.delete(texture)) return false;
    texture.dispose?.();
    return true;
  }

  return {
    texCache, texSource, texInflight, texFetching, texRetryAtMs, texRetryCount,
    dormantTextures, pump, claimTile, discardTexture, releaseTileDemand,
    abortAll, setRoadDebug, setWaterDebug, setHydroDebug,
    releaseStaleTexture,
    get roadDebug() { return roadDebug; },
    get waterDebug() { return waterDebug; },
    get hydroDebug() { return hydroDebug; },
    get version() { return version; },
    bumpVersion: advanceVersion,
  };
}
