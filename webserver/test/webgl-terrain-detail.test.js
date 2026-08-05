import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { applyTerrainDetailWebGL } from '../render-backends/webgl-terrain-detail.js';
import { CLIFF_GRAFTS } from '../terrain-cliff-graft.js';

function fakeTexture(uuid) {
  return { uuid, isTexture: true };
}

function detailTextures() {
  return {
    rock: fakeTexture('rock'),
    rockColor: fakeTexture('rockColor'),
    vegetation: fakeTexture('vegetation'),
    snow: fakeTexture('snow'),
    rockNormal: fakeTexture('rockNormal'),
    vegetationNormal: fakeTexture('vegetationNormal'),
    snowNormal: fakeTexture('snowNormal'),
  };
}

function fakeMesh() {
  const material = new THREE.MeshBasicMaterial();
  material.map = fakeTexture('base-map');
  return new THREE.Mesh(new THREE.BufferGeometry(), material);
}

function context(overrides = {}) {
  const graft = {
    spec: CLIFF_GRAFTS[0],
    texture: fakeTexture('graft-diffuse'),
    normalTexture: fakeTexture('graft-normal'),
    layers: [{
      texture: fakeTexture('graft-diffuse'),
      normalTexture: fakeTexture('graft-normal'),
      periodM: CLIFF_GRAFTS[0].periodM,
    }],
  };
  return {
    maskTexture: fakeTexture('mask'),
    textures: detailTextures(),
    uv: { scale: 1, offsetX: 0, offsetY: 0 },
    grafts: [graft],
    tintMap: null,
    detailEnabled: true,
    ...overrides,
  };
}

test('a redundant re-apply reports unchanged so callers can skip the repaint', () => {
  const mesh = fakeMesh();
  assert.equal(applyTerrainDetailWebGL(mesh, context()), 'patched');
  // Same inputs, fresh context object: nothing to write, nothing to repaint.
  assert.equal(applyTerrainDetailWebGL(mesh, context()), 'unchanged');
  assert.equal(applyTerrainDetailWebGL(mesh, context()), 'unchanged');
});

test('a changed input still refreshes the patched material in place', () => {
  const mesh = fakeMesh();
  applyTerrainDetailWebGL(mesh, context());

  const movedUv = context({ uv: { scale: 2, offsetX: 0.25, offsetY: 0.5 } });
  assert.equal(applyTerrainDetailWebGL(mesh, movedUv), 'refreshed');
  const uniforms = mesh.material.userData.terrainDetailUniforms;
  assert.equal(uniforms.detailUvScale.value, 2);
  assert.equal(uniforms.detailUvOffset.value.x, 0.25);

  // A new mask texture is the common real change and must not be swallowed.
  const newMask = context({
    uv: { scale: 2, offsetX: 0.25, offsetY: 0.5 },
    maskTexture: fakeTexture('mask-2'),
  });
  assert.equal(applyTerrainDetailWebGL(mesh, newMask), 'refreshed');
  assert.equal(uniforms.detailMask.value.uuid, 'mask-2');
});

test('detail uniforms carry the graft spec through both apply paths', () => {
  const spec = CLIFF_GRAFTS[0];
  const mesh = fakeMesh();
  applyTerrainDetailWebGL(mesh, context());
  const uniforms = mesh.material.userData.terrainDetailUniforms;

  // detailGraftRelief packs three separate spec fields into one vec3; a rename
  // on either side silently zeroes relief shading, which is invisible in tests
  // that only assert the call succeeded.
  assert.equal(uniforms.detailGraftRelief.value.x, spec.normalRelief);
  assert.equal(uniforms.detailGraftRelief.value.y, spec.reliefContrast);
  assert.equal(uniforms.detailGraftRelief.value.z, spec.reliefFloor);
  assert.equal(uniforms.detailGraftParams.value.x, spec.periodM);
  assert.equal(uniforms.detailGraftParams.value.y, spec.slopeStart);
  assert.equal(uniforms.detailGraftParams.value.z, spec.slopeEnd);
  assert.equal(uniforms.detailGraftParams.value.w, spec.strength);
  assert.equal(uniforms.detailGraftAllAspects.value, spec.aspect === 'all' ? 1 : 0);

  // And again after a refresh, which writes the same fields through a
  // completely separate code path.
  applyTerrainDetailWebGL(mesh, context({ uv: { scale: 4, offsetX: 0, offsetY: 0 } }));
  assert.equal(uniforms.detailGraftRelief.value.y, spec.reliefContrast);
  assert.equal(uniforms.detailGraftRelief.value.z, spec.reliefFloor);
});

test('a mesh without a base map cannot take the detail layer', () => {
  const mesh = new THREE.Mesh(
    new THREE.BufferGeometry(), new THREE.MeshBasicMaterial(),
  );
  assert.equal(applyTerrainDetailWebGL(mesh, context()), false);
});
