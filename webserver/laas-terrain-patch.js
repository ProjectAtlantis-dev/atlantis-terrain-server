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
import {
  classifierSourceCandidates,
  classifierSourcesCoverBounds,
} from './procgen/classifier-source.js';
import { selectProcgenWindowCenter } from './procgen/window-policy.js';
import { sampleTriangulatedHeight } from './terrain-height-sampling.js';

const PATCH_WORLD_SIZE = 768; // 384 m half-width: 265 m lush ring + guard band
const PATCH_RES = 256;        // 3 m field/normal samples
// A 192 m snap leaves at least 23 m of valid heightfield beyond GroundRing's
// 265 m far radius at the worst camera offset. The former 96 m snap rebuilt
// the complete scatter/forest allocation twice as often without adding view.
const RECENTER_STEP = 192;
// Do not let a few metres of lookahead/camera noise bounce a compiled window
// across the 96 m rounding boundary. 16 m on both sides gives a 32 m deadband
// while remaining inside the 119 m complete-coverage guard.
const RECENTER_HYSTERESIS = 16;
const WINDOW_CACHE_LIMIT = 25;
// Above this altitude the individual grass/plants are at or below useful
// screen size, while their ~3.2 M candidate cull and moving-window rebuilds
// remain fully priced. The streamed terrain/material LOD remains visible.
const DETAIL_AGL_MAX = 500;
// Cruise/fast flight uses the streamed 12 m satellite/DEM terrain tier. Full
// grass/plant/rock detail is a slow-flight and ground-navigation tier. Separate
// enter/exit thresholds prevent a speed hovering at the boundary from
// rebuilding every frame.
const DETAIL_SPEED_DISABLE_MPS = 45;
const DETAIL_SPEED_ENABLE_MPS = 30;
// Prepare the destination window just outside the visible-detail gates. The
// root stays hidden until the prepared window actually covers the camera.
const DETAIL_PREWARM_AGL_MAX = 650;
const DETAIL_PREWARM_SPEED_MAX = DETAIL_SPEED_DISABLE_MPS;
// PATCH_WORLD_SIZE/2 - GroundRing's 265 m outer radius. Within this guard the
// active patch still supplies a complete detail ring during an async handoff.
const DETAIL_CAMERA_GUARD = PATCH_WORLD_SIZE * 0.5 - 265;
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

function finestFieldSourceAt(sources, x, y) {
  let best = null;
  for (const source of sources) {
    if (!source?.fields
        || x < source.xMin || x > source.xMax
        || y < source.yMin || y > source.yMax) continue;
    if (!best || source.metresPerSample < best.metresPerSample) best = source;
  }
  return best;
}

function sampleSource(tile, x, y) {
  const fc = ((x - tile.xMin) / (tile.xMax - tile.xMin)) * (tile.res - 1);
  const fr = ((y - tile.yMin) / (tile.yMax - tile.yMin)) * (tile.res - 1);
  // Match terrain-mesh-builder's actual triangle split exactly. Bilinear
  // interpolation follows a curved saddle between four heights while the
  // rendered terrain is two planes (a,b,d) / (b,f,d); on coarse, rugged DEM
  // cells that discrepancy can visually perch props above the triangle.
  return sampleTriangulatedHeight(tile.hm, tile.res, fc, fr);
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

function cameraWindowAt(x, y, activeDescriptor = null) {
  const selected = selectProcgenWindowCenter({
    x,
    y,
    currentX: activeDescriptor?.centerX,
    currentY: activeDescriptor?.centerY,
    step: RECENTER_STEP,
    hysteresis: RECENTER_HYSTERESIS,
  });
  if (!selected) return null;
  const { centerX, centerY } = selected;
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
function buildWindow(descriptor, sourceTiles, fieldSources) {
  const heights = new Float32Array(PATCH_RES * PATCH_RES);
  const heightSourceIds = new Set();
  const fieldSourceIds = new Set();
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
      const fieldSource = finestFieldSourceAt(fieldSources, x, y);
      if (!source || !fieldSource) return null;
      heightSourceIds.add(source.id);
      fieldSourceIds.add(fieldSource.id);
      const index = row * PATCH_RES + col;
      heights[index] = sampleSource(source, x, y);
      for (const channel of Object.keys(classifier)) {
        classifier[channel][index] = sampleField(fieldSource, channel, x, y);
      }
    }
  }
  return {
    descriptor,
    heights,
    classifier,
    centerSourceDepth: finestSourceAt(
      sourceTiles,
      descriptor.centerX,
      descriptor.centerY,
    )?.depth ?? -1,
    stats: {
      ...summarizeWindowFields(heights, classifier),
      heightSourceIds: [...heightSourceIds].sort(),
      fieldSourceIds: [...fieldSourceIds].sort(),
    },
  };
}

function summarizeWindowFields(heights, classifier) {
  const summarize = (values) => {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (let index = 0; index < values.length; index++) {
      const value = values[index];
      min = Math.min(min, value);
      max = Math.max(max, value);
      sum += value;
    }
    return {
      min: Number(min.toFixed(3)),
      mean: Number((sum / Math.max(1, values.length)).toFixed(3)),
      max: Number(max.toFixed(3)),
    };
  };
  let dry = 0;
  let vegetated = 0;
  for (let index = 0; index < classifier.water.length; index++) {
    if (classifier.water[index] <= 0.45) dry += 1;
    if (classifier.veg[index] > 0.1) vegetated += 1;
  }
  const count = Math.max(1, classifier.water.length);
  return {
    height: summarize(heights),
    veg: summarize(classifier.veg),
    rock: summarize(classifier.rock),
    snow: summarize(classifier.snow),
    water: summarize(classifier.water),
    moisture: summarize(classifier.moisture),
    dryFraction: Number((dry / count).toFixed(3)),
    vegetatedFraction: Number((vegetated / count).toFixed(3)),
  };
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
    classifierSelectionReady = null,
    getCSM = null,
    getSunLight = null,
    onWindowChanged = null,
  } = {}) {
    this.terrainRoot = terrainRoot;
    this.seedN = seedN >>> 0;
    this.procgenVersion = 0;
    this.loadFields = loadFields;
    this.classifierSelectionReady = classifierSelectionReady;
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
    this.activeSlot = null;
    this.inactiveSlot = null;
    this.classifierSources = [];
    this.windowCache = new Map();
    this.windowCacheHits = 0;
    this.windowCacheMisses = 0;
    this.motionDetailActive = true;
    this._diag = 0;
  }

  setWorldIdentity({ worldSeed, procgenVersion } = {}) {
    const nextSeed = Number(worldSeed);
    const nextVersion = Number(procgenVersion);
    if (!Number.isInteger(nextSeed) || nextSeed < 0 || nextSeed > 0xffffffff
        || !Number.isInteger(nextVersion) || nextVersion < 0 || nextVersion > 0xffffffff) {
      return false;
    }
    if (this.ready || this.building) {
      const matches = this.seedN === (nextSeed >>> 0)
        && this.procgenVersion === (nextVersion >>> 0);
      if (!matches) {
        log('error', 'patch.world-identity.late-change-rejected', {
          active: { worldSeed: this.seedN, procgenVersion: this.procgenVersion },
          requested: { worldSeed: nextSeed, procgenVersion: nextVersion },
        });
      }
      return matches;
    }
    this.seedN = nextSeed >>> 0;
    this.procgenVersion = nextVersion >>> 0;
    log('info', 'patch.world-identity', {
      worldSeed: this.seedN,
      procgenVersion: this.procgenVersion,
    });
    return true;
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

  async _ensureVegLibrary(renderer, seed) {
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
  }

  async _prepareSlot(renderer, slot, seed, window, descriptor) {
    if (slot) {
      const startedAt = performance.now();
      await slot.hf.reseed(
        renderer,
        makeWindowSampler(window),
        false,
        makeWindowFieldSampler(window),
      );
      const heightfieldReadyAt = performance.now();
      slot.scatter.setWorldCenter(descriptor.centerX, -descriptor.centerY);
      await slot.scatter.reseed(renderer);
      const scatterReadyAt = performance.now();
      slot.root.position.set(descriptor.centerX, descriptor.centerY, 0);
      slot.window = window;
      slot.centerId = descriptor.id;
      slot.lastPrepareTiming = {
        heightfieldMs: Number((heightfieldReadyAt - startedAt).toFixed(1)),
        scatterMs: Number((scatterReadyAt - heightfieldReadyAt).toFixed(1)),
        totalMs: Number((scatterReadyAt - startedAt).toFixed(1)),
      };
      return slot;
    }

    const hf = await Heightfield.fromExternal(renderer, seed, {
      res: PATCH_RES,
      worldSize: PATCH_WORLD_SIZE,
      sampleDEM: makeWindowSampler(window),
      sampleFields: makeWindowFieldSampler(window),
      cpuReadback: false,
      progress: (progress, message) => log('info', 'patch.hf', { progress, message }),
    });
    const canopy = await makeEmptyCanopy(renderer);
    if (hf.noiseA) setWindContext({ noiseA: hf.noiseA, canopyTex: canopy });
    await this._ensureVegLibrary(renderer, seed);
    const scatter = await runScatter(renderer, hf, seed, {
      x: descriptor.centerX,
      // LAAS local +z maps to terrain/EPSG -y.
      z: -descriptor.centerY,
    });
    const forests = new Forests(hf, scatter, this.vegLibrary, null, null);
    forests.setCSM(this.getCSM?.() ?? null);
    forests.init(renderer);
    // Atlantis currently uses Three r182 and renders beneath an ENU/ECEF
    // transform. LAAS's r184 EqualDepth twins do not remain depth-identical,
    // so GroundRing uses normal shaded passes until the versions are unified.
    const ground = new GroundRing(hf, canopy, seed, null, false);
    ground.init(null);
    const root = new THREE.Group();
    root.name = 'greenland-procgen-clipmap';
    root.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    root.position.set(descriptor.centerX, descriptor.centerY, 0);
    root.add(ground.group);
    root.add(forests.group);
    root.visible = false;
    this.terrainRoot.add(root);
    return { hf, canopy, scatter, forests, ground, root, window, centerId: descriptor.id };
  }

  _adoptSlot(slot) {
    if (this.activeSlot && this.activeSlot !== slot) this.activeSlot.root.visible = false;
    this.activeSlot = slot;
    this.hf = slot.hf;
    this.ground = slot.ground;
    this.forests = slot.forests;
    this.scatter = slot.scatter;
    this.vegRoot = slot.root;
    this.window = slot.window;
    this.centerId = slot.centerId;
    // Visibility is a residency decision made by update(). In particular, a
    // window built while descending from the satellite tier must not flash for
    // one frame before its altitude/speed/coverage gates are evaluated.
    slot.root.visible = false;
  }

  async _loadClassifier(sourceTiles, descriptor) {
    if (!this.loadFields) return null;
    const needed = sourceTiles.filter(tile => (
      tile.xMax >= descriptor.xMin && tile.xMin <= descriptor.xMax &&
      tile.yMax >= descriptor.yMin && tile.yMin <= descriptor.yMax
    )).sort((a, b) => b.depth - a.depth || a.metresPerSample - b.metresPerSample);
    if (needed.length === 0) return null;

    const intersectsWindow = source => (
      source.xMax >= descriptor.xMin && source.xMin <= descriptor.xMax &&
      source.yMax >= descriptor.yMin && source.yMin <= descriptor.yMax
    );
    const coversTile = (source, tile) => (
      source.xMin <= Math.max(tile.xMin, descriptor.xMin) &&
      source.xMax >= Math.min(tile.xMax, descriptor.xMax) &&
      source.yMin <= Math.max(tile.yMin, descriptor.yMin) &&
      source.yMax >= Math.min(tile.yMax, descriptor.yMax)
    );

    // Leaving an area releases its choice. Pages still touching the active
    // window remain latched even if finer render imagery arrives underneath.
    const latched = this.classifierSources.filter(intersectsWindow);
    const selected = [...latched];
    const selectedIds = new Set(selected.map(source => source.id));
    for (let start = 0; start < needed.length;) {
      const depth = needed[start].depth;
      let end = start + 1;
      while (end < needed.length && needed[end].depth === depth) end++;
      // A fallback selected for one fine peer must not hide an already-ready
      // fine page beside it. Only selections from earlier visits/finer depth
      // groups suppress probes within this group.
      const groupStartSources = [...selected];
      for (const tile of needed.slice(start, end)) {
        if (groupStartSources.some(source => coversTile(source, tile))) continue;
        let chosen = null;
        for (const candidate of classifierSourceCandidates(tile)) {
          if (selectedIds.has(candidate.id)) {
            chosen = selected.find(source => source.id === candidate.id) ?? null;
          } else {
            const fields = await this.loadFields(candidate.id);
            if (fields) {
              const res = fields.res ?? 0;
              chosen = {
                ...candidate,
                fields,
                metresPerSample: res > 1
                  ? Math.max(
                      candidate.xMax - candidate.xMin,
                      candidate.yMax - candidate.yMin,
                    ) / (res - 1)
                  : Infinity,
              };
            }
          }
          if (chosen) break;
        }
        if (!chosen) return null;
        if (!selectedIds.has(chosen.id)) {
          selected.push(chosen);
          selectedIds.add(chosen.id);
        }
      }
      if (classifierSourcesCoverBounds(selected, descriptor)) break;
      start = end;
    }
    this.classifierSources = selected;
    return selected;
  }

  _camTerrainLocal(camera) {
    camera.getWorldPosition(this._camWorld);
    this.terrainRoot.updateWorldMatrix(true, false);
    this._invTR.copy(this.terrainRoot.matrixWorld).invert();
    this._camTR.copy(this._camWorld).applyMatrix4(this._invTR);
    return this._camTR;
  }

  _windowCacheKey(descriptor, sourceTiles, fieldSources) {
    const intersects = source => (
      source.xMax >= descriptor.xMin && source.xMin <= descriptor.xMax
      && source.yMax >= descriptor.yMin && source.yMin <= descriptor.yMax
    );
    const heightIds = [...new Set(
      sourceTiles.filter(intersects).map(source => source.id),
    )].sort();
    const fieldIds = [...new Set(
      fieldSources.filter(intersects).map(source => source.id),
    )].sort();
    return [
      descriptor.id,
      `seed=${this.seedN}`,
      `version=${this.procgenVersion}`,
      `height=${heightIds.join(',')}`,
      `fields=${fieldIds.join(',')}`,
    ].join('|');
  }

  _cachedWindow(cacheKey) {
    const cached = this.windowCache.get(cacheKey);
    if (!cached) {
      this.windowCacheMisses += 1;
      return null;
    }
    // LRU refresh. Window arrays are self-contained, deterministic area data;
    // they remain valid even after their source render meshes leave residency.
    this.windowCache.delete(cacheKey);
    this.windowCache.set(cacheKey, cached);
    this.windowCacheHits += 1;
    return cached;
  }

  _rememberWindow(cacheKey, window, classifierPages) {
    this.windowCache.set(cacheKey, { window, classifierPages });
    while (this.windowCache.size > WINDOW_CACHE_LIMIT) {
      const oldest = this.windowCache.keys().next().value;
      this.windowCache.delete(oldest);
    }
  }

  async _resolveWindow(sourceTiles, descriptor) {
    const fieldSources = await this._loadClassifier(sourceTiles, descriptor);
    if (!fieldSources) return null;
    // Cache the bake against its real inputs. An area first encountered with
    // a depth-12 fallback must be rebuilt when depth-13 imagery/DEM becomes
    // available instead of freezing the first coarse result forever.
    const cacheKey = this._windowCacheKey(descriptor, sourceTiles, fieldSources);
    const cached = this._cachedWindow(cacheKey);
    if (cached) return { ...cached, cacheHit: true };
    const window = buildWindow(descriptor, sourceTiles, fieldSources);
    if (!window) return null;
    const classifierPages = fieldSources.map(source => source.id);
    this._rememberWindow(cacheKey, window, classifierPages);
    return { window, classifierPages, cacheHit: false };
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

  async build(renderer, camera, cameraAGL, traversal = {}) {
    const speed = Number.isFinite(traversal.speedMps) ? Math.abs(traversal.speedMps) : 0;
    if (this.building || this.ready || !camera
        || cameraAGL > DETAIL_PREWARM_AGL_MAX
        || speed > DETAIL_PREWARM_SPEED_MAX) return;
    const now = performance.now();
    if (now < this.nextBuildAttempt) return;
    // The preview response deliberately contains only coarse bootstrap tiles.
    // Do not permanently latch one of those pages just before the full terrain
    // response makes finer classifier inputs available. The callback describes
    // streamer state, not a particular depth, so this remains source-agnostic.
    if (this.classifierSelectionReady && !this.classifierSelectionReady()) {
      this.nextBuildAttempt = now + RETRY_MS;
      return;
    }
    this.building = true;
    const startedAt = performance.now();
    try {
      const sourceTiles = collectTiles(this.terrainRoot);
      const camTR = this._camTerrainLocal(camera);
      const descriptor = cameraWindowAt(camTR.x, camTR.y);
      if (!descriptor) return;
      if (!finestSourceAt(sourceTiles, descriptor.centerX, descriptor.centerY)) {
        this.nextBuildAttempt = now + RETRY_MS;
        return;
      }
      const resolved = await this._resolveWindow(sourceTiles, descriptor);
      if (!resolved) {
        this.nextBuildAttempt = now + RETRY_MS;
        return;
      }
      const { window, classifierPages, cacheHit } = resolved;

      const seed = new WorldSeed(this.seedN);
      const slot = await this._prepareSlot(renderer, null, seed, window, descriptor);
      this._adoptSlot(slot);
      const activeReadyAt = performance.now();

      if (typeof document !== 'undefined' && !document.getElementById('season-ui')) {
        mountSeasonUI();
      }

      this.ready = true;
      this.onWindowChanged?.(this);
      log('info', 'patch.ready', {
        center: descriptor.id,
        worldSeed: this.seedN,
        procgenVersion: this.procgenVersion,
        sourceTiles: sourceTiles.length,
        classifierPages,
        windowCacheHit: cacheHit,
        spanMetres: PATCH_WORLD_SIZE,
        res: PATCH_RES,
        libraryPools: this.vegLibrary.pools.length,
        plants: this.scatter.understory.count,
        rocks: this.scatter.extras.count + this.scatter.stones.count,
        fields: window.stats,
        timing: {
          activeSlotMs: Number((activeReadyAt - startedAt).toFixed(1)),
          totalMs: Number((activeReadyAt - startedAt).toFixed(1)),
        },
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
    const startedAt = performance.now();
    let fieldsReadyAt = startedAt;
    try {
      const resolved = await this._resolveWindow(sourceTiles, descriptor);
      if (!resolved) return;
      fieldsReadyAt = performance.now();
      const { window, classifierPages, cacheHit } = resolved;
      // A second Forests/GroundRing graph caused a measured 12.5 s lazy
      // pipeline-compilation frame when first adopted. Keep one compiled render
      // graph and rewrite its persistent data buffers in place; the root stays
      // visible and retains its last indirect draw state while preparation is
      // in progress. Incremental strip updates remain the follow-up that will
      // reduce the bounded rewrite hitch further.
      const reusedSlot = Boolean(this.activeSlot);
      const nextSlot = await this._prepareSlot(
        renderer,
        this.activeSlot,
        new WorldSeed(this.seedN),
        window,
        descriptor,
      );
      nextSlot.ground.invalidateVisibility();
      nextSlot.forests.invalidateVisibility();
      const preparedAt = performance.now();
      // Preserve the compiled object/material graph and publish the new window
      // metadata only after its persistent buffers have been rewritten.
      this._adoptSlot(nextSlot);
      this.inactiveSlot = null;
      this.lastRecenterTiming = {
        fieldsMs: Number((fieldsReadyAt - startedAt).toFixed(1)),
        prepareSlotMs: Number((preparedAt - fieldsReadyAt).toFixed(1)),
        totalMs: Number((preparedAt - startedAt).toFixed(1)),
        reusedSlot,
        slot: nextSlot.lastPrepareTiming ?? null,
      };
      this.onWindowChanged?.(this);
      log('info', 'patch.recenter', {
        center: descriptor.id,
        spanMetres: PATCH_WORLD_SIZE,
        sourceTiles: sourceTiles.length,
        classifierPages,
        windowCacheHit: cacheHit,
        fields: window.stats,
        timing: this.lastRecenterTiming,
        handoff: 'single-compiled-root-visible-during-rewrite',
      });
    } catch (err) {
      log('error', 'patch.recenter', { error: String(err), stack: String(err?.stack ?? '') });
    } finally {
      this.reseeding = false;
    }
  }

  update(renderer, camera, cameraAGL, traversal = {}) {
    if (!this.ready) return;

    const speed = Number.isFinite(traversal.speedMps) ? Math.abs(traversal.speedMps) : 0;
    if (this.motionDetailActive && speed >= DETAIL_SPEED_DISABLE_MPS) {
      this.motionDetailActive = false;
      log('info', 'patch.detail-lod', {
        active: false,
        reason: 'speed',
        speedMps: Math.round(speed),
      });
    } else if (!this.motionDetailActive && speed <= DETAIL_SPEED_ENABLE_MPS) {
      this.motionDetailActive = true;
      log('info', 'patch.detail-lod', {
        active: true,
        reason: 'speed',
        speedMps: Math.round(speed),
      });
    }

    const camTR = this._camTerrainLocal(camera);
    const finiteAGL = Number.isFinite(cameraAGL);
    const wantsDetail = finiteAGL
      && cameraAGL <= DETAIL_AGL_MAX
      && this.motionDetailActive;
    const canPrewarm = finiteAGL
      && cameraAGL <= DETAIL_PREWARM_AGL_MAX
      && speed <= DETAIL_PREWARM_SPEED_MAX;
    const activeCenter = this.window?.descriptor;
    const hasCompleteCoverage = activeCenter != null
      && Math.abs(camTR.x - activeCenter.centerX) <= DETAIL_CAMERA_GUARD
      && Math.abs(camTR.y - activeCenter.centerY) <= DETAIL_CAMERA_GUARD;

    // The streamed satellite/DEM meshes are not children of vegRoot and remain
    // visible in every tier. Only show micro-detail when the active local data
    // window still covers its entire render radius.
    this.vegRoot.visible = wantsDetail && hasCompleteCoverage;

    if (canPrewarm && !this.reseeding && !this.building
        && (!this.classifierSelectionReady || this.classifierSelectionReady())) {
      const sourceTiles = collectTiles(this.terrainRoot);
      // A single compiled slot cannot safely adopt a predictive center: when
      // speed falls near a snap boundary, lookahead vanishes and immediately
      // pulls the slot back (the measured 384:0 -> 192:0 double rebuild).
      // Center on the real camera with hysteresis. Predictive preparation
      // returns when retained chunk slots exist and can be warmed without
      // replacing the active population.
      const descriptor = cameraWindowAt(camTR.x, camTR.y, activeCenter);
      if (descriptor && descriptor.id !== this.centerId) {
        void this._recenter(renderer, descriptor, sourceTiles);
      }
    }

    if (!this.vegRoot.visible) return;

    // Keep submitting the last compiled draw graph during preparation. WebGPU
    // queue ordering prevents a partially submitted scatter pass from being
    // observed by a later scene render; no speed threshold hides the root.
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
        traversalSpeedMps: Math.round(speed),
        recentering: this.reseeding,
        center: this.centerId,
        worldSeed: this.seedN,
        procgenVersion: this.procgenVersion,
        spanMetres: PATCH_WORLD_SIZE,
        windowCacheHits: this.windowCacheHits,
        windowCacheMisses: this.windowCacheMisses,
        windowCacheEntries: this.windowCache.size,
        groundCullSubmits: hud['veg.groundCullSubmits'] ?? -1,
        groundCullSkips: hud['veg.groundCullSkips'] ?? -1,
        forestCullSubmits: forestHud['veg.forestCullSubmits'] ?? -1,
        forestCullSkips: forestHud['veg.forestCullSkips'] ?? -1,
      });
    }
  }
}
