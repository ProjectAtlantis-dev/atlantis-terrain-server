import * as THREE from 'three';
import { buildRadialGridGeometry } from './water-grid.js';
import { createWaterPalette, computeWaterPalette } from './water-sky.js';
import { NORTH_CLIFF_REFLECTION_MAX_PADDING_M } from './water-reflection-mask.js';
import {
  createOpticalWaterSurfaceRuntime,
  DEFAULT_OPTICAL_WATER_DEPTH_M,
  WATER_SURFACE_RENDER_ORDER,
} from './water-optical-surface.js';

// Backend-neutral fjord water orchestration: owns parameters, the camera-
// local/sun-local frame math, and sim pacing. The backend supplies the
// actual renderer work via createWater() (WebGL today; a WGSL/TSL port plugs
// in behind the same interface). Backends without water simply don't
// implement createWater and this runtime is inert. Colour inheritance
// orchestration now lives in the optical surface runtime: true bathymetry
// remains at its measured depth while a color-only copy of the satellite
// water footprint sits just below the dynamic surface.

// Fjords are NOT fetch-limited: they are long enough to channel the east-west
// winds, so the default sea state stays ocean-grade — wind along the fjord
// axis. Do not pre-calm; the sliders exist for that.
// Shore sparkle is deliberately analytic and close-range only. The old foam
// persistence simulation read as garbage from altitude; this version reuses
// bathymetry and crest signals already sampled by the surface shader.
export const DEFAULT_WATER_PARAMS = {
  enabled: true,           // hide/pause the dynamic surface when disabled;
                          // the underlying fjord imagery remains visible
  opticalEnabled: true,    // independent diagnostic gate for the shallow
                          // color/depth proxy consumed by Takram volumetrics
  waterline: 0.5,          // terrainRoot-local metres
  opticalDepth: DEFAULT_OPTICAL_WATER_DEPTH_M,
                          // satellite-water colour plane below waterline
  windSpeed: 13,          // m/s
  windDirection: 90,      // degrees the wind blows toward (90 = east)
  fetchKm: 100,           // wave-growth fetch: sets the JONSWAP peak so a
                          // windy fjord sea stays short (~60-70 m waves at
                          // 13 m/s) instead of open-Atlantic 150 m swell
  shoreFetchRamp: 3000,   // metres of open water downwind of a lee shore for
                          // the sea state to build back to full; the spatial
                          // counterpart of fetchKm (which stays global). This
                          // calms only wind-FROM-land shorelines, not the
                          // fjord as a whole — see the note above.
  shoreFoamDepth: 3.5,    // metres: shallow sparkle fades out by here
  shoreFoamStrength: 0.7,
  alignment: 1.0,         // directional spreading of the spectrum
  choppiness: 1.38,       // horizontal displacement scale
  amplitude: 1.0,
  cloudiness: 0,          // 0 clear -> 1 overcast
  opacity: 0,             // surface body veil — 0 by choice: the seabed
                          // imagery carries the water colour entirely, the
                          // surface adds only reflection and glint
  reflectivity: 0.4,      // sky-reflection gain (fjord walls occlude the sky)
  glintStrength: 1.0,     // direct-sun glitter gain, independent of the
                          // deliberately subdued ambient sky reflection
  absorption: 0.25,       // Beer-Lambert 1/m, applied only inside the
                          // wall-slope gate: open water stays fully clear,
                          // the -5 m mask-drop walls fade hard with depth
  northCliffReflectionPadding: NORTH_CLIFF_REFLECTION_MAX_PADDING_M,
                          // maximum reflection setback; actual
                          // distance scales from ~0 on flat north shores to
                          // this value on large, steep north-facing cliffs
  radiance: 1.0,          // output gain vs the scene's tone-mapping exposure
  timeScale: 1.0,
  seed: 1,
};

const BATHY_REFRESH_MS = 15000;
const BATHY_TEXTURE_SETTLE_MS = 2000;

export function createWaterRuntime({
  backend,
  scene,
  terrainRoot,
  anchorPosition,
  east,
  north,
  up,
  getSunDirection,
  getTextureVersion = null,
  log = null,
  params = { ...DEFAULT_WATER_PARAMS },
  evictionGate = null,
}) {
  const water = backend.createWater?.({ geometry: buildRadialGridGeometry(), log }) ?? null;
  if (!water?.mesh) {
    return {
      enabled: false, params, opticalSurface: null,
      applyWind() {}, update() {}, dispose() {}, setDebugMode() {},
    };
  }
  water.mesh.renderOrder = WATER_SURFACE_RENDER_ORDER;
  terrainRoot.add(water.mesh);
  const opticalSurface = createOpticalWaterSurfaceRuntime({
    terrainRoot,
    opticalDepth: params.opticalDepth,
    onInversion: details => log?.('water.optical.inversion', details),
    evictionGate,
  });

  const palette = createWaterPalette();
  const rel = new THREE.Vector3();
  const cameraLocal = new THREE.Vector3();
  const sunLocal = new THREE.Vector3();
  const meshOffset = new THREE.Vector2();
  const lastCaptureCenter = new THREE.Vector2(Infinity, Infinity);
  const simParams = {};
  let simTime = 0;
  let lastCaptureMs = -Infinity;
  let lastCaptureTextureVersion = null;

  function applyWind() {
    water.setWind({
      speed: params.windSpeed,
      directionRad: THREE.MathUtils.degToRad(params.windDirection),
      amplitude: params.amplitude,
      alignment: params.alignment,
      seed: params.seed,
      fetchKm: params.fetchKm,
    });
  }
  applyWind();

  function update({
    dt,
    camera,
    visible,
    opticalVisible = visible,
  }) {
    // The water block is the largest remaining in-frame stall and the depth
    // capture was measured out of it, so time the rest of the phases here.
    const timings = {};
    const syncStartedAt = performance.now();
    water.mesh.visible = visible;
    // Camera position is needed before the visibility early-return so the
    // optical surface can report build ordering relative to the viewer.
    rel.copy(camera.position).sub(anchorPosition);
    opticalSurface.sync({
      visible: opticalVisible,
      waterline: params.waterline ?? 0,
      cameraX: rel.dot(east),
      cameraY: rel.dot(north),
    });
    timings.opticalSync = performance.now() - syncStartedAt;
    if (!visible) return timings;

    rel.copy(camera.position).sub(anchorPosition);
    cameraLocal.set(rel.dot(east), rel.dot(north), rel.dot(up));
    meshOffset.set(cameraLocal.x, cameraLocal.y);
    const waterline = params.waterline ?? 0;
    cameraLocal.z -= waterline;
    water.mesh.position.set(
      meshOffset.x,
      meshOffset.y,
      waterline,
    );

    const sunScene = getSunDirection();
    sunLocal.set(sunScene.dot(east), sunScene.dot(north), sunScene.dot(up)).normalize();
    const sunElevationDeg = THREE.MathUtils.radToDeg(
      Math.asin(THREE.MathUtils.clamp(sunLocal.z, -1, 1)),
    );
    computeWaterPalette(palette, { sunElevationDeg, cloudiness: params.cloudiness });

    const scaledDt = dt * params.timeScale;
    simTime += scaledDt;
    simParams.choppiness = params.choppiness;
    simParams.cameraAltitude = Math.max(0, cameraLocal.z);

    const simStartedAt = performance.now();
    water.update({
      simTime, dt: scaledDt, meshOffset, cameraLocal, sunLocal,
      palette, params, simParams,
    });
    timings.sim = performance.now() - simStartedAt;
    const captureStartedAt = performance.now();

    // Re-capture when movement re-centres the window, when tile textures have
    // changed since the last capture (debounced — streaming arrives in
    // bursts), plus a lazy periodic refresh as a backstop. The texture
    // trigger matters: the capture bakes tile-texture brightness into the
    // reflection gate, and with an on-demand render loop the lazy refresh
    // alone deferred that update to whatever next dirtied the scene — a sun
    // tick, minutes later — which read as lighting suddenly breaking.
    if (water.captureBathymetry) {
      const nowMs = performance.now();
      const textureVersion = getTextureVersion?.() ?? 0;
      const moved = lastCaptureCenter.distanceTo(meshOffset)
        > water.bathyExtent * 0.12;
      const texturesSettled = textureVersion !== lastCaptureTextureVersion
        && nowMs - lastCaptureMs >= BATHY_TEXTURE_SETTLE_MS;
      if (moved || texturesSettled || nowMs - lastCaptureMs >= BATHY_REFRESH_MS) {
        const reason = lastCaptureTextureVersion == null ? 'initial'
          : moved ? 'moved'
          : texturesSettled ? 'textures-settled'
          : 'periodic';
        const sincePreviousMs = Number.isFinite(lastCaptureMs)
          ? Math.round(nowMs - lastCaptureMs) : null;
        const stats = water.captureBathymetry({ scene, terrainRoot, centerXY: meshOffset });
        lastCaptureCenter.copy(meshOffset);
        lastCaptureMs = nowMs;
        lastCaptureTextureVersion = textureVersion;
        log?.('water.bathymetry.capture', {
          reason,
          sincePreviousMs,
          textureVersion,
          centerX: Math.round(meshOffset.x),
          centerY: Math.round(meshOffset.y),
          ...stats,
        });
      }
    }
    // Update after capture so a recentered height field and its shadow mask
    // become visible together, with at most one shadow pass per frame.
    water.updateSunShadow?.();
    timings.capture = performance.now() - captureStartedAt;
    return timings;
  }

  return {
    enabled: true,
    params,
    opticalSurface: opticalSurface.group,
    opticalStats: () => opticalSurface.stats(),
    applyWind,
    update,
    setDebugMode(mode) { water.setDebugMode?.(mode); },
    dispose() {
      opticalSurface.dispose();
      terrainRoot.remove(water.mesh);
      water.dispose();
    },
  };
}
