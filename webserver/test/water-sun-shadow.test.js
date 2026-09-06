import assert from 'node:assert/strict';
import test from 'node:test';
import { createWaterSunShadowCache } from '../water/water-sun-shadow.js';

test('sun shadow is cached across frames and refreshes for terrain, sun, and waterline changes', () => {
  let renders = 0;
  const cache = createWaterSunShadowCache(() => { renders++; });
  const sun = { x: 0, y: 0, z: 1 };
  assert.equal(cache.update(sun, 0.5), false); // no terrain captured yet
  cache.invalidate();
  assert.equal(cache.update(sun, 0.5), true);
  for (let frame = 0; frame < 1000; frame++) cache.update(sun, 0.5);
  assert.equal(renders, 1);
  const direction = degrees => ({ x: Math.sin(degrees * Math.PI / 180), y: 0, z: Math.cos(degrees * Math.PI / 180) });
  assert.equal(cache.update(direction(0.05), 0.5), false);
  assert.equal(cache.update(direction(0.11), 0.5), true);
  assert.equal(cache.update(direction(0.11), 2), true);
  cache.invalidate();
  cache.invalidate();
  assert.equal(cache.update(direction(0.11), 2), true);
  assert.equal(renders, 4);
});

test('failed shadow render remains dirty for retry', () => {
  let fail = true;
  const cache = createWaterSunShadowCache(() => { if (fail) throw new Error('render failed'); });
  const sun = { x: 0, y: 0, z: 1 };
  cache.invalidate();
  assert.throws(() => cache.update(sun, 0), /render failed/);
  fail = false;
  assert.equal(cache.update(sun, 0), true);
  assert.equal(cache.update(sun, 0), false);
});
