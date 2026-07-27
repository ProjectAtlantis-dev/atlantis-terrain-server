import * as THREE from 'three';
import { terrainTileDepth } from './terrain-tile-address.js';

// Debug overlay: paint the server's full-resolution classifier decisions
// straight onto the terrain meshes for inspection in the live 3D view.
//
//   off        — normal satellite imagery
//   classifier — colorized coarse_v4 class map (/api/classifier/<id>.png)
//
// Textures are fetched lazily per tile+mode, cached, and swapped in through
// the tile set's texture-overlay hook; the satellite texture is untouched
// underneath and restored the moment the overlay turns off.

const ENDPOINTS = {
  classifier: tileId => `/api/classifier/${tileId}.png?res=256&v=10`,
};
export const OVERLAY_MODES = ['off', ...Object.keys(ENDPOINTS)];

// The classifier serves d11+ through its ancestor walk.
const MODE_MIN_DEPTH = { classifier: 11 };
const PENDING_RETRY_DELAYS_MS = [500, 1500, 4000, 10000];

export function createClassifierOverlay({
  tileSet,
  requestRender = () => {},
  log = () => {},
  fetchImpl = (...args) => fetch(...args),
  setTimeoutImpl = (...args) => setTimeout(...args),
  clearTimeoutImpl = timer => clearTimeout(timer),
}) {
  let mode = 'off';
  const cache = new Map(); // `${mode}:${tileId}` -> THREE.Texture | 'failed'
  const inFlight = new Set();
  const pendingAttempts = new Map();
  const retryTimers = new Map();

  function schedulePendingRetry(key, tileId) {
    if (retryTimers.has(key)) return;
    const attempt = pendingAttempts.get(key) ?? 0;
    pendingAttempts.set(key, attempt + 1);
    const delay = PENDING_RETRY_DELAYS_MS[
      Math.min(attempt, PENDING_RETRY_DELAYS_MS.length - 1)
    ];
    const timer = setTimeoutImpl(() => {
      retryTimers.delete(key);
      if (mode === 'off' || !key.startsWith(`${mode}:`)) return;
      log(tileId, `overlay classification pending; retrying`);
      // Refreshing asks the resolver again only for tiles that are still
      // live. The retry therefore cannot resurrect an evicted mesh.
      tileSet.refreshTextureOverlay?.();
      requestRender();
    }, delay);
    retryTimers.set(key, timer);
  }

  function load(key, url, tileId) {
    inFlight.add(key);
    fetchImpl(url)
      .then(response => {
        if (!response.ok) throw new Error(`http ${response.status}`);
        if (response.headers.get('X-Classifier-Status') === 'pending') {
          schedulePendingRetry(key, tileId);
          return null;
        }
        return response.blob();
      })
      .then(blob => (blob === null ? null : createImageBitmap(blob)))
      .then(bitmap => {
        if (bitmap === null) return;
        // Same orientation trap as terrain-surface-fields: the PNG's row 0
        // is north, mesh v=0 is south, and flipY is IGNORED on ImageBitmap
        // uploads — draw through a canvas so flipY=true actually applies.
        const size = bitmap.width;
        const canvas = typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(size, size)
          : Object.assign(
            document.createElement('canvas'), { width: size, height: size },
          );
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        bitmap.close?.();
        const texture = new THREE.CanvasTexture(canvas);
        texture.flipY = true;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.magFilter = THREE.NearestFilter; // crisp decision cells
        texture.minFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        cache.set(key, texture);
        pendingAttempts.delete(key);
        log(tileId, `overlay texture ready (${mode})`);
        tileSet.refreshTextureOverlay?.();
        requestRender();
      })
      .catch(error => {
        cache.set(key, 'failed');
        log(tileId, `overlay unavailable: ${error?.message ?? error}`);
      })
      .finally(() => inFlight.delete(key));
  }

  /** Texture-overlay hook for the tile set: overlay texture or null. */
  function resolve(tileId) {
    if (mode === 'off') return null;
    const depth = terrainTileDepth(tileId);
    if (!(depth >= MODE_MIN_DEPTH[mode])) return null;
    const key = `${mode}:${tileId}`;
    const cached = cache.get(key);
    if (cached && cached !== 'failed') return cached;
    if (
      cached !== 'failed'
      && !inFlight.has(key)
      && !retryTimers.has(key)
    ) {
      load(key, ENDPOINTS[mode](tileId), tileId);
    }
    return null; // satellite stays until the overlay texture lands
  }

  function setMode(next) {
    if (!OVERLAY_MODES.includes(next) || next === mode) return mode;
    mode = next;
    log('overlay', `mode -> ${mode}`);
    tileSet.setTextureOverlay(mode === 'off' ? null : resolve);
    requestRender();
    return mode;
  }

  function cycle() {
    return setMode(
      OVERLAY_MODES[(OVERLAY_MODES.indexOf(mode) + 1) % OVERLAY_MODES.length],
    );
  }

  function dispose() {
    for (const timer of retryTimers.values()) clearTimeoutImpl(timer);
    retryTimers.clear();
    pendingAttempts.clear();
    for (const entry of cache.values()) entry?.dispose?.();
    cache.clear();
  }

  return {
    get mode() { return mode; },
    setMode,
    cycle,
    resolve,
    dispose,
  };
}
