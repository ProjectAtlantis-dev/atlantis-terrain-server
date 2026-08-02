import test from 'node:test';
import assert from 'node:assert/strict';

import { createLodAltitudeStabilizer } from '../terrain-lod-altitude.js';

test('adopts the first measurement as-is', () => {
  const stabilizer = createLodAltitudeStabilizer();
  assert.equal(stabilizer.stabilize(1364), 1364);
});

test('holds through the AGL swing that straddled the depth-12 cutoff', () => {
  // Captured from a level cruise at 1364.56 m ASL; the server drops depth 12
  // above 1318.4 m AGL, so these raw values flipped the cap every response.
  const stabilizer = createLodAltitudeStabilizer({ hysteresis: 0.15 });
  const observed = [1370.6, 1306.2, 1370.6, 1305.1, 1444.1, 1457.5, 1273.5];
  const emitted = observed.map(value => stabilizer.stabilize(value));

  assert.deepEqual(emitted, observed.map(() => 1370.6));
  // Every emitted value stays on one side of the boundary.
  assert.ok(emitted.every(value => value > 1318.4));
});

test('follows a genuine climb once it leaves the band', () => {
  const stabilizer = createLodAltitudeStabilizer({ hysteresis: 0.15 });
  stabilizer.stabilize(1000);
  assert.equal(stabilizer.stabilize(1100), 1000, 'inside the band, held');
  assert.equal(stabilizer.stabilize(1800), 1800, 'outside the band, adopted');
  assert.equal(stabilizer.stabilize(1750), 1800, 'band now centred on 1800');
});

test('follows a genuine descent once it leaves the band', () => {
  const stabilizer = createLodAltitudeStabilizer({ hysteresis: 0.15 });
  stabilizer.stabilize(1600);
  assert.equal(stabilizer.stabilize(1450), 1600);
  assert.equal(stabilizer.stabilize(600), 600);
});

test('floors the band near the ground so low passes stay stable', () => {
  const stabilizer = createLodAltitudeStabilizer({
    hysteresis: 0.15,
    minimumBandAltitude: 100,
  });
  stabilizer.stabilize(20);
  // A proportional band would be 3 m here; the floor makes it 15 m.
  assert.equal(stabilizer.stabilize(30), 20);
  assert.equal(stabilizer.stabilize(50), 50);
});

test('passes through non-finite and negative measurements untouched', () => {
  const stabilizer = createLodAltitudeStabilizer();
  stabilizer.stabilize(1000);
  assert.equal(stabilizer.stabilize(Number.NaN), Number.NaN);
  assert.equal(stabilizer.stabilize(-5), -5);
  // A bad sample must not disturb the held value.
  assert.equal(stabilizer.stabilize(1050), 1000);
});

test('reset() drops the held value so the next sample is adopted', () => {
  const stabilizer = createLodAltitudeStabilizer();
  stabilizer.stabilize(1000);
  stabilizer.reset();
  assert.equal(stabilizer.held, null);
  assert.equal(stabilizer.stabilize(1100), 1100);
});

test('zero hysteresis passes every measurement straight through', () => {
  const stabilizer = createLodAltitudeStabilizer({ hysteresis: 0 });
  assert.equal(stabilizer.stabilize(1000), 1000);
  assert.equal(stabilizer.stabilize(1001), 1001);
});

test('rejects a negative hysteresis', () => {
  assert.throws(() => createLodAltitudeStabilizer({ hysteresis: -0.1 }), RangeError);
});
