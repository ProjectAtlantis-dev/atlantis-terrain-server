import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeWaterGlintColor,
  computeWaterPalette,
  createWaterPalette,
  waterCloudinessFromCoverage,
} from '../water/water-sky.js';

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

test('direct glint preserves sun luminance while compressing copper chroma', () => {
  const source = { r: 3.2, g: 1.718419, b: 1.126497 };
  const glint = computeWaterGlintColor(
    createWaterPalette().glint,
    source,
  );
  const luminance = color =>
    color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;

  assert.ok(Math.abs(luminance(glint) - luminance(source)) < 1e-9);
  assert.ok(glint.r / glint.b < source.r / source.b * 0.5);
  assert.ok(glint.r > glint.g && glint.g > glint.b);
});

test('water overcast follows enabled sky coverage', () => {
  assert.equal(waterCloudinessFromCoverage(0.8, true), 0.8);
  assert.equal(waterCloudinessFromCoverage(0.8, false), 0);
  assert.equal(waterCloudinessFromCoverage(-1, true), 0);
  assert.equal(waterCloudinessFromCoverage(2, true), 1);
  assert.equal(waterCloudinessFromCoverage(Number.NaN, true), 0);
});

test('overcast palette neutralizes sun and shifts the water body toward steel gray', () => {
  const clear = computeWaterPalette(createWaterPalette(), {
    sunElevationDeg: 13.123,
    cloudiness: 0,
  });
  const overcast = computeWaterPalette(createWaterPalette(), {
    sunElevationDeg: 13.123,
    cloudiness: 1,
  });

  assert.ok(overcast.sun.r < clear.sun.r);
  assert.ok(Math.abs(overcast.sun.r - overcast.sun.g) < 1e-9);
  assert.ok(Math.abs(overcast.sun.g - overcast.sun.b) < 1e-9);
  assert.ok(overcast.deep.b > overcast.deep.r);
  assert.ok(overcast.scatter.g > overcast.scatter.r);
});
