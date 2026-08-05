import {
  DETAIL_MIN_DEPTH,
  createDetailTextures,
  detailUvTransform,
  tileDepthFromTileId,
} from './terrain-detail-layer.js';
import {
  cliffGraftsForTile,
  loadCliffGraftTexture,
} from './terrain-cliff-graft.js';
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
  const graftAssets = new Map();
  const graftInflight = new Map();
  const store = fieldStore ?? sharedSurfaceFieldStore({ log });
  const applyBackend = backendKind === 'webgpu'
    ? applyTerrainDetailWebGPU
    : applyTerrainDetailWebGL;

  function detailTextures() {
    if (!textures) textures = createDetailTextures();
    return textures;
  }

  function graftAsset(spec) {
    if (!spec) return Promise.resolve(null);
    const assetKey = spec.assetId;
    const cached = graftAssets.get(assetKey);
    if (cached) return Promise.resolve({ spec, ...cached });
    const pending = graftInflight.get(assetKey);
    if (pending) return pending.then(asset => ({ spec, ...asset }));
    const request = loadCliffGraftTexture({ spec })
      .then(asset => {
        graftAssets.set(assetKey, asset);
        log(
          assetKey,
          `cliff material ${assetKey} ready`,
        );
        return asset;
      })
      .finally(() => graftInflight.delete(assetKey));
    graftInflight.set(assetKey, request);
    return request.then(asset => ({ spec, ...asset }));
  }

  function apply(mesh, {
    graftOnly = false,
    tintMap = null,
  } = {}) {
    if (!enabled || !mesh?.userData?.tileId) return;
    const tileId = mesh.userData.tileId;
    if (tileDepthFromTileId(tileId) < DETAIL_MIN_DEPTH) return;
    if (!mesh.material?.map) return;
    const displayMap = mesh.material.map;
    const resolvedTintMap = tintMap ?? displayMap;
    const graftSpecs = cliffGraftsForTile(tileId);
    Promise.all([
      store.get(tileId),
      Promise.all(graftSpecs.map(spec => (
        graftAsset(spec).catch(error => {
          log(
            tileId,
            `cliff material ${spec.assetId} unavailable: ${error?.message ?? error}`,
          );
          return null;
        })
      ))).then(grafts => grafts.filter(Boolean)),
    ]).then(([entry, grafts]) => {
      if (!entry) return;
      // The mesh may have been evicted or retextured while the mask loaded.
      if (
        mesh.userData.tileId !== tileId
        || mesh.material?.map !== displayMap
      ) return;
      const applied = applyBackend(mesh, {
        maskTexture: entry.texture,
        textures: detailTextures(),
        uv: detailUvTransform(tileId),
        grafts,
        tintMap: resolvedTintMap,
        detailEnabled: !graftOnly,
      });
      // Backends report 'patched' / 'refreshed' / 'unchanged' (older ones just
      // true). A redundant re-apply writes the same uniform values it already
      // held, so repainting for it is pure churn — and logging it identically
      // to real work hides that churn instead of exposing it.
      if (applied === 'unchanged') {
        log(tileId, 'ground-detail unchanged');
        return;
      }
      if (applied) {
        // Diagnosis breadcrumb (cheap, once per texture land): "is the
        // detail layer even patching this tile" must be answerable from
        // the client log, not from theorizing over screenshots.
        log(tileId, `ground-detail ${applied === true ? 'applied' : applied}`);
        requestRender();
      }
    });
  }

  function dispose() {
    if (textures) {
      for (const texture of Object.values(textures)) texture.dispose?.();
      textures = null;
    }
    for (const asset of graftAssets.values()) {
      for (const layer of asset.layers ?? [asset]) {
        layer.texture?.dispose?.();
        layer.normalTexture?.dispose?.();
      }
    }
    graftAssets.clear();
    graftInflight.clear();
  }

  return { apply, dispose };
}
