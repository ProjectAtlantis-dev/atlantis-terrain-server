import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { applyV22Materials } from './terrain-v22-materials.js';

test('V-22 PBR binding restores exterior and glass without replacing cockpit maps', () => {
  const root = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ name: 'DefaultWhite' }));
  const glass = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ name: 'Transparent' }));
  const cockpitMap = new THREE.Texture();
  const cockpit = new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial({ name: 'DefaultWhite_mfd.png', map: cockpitMap }),
  );
  root.add(body, glass, cockpit);
  const textures = {
    bodyAlbedo: new THREE.Texture(), bodyMetallic: new THREE.Texture(),
    bodyNormal: new THREE.Texture(), bodyRoughness: new THREE.Texture(),
    glassDiffuse: new THREE.Texture(), glassRoughness: new THREE.Texture(),
  };
  assert.deepEqual(applyV22Materials(root, textures), { body: 1, glass: 1 });
  assert.equal(body.material.map, textures.bodyAlbedo);
  assert.equal(body.material.normalMap, textures.bodyNormal);
  assert.equal(glass.material.map, textures.glassDiffuse);
  assert.equal(glass.material.depthWrite, false);
  assert.equal(cockpit.material.map, cockpitMap);
});
