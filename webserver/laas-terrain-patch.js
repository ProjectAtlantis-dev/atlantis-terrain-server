// Greenland near-field procgen overlay (WebGPU client).
//
// The satellite/terrain meshes remain owned by the existing terrain streamer;
// this class never removes, replaces, or hides them. It only maintains a
// compact camera-following clipmap for GroundRing + Forests. The clipmap is
// snapped in world metres so deterministic scatter remains stable while the
// player moves inside a cell; it never generates vegetation for the streamed
// terrain's multi-kilometre quadtree window.
import * as THREE from 'three';
import { StorageTexture } from 'three/webgpu';
import { Fn, If, Return, instanceIndex, textureStore, uvec2, vec4 } from 'three/tsl';
import { Heightfield } from './laas/world/Heightfield.ts';
import { runScatter } from './laas/gpu/passes/Scatter.ts';
import { GroundRing } from './laas/vegetation/GroundRing.ts';
import { Forests } from './laas/vegetation/Forests.ts';
import { buildVegLibrary } from './laas/vegetation/VegLibrary.ts';
import { WorldSeed } from './laas/core/Seed.ts';
import { updateSunUniforms } from './laas/render/VegMaterials.ts';
import { mountSeasonUI } from './laas/render/Season.ts';
import { setWindContext } from './laas/render/Wind.ts';
import { parseTileId } from './procgen/chunk-window.js';

const PATCH_WORLD_SIZE = 768; // 384 m half-width: 265 m lush ring + guard band
const PATCH_RES = 256;        // 3 m field/normal samples
const RECENTER_STEP = 96;     // stable deterministic cells; rebuild after 96 m
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

function finestFieldSourceAt(tiles, x, y) {
  let best = null;
  for (const tile of tiles) {
    if (!tile.fields || x < tile.xMin || x > tile.xMax || y < tile.yMin || y > tile.yMax) continue;
    if (!best || tile.metresPerSample < best.metresPerSample) best = tile;
  }
  return best;
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

// Classifier rasters are north-up (row 0 = bbox yMax), unlike the DEM's
// south-up row order. Bilinear sampling here keeps the two data products in
// the same EPSG:3413 position before the LAAS frame's north flip is applied.
function sampleField(tile, channel, x, y) {
  const fields = tile.fields;
  const values = fields?.chans?.[channel];
  if (!values || fields.res < 2) return 0;
  const res = fields.res;
  const fc = ((x - tile.xMin) / (tile.xMax - tile.xMin)) * (res - 1);
  const fr = ((tile.yMax - y) / (tile.yMax - tile.yMin)) * (res - 1);
  const c0 = Math.max(0, Math.min(res - 2, Math.floor(fc)));
  const r0 = Math.max(0, Math.min(res - 2, Math.floor(fr)));
  const tc = Math.max(0, Math.min(1, fc - c0));
  const tr = Math.max(0, Math.min(1, fr - r0));
  const i00 = r0 * res + c0;
  const v = values[i00] * (1 - tc) * (1 - tr)
    + values[i00 + 1] * tc * (1 - tr)
    + values[i00 + res] * (1 - tc) * tr
    + values[i00 + res + 1] * tc * tr;
  return v / 255;
}

function cameraWindowAt(x, y) {
  const centerX = Math.round(x / RECENTER_STEP) * RECENTER_STEP;
  const centerY = Math.round(y / RECENTER_STEP) * RECENTER_STEP;
  const half = PATCH_WORLD_SIZE * 0.5;
  return {
    id: `${centerX}:${centerY}`,
    centerX,
    centerY,
    xMin: centerX - half,
    yMin: centerY - half,
    xMax: centerX + half,
    yMax: centerY + half,
  };
}

// Sample only the compact player clipmap from the finest resident DEM/field
// tiles. Missing coverage delays the clipmap instead of inventing terrain.
function buildWindow(descriptor, sourceTiles) {
  const heights = new Float32Array(PATCH_RES * PATCH_RES);
  const classifier = {
    veg: new Float32Array(PATCH_RES * PATCH_RES),
    rock: new Float32Array(PATCH_RES * PATCH_RES),
    snow: new Float32Array(PATCH_RES * PATCH_RES),
    water: new Float32Array(PATCH_RES * PATCH_RES),
    moisture: new Float32Array(PATCH_RES * PATCH_RES),
  };
  for (let row = 0; row < PATCH_RES; row++) {
    const y = descriptor.yMin + ((row + 0.5) / PATCH_RES) * PATCH_WORLD_SIZE;
    for (let col = 0; col < PATCH_RES; col++) {
      const x = descriptor.xMin + ((col + 0.5) / PATCH_RES) * PATCH_WORLD_SIZE;
      const source = finestSourceAt(sourceTiles, x, y);
      const fieldSource = finestFieldSourceAt(sourceTiles, x, y);
      if (!source || !fieldSource) return null;
      const index = row * PATCH_RES + col;
      heights[index] = sampleSource(source, x, y);
      for (const channel of Object.keys(classifier)) {
        classifier[channel][index] = sampleField(fieldSource, channel, x, y);
      }
    }
  }
  return { descriptor, heights, classifier };
}

function sampleWindow(window, x, y) {
  const { descriptor, heights } = window;
  const gx = Math.max(0, Math.min(PATCH_RES - 1.001,
    ((x - descriptor.xMin) / PATCH_WORLD_SIZE) * PATCH_RES - 0.5));
  const gy = Math.max(0, Math.min(PATCH_RES - 1.001,
    ((y - descriptor.yMin) / PATCH_WORLD_SIZE) * PATCH_RES - 0.5));
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const at = (xx, yy) => heights[Math.min(yy, PATCH_RES - 1) * PATCH_RES + Math.min(xx, PATCH_RES - 1)];
  const a = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
  const b = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
  return a * (1 - fy) + b * fy;
}

function sampleWindowField(window, channel, x, y) {
  const { descriptor, classifier } = window;
  const values = classifier[channel];
  const gx = Math.max(0, Math.min(PATCH_RES - 1.001,
    ((x - descriptor.xMin) / PATCH_WORLD_SIZE) * PATCH_RES - 0.5));
  const gy = Math.max(0, Math.min(PATCH_RES - 1.001,
    ((y - descriptor.yMin) / PATCH_WORLD_SIZE) * PATCH_RES - 0.5));
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const at = (xx, yy) => values[Math.min(yy, PATCH_RES - 1) * PATCH_RES + Math.min(xx, PATCH_RES - 1)];
  const a = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
  const b = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
  return a * (1 - fy) + b * fy;
}

function makeWindowSampler(window) {
  const { centerX: originX, centerY: originY } = window.descriptor;
  return (wx, wz) => {
    const x = originX + wx;
    const y = originY - wz; // GroundRing's +z points toward terrain -y
    return sampleWindow(window, x, y);
  };
}

function makeWindowFieldSampler(window) {
  const { centerX: originX, centerY: originY } = window.descriptor;
  return (wx, wz) => {
    const x = originX + wx;
    const y = originY - wz;
    return {
      veg: sampleWindowField(window, 'veg', x, y),
      rock: sampleWindowField(window, 'rock', x, y),
      snow: sampleWindowField(window, 'snow', x, y),
      water: sampleWindowField(window, 'water', x, y),
      moisture: sampleWindowField(window, 'moisture', x, y),
    };
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
  constructor(terrainRoot, seedN, {
    loadFields = null,
    getCSM = null,
    getSunLight = null,
    onWindowChanged = null,
  } = {}) {
    this.terrainRoot = terrainRoot;
    this.seedN = seedN >>> 0;
    this.loadFields = loadFields;
    this.getCSM = getCSM;
    this.getSunLight = getSunLight;
    this.onWindowChanged = onWindowChanged;
    this.hf = null;
    this.ground = null;
    this.forests = null;
    this.scatter = null;
    this.vegLibrary = null;
    this.vegRoot = null;
    this.proxy = new THREE.PerspectiveCamera();
    this._invVeg = new THREE.Matrix4();
    this._invTR = new THREE.Matrix4();
    this._camWorld = new THREE.Vector3();
    this._camTR = new THREE.Vector3();
    this.window = null;
    this.centerId = null;
    this.ready = false;
    this.building = false;
    this.reseeding = false;
    this.nextBuildAttempt = 0;
    this._diag = 0;
  }

  _disposeForests(renderer) {
    if (this.forests) {
      this.forests.group.removeFromParent();
      const materials = new Set();
      this.forests.group.traverse(object => {
        const list = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of list) if (material) materials.add(material);
      });
      for (const material of materials) material.dispose?.();
      this.forests = null;
    }
    if (this.scatter) {
      // Three does not expose public disposal on StorageBufferNode. Route the
      // backing attributes through the renderer's attribute manager so a
      // roaming-window rebuild does not retain multi-million-instance buffers.
      const attributes = renderer?._attributes;
      for (const layer of Object.values(this.scatter)) {
        attributes?.delete?.(layer.bufA?.value);
        attributes?.delete?.(layer.bufB?.value);
      }
      this.scatter = null;
    }
  }

  async _buildForests(renderer, seed) {
    if (!this.vegLibrary) {
      this.vegLibrary = await buildVegLibrary(
        renderer,
        seed,
        (progress, message) => log('info', 'patch.library', { progress, message }),
        { treeless: true },
      );
      log('info', 'patch.library.ready', {
        pools: this.vegLibrary.pools.length,
        atlases: this.vegLibrary.atlases.size,
        barks: this.vegLibrary.barks.size,
        impostors: this.vegLibrary.impostors.size,
      });
    }
    const scatter = await runScatter(renderer, this.hf, seed);
    const forests = new Forests(this.hf, scatter, this.vegLibrary, null, null);
    forests.setCSM(this.getCSM?.() ?? null);
    forests.init(renderer);
    this.scatter = scatter;
    this.forests = forests;
    return forests;
  }

  async _loadClassifier(sourceTiles, descriptor) {
    if (!this.loadFields) return false;
    const needed = sourceTiles.filter(tile => (
      tile.xMax >= descriptor.xMin && tile.xMin <= descriptor.xMax &&
      tile.yMax >= descriptor.yMin && tile.yMin <= descriptor.yMax
    ));
    await Promise.all(needed.map(async tile => {
      tile.fields = await this.loadFields(tile.id);
    }));
    return needed.some(tile => tile.fields != null);
  }

  _camTerrainLocal(camera) {
    camera.getWorldPosition(this._camWorld);
    this.terrainRoot.updateWorldMatrix(true, false);
    this._invTR.copy(this.terrainRoot.matrixWorld).invert();
    this._camTR.copy(this._camWorld).applyMatrix4(this._invTR);
    return this._camTR;
  }

  terrainMaterialContext() {
    if (!this.ready || !this.hf || !this.window) return null;
    const d = this.window.descriptor;
    return {
      hf: this.hf,
      id: this.centerId,
      centerX: d.centerX,
      centerY: d.centerY,
      xMin: d.xMin,
      yMin: d.yMin,
      xMax: d.xMax,
      yMax: d.yMax,
      worldSize: PATCH_WORLD_SIZE,
    };
  }

  async build(renderer, camera, cameraAGL) {
    if (this.building || this.ready || !camera || cameraAGL > AGL_MAX) return;
    const now = performance.now();
    if (now < this.nextBuildAttempt) return;
    this.building = true;
    try {
      const sourceTiles = collectTiles(this.terrainRoot);
      const camTR = this._camTerrainLocal(camera);
      const descriptor = cameraWindowAt(camTR.x, camTR.y);
      if (!finestSourceAt(sourceTiles, descriptor.centerX, descriptor.centerY)) {
        this.nextBuildAttempt = now + RETRY_MS;
        return;
      }
      if (!await this._loadClassifier(sourceTiles, descriptor)) {
        this.nextBuildAttempt = now + RETRY_MS;
        return;
      }
      const window = buildWindow(descriptor, sourceTiles);
      if (!window) {
        this.nextBuildAttempt = now + RETRY_MS;
        return;
      }

      const seed = new WorldSeed(this.seedN);
      this.hf = await Heightfield.fromExternal(renderer, seed, {
        res: PATCH_RES,
        worldSize: PATCH_WORLD_SIZE,
        sampleDEM: makeWindowSampler(window),
        sampleFields: makeWindowFieldSampler(window),
        cpuReadback: false,
        progress: (progress, message) => log('info', 'patch.hf', { progress, message }),
      });
      const canopy = await makeEmptyCanopy(renderer);
      if (this.hf.noiseA) setWindContext({ noiseA: this.hf.noiseA, canopyTex: canopy });
      const forests = await this._buildForests(renderer, seed);
      // Atlantis currently uses Three r182 and renders beneath an ENU/ECEF
      // transform. LAAS's r184 EqualDepth vegetation twins do not remain
      // depth-identical in that graph and visibly erase the terrain. Keep the
      // same GroundRing placement/material/indirect draws, but render its
      // shaded passes normally until the renderer versions are unified.
      this.ground = new GroundRing(this.hf, canopy, seed, null, false);
      this.ground.init(null);

      this.vegRoot = new THREE.Group();
      this.vegRoot.name = 'greenland-procgen-clipmap';
      this.vegRoot.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
      this.vegRoot.position.set(
        descriptor.centerX,
        descriptor.centerY,
        0,
      );
      this.vegRoot.add(this.ground.group);
      this.vegRoot.add(forests.group);
      this.terrainRoot.add(this.vegRoot);

      if (typeof document !== 'undefined' && !document.getElementById('season-ui')) {
        mountSeasonUI();
      }

      this.window = window;
      this.centerId = descriptor.id;
      this.ready = true;
      this.onWindowChanged?.(this);
      log('info', 'patch.ready', {
        center: descriptor.id,
        sourceTiles: sourceTiles.filter(tile => tile.fields).length,
        spanMetres: PATCH_WORLD_SIZE,
        res: PATCH_RES,
        libraryPools: this.vegLibrary.pools.length,
        plants: this.scatter.understory.count,
        rocks: this.scatter.extras.count + this.scatter.stones.count,
      });
    } catch (err) {
      this.nextBuildAttempt = now + RETRY_MS;
      log('error', 'patch.build', { error: String(err), stack: String(err?.stack ?? '') });
      console.error('[greenland-patch] build failed', err);
    } finally {
      this.building = false;
    }
  }

  async _recenter(renderer, descriptor, sourceTiles) {
    this.reseeding = true;
    try {
      if (!await this._loadClassifier(sourceTiles, descriptor)) return;
      const window = buildWindow(descriptor, sourceTiles);
      if (!window) return;
      await this.hf.reseed(
        renderer,
        makeWindowSampler(window),
        false,
        makeWindowFieldSampler(window),
      );
      this._disposeForests(renderer);
      const forests = await this._buildForests(renderer, new WorldSeed(this.seedN));
      this.vegRoot.position.set(
        descriptor.centerX,
        descriptor.centerY,
        0,
      );
      this.vegRoot.add(forests.group);
      this.window = window;
      this.centerId = descriptor.id;
      this.onWindowChanged?.(this);
      log('info', 'patch.recenter', {
        center: descriptor.id,
        spanMetres: PATCH_WORLD_SIZE,
        sourceTiles: sourceTiles.filter(tile => tile.fields).length,
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
      const descriptor = cameraWindowAt(camTR.x, camTR.y);
      if (descriptor.id !== this.centerId) {
        void this._recenter(renderer, descriptor, sourceTiles);
      }
    }

    this.vegRoot.updateWorldMatrix(true, false);
    this.proxy.projectionMatrix.copy(camera.projectionMatrix);
    this.proxy.matrixWorldInverse.copy(camera.matrixWorldInverse).multiply(this.vegRoot.matrixWorld);
    this._invVeg.copy(this.vegRoot.matrixWorld).invert();
    camera.getWorldPosition(this._camWorld);
    this.proxy.position.copy(this._camWorld).applyMatrix4(this._invVeg);
    this.ground.update(renderer, this.proxy);
    const sun = this.getSunLight?.();
    if (sun) updateSunUniforms(sun);
    this.forests?.setCSM(this.getCSM?.() ?? null);
    this.forests?.update(renderer, this.proxy);

    if ((this._diag = (this._diag + 1) % 180) === 0) {
      const hud = this.ground.counterSnapshot?.() ?? {};
      const forestHud = this.forests?.counterSnapshot?.() ?? {};
      log('info', 'patch.diag', {
        grass: hud['veg.grass'] ?? -1,
        plants: this.scatter?.understory.count ?? -1,
        rocks: (this.scatter?.extras.count ?? 0) + (this.scatter?.stones.count ?? 0),
        plantsDrawn: forestHud['veg.underDrawn'] ?? -1,
        rocksDrawn: forestHud['veg.extraDrawn'] ?? -1,
        vegetationTriangles: forestHud['veg.tris'] ?? -1,
        pools: this.vegLibrary?.pools.length ?? -1,
        agl: Math.round(cameraAGL),
        center: this.centerId,
        spanMetres: PATCH_WORLD_SIZE,
      });
    }
  }
}
