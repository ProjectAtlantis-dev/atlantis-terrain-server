import assert from 'node:assert/strict';
import test from 'node:test';
import { OrthographicCamera, Vector3 } from 'three';

import {
  ATMOSPHERE_VISIBILITY_SAMPLES,
  configureSunDepthCamera,
} from '../webgpu-sun-depth-camera.js';

test('sun depth camera encloses the capture span and looks down sunlight', () => {
  const camera = new OrthographicCamera();
  const center = new Vector3(100, 200, 300);
  const sunDirection = new Vector3(0, 0, 1);
  const up = new Vector3(0, 1, 0);

  configureSunDepthCamera(camera, {
    center,
    sunDirection,
    up,
    span: 70_000,
    rayStart: 14_000,
    rayLength: 24_000,
  });

  assert.equal(camera.left, -35_000);
  assert.equal(camera.right, 35_000);
  assert.equal(camera.top, 35_000);
  assert.equal(camera.bottom, -35_000);
  assert.equal(camera.near, 0);
  assert.equal(camera.far, 24_000);
  assert.deepEqual(camera.position.toArray(), [100, 200, 14_300]);

  const direction = new Vector3();
  camera.getWorldDirection(direction);
  assert.ok(direction.distanceTo(sunDirection.clone().negate()) < 1e-8);
  assert.equal(ATMOSPHERE_VISIBILITY_SAMPLES, 8);
});
