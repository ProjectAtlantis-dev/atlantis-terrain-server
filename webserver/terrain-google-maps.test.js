import assert from 'node:assert/strict';
import test from 'node:test';
import { googleMaps3dCamera, googleMaps3dUrl } from './terrain-google-maps.js';

test('Google Maps camera preserves heading and translates view elevation', () => {
  assert.deepEqual(googleMaps3dCamera({
    alt: 800, directionEast: 1, directionNorth: 0, directionUp: 0, fov: 60,
  }), { altitude: 800, fov: 60, heading: 90, tilt: 90 });
});

test('Google Maps URL uses camera coordinates and height above ground', () => {
  assert.equal(googleMaps3dUrl({
    lat: 64.18, lon: -51.72, alt: 240,
    directionEast: 1, directionNorth: 0, directionUp: 0, fov: 60,
  }), 'https://www.google.com/maps/@64.1800000,-51.7200000,240.0a,60.0y,90.00h,90.00t/data=!3m1!1e3');
});
