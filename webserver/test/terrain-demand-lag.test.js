import assert from 'node:assert/strict';
import test from 'node:test';

import {
  terrainDemandLag,
  terrainInspectorCameraScenePosition,
} from '../terrain-tile-fetch.js';

test('terrain demand lag compares live and last-served EPSG positions', () => {
  assert.deepEqual(terrainDemandLag({
    cameraX: -275_000,
    cameraY: -2_869_000,
    servedX: -275_300,
    servedY: -2_869_400,
  }), {
    cameraX: -275_000,
    cameraY: -2_869_000,
    servedX: -275_300,
    servedY: -2_869_400,
    eastM: 300,
    northM: 400,
    distanceM: 500,
  });
});

test('terrain demand lag rejects incomplete coordinates', () => {
  assert.equal(terrainDemandLag({
    cameraX: 1,
    cameraY: 2,
    servedX: null,
    servedY: 4,
  }), null);
});

test('tile inspector follows live camera instead of last server position', () => {
  assert.deepEqual(terrainInspectorCameraScenePosition({
    liveX: -274_000,
    liveY: -2_868_000,
    servedX: -280_000,
    servedY: -2_875_000,
    originX: -275_000,
    originY: -2_869_000,
    frameOffsetX: 30,
    frameOffsetY: -20,
  }), { x: 1030, y: 980 });
});
