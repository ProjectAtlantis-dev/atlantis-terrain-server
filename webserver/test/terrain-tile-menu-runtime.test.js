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
