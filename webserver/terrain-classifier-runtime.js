import * as THREE from 'three';

/** Loads optional semantic tile overlays. Missing rows intentionally stay
 * cached as missing for this session; toggling shows desaturated satellite
 * imagery, with grayscale elevation only while imagery is still loading.
 */
export function createTerrainClassifierRuntime({
  terrainTiles,
  fetchImpl = (...args) => fetch(...args),
  decodeImage = (...args) => createImageBitmap(...args),
  onChanged = () => {},
}) {
  const textures = new Map();
  const missing = new Set();
  const inflight = new Map();
  let active = false;

  function load(tile) {
    if (!active || !tile?.id || textures.has(tile.id) || missing.has(tile.id) || inflight.has(tile.id)) {
      return;
    }
    const controller = new AbortController();
    inflight.set(tile.id, controller);
    fetchImpl(`/api/classifier/${tile.id}.png`, { signal: controller.signal })
      .then(response => {
        if (response.status === 404) {
          missing.add(tile.id);
          return null;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.blob().then(blob => decodeImage(blob, { imageOrientation: 'flipY' }));
      })
      .then(bitmap => {
        if (!bitmap) return;
        const texture = new THREE.Texture(bitmap);
        texture.flipY = false;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.generateMipmaps = true;
        texture.minFilter = THREE.NearestMipmapLinearFilter;
        texture.magFilter = THREE.NearestFilter;
        texture.needsUpdate = true;
        textures.set(tile.id, texture);
        terrainTiles.setClassifierTexture(tile.id, texture);
        onChanged();
      })
      .catch(error => {
        if (error.name !== 'AbortError') {
          console.warn(`[CLASSIFIER] ${tile.id}: ${error.message}`);
        }
      })
      .finally(() => inflight.delete(tile.id));
  }

  function update(tiles = []) {
    if (!active) return;
    for (const tile of tiles) load(tile);
  }

  function setActive(enabled, tiles = []) {
    active = Boolean(enabled);
    terrainTiles.setClassifierMode(active);
    if (active) {
      update(tiles);
    } else {
      for (const controller of inflight.values()) controller.abort();
      inflight.clear();
    }
    onChanged();
    return active;
  }

  function toggle(tiles = []) {
    return setActive(!active, tiles);
  }

  return {
    textures,
    missing,
    inflight,
    update,
    setActive,
    toggle,
    get active() { return active; },
  };
}
