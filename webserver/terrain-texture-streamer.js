import * as THREE from 'three';

import { textureRetryDelay } from './terrain-tile-runtime.js';

export function createTextureStreamer({
  log,
  recolor = false,
  enableWaterMasks = false,
  maxInflight = 120,
  repollBatch = 8,
  retryBaseMs = 2000,
  retryMaxMs = 30000,
  retryErrorMs = 3000,
  onWaterMask = () => {},
}) {
  const texCache = new Map();
  const texSource = new Map();
  const texInflight = new Map();
  const texFetching = new Set();
  const texRetryAtMs = new Map();
  const texRetryCount = new Map();
  const waterMaskCache = new Map();
  const waterMaskInflight = new Map();
  const ancestorLogged = new Set();
  let version = Date.now();

  function requestWaterMask(tileId) {
    if (!enableWaterMasks || !tileId || waterMaskCache.has(tileId) || waterMaskInflight.has(tileId)) return;
    const controller = new AbortController();
    waterMaskInflight.set(tileId, controller);
    fetch(`/api/watermask/${tileId}.png?v=${version}`, { signal: controller.signal })
      .then(response => {
        waterMaskInflight.delete(tileId);
        if (response.status === 202 || !response.ok) return null;
        return response.blob();
      })
      .then(blob => blob && createImageBitmap(blob, { imageOrientation: 'flipY' }))
      .then(bitmap => {
        if (!bitmap) return;
        const texture = new THREE.Texture(bitmap);
        texture.flipY = false;
        texture.colorSpace = THREE.NoColorSpace;
        texture.needsUpdate = true;
        waterMaskCache.set(tileId, texture);
        onWaterMask(tileId, texture);
      })
      .catch(error => {
        waterMaskInflight.delete(tileId);
        if (error.name !== 'AbortError') console.warn(`[WATER MASK] ${tileId}:`, error.message);
      });
  }

  function pump(scored, { isCovered, onPlaceholder, onTexture }) {
    const now = performance.now();
    let repolls = repollBatch;
    for (const { tile } of scored) {
      if (texInflight.size >= maxInflight) break;
      const tileId = tile.id;
      if (texCache.has(tileId) || texInflight.has(tileId)) continue;
      if (texFetching.has(tileId)) {
        if ((texRetryAtMs.get(tileId) ?? 0) > now || repolls <= 0) continue;
        repolls -= 1;
        texFetching.delete(tileId);
      }
      if ((texRetryAtMs.get(tileId) ?? 0) > now) continue;
      texRetryAtMs.delete(tileId);
      if (isCovered(tile)) continue;

      const controller = new AbortController();
      texInflight.set(tileId, controller);
      fetch(`/api/texture/${tileId}.jpg?v=${version}${recolor ? '&stage=colorized' : ''}`, { signal: controller.signal })
        .then(response => {
          texInflight.delete(tileId);
          if (response.status === 202) {
            const attempt = (texRetryCount.get(tileId) || 0) + 1;
            texRetryCount.set(tileId, attempt);
            const delay = textureRetryDelay(attempt, retryBaseMs, retryMaxMs);
            log(tileId, `fetch -> 202 (server fetching, retry #${attempt} in ${(delay / 1000).toFixed(1)}s)`);
            texFetching.add(tileId);
            texRetryAtMs.set(tileId, performance.now() + delay);
            return null;
          }
          if (!response.ok) {
            log(tileId, `fetch -> HTTP ${response.status}`);
            throw new Error(response.status);
          }
          const ancestorId = response.headers.get('X-Tex-Ancestor');
          const source = response.headers.get('X-Tex-Source') || '';
          return response.blob()
            .then(blob => createImageBitmap(blob, { imageOrientation: 'flipY' }))
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
          texture.needsUpdate = true;
          if (ancestorId) {
            const attempt = (texRetryCount.get(tileId) || 0) + 1;
            texRetryCount.set(tileId, attempt);
            const delay = textureRetryDelay(attempt, retryBaseMs, retryMaxMs);
            log(tileId, `ancestor crop from ${ancestorId} — placeholder applied, retry #${attempt} in ${(delay / 1000).toFixed(1)}s)`);
            ancestorLogged.add(tileId);
            texFetching.add(tileId);
            texRetryAtMs.set(tileId, performance.now() + delay);
            onPlaceholder({ tileId, tile, texture, ancestorId });
            return;
          }
          ancestorLogged.delete(tileId);
          texRetryCount.delete(tileId);
          texCache.set(tileId, texture);
          texSource.set(tileId, source);
          requestWaterMask(tileId);
          onTexture({ tileId, tile, texture, source });
        })
        .catch(error => {
          texInflight.delete(tileId);
          texRetryAtMs.set(tileId, performance.now() + retryErrorMs);
          if (error.name !== 'AbortError') {
            log(tileId, `fetch error: ${error.message} (retry in ${retryErrorMs}ms)`);
            console.warn(`[TEX] ${tileId}:`, error.message);
          }
        });
    }
  }

  return {
    texCache, texSource, texInflight, texFetching, texRetryAtMs, texRetryCount,
    waterMaskCache, waterMaskInflight, ancestorLogged,
    requestWaterMask, pump,
    get version() { return version; },
    bumpVersion() { version = Date.now(); return version; },
  };
}
