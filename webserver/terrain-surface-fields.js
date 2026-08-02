import * as THREE from 'three';
import { detailMaskUrl, tileDepthFromTileId } from './terrain-detail-layer.js';

// Shared per-tile surface-channel store. One fetch of the server's surface
// mask (/api/classifier/<id>.png?raw=1: R=rock/dark/shore markers,
// G=vegetation, B=snow, exact black=water/lake, R=1 shadow, R=2 road/path)
// serves
// BOTH consumers:
//  - the ground-detail shader wants a THREE.Texture,
//  - the clutter scatter wants raw channel grids (procgen TileFields shape).
// Single-flight, LRU-capped, failure-memoized — same policy the detail
// runtime had when it owned the fetch.

const CACHE_LIMIT = 384;

export function createSurfaceFieldStore({
  fetchImpl = (...args) => fetch(...args),
  log = () => {},
  evictionGate = null,
} = {}) {
  const entries = new Map(); // tileId -> { texture, fields }
  const inFlight = new Map();
  const failed = new Set();

  function evictOverflow() {
    if (evictionGate?.enabled === false) return;
    while (entries.size > CACHE_LIMIT) {
      const [oldestId, oldest] = entries.entries().next().value;
      entries.delete(oldestId);
      oldest.texture?.dispose?.();
    }
  }
  evictionGate?.onChange?.(enabled => {
    if (enabled) evictOverflow();
  });

  function decode(bitmap) {
    const size = bitmap.width;
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(size, size)
      : Object.assign(document.createElement('canvas'), { width: size, height: size });
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, size, size).data;
    const rock = new Uint8Array(size * size);
    const veg = new Uint8Array(size * size);
    const snow = new Uint8Array(size * size);
    const water = new Uint8Array(size * size);
    const shore = new Uint8Array(size * size);
    const road = new Uint8Array(size * size);
    // DARK lives inside the R/rock channel as a distinct value (grey=255,
    // dark=128, neither=0) — NOT the PNG alpha channel. Alpha was tried
    // first, but this decode goes through a 2D canvas drawImage/
    // getImageData round trip, which premultiplies alpha by default: any
    // pixel with alpha=0 got its R/G/B zeroed by the browser too, so rock/
    // veg/snow only survived on pixels that happened to be "dark" (visible
    // live as "everything vanished except rocks on the dark streaks").
    const dark = new Uint8Array(size * size);
    for (let index = 0; index < size * size; index++) {
      const offset = index * 4;
      const shadowMarker = pixels[offset] === 1
        && pixels[offset + 1] === 0 && pixels[offset + 2] === 0;
      const roadMarker = pixels[offset] === 2
        && pixels[offset + 1] === 0 && pixels[offset + 2] === 0;
      const beachMarker = pixels[offset] === 64
        && pixels[offset + 1] === 0 && pixels[offset + 2] === 0;
      const shoreRockMarker = pixels[offset] === 192
        && pixels[offset + 1] === 0 && pixels[offset + 2] === 0;
      rock[index] = shadowMarker || roadMarker || beachMarker ? 0
        : shoreRockMarker ? 255 : pixels[offset];
      veg[index] = pixels[offset + 1];
      snow[index] = pixels[offset + 2];
      dark[index] = pixels[offset] === 128 ? 255 : 0;
      shore[index] = beachMarker || shoreRockMarker ? 255 : 0;
      road[index] = roadMarker ? 255 : 0;
      // surface_rgb_v5 reserves exact black for WATER/LAKE. SHADOW carries
      // R=1; ROAD/PATH R=2; SAND R=64; SHORE_ROCK R=192.
      water[index] = pixels[offset] === 0
        && pixels[offset + 1] === 0 && pixels[offset + 2] === 0 ? 255 : 0;
    }

    // ORIENTATION: tile mesh UVs put v=0 at the SOUTH edge; the mask PNG's
    // row 0 is NORTH. The satellite map corrects this via default
    // flipY=true — the mask must flip the same way or every GPU consumer
    // reads it north/south MIRRORED (seen live as rock detail on dark
    // streaks and bare bright ridges — the CPU fields path below does its
    // own row math and was correct, which made the shader disagree with
    // scatter about where rock was). flipY on an ImageBitmap upload is
    // IGNORED by WebGL (spec: bitmaps carry their own orientation), so the
    // texture is built from the canvas we already drew — canvas uploads
    // respect flipY.
    const texture = new THREE.CanvasTexture(canvas);
    texture.flipY = true;
    texture.colorSpace = THREE.NoColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    bitmap.close?.();

    return {
      texture,
      // Mask rasters are image-oriented: row 0 = north — the procgen
      // TileFields contract.
      fields: {
        res: size,
        chans: { rock, veg, snow, water, dark, shore, road },
      },
    };
  }

  function get(tileId) {
    const cached = entries.get(tileId);
    if (cached) {
      entries.delete(tileId);
      entries.set(tileId, cached); // refresh recency
      return Promise.resolve(cached);
    }
    if (failed.has(tileId)) return Promise.resolve(null);
    const inFlightRequest = inFlight.get(tileId);
    if (inFlightRequest) return inFlightRequest;
    const request = fetchImpl(detailMaskUrl(tileId))
      .then(response => {
        if (!response.ok) throw new Error(`mask http ${response.status}`);
        // The server returns 200 with an all-black fallback mask when a
        // tile has no classifier row anywhere in its ancestor chain yet
        // (first request often lands mid-fetch/mid-cook). That blank is
        // transient, not a real "nothing grows here" classification —
        // caching it here would freeze the tile grass-less forever, since
        // nothing else ever invalidates this cache.
        const pending = response.headers.get('X-Classifier-Status') === 'pending';
        return response.blob().then(blob => ({ blob, pending }));
      })
      .then(({ blob, pending }) => createImageBitmap(
        blob, { premultiplyAlpha: 'none' },
      ).then(bitmap => ({ bitmap, pending })))
      .then(({ bitmap, pending }) => {
        const entry = decode(bitmap);
        if (!pending) {
          entries.set(tileId, entry);
          evictOverflow();
        } else {
          // One-shot consumers (scatter placement) build permanently from
          // whatever they got on first fetch — they need to know this
          // result is a transient blank, not a real "nothing lives here",
          // so they can retry once classification actually lands.
          entry.pending = true;
        }
        return entry;
      })
      .catch(error => {
        // Missing classification is a normal state for never-classified
        // ground; remember so we do not hammer the endpoint.
        failed.add(tileId);
        log(tileId, `surface fields unavailable: ${error?.message ?? error}`);
        return null;
      })
      .finally(() => inFlight.delete(tileId));
    inFlight.set(tileId, request);
    return request;
  }

  /** Cached entry or null, without fetching. Warms the cache on miss so a
   *  later peek succeeds — synchronous consumers (the ground-ring window
   *  composer) recompose periodically and pick the data up then. */
  function peek(tileId) {
    const cached = entries.get(tileId);
    if (cached) return cached;
    if (!failed.has(tileId) && !inFlight.has(tileId)) get(tileId);
    return null;
  }

  function dispose() {
    for (const entry of entries.values()) entry.texture?.dispose?.();
    entries.clear();
    failed.clear();
  }

  return { get, peek, dispose, tileDepthFromTileId };
}

let _sharedStore = null;

/** Application-wide store: detail shader and clutter share one mask fetch. */
export function sharedSurfaceFieldStore(options) {
  if (!_sharedStore) _sharedStore = createSurfaceFieldStore(options);
  return _sharedStore;
}
