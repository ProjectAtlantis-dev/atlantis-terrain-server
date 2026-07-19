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

test('view direction immediately reranks existing heatmap tiles', () => {
  const tiles = [
    { id: 'north', bbox: [-10, 90, 10, 110], priority: 0, order: 0 },
    { id: 'south', bbox: [-10, -110, 10, -90], priority: 0, order: 1 },
  ];

  updateHeatmapViewPriorities(tiles, {
    cameraX: 0, cameraY: 0, yaw: 0,
  });
  assert.deepEqual(tiles.map(tile => tile.id), ['north', 'south']);
  assert.deepEqual(tiles.map(tile => tile.order), [0, 1]);

  updateHeatmapViewPriorities(tiles, {
    cameraX: 0, cameraY: 0, yaw: Math.PI,
  });
  assert.deepEqual(tiles.map(tile => tile.id), ['south', 'north']);
  assert.deepEqual(tiles.map(tile => tile.order), [0, 1]);
});

test('view direction aborts WIP and starts a fresh heatmap generation', async () => {
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
  const requests = [];
  const view = { x: 0, y: 0, cameraX: 0, cameraY: 0, alt: 100, yaw: 0, zoom: 1000 };
  const runtime = createTerrainHeatmapRuntime({
    documentImpl,
    windowImpl: {
      innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1,
      addEventListener() {},
      requestAnimationFrame(callback) { animationFrames.push(callback); return animationFrames.length; },
      cancelAnimationFrame() {}, setTimeout() { return 1; }, clearTimeout() {},
    },
    getView: () => view,
    fetchImpl: (url, options) => {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      requests.push({ url, signal: options.signal, resolve });
      return promise;
    },
  });

  runtime.setPresentation('heatmap');
  assert.equal(requests.length, 1);
  animationFrames.shift()(0);
  view.yaw = Math.PI / 2;
  animationFrames.shift()(16);

  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /heading=1\.5707963267948966/);
  assert.equal(requests[1].signal.aborted, false);

  const response = id => ({
    ok: true,
    json: async () => ({
      tiles: [{ id, depth: 1, bbox: [-10, -10, 10, 10], priority: 1, order: 0 }],
    }),
  });
  requests[1].resolve(response('latest'));
  await Promise.resolve();
  await Promise.resolve();
  requests[0].resolve(response('stale'));
  await Promise.resolve();
  await Promise.resolve();
  animationFrames.shift()(32);
  runtime.canvas.listeners.get('mousemove')({ clientX: 500, clientY: 400 });
  const tip = runtime.layer.children[2];
  assert.match(tip.textContent, /^latest /);
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
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        tiles: [{ id: '1-0-0', depth: 1, bbox: [-100, -100, 100, 100], priority: 1, order: 0 }],
      }),
    }),
  });

  runtime.setPresentation('edges');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(runtime.presentation, 'edges');
  assert.equal(runtime.layer.style.display, 'none');
  assert.equal(fills, 0);

  runtime.setPresentation('heatmap');
  await Promise.resolve();
  await Promise.resolve();
  animationFrames.shift()(16);
  assert.equal(runtime.active, true);
  assert.equal(runtime.layer.style.background, '#060a10');
  assert.equal(runtime.layer.style.pointerEvents, 'auto');
  assert.equal(fills, 1);

  runtime.setPresentation('hidden');
  assert.equal(runtime.layer.style.display, 'none');
});
