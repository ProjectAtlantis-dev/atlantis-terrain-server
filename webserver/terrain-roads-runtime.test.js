import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRoadsGeometry } from './terrain-roads-runtime.js';

const straightRoad = {
  id: '0600NUK_VEJMIDTE_1',
  kind: 'road',
  category: 'Hovedvej',
  widthM: 8,
  path: [
    [0, 0, 10],
    [100, 0, 12],
    [200, 0, 14],
  ],
};

test('buildRoadsGeometry makes a ribbon with the category width', () => {
  const geometry = buildRoadsGeometry([straightRoad]);
  assert.ok(geometry);
  const positions = geometry.getAttribute('position');
  // 3 centerline vertices → 2 ribbon vertices each.
  assert.equal(positions.count, 6);
  // 2 segments → 4 triangles.
  assert.equal(geometry.getIndex().count, 12);
  // Road runs along +x, so the ribbon spreads ±widthM/2 in y.
  const ys = [];
  const zs = [];
  for (let index = 0; index < positions.count; index++) {
    ys.push(positions.getY(index));
    zs.push(positions.getZ(index));
  }
  assert.equal(Math.max(...ys), 4);
  assert.equal(Math.min(...ys), -4);
  // Surveyed elevations preserved with the anti-z-fight lift.
  assert.equal(Math.min(...zs), 10.5);
  assert.equal(Math.max(...zs), 14.5);
  assert.ok(geometry.getAttribute('normal')); // relight pass requirement
});

test('buildRoadsGeometry applies offsets and skips degenerate paths', () => {
  const geometry = buildRoadsGeometry([straightRoad], { offsetX: 50, offsetY: -20 });
  const positions = geometry.getAttribute('position');
  assert.equal(positions.getX(0), 50);
  assert.equal(positions.getY(0), -16); // -20 + halfWidth

  assert.equal(buildRoadsGeometry([{ ...straightRoad, path: [[0, 0, 1]] }]), null);
  assert.equal(buildRoadsGeometry([]), null);
});

test('buildRoadsGeometry collapses duplicate survey points', () => {
  const withDuplicate = {
    ...straightRoad,
    path: [[0, 0, 10], [0, 0, 10], [100, 0, 12]],
  };
  const geometry = buildRoadsGeometry([withDuplicate]);
  const positions = geometry.getAttribute('position');
  assert.equal(positions.count, 4); // duplicate dropped, 2 ribbon pairs
});
