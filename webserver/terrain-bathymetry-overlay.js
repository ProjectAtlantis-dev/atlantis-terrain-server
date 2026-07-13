export function createTerrainBathymetryOverlay({
  THREE,
  enabled = true,
  onReady = () => {},
  fetchImpl = (...args) => fetch(...args),
  createImageBitmapImpl = (...args) => createImageBitmap(...args),
  documentImpl = globalThis.document,
} = {}) {
  let visible = false;
  const masks = new Map();
  const inflight = new Set();
  const composites = new Map();

  function requestMask(tileId) {
    if (!enabled || masks.has(tileId) || inflight.has(tileId)) return;
    inflight.add(tileId);
    fetchImpl(`/api/bathyfix/${tileId}.png`)
      .then(response => {
        if (response.status !== 200) {
          inflight.delete(tileId);
          masks.set(tileId, null);
          return null;
        }
        return response.blob()
          .then(blob => createImageBitmapImpl(blob))
          .then(image => {
            inflight.delete(tileId);
            masks.set(tileId, image);
            if (visible) onReady();
          });
      })
      .catch(() => inflight.delete(tileId));
  }

  function compositeTexture(baseTexture, maskImage) {
    const width = baseTexture.image.width;
    const height = baseTexture.image.height;
    const canvas = documentImpl.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.drawImage(baseTexture.image, 0, 0, width, height);
    // Base texture rows are south-first after flipY; mask PNG rows are north-first.
    context.save();
    context.translate(0, height);
    context.scale(1, -1);
    context.imageSmoothingEnabled = false;
    context.drawImage(maskImage, 0, 0, width, height);
    context.restore();
    const texture = new THREE.Texture(canvas);
    texture.flipY = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }

  return {
    get enabled() { return enabled && visible; },
    toggle() { if (enabled) visible = !visible; return visible; },
    resolveTexture(mesh, baseTexture, active) {
      if (!enabled || !visible || !active || !baseTexture) return baseTexture;
      const tileId = mesh.userData.tileId;
      const mask = masks.get(tileId);
      if (mask === undefined) {
        requestMask(tileId);
        return baseTexture;
      }
      if (!mask) return baseTexture;
      let composite = composites.get(tileId);
      if (!composite || composite.baseUuid !== baseTexture.uuid) {
        composite?.texture?.dispose?.();
        composite = {
          texture: compositeTexture(baseTexture, mask),
          baseUuid: baseTexture.uuid,
        };
        composites.set(tileId, composite);
      }
      return composite.texture;
    },
    dispose() {
      for (const composite of composites.values()) composite.texture.dispose?.();
      for (const mask of masks.values()) mask?.close?.();
      composites.clear();
      masks.clear();
      inflight.clear();
    },
  };
}
