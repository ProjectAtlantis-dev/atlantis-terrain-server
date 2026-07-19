import * as THREE from 'three';
import { buildRadialGridGeometry } from './water-grid.js';
import { createWaterPalette, computeWaterPalette } from './water-sky.js';
import { windCoverage } from './water-spectrum.js';

// Backend-neutral fjord water orchestration: owns parameters, the camera-
// local/sun-local frame math, sim pacing, and the colour-map capture cadence.
// The backend supplies the actual renderer work via createWater() (WebGL
// today; a WGSL/TSL port plugs in behind the same interface). Backends
// without water simply don't implement createWater and this runtime is inert.

// Fjords are NOT fetch-limited: they are long enough to channel the east-west
// winds, so the default sea state stays ocean-grade — wind along the fjord
// axis, real whitecaps. Do not pre-calm; the sliders exist for that.
export const DEFAULT_WATER_PARAMS = {
  windSpeed: 13,          // m/s
  windDirection: 90,      // degrees the wind blows toward (90 = east)
  alignment: 1.0,         // directional spreading of the spectrum
  choppiness: 1.38,       // horizontal displacement scale (drives breaking)
  amplitude: 1.0,
  foamAmount: 1.0,
  plumeLife: 7,           // whitecap (plume) e-folding life, seconds
  residueLife: 150,       // bubble-residue e-folding life, seconds
  foamTransfer: 0.12,     // plume -> residue feed rate (per second)
  ghostStrength: 2.0,     // how strongly residue keeps the cap's ghost visible
  cloudiness: 0,          // 0 clear -> 1 overcast
  tintStrength: 1.0,      // how much local imagery colour replaces defaults
  radiance: 1.0,          // output gain vs the scene's tone-mapping exposure
  timeScale: 1.0,
  seed: 1,
};

const CAPTURE_MIN_INTERVAL_MS = 750;

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
      applyWind() {}, markColorDirty() {}, update() {}, dispose() {},
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
  let lastCaptureMs = 0;
  let colorDirty = true;
  let simTime = 0;

  function applyWind() {
    water.setWind({
      speed: params.windSpeed,
      directionRad: THREE.MathUtils.degToRad(params.windDirection),
      amplitude: params.amplitude,
      alignment: params.alignment,
      seed: params.seed,
      windCoverage: windCoverage(params.windSpeed),
    });
  }
  applyWind();

  function update({ dt, nowMs, camera, visible }) {
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
    const cov = windCoverage(params.windSpeed) * Math.min(params.foamAmount, 1.5);
    simParams.choppiness = params.choppiness;
    simParams.foamBias = THREE.MathUtils.lerp(
      0.34, 0.70, Math.pow(THREE.MathUtils.clamp(cov, 0, 1), 0.55),
    );
    simParams.foamGrow = 4.0;
    simParams.plumeDecay = 1 / params.plumeLife;
    simParams.residueDecay = 1 / params.residueLife;
    simParams.foamTransfer = params.foamTransfer;

    water.update({
      simTime, dt: scaledDt, meshOffset, cameraLocal, sunLocal,
      palette, params, simParams,
    });

    // Colour-map capture is event-driven: markColorDirty() fires on actual
    // texture application (tile arrival/upgrade), movement re-centres the
    // window. The interval is only a coalescer — tiles apply in bursts of a
    // few per frame and must not become a capture per frame.
    if (water.captureColorMap && nowMs - lastCaptureMs >= CAPTURE_MIN_INTERVAL_MS) {
      const moved = lastCaptureCenter.distanceTo(meshOffset)
        > water.colorMapExtent * 0.12;
      if (moved || colorDirty) {
        water.captureColorMap({ scene, terrainRoot, centerXY: meshOffset });
        lastCaptureCenter.copy(meshOffset);
        lastCaptureMs = nowMs;
        colorDirty = false;
      }
    }
  }

  return {
    enabled: true,
    params,
    applyWind,
    // Call when a terrain texture is applied or upgraded; the next update
    // (past the coalescing interval) re-captures the colour map.
    markColorDirty() { colorDirty = true; },
    update,
    dispose() {
      terrainRoot.remove(water.mesh);
      water.dispose();
    },
  };
}
