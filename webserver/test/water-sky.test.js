import assert from 'node:assert/strict';
import test from 'node:test';

import { computeWaterPalette, createWaterPalette } from '../water/water-sky.js';

test('clear dusk water palette is orange with violet off-axis reflections', () => {
  const palette = computeWaterPalette(createWaterPalette(), {
    sunElevationDeg: 0,
    cloudiness: 0,
  });

  // The warm lane must stay saturated enough to survive mixing with the dark
  // satellite-water background without collapsing into copper/brown.
  assert.ok(palette.horizon.r > palette.horizon.g * 3.5);
  assert.ok(palette.horizon.g > palette.horizon.b * 8);
  assert.ok(palette.sun.r > palette.sun.g * 3);

  // Reflections immediately outside that lane should read violet, not as a
  // dimmer extension of the red/orange band.
  assert.ok(palette.horizonCool.b > palette.horizonCool.r * 2);
  assert.ok(palette.horizonCool.r > palette.horizonCool.g * 4);
});

test('daylight water palette still converges on the neutral blue horizon', () => {
  const palette = computeWaterPalette(createWaterPalette(), {
    sunElevationDeg: 35,
    cloudiness: 0,
  });

  assert.ok(palette.horizon.b > palette.horizon.g);
  assert.ok(palette.horizon.g > palette.horizon.r);
  assert.ok(Math.abs(palette.horizon.r - palette.horizonCool.r) < 1e-9);
  assert.ok(Math.abs(palette.horizon.g - palette.horizonCool.g) < 1e-9);
  assert.ok(Math.abs(palette.horizon.b - palette.horizonCool.b) < 1e-9);
});
