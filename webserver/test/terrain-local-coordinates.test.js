import assert from 'node:assert/strict';
import test from 'node:test';

import {
  METRES_PER_DEGREE,
  approximateLatLonToLocalMeters,
  localMetersToApproximateLatLon,
} from '../terrain-local-coordinates.js';

test('local coordinate approximation round-trips around its anchor', () => {
  const anchorLat = 64;
  const anchorLon = -51;
  const local = {
    eastM: METRES_PER_DEGREE * Math.cos(anchorLat * Math.PI / 180),
    northM: METRES_PER_DEGREE,
  };
  const latLon = localMetersToApproximateLatLon({
    ...local,
    anchorLat,
    anchorLon,
  });
  assert.deepEqual(latLon, { lat: 65, lon: -50 });
  const restored = approximateLatLonToLocalMeters({
    ...latLon,
    anchorLat,
    anchorLon,
  });
  assert.ok(Math.abs(restored.eastM - local.eastM) < 1e-9);
  assert.ok(Math.abs(restored.northM - local.northM) < 1e-9);
});

test('coordinate deltas are measured relative to the supplied anchor latitude', () => {
  const delta = approximateLatLonToLocalMeters({
    lat: 64.1,
    lon: -51.2,
    anchorLat: 64,
    anchorLon: -51,
  });
  assert.ok(
    Math.abs(delta.eastM - (-0.2 * METRES_PER_DEGREE * Math.cos(64 * Math.PI / 180))) < 1e-9,
  );
  assert.ok(Math.abs(delta.northM - 0.1 * METRES_PER_DEGREE) < 1e-9);
});

