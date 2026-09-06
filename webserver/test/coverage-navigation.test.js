import assert from 'node:assert/strict';
import test from 'node:test';

import {
  centerCoverageNavigation,
  createCoverageView,
  panCoverageNavigation,
  parseCoverageNavigationSnapshot,
  serializeCoverageNavigationSnapshot,
  zoomCoverageNavigation,
} from '../coverage-navigation.js';

const bounds = { xMin: -100, yMin: -200, xMax: 300, yMax: 200 };
const initial = { zoom: 1, panX: 0, panY: 0 };

test('coverage view projects and unprojects the atlas exactly', () => {
  const view = createCoverageView(bounds, 1000, 700, initial);
  assert.ok(Math.abs(view.gridX(view.x(73)) - 73) < 1e-9);
  assert.ok(Math.abs(view.gridY(view.y(-51)) + 51) < 1e-9);
});

test('coverage pan moves the projected map in screen pixels', () => {
  const moved = panCoverageNavigation(initial, 42, -19);
  const before = createCoverageView(bounds, 1000, 700, initial);
  const after = createCoverageView(bounds, 1000, 700, moved);
  assert.equal(after.x(0) - before.x(0), 42);
  assert.equal(after.y(0) - before.y(0), -19);
});

test('coverage camera centering preserves zoom and puts the grid point onscreen center', () => {
  const navigation = { zoom: 5, panX: 42, panY: -19 };
  const centered = centerCoverageNavigation({
    bounds,
    width: 1000,
    height: 700,
    navigation,
    gridX: 73,
    gridY: -51,
  });
  const centeredView = createCoverageView(bounds, 1000, 700, centered);

  assert.equal(centered.zoom, navigation.zoom);
  assert.ok(Math.abs(centeredView.x(73) - 500) < 1e-9);
  assert.ok(Math.abs(centeredView.y(-51) - 350) < 1e-9);
});

test('coverage wheel zoom keeps the map coordinate under the cursor fixed', () => {
  const screenX = 713;
  const screenY = 188;
  const before = createCoverageView(bounds, 1000, 700, initial);
  const anchor = { x: before.gridX(screenX), y: before.gridY(screenY) };
  const zoomed = zoomCoverageNavigation({
    bounds,
    width: 1000,
    height: 700,
    navigation: initial,
    screenX,
    screenY,
    factor: 2,
  });
  const after = createCoverageView(bounds, 1000, 700, zoomed);
  assert.ok(Math.abs(after.x(anchor.x) - screenX) < 1e-9);
  assert.ok(Math.abs(after.y(anchor.y) - screenY) < 1e-9);
  assert.equal(zoomed.zoom, 2);
});

test('coverage zoom is bounded at useful navigation limits', () => {
  const minimum = zoomCoverageNavigation({
    bounds, width: 1000, height: 700, navigation: initial,
    screenX: 500, screenY: 350, factor: 0.00001,
  });
  const maximum = zoomCoverageNavigation({
    bounds, width: 1000, height: 700, navigation: initial,
    screenX: 500, screenY: 350, factor: 1000,
  });
  assert.equal(minimum.zoom, 0.5);
  assert.equal(maximum.zoom, 64);
});

test('coverage navigation snapshots round-trip zoom and camera position', () => {
  const navigation = { zoom: 7.5, panX: -238.25, panY: 91.75 };
  assert.deepEqual(
    parseCoverageNavigationSnapshot(serializeCoverageNavigationSnapshot(navigation)),
    navigation,
  );
});

test('coverage navigation snapshots reject corrupt and unsafe values', () => {
  assert.equal(parseCoverageNavigationSnapshot('{broken'), null);
  assert.equal(parseCoverageNavigationSnapshot({ zoom: 0, panX: 0, panY: 0 }), null);
  assert.equal(parseCoverageNavigationSnapshot({ zoom: 1, panX: Infinity, panY: 0 }), null);
  assert.equal(serializeCoverageNavigationSnapshot({ zoom: 65, panX: 0, panY: 0 }), null);
});
