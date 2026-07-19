import * as THREE from 'three';
import { buildRadialGridGeometry } from './water-grid.js';
import { createWaterPalette, computeWaterPalette } from './water-sky.js';

// Backend-neutral fjord water orchestration: owns parameters, the camera-
// local/sun-local frame math, and sim pacing. The backend supplies the
// actual renderer work via createWater() (WebGL today; a WGSL/TSL port plugs
// in behind the same interface). Backends without water simply don't
// implement createWater and this runtime is inert. Colour inheritance needs
// no orchestration: the surface is translucent and the seabed imagery —
// which is satellite photography OF the water — shows through per-pixel.

// Fjords are NOT fetch-limited: they are long enough to channel the east-west
// winds, so the default sea state stays ocean-grade — wind along the fjord
// axis. Do not pre-calm; the sliders exist for that.
// (No foam/whitecap params: the foam system was removed — every presentation
// read as garbage from altitude. Waves + light only.)
export const DEFAULT_WATER_PARAMS = {
  windSpeed: 13,          // m/s
  windDirection: 90,      // degrees the wind blows toward (90 = east)
  fetchKm: 100,           // wave-growth fetch: sets the JONSWAP peak so a
                          // windy fjord sea stays short (~60-70 m waves at
                          // 13 m/s) instead of open-Atlantic 150 m swell
  alignment: 1.0,         // directional spreading of the spectrum
  choppiness: 1.38,       // horizontal displacement scale
  amplitude: 1.0,
  cloudiness: 0,          // 0 clear -> 1 overcast
  opacity: 0,             // surface body veil — 0 by choice: the seabed
                          // imagery carries the water colour entirely, the
                          // surface adds only reflection and glint
  reflectivity: 0.4,      // sky-reflection gain (fjord walls occlude the sky)
  absorption: 0.05,       // Beer-Lambert 1/m: shallow shore water stays
                          // clear, the -10 m mask-drop walls fade with depth
  radiance: 1.0,          // output gain vs the scene's tone-mapping exposure
  timeScale: 1.0,
  seed: 1,
};

const BATHY_REFRESH_MS = 15000;

export function createWaterRuntime({
  backend,
  scene,
  terrainRoot,
  anchorPosition,
  east,
  north,
  up,
  getSunDirection,
  params = { ...DEFAULT_WATER_PARAMS },
}) {
  const water = backend.createWater?.({ geometry: buildRadialGridGeometry() }) ?? null;
  if (!water?.mesh) {
    return {
      enabled: false, params,
      applyWind() {}, update() {}, dispose() {},
    };
  }
  terrainRoot.add(water.mesh);

  const palette = createWaterPalette();
  const rel = new THREE.Vector3();
  const cameraLocal = new THREE.Vector3();
  const sunLocal = new THREE.Vector3();
  const meshOffset = new THREE.Vector2();
  const lastCaptureCenter = new THREE.Vector2(Infinity, Infinity);
  const simParams = {};
  let simTime = 0;
  let lastCaptureMs = -Infinity;

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

  function update({ dt, camera, visible }) {
    water.mesh.visible = visible;
    if (!visible) return;

    rel.copy(camera.position).sub(anchorPosition);
    cameraLocal.set(rel.dot(east), rel.dot(north), rel.dot(up));
    meshOffset.set(cameraLocal.x, cameraLocal.y);
    water.mesh.position.set(meshOffset.x, meshOffset.y, 0);

    const sunEcef = getSunDirection();
    sunLocal.set(sunEcef.dot(east), sunEcef.dot(north), sunEcef.dot(up)).normalize();
    const sunElevationDeg = THREE.MathUtils.radToDeg(
      Math.asin(THREE.MathUtils.clamp(sunLocal.z, -1, 1)),
    );
    computeWaterPalette(palette, { sunElevationDeg, cloudiness: params.cloudiness });

    const scaledDt = dt * params.timeScale;
    simTime += scaledDt;
    simParams.choppiness = params.choppiness;

    water.update({
      simTime, dt: scaledDt, meshOffset, cameraLocal, sunLocal,
      palette, params, simParams,
    });

    // The seabed is a static -10 m floor — water terrain effectively never
    // changes; at most the shoreline sharpens as higher-LOD tiles stream in.
    // So: re-capture when movement re-centres the window, plus a lazy
    // periodic refresh to pick up shoreline upscales. No event plumbing.
    if (water.captureBathymetry) {
      const nowMs = performance.now();
      const moved = lastCaptureCenter.distanceTo(meshOffset)
        > water.bathyExtent * 0.12;
      if (moved || nowMs - lastCaptureMs >= BATHY_REFRESH_MS) {
        water.captureBathymetry({ scene, terrainRoot, centerXY: meshOffset });
        lastCaptureCenter.copy(meshOffset);
        lastCaptureMs = nowMs;
      }
    }
  }

  return {
    enabled: true,
    params,
    applyWind,
    update,
    dispose() {
      terrainRoot.remove(water.mesh);
      water.dispose();
    },
  };
}
