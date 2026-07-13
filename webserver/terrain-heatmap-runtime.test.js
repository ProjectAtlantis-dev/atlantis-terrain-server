import assert from 'node:assert/strict';
import test from 'node:test';
import { createTerrainHeatmapRuntime } from './terrain-heatmap-runtime.js';

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
