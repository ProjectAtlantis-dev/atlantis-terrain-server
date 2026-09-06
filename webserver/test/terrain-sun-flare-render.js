// Open through Vite. Exercise the real HDR flare pass with a sun disk at the
// position rendered by the moving atmosphere frame, well away from Nuuk.
import * as THREE from 'three';
import { EffectComposer, EffectPass, RenderPass } from 'postprocessing';
import { Ellipsoid, Geodetic, radians } from '@takram/three-geospatial';
import { createTerrainAtmosphereFrame } from '../terrain-atmosphere-frame.js';
import { TerrainSunFlareEffect } from '../terrain-sun-flare-effect.js';

try {
  const anchor = new Geodetic(radians(-51.7216), radians(64.1835), 0).toECEF();
  const east = new THREE.Vector3(), north = new THREE.Vector3(), up = new THREE.Vector3();
  Ellipsoid.WGS84.getEastNorthUpVectors(anchor, east, north, up);
  const frame = createTerrainAtmosphereFrame({ sceneEast: east, sceneNorth: north, sceneUp: up });
  const state = frame.update({ latitude: 60.57, longitude: -44.25, sceneSurfacePosition: anchor });
  const elevation = radians(25);
  const ecefSun = state.ecefNorth.clone().multiplyScalar(Math.cos(elevation))
    .addScaledVector(state.ecefUp, Math.sin(elevation));
  const sceneSun = frame.toSceneDirection(ecefSun);
  const camera = new THREE.PerspectiveCamera(60, 1, 1, 1e7);
  camera.position.copy(anchor).addScaledVector(up, 100);
  camera.up.copy(up);
  camera.lookAt(camera.position.clone().addScaledVector(sceneSun, 1000));
  camera.updateMatrixWorld(true);

  const renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true, logarithmicDepthBuffer: true });
  renderer.setSize(256, 256);
  const scene = new THREE.Scene();
  const material = new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false,
    vertexShader: 'varying vec2 vUv; void main() { vUv=uv; gl_Position=vec4(position.xy,0.,1.); }',
    fragmentShader: 'varying vec2 vUv; void main() { float disk=1.-smoothstep(.002,.004,length(vUv-.5)); gl_FragColor=vec4(vec3(.02+disk*100.),1.); }',
  });
  const source = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  source.frustumCulled = false; scene.add(source);
  const flareDirection = ecefSun.clone();
  const flare = new TerrainSunFlareEffect();
  flare.configure({ camera, sunDirection: flareDirection, surfaceUp: up });
  const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new EffectPass(camera, flare));
  const pixel = new Uint8Array(4);
  const gl = renderer.getContext();
  function sampleGlow() {
    for (let i = 0; i < 10; i++) composer.render(0.1);
    gl.readPixels(160, 128, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    return pixel[0];
  }
  const stale = sampleGlow();
  flareDirection.copy(sceneSun);
  const corrected = sampleGlow();
  if (corrected <= stale + 15) throw new Error(`Flare did not recover: stale=${stale}, corrected=${corrected}`);
  if (gl.getError() !== 0) throw new Error('GL error while rendering flare');
  // Leave the resulting image visible when this fixture is opened manually.
  document.body.textContent = `PASS: real HDR flare glow recovered, red channel ${stale} → ${corrected} / 255`;
  document.body.append(renderer.domElement);
} catch (error) {
  document.body.textContent = `FAIL: ${error.stack}`;
}
