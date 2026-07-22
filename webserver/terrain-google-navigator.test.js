import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGoogleNavigationCoordinates } from './terrain-google-navigator.js';

test('navigation coordinates accept signed decimals and cardinal directions', () => {
  assert.deepEqual(parseGoogleNavigationCoordinates('64.1835, -51.7214'), {
    lat: 64.1835, lon: -51.7214,
  });
  assert.deepEqual(parseGoogleNavigationCoordinates('64.2 N, 51.7 W'), {
    lat: 64.2, lon: -51.7,
  });
  assert.deepEqual(parseGoogleNavigationCoordinates('12.5 S 44.25 E'), {
    lat: -12.5, lon: 44.25,
  });
});

test('navigation coordinates reject missing and out-of-range positions', () => {
  assert.equal(parseGoogleNavigationCoordinates('64.2'), null);
  assert.equal(parseGoogleNavigationCoordinates('91, 0'), null);
  assert.equal(parseGoogleNavigationCoordinates('45, 181'), null);
});
