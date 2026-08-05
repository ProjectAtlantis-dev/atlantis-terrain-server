import assert from 'node:assert/strict';
import test from 'node:test';
import {
  epsg3413DirectionBearing,
  epsg3413ToWgs84,
  wgs84ToEpsg3413,
} from '../terrain-polar-stereo.js';

test('EPSG:3413 inverse matches the Nuuk-area WGS84 reference', () => {
  const result = epsg3413ToWgs84(-321798.6734463132, -2833594.578052482);
  assert.ok(Math.abs(result.lat - 64.1062513) < 1e-8);
  assert.ok(Math.abs(result.lon - -51.4790670) < 1e-8);
});

test('WGS84 forward projection round-trips Greenland town coordinates', () => {
  for (const expected of [
    { lat: 64.18347, lon: -51.72157 },
    { lat: 77.46666, lon: -69.23155 },
    { lat: 70.48456, lon: -21.96221 },
  ]) {
    const grid = wgs84ToEpsg3413(expected.lat, expected.lon);
    const actual = epsg3413ToWgs84(grid.x, grid.y);
    assert.ok(Math.abs(actual.lat - expected.lat) < 1e-8);
    assert.ok(Math.abs(actual.lon - expected.lon) < 1e-8);
  }
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
