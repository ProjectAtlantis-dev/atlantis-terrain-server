import assert from 'node:assert/strict';
import test from 'node:test';

import { createTerrainTileMenuRuntime } from '../terrain-tile-menu-runtime.js';

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

test('flagging a regression posts the tile and note, then opens the gallery', async () => {
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
  await flag.listeners.get('click')();

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, '/api/regression/cases');
  assert.deepEqual(JSON.parse(fetchCalls[0].options.body), {
    tile: '12-1380-791',
    note: 'green painted on the lake',
  });
  assert.deepEqual(opened, ['/api/regression/']);
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
