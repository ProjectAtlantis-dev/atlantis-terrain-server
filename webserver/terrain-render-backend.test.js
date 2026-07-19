import assert from 'node:assert/strict';
import test from 'node:test';

import {
  alternateTerrainRenderBackend,
  resolveTerrainRenderBackend,
} from './terrain-render-backend.js';

test('renderer selection defaults to WebGL and restores supported WebGPU', () => {
  assert.equal(resolveTerrainRenderBackend(null, true), 'webgl');
  assert.equal(resolveTerrainRenderBackend('junk', true), 'webgl');
  assert.equal(resolveTerrainRenderBackend('webgl', true), 'webgl');
  assert.equal(resolveTerrainRenderBackend('webgpu', true), 'webgpu');
  assert.equal(resolveTerrainRenderBackend('webgpu', false), 'webgl');
});

test('renderer selection toggles between the two backends', () => {
  assert.equal(alternateTerrainRenderBackend('webgl'), 'webgpu');
  assert.equal(alternateTerrainRenderBackend('webgpu'), 'webgl');
});
