import * as THREE from 'three';

// Debug overlay: paint the server's classification decisions straight onto
// the terrain meshes, so classifier/archetype output can be judged in the
// live 3D view (with the macro relief it drives) instead of flipping
// between the world and the pipeline galleries.
//
//   off        — normal satellite imagery
//   classifier — colorized coarse_v2 class map (/api/classifier/<id>.png)
//   archetypes — landform decision rung   (/api/archetypes/<id>.png)
//
// Textures are fetched lazily per tile+mode, cached, and swapped in through
// the tile set's texture-overlay hook; the satellite texture is untouched
// underneath and restored the moment the overlay turns off.

const ENDPOINTS = {
  classifier: tileId => `/api/classifier/${tileId}.png?res=256&v=3`,
  archetypes: tileId => `/api/archetypes/${tileId}.png?res=256&v=2`,
};
export const OVERLAY_MODES = ['off', ...Object.keys(ENDPOINTS)];

// The classifier serves d11+ (ancestor walk); archetypes are a d12 rung.
const MODE_MIN_DEPTH = { classifier: 11, archetypes: 12 };

export function createClassifierOverlay({
  tileSet,
  requestRender = () => {},
  log = () => {},
  fetchImpl = (...args) => fetch(...args),
}) {
  let mode = 'off';
  const cache = new Map(); // `${mode}:${tileId}` -> THREE.Texture | 'failed'
  const inFlight = new Set();

  function load(key, url, tileId) {
    inFlight.add(key);
    fetchImpl(url)
      .then(response => {
        if (!response.ok) throw new Error(`http ${response.status}`);
        return response.blob();
      })
      .then(blob => createImageBitmap(blob))
      .then(bitmap => {
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
    const depth = Number.parseInt(String(tileId).split('-')[0], 10);
    if (!(depth >= MODE_MIN_DEPTH[mode])) return null;
    const key = `${mode}:${tileId}`;
    const cached = cache.get(key);
    if (cached && cached !== 'failed') return cached;
    if (cached !== 'failed' && !inFlight.has(key)) {
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
