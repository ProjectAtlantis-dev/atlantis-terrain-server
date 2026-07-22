import {
  DETAIL_MIN_DEPTH,
  createDetailTextures,
  detailUvTransform,
  tileDepthFromTileId,
} from './terrain-detail-layer.js';
import { sharedSurfaceFieldStore } from './terrain-surface-fields.js';
import { applyTerrainDetailWebGL } from './render-backends/webgl-terrain-detail.js';
import { applyTerrainDetailWebGPU } from './render-backends/webgpu-terrain-detail.js';

// Owns the ground-detail layer: shared tiling detail textures, the per-tile
// surface-mask stream (via the shared surface-field store, which the clutter
// scatter also reads), and dispatch into the backend-specific material patch.
// apply() is idempotent and cheap — the tile set calls it every time a tile's
// satellite texture lands on its material.
export function createTerrainDetailRuntime({
  backendKind,
  requestRender = () => {},
  log = () => {},
  fieldStore = null,
  enabled = true,
} = {}) {
  let textures = null;
  const store = fieldStore ?? sharedSurfaceFieldStore({ log });
  const applyBackend = backendKind === 'webgpu'
    ? applyTerrainDetailWebGPU
    : applyTerrainDetailWebGL;

  function detailTextures() {
    if (!textures) textures = createDetailTextures();
    return textures;
  }

  function apply(mesh) {
    if (!enabled || !mesh?.userData?.tileId) return;
    const tileId = mesh.userData.tileId;
    if (tileDepthFromTileId(tileId) < DETAIL_MIN_DEPTH) return;
    if (!mesh.material?.map) return;
    store.get(tileId).then(entry => {
      if (!entry) return;
      // The mesh may have been evicted or retextured while the mask loaded.
      if (mesh.userData.tileId !== tileId || !mesh.material?.map) return;
      const applied = applyBackend(mesh, {
        maskTexture: entry.texture,
        textures: detailTextures(),
        uv: detailUvTransform(tileId),
      });
      if (applied) requestRender();
    });
  }

  function dispose() {
    if (textures) {
      for (const texture of Object.values(textures)) texture.dispose?.();
      textures = null;
    }
  }

  return { apply, dispose };
}
