// Isolated smoke test for the WebGPU clouds port (no terrain, no post chain):
// left half = LocalWeatherNode RGB, right half = 8 tiled Z-slices of
// CloudShapeNode. Console logs CLOUD_TEXTURE_TEST_READY when rendering.
import { NodeMaterial, WebGPURenderer } from 'three/webgpu';
import * as THREE from 'three';
import { Fn, positionGeometry, screenUV, select, vec3, vec4 } from 'three/tsl';
import { CloudShapeNode, LocalWeatherNode } from '@takram/three-clouds/webgpu';

const renderer = new WebGPURenderer({ antialias: false });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.NoToneMapping;
document.body.appendChild(renderer.domElement);

const weatherNode = new LocalWeatherNode();
const shapeNode = new CloudShapeNode();

const material = new NodeMaterial();
material.vertexNode = vec4(positionGeometry.xy, 0, 1);
material.colorNode = Fn(() => {
  const weather = weatherNode
    .getTextureNode()
    .sample(vec3(screenUV.x.mul(2), screenUV.y, 0).xy);
  const shapeX = screenUV.x.mul(2).sub(1).mul(8);
  const shape = shapeNode
    .getTextureNode()
    .sample(vec3(shapeX.fract(), screenUV.y, shapeX.floor().div(8)))
    .xxxx;
  return select(screenUV.x.lessThan(0.5), weather, shape);
})();

const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
const scene = new THREE.Scene();
scene.add(quad);
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

await renderer.init();
renderer.setAnimationLoop(() => {
  renderer.render(scene, camera);
});
console.log('CLOUD_TEXTURE_TEST_READY');
