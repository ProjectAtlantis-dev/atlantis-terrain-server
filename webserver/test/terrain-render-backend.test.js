import assert from 'node:assert/strict';
import test from 'node:test';

import {
  alternateTerrainRenderBackend,
  resolveTerrainRenderBackend,
  WEBGPU_BACKEND_ENABLED,
} from '../terrain-render-backend.js';

test('renderer selection defaults to WebGL and restores supported WebGPU', () => {
  assert.equal(resolveTerrainRenderBackend(null, true, true), 'webgl');
  assert.equal(resolveTerrainRenderBackend('junk', true, true), 'webgl');
  assert.equal(resolveTerrainRenderBackend('webgl', true, true), 'webgl');
  assert.equal(resolveTerrainRenderBackend('webgpu', true, true), 'webgpu');
  assert.equal(resolveTerrainRenderBackend('webgpu', false, true), 'webgl');
});

test('renderer selection stays on WebGL while the WebGPU backend is disabled', () => {
  assert.equal(resolveTerrainRenderBackend('webgpu', true, false), 'webgl');
  assert.equal(resolveTerrainRenderBackend(null, true, false), 'webgl');
});

test('the WebGPU backend is disabled by default, so stored preferences fall back', () => {
  assert.equal(WEBGPU_BACKEND_ENABLED, false);
  assert.equal(resolveTerrainRenderBackend('webgpu', true), 'webgl');
});

test('renderer selection toggles between the two backends', () => {
  assert.equal(alternateTerrainRenderBackend('webgl'), 'webgpu');
  assert.equal(alternateTerrainRenderBackend('webgpu'), 'webgl');
});
