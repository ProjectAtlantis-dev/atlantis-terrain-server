import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTerrainHeatmapRuntime,
  updateHeatmapViewPriorities,
} from '../terrain-heatmap-runtime.js';

class FakeElement {
  constructor(tagName, context = null) {
    this.tagName = tagName;
    this.context = context;
    this.children = [];
    this.listeners = new Map();
    this.style = {};
    this.innerHTML = '';
    this.textContent = '';
  }

  appendChild(child) { this.children.push(child); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  getContext() { return this.context; }
}

test('heatmap priority is radial and unaffected by view direction', () => {
  const tiles = [
    { id: 'north', bbox: [-10, 90, 10, 110], priority: 0, order: 0 },
    { id: 'south', bbox: [-10, -110, 10, -90], priority: 0, order: 1 },
    { id: 'east', bbox: [190, -10, 210, 10], priority: 0, order: 2 },
  ];

  updateHeatmapViewPriorities(tiles, {
    cameraX: 0, cameraY: 0, yaw: 0,
  });
  assert.deepEqual(tiles.map(tile => tile.id), ['north', 'south', 'east']);
  assert.equal(tiles[0].priority, tiles[1].priority);
  assert.ok(Math.abs(
    tiles[2].priority - tiles[0].priority - Math.log(2),
  ) < 1e-12);

  updateHeatmapViewPriorities(tiles, {
    cameraX: 0, cameraY: 0, yaw: Math.PI,
  });
  assert.deepEqual(tiles.map(tile => tile.id), ['north', 'south', 'east']);
  assert.deepEqual(tiles.map(tile => tile.order), [0, 1, 2]);
});

test('heatmap uses browser demand and never mutates its tile ordering', () => {
  const context = {
    clearRect() {}, setTransform() {}, save() {}, restore() {}, translate() {}, rotate() {},
    fillRect() {}, strokeRect() {}, fillText() {}, beginPath() {}, moveTo() {}, lineTo() {},
    closePath() {}, fill() {}, stroke() {},
  };
  const body = new FakeElement('body');
  const documentImpl = {
    body,
    createElement: tag => new FakeElement(tag, tag === 'canvas' ? context : null),
  };
  const animationFrames = [];
  const view = { x: 0, y: 0, cameraX: 0, cameraY: 0, alt: 100, yaw: 0, zoom: 1000 };
  const tiles = [
    { id: 'south', depth: 1, bbox: [-10, -110, 10, -90], heightmap: 'hm' },
    { id: 'north', depth: 1, bbox: [-10, 90, 10, 110], heightmap: 'hm' },
  ];
  const runtime = createTerrainHeatmapRuntime({
    documentImpl,
    windowImpl: {
      innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1,
      addEventListener() {},
      requestAnimationFrame(callback) { animationFrames.push(callback); return animationFrames.length; },
      cancelAnimationFrame() {}, setTimeout() { return 1; }, clearTimeout() {},
    },
    getView: () => view,
    getTiles: () => tiles,
  });

  runtime.setPresentation('heatmap');
  animationFrames.shift()(0);
  assert.deepEqual(tiles.map(tile => tile.id), ['south', 'north']);

  view.yaw = Math.PI / 2;
  animationFrames.shift()(16);
  assert.deepEqual(tiles.map(tile => tile.id), ['south', 'north']);
});

test('heatmap runtime keeps the embedded edge mode hidden and renders filled heatmap', async () => {
  const strokes = [];
  let fills = 0;
  const context = {
    clearRect() {}, setTransform() {}, save() {}, restore() {}, translate() {}, rotate() {},
    fillRect() { fills += 1; },
    strokeRect() { strokes.push(this.strokeStyle); },
    fillText() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {},
  };
  const body = new FakeElement('body');
  const documentImpl = {
    body,
    createElement: tag => new FakeElement(tag, tag === 'canvas' ? context : null),
  };
  const animationFrames = [];
  const windowListeners = new Map();
  const windowImpl = {
    innerWidth: 1000,
    innerHeight: 800,
    devicePixelRatio: 1,
    addEventListener: (type, listener) => windowListeners.set(type, listener),
    requestAnimationFrame: callback => { animationFrames.push(callback); return animationFrames.length; },
    cancelAnimationFrame() {},
    setTimeout: () => 1,
    clearTimeout() {},
  };
  const runtime = createTerrainHeatmapRuntime({
    documentImpl,
    windowImpl,
    getView: () => ({ x: 0, y: 0, cameraX: 0, cameraY: 0, alt: 100, yaw: 0, zoom: 1000 }),
    getTiles: () => [
      { id: '1-0-0', depth: 1, bbox: [-100, -100, 100, 100], heightmap: 'hm' },
    ],
  });

  runtime.setPresentation('edges');
  assert.equal(runtime.presentation, 'edges');
  assert.equal(runtime.layer.style.display, 'none');
  assert.equal(fills, 0);

  runtime.setPresentation('heatmap');
  animationFrames.shift()(16);
  assert.equal(runtime.active, true);
  assert.equal(runtime.layer.style.background, '#060a10');
  assert.equal(runtime.layer.style.pointerEvents, 'auto');
  assert.equal(fills, 1);

  runtime.setPresentation('hidden');
  assert.equal(runtime.layer.style.display, 'none');
});
