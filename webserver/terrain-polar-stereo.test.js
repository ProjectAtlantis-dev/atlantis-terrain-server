import assert from 'node:assert/strict';
import test from 'node:test';
import {
  epsg3413DirectionBearing,
  epsg3413ToWgs84,
  wgs84ToEpsg3413,
} from './terrain-polar-stereo.js';

test('EPSG:3413 matches and round-trips the Nuuk-area WGS84 reference', () => {
  const result = epsg3413ToWgs84(-321798.6734463132, -2833594.578052482);
  assert.ok(Math.abs(result.lat - 64.1062513) < 1e-8);
  assert.ok(Math.abs(result.lon - -51.4790670) < 1e-8);
  const reference = wgs84ToEpsg3413(64.1062513, -51.4790670);
  assert.ok(Math.abs(reference.x - -321798.6734463132) < 0.02);
  assert.ok(Math.abs(reference.y - -2833594.578052482) < 0.02);
  const projected = wgs84ToEpsg3413(64.18, -51.72);
  const roundTrip = epsg3413ToWgs84(projected.x, projected.y);
  assert.ok(Math.abs(roundTrip.lat - 64.18) < 1e-9);
  assert.ok(Math.abs(roundTrip.lon - -51.72) < 1e-9);
});

test('EPSG:3413 grid heading accounts for meridian convergence', () => {
  const bearing = epsg3413DirectionBearing({
    x: -321798.6734463132,
    y: -2833594.578052482,
    directionX: Math.sin(294.75 * Math.PI / 180),
    directionY: Math.cos(294.75 * Math.PI / 180),
  });
  assert.ok(Math.abs(bearing - 288.270983) < 1e-4);
});
