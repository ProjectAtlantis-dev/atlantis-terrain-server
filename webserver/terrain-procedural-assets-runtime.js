import { color, float, mix, normalLocal, positionLocal, smoothstep, texture, transformNormalToView, uniform, uv, vec3 } from 'three/tsl';
import { TerrainProceduralPatch } from './terrain-procedural-patch.js';
import { buildTerrainShading } from './procedural-runtime/render/TerrainMaterial.ts';
import { vegViewPos } from './procedural-runtime/render/VegInstance.ts';

const FIELD_KEYS = [
  'veg', 'rock', 'snow', 'water', 'slope', 'southness', 'sun', 'altitude', 'moisture',
];
const FIELD_RETRY_MS = 2000;
const FIELD_PREFETCH_COUNT = 32;
const FIELD_PREFETCH_LEAD_MAX = 768;
const UNTEXTURED_COLOR = 0x29313a;

/**
 * Bridges the streamed terrain application to the camera-following procedural
 * detail system. The bridge is intentionally inert on WebGL: streamed terrain,
 * textures, classifiers, water, controls, and vehicles remain shared by both
 * render backends while GPU-compute vegetation is enabled only on WebGPU.
 */
export function createTerrainProceduralAssetsRuntime({
  backend,
  renderer,
  terrainRoot,
  camera,
  anchorPosition,
  east,
  north,
  bootQuery = new URLSearchParams(),
  getSunLight = () => null,
  getCSM = () => null,
  markSceneMutated = () => {},
  requestRender = () => {},
  log = () => {},
} = {}) {
  const enabled = backend === 'webgpu' && bootQuery.get('procgenPatch') !== '0';
  const fieldCache = new Map();
  const fieldPending = new Map();
  const fieldRetryAfter = new Map();
  const centerX = uniform(0).setName('atlantisProcgenCenterX');
  const centerY = uniform(0).setName('atlantisProcgenCenterY');
  const cameraRelative = { x: 0, y: 0 };
  let classifierSelectionReady = false;
  let patch = null;

  async function fetchTileFields(tileId) {
    if (!enabled || !tileId) return null;
    if (fieldCache.has(tileId)) return fieldCache.get(tileId);
    if (fieldPending.has(tileId)) return fieldPending.get(tileId);
    if (performance.now() < (fieldRetryAfter.get(tileId) ?? 0)) return null;

    const pending = (async () => {
      const response = await fetch(`/api/fields/${tileId}`);
      if (!response.ok) {
        fieldRetryAfter.set(tileId, performance.now() + FIELD_RETRY_MS);
        return null;
      }
      const compressed = await response.arrayBuffer();
      const decompressor = new DecompressionStream('deflate');
      const stream = new Blob([compressed]).stream().pipeThrough(decompressor);
      const raw = new Uint8Array(await new Response(stream).arrayBuffer());
      if (raw.length < 8 || raw[0] !== 0x46 || raw[1] !== 0x4c
          || raw[2] !== 0x44 || raw[3] !== 0x31) return null;
      const resolution = raw[4] | (raw[5] << 8);
      const fieldCount = Math.min(raw[6], FIELD_KEYS.length);
      const fieldLength = resolution * resolution;
      if (resolution < 2 || raw.length < 8 + fieldLength * fieldCount) return null;
      const channels = {};
      let offset = 8;
      for (let index = 0; index < fieldCount; index += 1) {
        channels[FIELD_KEYS[index]] = raw.subarray(offset, offset + fieldLength);
        offset += fieldLength;
      }
      const fields = { res: resolution, chans: channels };
      fieldCache.set(tileId, fields);
      fieldRetryAfter.delete(tileId);
      return fields;
    })().catch(error => {
      fieldRetryAfter.set(tileId, performance.now() + FIELD_RETRY_MS);
      log('warn', 'fields.fetch', { tileId, error: String(error) });
      return null;
    }).finally(() => {
      fieldPending.delete(tileId);
    });
    fieldPending.set(tileId, pending);
    return pending;
  }

  function clearTerrainNodes(mesh) {
    const material = mesh?.material;
    if (!material || !mesh.userData?.proceduralTerrainMaterial) return false;
    material.colorNode = null;
    material.normalNode = null;
    material.roughnessNode = null;
    material.metalnessNode = null;
    mesh.userData.proceduralTerrainMaterial = null;
    material.needsUpdate = true;
    return true;
  }

  function intersects(context, mesh) {
    const bbox = mesh?.userData?.bbox ?? mesh?.userData?.scatterInput?.bbox;
    return Array.isArray(bbox) && bbox.length === 4
      && bbox[2] >= context.xMin && bbox[0] <= context.xMax
      && bbox[3] >= context.yMin && bbox[1] <= context.yMax;
  }

  function applyTerrainNodes(mesh, sourceTexture, context) {
    if (!enabled || !mesh?.material || !context || !intersects(context, mesh)) {
      return clearTerrainNodes(mesh);
    }
    const material = mesh.material;
    const materialKey = `procedural:${sourceTexture?.uuid ?? 'fields'}`;
    if (mesh.userData.proceduralTerrainMaterial === materialKey) return false;

    const localPosition = vec3(
      positionLocal.x.sub(centerX),
      positionLocal.z,
      centerY.sub(positionLocal.y),
    );
    const heightfield = context.hf;
    const shading = buildTerrainShading({
      normalTex: heightfield.normalTex,
      biomeTex: heightfield.biomeTex,
      fieldsTex: heightfield.fieldsTex,
      noiseA: heightfield.noiseA,
      noiseB: heightfield.noiseB,
      mp: heightfield.mp,
      far: false,
      external: true,
      worldPosition: localPosition,
      cameraWorldPosition: vegViewPos,
      worldSize: context.worldSize,
    });
    const cameraDistance = localPosition.sub(vegViewPos).length();
    const proceduralMix = float(1).sub(smoothstep(270, 350, cameraDistance));
    const satellite = sourceTexture
      ? texture(sourceTexture, uv()).rgb
      : color(UNTEXTURED_COLOR);

    if (sourceTexture) {
      material.colorNode = satellite;
      material.normalNode = null;
      material.roughnessNode = null;
    } else {
      material.colorNode = mix(satellite, shading.colorNode, proceduralMix);
      const baseNormal = vec3(normalLocal.x, normalLocal.z, normalLocal.y.negate());
      const blendedNormal = mix(baseNormal, shading.worldNormalNode, proceduralMix).normalize();
      material.normalNode = transformNormalToView(vec3(
        blendedNormal.x,
        blendedNormal.z.negate(),
        blendedNormal.y,
      ));
      material.roughnessNode = mix(float(1), shading.roughnessNode, proceduralMix);
    }
    material.metalnessNode = float(0);
    material.vertexColors = false;
    mesh.userData.proceduralTerrainMaterial = materialKey;
    material.needsUpdate = true;
    return true;
  }

  function refreshTerrainMaterials() {
    if (!enabled) return;
    const context = patch?.terrainMaterialContext?.() ?? null;
    if (context) {
      centerX.value = context.centerX;
      centerY.value = context.centerY;
    }
    let applied = 0;
    let cleared = 0;
    for (const child of terrainRoot.children) {
      if (!child.isMesh || !child.material) continue;
      const changed = context && intersects(context, child)
        ? applyTerrainNodes(child, child.material.map ?? null, context)
        : clearTerrainNodes(child);
      if (changed && context && intersects(context, child)) applied += 1;
      else if (changed) cleared += 1;
    }
    log('info', 'procedural.materials', { center: context?.id ?? null, applied, cleared });
    markSceneMutated();
    requestRender();
  }

  if (enabled) {
    patch = new TerrainProceduralPatch(terrainRoot, 1337, {
      loadFields: fetchTileFields,
      classifierSelectionReady: () => classifierSelectionReady,
      getCSM,
      getSunLight,
      onWindowChanged: refreshTerrainMaterials,
      logger: log,
    });
  }
  log('info', 'procedural.runtime.ready', {
    backend,
    enabled,
    worldSizeM: 768,
    fieldChannels: FIELD_KEYS,
  });

  function cameraTerrainPosition() {
    const relative = camera.position.clone().sub(anchorPosition);
    cameraRelative.x = relative.dot(east);
    cameraRelative.y = relative.dot(north);
    return cameraRelative;
  }

  function attachTerrainData(mesh, tile, heightmap) {
    if (!enabled || !mesh || !tile?.id) return;
    mesh.userData.scatterInput = {
      tileId: tile.id,
      bbox: tile.bbox,
      hm: heightmap,
      res: tile.resolution,
      source: tile.source,
    };
  }

  function prefetchFields(tiles, motion = {}) {
    if (!patch || !Array.isArray(tiles) || tiles.length === 0) return;
    const current = cameraTerrainPosition();
    const heading = Number.isFinite(motion.heading) ? motion.heading : 0;
    const speed = Number.isFinite(motion.speedMps) ? Math.abs(motion.speedMps) : 0;
    const lead = Math.min(FIELD_PREFETCH_LEAD_MAX, speed * 4);
    const targetX = current.x - Math.sin(heading) * lead;
    const targetY = current.y + Math.cos(heading) * lead;
    const ranked = [];
    for (const tile of tiles) {
      const bbox = tile?.bbox;
      if (!tile?.id || !Array.isArray(bbox) || bbox.length !== 4) continue;
      const tileX = (bbox[0] + bbox[2]) * 0.5;
      const tileY = (bbox[1] + bbox[3]) * 0.5;
      ranked.push({
        tileId: tile.id,
        distance2: Math.min(
          (tileX - current.x) ** 2 + (tileY - current.y) ** 2,
          (tileX - targetX) ** 2 + (tileY - targetY) ** 2,
        ),
      });
    }
    ranked.sort((left, right) => left.distance2 - right.distance2);
    for (const entry of ranked.slice(0, FIELD_PREFETCH_COUNT)) {
      void fetchTileFields(entry.tileId);
    }
  }

  function update({ cameraAGL, motion = {}, terrainReady = false } = {}) {
    if (!patch || renderer.backend?.isWebGPUBackend !== true) return;
    camera.updateMatrixWorld(true);
    if (terrainReady && !patch.ready && !patch.building) {
      void patch.build(renderer, camera, cameraAGL, motion).then(requestRender);
    }
    patch.update(renderer, camera, cameraAGL, motion);
  }

  const runtime = {
    enabled,
    get patch() { return patch; },
    attachTerrainData,
    applyTerrainMaterial(mesh, sourceTexture = mesh?.material?.map ?? null) {
      const context = patch?.terrainMaterialContext?.() ?? null;
      if (context) {
        centerX.value = context.centerX;
        centerY.value = context.centerY;
      }
      const changed = context
        ? applyTerrainNodes(mesh, sourceTexture, context)
        : clearTerrainNodes(mesh);
      if (changed) markSceneMutated();
      return changed;
    },
    refreshTerrainMaterials,
    prefetchFields,
    setWorldIdentity(identity) { return patch?.setWorldIdentity(identity) ?? false; },
    markClassifierReady() { classifierSelectionReady = true; },
    resetClassifierReadiness() { classifierSelectionReady = false; },
    update,
    requiresContinuousRender() {
      return Boolean(patch?.vegRoot?.visible || patch?.building || patch?.reseeding);
    },
  };

  if (typeof window !== 'undefined') {
    window.__atlantisWebGPU ??= {};
    window.__atlantisWebGPU.proceduralAssets = runtime;
  }
  return runtime;
}
