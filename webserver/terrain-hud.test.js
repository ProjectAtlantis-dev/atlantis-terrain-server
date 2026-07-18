import assert from 'node:assert/strict';
import test from 'node:test';
import { renderGameClock } from './terrain-hud.js';

test('renderGameClock only rewrites the DOM when the display changes', () => {
  const element = { innerHTML: '', dataset: {} };
  const date = new Date('2025-07-01T12:00:00Z');

  renderGameClock(element, date, true);
  const firstRender = element.innerHTML;
  assert.ok(firstRender.includes('data-gc="stop"')); // playing → pause button

  element.innerHTML = 'sentinel';
  renderGameClock(element, date, true);
  assert.equal(element.innerHTML, 'sentinel'); // same minute + state: untouched

  renderGameClock(element, date, false);
  assert.ok(element.innerHTML.includes('data-gc="play"')); // state change rewrites

  element.innerHTML = 'sentinel';
  renderGameClock(element, new Date(date.getTime() + 60_000), false);
  assert.notEqual(element.innerHTML, 'sentinel'); // minute change rewrites
});
