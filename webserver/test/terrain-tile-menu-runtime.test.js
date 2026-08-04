import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifierD12TileId, createTerrainTileMenuRuntime,
} from '../terrain-tile-menu-runtime.js';

test('classifier collection normalizes visible descendants to D12', () => {
  assert.equal(classifierD12TileId('12-1373-784'), '12-1373-784');
  assert.equal(classifierD12TileId('14-5499-3176'), '12-1374-794');
  assert.equal(classifierD12TileId('11-1-2'), null);
});

function createElement(tagName) {
  return {
    tagName,
    children: [],
    listeners: new Map(),
    style: {},
    appendChild(child) { this.children.push(child); },
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    contains() { return false; },
    set innerHTML(_value) { this.children = []; },
  };
}

test('tile menu exposes the complete tile package download', () => {
  const body = createElement('body');
  const documentImpl = {
    body,
    createElement,
    addEventListener() {},
  };
  const tileInfoElement = { style: { display: 'block' } };
  const runtime = createTerrainTileMenuRuntime({
    tileInfoElement,
    documentImpl,
    windowImpl: { open() {} },
  });

  runtime.show(20, 30, '12-345-678', 'dataforsyningen', 'AAAA', 65);

  assert.equal(tileInfoElement.style.display, 'none');
  assert.equal(runtime.active, true);
  assert.equal(runtime.menu.children.some(child => child.tagName === 'a'), false);
  assert.ok(runtime.menu.children.some(child => child.textContent === 'Save tile package as…'));
  runtime.hide();
  assert.equal(runtime.active, false);
});

test('tile menu does not offer a download before a texture is available', () => {
  const body = createElement('body');
  const documentImpl = {
    body,
    createElement,
    addEventListener() {},
  };
  const runtime = createTerrainTileMenuRuntime({
    tileInfoElement: { style: {} },
    documentImpl,
    windowImpl: { open() {} },
  });

  runtime.show(20, 30, '12-345-678', '');

  assert.equal(runtime.menu.children.some(child => child.tagName === 'a'), false);
});

test('tile menu leaves classifier operations in the main HUD', () => {
  const body = createElement('body');
  const documentImpl = { body, createElement, addEventListener() {} };
  const runtime = createTerrainTileMenuRuntime({
    tileInfoElement: { style: {} },
    documentImpl,
    windowImpl: { open() {} },
  });

  runtime.show(20, 30, '14-5499-3176', 'fractal_upscale');
  assert.equal(runtime.menu.children.some(
    child => child.textContent === 'Classifier operations',
  ), false);
});

test('flagging a regression posts the tile and note without leaving terrain', async () => {
  const body = createElement('body');
  const documentImpl = { body, createElement, addEventListener() {} };
  const fetchCalls = [];
  const opened = [];
  const runtime = createTerrainTileMenuRuntime({
    tileInfoElement: { style: {} },
    documentImpl,
    windowImpl: {
      open(url) { opened.push(url); },
      prompt() { return 'green painted on the lake'; },
      fetch(url, options) {
        fetchCalls.push({ url, options });
        return Promise.resolve({ ok: true });
      },
    },
  });

  runtime.show(20, 30, '12-1380-791', 'dataforsyningen');
  const flag = runtime.menu.children.find(
    child => child.textContent === '⚑ Flag classifier regression…',
  );
  assert.ok(flag, 'flag action present');
  await flag.listeners.get('click')({ currentTarget: flag });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, '/api/regression/cases');
  assert.deepEqual(JSON.parse(fetchCalls[0].options.body), {
    tile: '12-1380-791',
    note: 'green painted on the lake',
  });
  assert.deepEqual(opened, []);
  assert.equal(flag.textContent, '✓ Regression flagged');
});

test('cancelling the regression prompt sends nothing', async () => {
  const body = createElement('body');
  const documentImpl = { body, createElement, addEventListener() {} };
  const fetchCalls = [];
  const runtime = createTerrainTileMenuRuntime({
    tileInfoElement: { style: {} },
    documentImpl,
    windowImpl: {
      open() {},
      prompt() { return null; },
      fetch(...args) { fetchCalls.push(args); return Promise.resolve({ ok: true }); },
    },
  });

  runtime.show(20, 30, '12-1380-791', 'dataforsyningen');
  const flag = runtime.menu.children.find(
    child => child.textContent === '⚑ Flag classifier regression…',
  );
  await flag.listeners.get('click')();
  assert.equal(fetchCalls.length, 0);
});
