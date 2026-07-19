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
  repollBatch = 8,
  retryBaseMs = 2000,
  retryMaxMs = 30000,
  retryErrorMs = 3000,
  fetchImpl = (...args) => fetch(...args),
  decodeImage = (...args) => createImageBitmap(...args),
  getTextureAnisotropy = () => 1,
  now = () => performance.now(),
}) {
  const texCache = new Map();
  const texSource = new Map();
  const texInflight = new Map();
  const texFetching = new Set();
  const texRetryAtMs = new Map();
  const texRetryCount = new Map();
  const ancestorLogged = new Set();
  const demandClient = globalThis.crypto?.randomUUID?.() ?? `terrain-${Date.now()}-${Math.random()}`;
  let version = Date.now();

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

  function pump(scored, { isCovered, onPlaceholder, onTexture }) {
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
      fetchImpl(`/api/texture/${tileId}.jpg?v=${version}&demand=${version}&demandClient=${encodeURIComponent(demandClient)}`, { signal: controller.signal })
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
            ancestorLogged.add(tileId);
            texFetching.add(tileId);
            texRetryAtMs.set(tileId, now() + delay);
            onPlaceholder({ tileId, tile, texture, ancestorId });
            return;
          }
          ancestorLogged.delete(tileId);
          texRetryCount.delete(tileId);
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
        });
    }
  }

  function invalidate(tileId) {
    texInflight.get(tileId)?.abort();
    texInflight.delete(tileId);
    texFetching.delete(tileId);
    texRetryAtMs.delete(tileId);
    texRetryCount.delete(tileId);
    ancestorLogged.delete(tileId);
    texCache.delete(tileId);
    texSource.delete(tileId);
    return advanceVersion();
  }

  function abortAll() {
    for (const controller of texInflight.values()) controller.abort();
    texInflight.clear();
    texFetching.clear();
    texRetryAtMs.clear();
    texRetryCount.clear();
    ancestorLogged.clear();
    advanceVersion();
  }

  return {
    texCache, texSource, texInflight, texFetching, texRetryAtMs, texRetryCount,
    ancestorLogged, pump, invalidate, abortAll,
    get version() { return version; },
    bumpVersion: advanceVersion,
  };
}
