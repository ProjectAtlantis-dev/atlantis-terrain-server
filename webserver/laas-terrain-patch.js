// Greenland near-field procgen overlay (WebGPU client).
//
// The satellite/terrain meshes remain owned by the existing terrain streamer;
// this class never removes, replaces, or hides them. It only maintains a
// canonical 3x3 window of depth-12 (~659 m) DEM chunks for GroundRing.
// Moving inside the centre tile does no chunk work. Crossing a tile boundary
// retains six chunks, unloads the trailing three, and builds the new three.
import * as THREE from 'three';
import { StorageTexture } from 'three/webgpu';
import { Fn, If, Return, instanceIndex, textureStore, uvec2, vec4 } from 'three/tsl';
import { Heightfield } from './laas/world/Heightfield.ts';
import { GroundRing } from './laas/vegetation/GroundRing.ts';
import { WorldSeed } from './laas/core/Seed.ts';
import {
  PROCGEN_WINDOW_TILE_COUNT,
  canonicalTileFromSource,
  parseTileId,
  windowDescriptors,
} from './procgen/chunk-window.js';

const CHUNK_RES = 96;       // ~6.9 m/sample on a 659 m tile
const PATCH_RES = CHUNK_RES * 3;
const AGL_MAX = 800;        // satellite terrain still renders above and below this
const RETRY_MS = 500;

function log(level, ev, details) {
  if (typeof window !== 'undefined' && window.__enqueueClientLog) {
    window.__enqueueClientLog(level, ev, details);
  }
}

// Loaded terrain meshes carrying their decoded heightmap. These are read-only
// inputs from the base terrain streamer; the procgen overlay owns none of them.
function collectTiles(terrainRoot) {
  const tiles = [];
  for (const mesh of terrainRoot.children) {
    const input = mesh.userData?.scatterInput;
    const address = parseTileId(input?.tileId);
    if (!address || !input?.hm || !Array.isArray(input.bbox) || input.res < 2) continue;
    const [xMin, yMin, xMax, yMax] = input.bbox;
    tiles.push({
      id: input.tileId,
      ...address,
      xMin,
      yMin,
      xMax,
      yMax,
      hm: input.hm,
      res: input.res,
      metresPerSample: Math.max(xMax - xMin, yMax - yMin) / (input.res - 1),
    });
  }
  return tiles;
}

function finestSourceAt(tiles, x, y) {
  let best = null;
  for (const tile of tiles) {
    if (x < tile.xMin || x > tile.xMax || y < tile.yMin || y > tile.yMax) continue;
    if (!best || tile.metresPerSample < best.metresPerSample) best = tile;
  }
  return best;
}

function canonicalTileAt(tiles, x, y) {
  return canonicalTileFromSource(finestSourceAt(tiles, x, y), x, y);
}

function sampleSource(tile, x, y) {
  const fc = ((x - tile.xMin) / (tile.xMax - tile.xMin)) * (tile.res - 1);
  const fr = ((y - tile.yMin) / (tile.yMax - tile.yMin)) * (tile.res - 1);
  const c0 = Math.max(0, Math.min(tile.res - 2, Math.floor(fc)));
  const r0 = Math.max(0, Math.min(tile.res - 2, Math.floor(fr)));
  const tc = Math.max(0, Math.min(1, fc - c0));
  const tr = Math.max(0, Math.min(1, fr - r0));
  const i00 = r0 * tile.res + c0;
  const h00 = tile.hm[i00];
  const h10 = tile.hm[i00 + 1];
  const h01 = tile.hm[i00 + tile.res];
  const h11 = tile.hm[i00 + tile.res + 1];
  return h00 * (1 - tc) * (1 - tr)
    + h10 * tc * (1 - tr)
    + h01 * (1 - tc) * tr
    + h11 * tc * tr;
}

// Create one canonical procgen chunk from the best currently resident DEM at
// each sample. Returning null delays the procgen overlay; it never substitutes
// zero-height geometry that could cover or contradict the real land.
function buildChunk(descriptor, sourceTiles) {
  const heights = new Float32Array(CHUNK_RES * CHUNK_RES);
  for (let row = 0; row < CHUNK_RES; row++) {
    const y = descriptor.yMin + ((row + 0.5) / CHUNK_RES) * descriptor.height;
    for (let col = 0; col < CHUNK_RES; col++) {
      const x = descriptor.xMin + ((col + 0.5) / CHUNK_RES) * descriptor.width;
      const source = finestSourceAt(sourceTiles, x, y);
      if (!source) return null;
      heights[row * CHUNK_RES + col] = sampleSource(source, x, y);
    }
  }
  return { descriptor, heights };
}

function sampleChunk(chunk, x, y) {
  const { descriptor, heights } = chunk;
  const gx = Math.max(0, Math.min(CHUNK_RES - 1.001,
    ((x - descriptor.xMin) / descriptor.width) * CHUNK_RES - 0.5));
  const gy = Math.max(0, Math.min(CHUNK_RES - 1.001,
    ((y - descriptor.yMin) / descriptor.height) * CHUNK_RES - 0.5));
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const at = (xx, yy) => heights[Math.min(yy, CHUNK_RES - 1) * CHUNK_RES + Math.min(xx, CHUNK_RES - 1)];
  const a = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
  const b = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
  return a * (1 - fy) + b * fy;
}

function prepareWindow(center, sourceTiles, previousChunks) {
  const chunks = new Map();
  const loaded = [];
  const retained = [];
  for (const descriptor of windowDescriptors(center)) {
    const existing = previousChunks.get(descriptor.id);
    if (existing) {
      chunks.set(descriptor.id, existing);
      retained.push(descriptor.id);
      continue;
    }
    const chunk = buildChunk(descriptor, sourceTiles);
    if (!chunk) return null;
    chunks.set(descriptor.id, chunk);
    loaded.push(descriptor.id);
  }
  const unloaded = [...previousChunks.keys()].filter(id => !chunks.has(id));
  return { chunks, loaded, retained, unloaded };
}

function makeMosaicSampler(chunks, center) {
  const list = [...chunks.values()];
  const originX = (center.xMin + center.xMax) * 0.5;
  const originY = (center.yMin + center.yMax) * 0.5;
  return (wx, wz) => {
    const x = originX + wx;
    const y = originY - wz; // GroundRing's +z points toward terrain -y
    for (const chunk of list) {
      const d = chunk.descriptor;
      if (x >= d.xMin && x <= d.xMax && y >= d.yMin && y <= d.yMax) {
        return sampleChunk(chunk, x, y);
      }
    }
    // Heightfield samples are texel-centred and should never reach this path.
    return 0;
  };
}

async function makeEmptyCanopy(renderer) {
  const tex = new StorageTexture(8, 8);
  tex.generateMipmaps = false;
  const kernel = Fn(() => {
    const i = instanceIndex;
    If(i.greaterThanEqual(64), () => { Return(); });
    textureStore(tex, uvec2(i.mod(8).toUint(), i.div(8).toUint()), vec4(0, 0, 0, 0)).toWriteOnly();
  })().compute(64);
  await renderer.computeAsync(kernel);
  return tex;
}

export class GreenlandPatch {
  constructor(terrainRoot, seedN) {
    this.terrainRoot = terrainRoot;
    this.seedN = seedN >>> 0;
    this.hf = null;
    this.ground = null;
    this.vegRoot = null;
    this.proxy = new THREE.PerspectiveCamera();
    this._invVeg = new THREE.Matrix4();
    this._invTR = new THREE.Matrix4();
    this._camWorld = new THREE.Vector3();
    this._camTR = new THREE.Vector3();
    this.chunks = new Map();
    this.centerId = null;
    this.ready = false;
    this.building = false;
    this.reseeding = false;
    this.nextBuildAttempt = 0;
    this._diag = 0;
  }

  _camTerrainLocal(camera) {
    camera.getWorldPosition(this._camWorld);
    this.terrainRoot.updateWorldMatrix(true, false);
    this._invTR.copy(this.terrainRoot.matrixWorld).invert();
    this._camTR.copy(this._camWorld).applyMatrix4(this._invTR);
    return this._camTR;
  }

  async build(renderer, camera, cameraAGL) {
    if (this.building || this.ready || !camera || cameraAGL > AGL_MAX) return;
    const now = performance.now();
    if (now < this.nextBuildAttempt) return;
    this.building = true;
    try {
      const sourceTiles = collectTiles(this.terrainRoot);
      const camTR = this._camTerrainLocal(camera);
      const center = canonicalTileAt(sourceTiles, camTR.x, camTR.y);
      if (!center) {
        this.nextBuildAttempt = now + RETRY_MS;
        return;
      }
      const prepared = prepareWindow(center, sourceTiles, this.chunks);
      if (!prepared || prepared.chunks.size !== PROCGEN_WINDOW_TILE_COUNT) {
        this.nextBuildAttempt = now + RETRY_MS;
        return;
      }

      const seed = new WorldSeed(this.seedN);
      const worldSize = center.width * 3;
      this.hf = await Heightfield.fromExternal(renderer, seed, {
        res: PATCH_RES,
        worldSize,
        sampleDEM: makeMosaicSampler(prepared.chunks, center),
        biomeId: 3,
        vegDensity: 0.9,
        cpuReadback: false,
      });
      const canopy = await makeEmptyCanopy(renderer);
      // Atlantis currently uses Three r182 and renders beneath an ENU/ECEF
      // transform. LAAS's r184 EqualDepth vegetation twins do not remain
      // depth-identical in that graph and visibly erase the terrain. Keep the
      // same GroundRing placement/material/indirect draws, but render its
      // shaded passes normally until the renderer versions are unified.
      this.ground = new GroundRing(this.hf, canopy, seed, null, false);
      this.ground.init(null);

      this.vegRoot = new THREE.Group();
      this.vegRoot.name = 'greenland-procgen-3x3';
      this.vegRoot.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
      this.vegRoot.position.set(
        (center.xMin + center.xMax) * 0.5,
        (center.yMin + center.yMax) * 0.5,
        0,
      );
      this.vegRoot.add(this.ground.group);
      this.terrainRoot.add(this.vegRoot);

      this.chunks = prepared.chunks;
      this.centerId = center.id;
      this.ready = true;
      log('info', 'patch.ready', {
        center: center.id,
        chunks: [...this.chunks.keys()],
        loaded: prepared.loaded,
        tileMetres: Math.round(center.width),
        spanMetres: Math.round(worldSize),
        res: PATCH_RES,
      });
    } catch (err) {
      this.nextBuildAttempt = now + RETRY_MS;
      log('error', 'patch.build', { error: String(err), stack: String(err?.stack ?? '') });
      console.error('[greenland-patch] build failed', err);
    } finally {
      this.building = false;
    }
  }

  async _recenter(renderer, center, sourceTiles) {
    this.reseeding = true;
    try {
      const prepared = prepareWindow(center, sourceTiles, this.chunks);
      if (!prepared || prepared.chunks.size !== PROCGEN_WINDOW_TILE_COUNT) return;

      await this.hf.reseed(renderer, makeMosaicSampler(prepared.chunks, center), false);
      this.vegRoot.position.set(
        (center.xMin + center.xMax) * 0.5,
        (center.yMin + center.yMax) * 0.5,
        0,
      );
      this.chunks = prepared.chunks;
      this.centerId = center.id;
      log('info', 'patch.recenter', {
        center: center.id,
        loaded: prepared.loaded,
        retained: prepared.retained,
        unloaded: prepared.unloaded,
      });
    } catch (err) {
      log('error', 'patch.recenter', { error: String(err), stack: String(err?.stack ?? '') });
    } finally {
      this.reseeding = false;
    }
  }

  update(renderer, camera, cameraAGL) {
    if (!this.ready) return;

    const active = Number.isFinite(cameraAGL) && cameraAGL <= AGL_MAX;
    this.vegRoot.visible = active;
    if (!active) return;

    const camTR = this._camTerrainLocal(camera);
    if (!this.reseeding) {
      const sourceTiles = collectTiles(this.terrainRoot);
      const center = canonicalTileAt(sourceTiles, camTR.x, camTR.y);
      if (center && center.id !== this.centerId) {
        void this._recenter(renderer, center, sourceTiles);
      }
    }

    this.vegRoot.updateWorldMatrix(true, false);
    this.proxy.projectionMatrix.copy(camera.projectionMatrix);
    this.proxy.matrixWorldInverse.copy(camera.matrixWorldInverse).multiply(this.vegRoot.matrixWorld);
    this._invVeg.copy(this.vegRoot.matrixWorld).invert();
    camera.getWorldPosition(this._camWorld);
    this.proxy.position.copy(this._camWorld).applyMatrix4(this._invVeg);
    this.ground.update(renderer, this.proxy);

    if ((this._diag = (this._diag + 1) % 180) === 0) {
      const hud = this.ground.counterSnapshot?.() ?? {};
      log('info', 'patch.diag', {
        grass: hud['veg.grass'] ?? -1,
        agl: Math.round(cameraAGL),
        center: this.centerId,
        chunks: this.chunks.size,
      });
    }
  }
}
