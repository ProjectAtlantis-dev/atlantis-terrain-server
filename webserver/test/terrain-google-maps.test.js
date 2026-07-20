import assert from 'node:assert/strict';
import test from 'node:test';
import { installTerrainKeyboardControls } from '../terrain-controls.js';
import { googleMaps3dCamera, googleMaps3dUrl } from '../terrain-google-maps.js';

test('Google Maps camera preserves heading and translates view elevation', () => {
  assert.deepEqual(googleMaps3dCamera({
    alt: 800,
    directionEast: 1,
    directionNorth: 0,
    directionUp: 0,
    fov: 60,
  }), { altitude: 800, fov: 60, heading: 90, tilt: 90 });
});

test('Google Maps URL uses camera coordinates and height above ground', () => {
  assert.equal(googleMaps3dUrl({
    lat: 64.18,
    lon: -51.72,
    alt: 240,
    directionEast: 1,
    directionNorth: 0,
    directionUp: 0,
    fov: 60,
  }), 'https://www.google.com/maps/@64.1800000,-51.7200000,240.0a,60.0y,90.00h,90.00t/data=!3m1!1e3');
});

test('G key opens Google Maps once and C remains unassigned', () => {
  const previousWindow = globalThis.window;
  const listeners = new Map();
  globalThis.window = {
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type) { listeners.delete(type); },
  };
  let opens = 0;
  let gridlinesToggles = 0;
  const noop = () => {};
  const dispose = installTerrainKeyboardControls({
    controls: { keys: {} },
    isVehicleActive: () => false,
    onForwardDoubleTap: noop,
    onEscapeVehicle: noop,
    onToggleMap: noop,
    onOpenGoogleMaps: () => { opens += 1; },
    onToggleGridlines: () => { gridlinesToggles += 1; },
    onReset: noop,
    onHouseAction: noop,
    onToggleHeadlights: noop,
  });
  try {
    listeners.get('keydown')({ code: 'KeyG', repeat: false });
    listeners.get('keydown')({ code: 'KeyG', repeat: true });
    listeners.get('keydown')({ code: 'KeyC', repeat: false });
    listeners.get('keydown')({ code: 'KeyC', repeat: true });
    assert.equal(opens, 1);
    assert.equal(gridlinesToggles, 0);
  } finally {
    dispose();
    globalThis.window = previousWindow;
  }
});

test('H and R remain unassigned to heatmap and road debug', () => {
  const previousWindow = globalThis.window;
  const listeners = new Map();
  globalThis.window = {
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type) { listeners.delete(type); },
  };
  let roadToggles = 0;
  let heatmapToggles = 0;
  const noop = () => {};
  const dispose = installTerrainKeyboardControls({
    controls: { keys: {} },
    isVehicleActive: () => false,
    onForwardDoubleTap: noop,
    onEscapeVehicle: noop,
    onToggleMap: noop,
    onToggleRoadDebug: () => { roadToggles += 1; },
    onToggleHeatmap: () => { heatmapToggles += 1; },
    onHouseAction: noop,
    onToggleHeadlights: noop,
  });
  try {
    listeners.get('keydown')({ code: 'KeyR', repeat: false });
    listeners.get('keydown')({ code: 'KeyR', repeat: true });
    listeners.get('keydown')({ code: 'KeyH', repeat: false });
    listeners.get('keydown')({ code: 'KeyH', repeat: true });
    assert.equal(roadToggles, 0);
    assert.equal(heatmapToggles, 0);
  } finally {
    dispose();
    globalThis.window = previousWindow;
  }
});
