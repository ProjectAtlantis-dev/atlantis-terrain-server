// Open /test/water-sun-shadow-render.html through Vite. This checks real GPU
// output on both backends; node tests alone cannot validate shader compilation.
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { texture, uniform } from 'three/tsl';
import { createWebGLWaterSunShadow } from '../render-backends/webgl-water-sun-shadow.js';
import { createWebGPUWaterSunShadow } from '../render-backends/webgpu-water-sun-shadow.js';
import { createWebGLWater } from '../render-backends/webgl-water.js';
import { createWebGPUWater } from '../render-backends/webgpu-water.js';
import { createWaterPalette, computeWaterPalette } from '../water/water-sky.js';
import { DEFAULT_WATER_PARAMS } from '../water/water-runtime.js';

const reports = [];
const errors = [];
const originalError = console.error;
console.error = (...args) => { errors.push(args.map(String).join(' ')); originalError(...args); };
const check = (condition, message) => { if (!condition) throw new Error(message); };

async function run(gpu) {
  const name = gpu ? 'WebGPU' : 'WebGL';
  const renderer = gpu ? new WebGPURenderer() : new THREE.WebGLRenderer({ logarithmicDepthBuffer: true });
  renderer.setSize(64, 64);
  if (gpu) await renderer.init();
  const n = 256, extent = 6000;
  const data = new Uint16Array(n * n * 4);
  const bathy = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.HalfFloatType);
  bathy.minFilter = bathy.magFilter = THREE.LinearFilter;
  const setTerrain = (coverage = 1) => {
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      // A north-only ridge, so both azimuth and capture V orientation matter.
      const worldY = ((gpu ? n - 1 - y : y) + 0.5) / n * extent - extent / 2;
      const offset = (y * n + x) * 4;
      data[offset] = THREE.DataUtils.toHalfFloat(worldY >= 600 && worldY <= 1000 ? 700 : -5);
      data[offset + 3] = THREE.DataUtils.toHalfFloat(coverage);
    }
    bathy.needsUpdate = true;
  };
  setTerrain();
  const sun = new THREE.Vector3(0, 1, 0.4).normalize();
  const inputs = gpu ? {
    texBathy: texture(bathy), uBathyExtent: uniform(extent),
    uSunDir: uniform(sun), uWaterline: uniform(0.5),
  } : {
    uBathy: { value: bathy }, uBathyExtent: { value: extent },
    uSunDir: { value: sun }, uWaterline: { value: 0.5 },
  };
  const shadow = gpu ? createWebGPUWaterSunShadow(renderer, inputs) : createWebGLWaterSunShadow(renderer, inputs);
  let shadowTarget;
  const originalSetTarget = renderer.setRenderTarget.bind(renderer);
  renderer.setRenderTarget = (target, ...args) => {
    if (target?.texture === shadow.texture) shadowTarget = target;
    return originalSetTarget(target, ...args);
  };
  const previousTarget = gpu ? new THREE.RenderTarget(8, 8) : new THREE.WebGLRenderTarget(8, 8);
  renderer.setRenderTarget(previousTarget);
  renderer.setClearColor(0x123456, 0.4);
  renderer.autoClear = false;
  shadow.invalidate();
  shadow.update();
  check(renderer.getRenderTarget() === previousTarget, `${name}: render target leaked`);
  check(renderer.getClearColor(new THREE.Color()).getHex() === 0x123456, `${name}: clear color leaked`);
  check(renderer.getClearAlpha() === 0.4 && renderer.autoClear === false, `${name}: renderer state leaked`);
  const sample = async (x = 128, y = 128) => {
    if (gpu) return (await renderer.readRenderTargetPixelsAsync(shadowTarget, x, y, 1, 1))[0];
    const result = new Uint8Array(4);
    renderer.readRenderTargetPixels(shadowTarget, x, y, 1, 1, result);
    return result[0];
  };
  check(await sample() < 5, `${name}: north ridge should block low northern sun`);
  check(await sample(128, 205) > 250, `${name}: water north of ridge must stay lit (UV orientation)`);
  sun.set(0, -1, 0.4).normalize(); shadow.update();
  check(await sample() > 250, `${name}: opposite sun should stay visible`);
  sun.set(0, 1, 3).normalize(); shadow.update();
  check(await sample() > 250, `${name}: high sun should clear ridge`);
  sun.set(0, 0, 1); shadow.update();
  check(await sample() > 250, `${name}: zenith must stay finite and lit`);
  sun.set(0, 1, -0.1).normalize(); shadow.update();
  check(await sample() < 5, `${name}: sun below horizon must be blocked`);
  sun.set(0, 1, 0.4).normalize();
  setTerrain(0); shadow.invalidate(); shadow.update();
  check(await sample() > 250, `${name}: missing coverage must stay lit`);
  setTerrain(); shadow.invalidate(); inputs.uWaterline.value = 800; shadow.update();
  check(await sample() > 250, `${name}: terrain below raised waterline must not cast shadows`);
  shadow.dispose(); bathy.dispose(); previousTarget.dispose();
  renderer.setRenderTarget(null);
  renderer.autoClear = true;

  // Compile/render the actual surface, including the new texture lookup.
  const water = (gpu ? createWebGPUWater : createWebGLWater)({
    renderer, geometry: new THREE.PlaneGeometry(100, 100, 2, 2),
    resolution: 8, bathySize: 16, bathyExtent: 6000,
  });
  const scene = new THREE.Scene();
  const root = new THREE.Group(); scene.add(root); root.add(water.mesh);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 10000);
  camera.position.set(0, -60, 40); camera.up.set(0, 0, 1); camera.lookAt(0, 0, 0);
  const palette = createWaterPalette(); computeWaterPalette(palette, { sunElevationDeg: 30, cloudiness: 0 });
  water.setWind({ speed: 13, directionRad: 1, amplitude: 1, alignment: 1, seed: 1, fetchKm: 100 });
  water.update({ simTime: 0, dt: 0.016, meshOffset: new THREE.Vector2(), cameraLocal: camera.position,
    sunLocal: new THREE.Vector3(0, 1, 0.5).normalize(), palette, params: DEFAULT_WATER_PARAMS,
    simParams: { choppiness: 1, cameraAltitude: 40 } });
  water.captureBathymetry({ scene, terrainRoot: root, centerXY: new THREE.Vector2() });
  water.updateSunShadow(); water.mesh.visible = true;
  renderer.render(scene, camera);
  if (gpu) await renderer.backend.device.queue.onSubmittedWorkDone();
  else check(renderer.getContext().getError() === 0, 'WebGL: GL error after surface render');
  water.dispose(); renderer.dispose();
  reports.push(`${name}: occlusion, clear sunlight, UV orientation, missing data, waterline, state restoration, surface compilation passed`);
}
try {
  await run(false);
  await run(true);
  check(errors.length === 0, errors.join('\n'));
  document.body.textContent = `PASS\n${reports.join('\n')}`;
} catch (error) {
  document.body.textContent = `FAIL\n${reports.join('\n')}\n${error.stack}\n${errors.join('\n')}`;
}
