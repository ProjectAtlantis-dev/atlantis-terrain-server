import assert from 'node:assert/strict';
import test from 'node:test';
import {
  renderGameClock,
  terrainHudHeader,
  tileEvictionHudLine,
} from '../terrain-hud.js';

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

  renderGameClock(element, date, true, 600);
  assert.ok(element.innerHTML.includes('×600'));
});

test('terrain HUD header exposes its expanded state and dropdown direction', () => {
  const expanded = terrainHudHeader(false);
  assert.match(expanded, /id="hudToggleLink"/);
  assert.match(expanded, /aria-expanded="true"/);
  assert.match(expanded, /Hide HUD details/);
  assert.match(expanded, /&#9650;/);

  const collapsed = terrainHudHeader(true);
  assert.match(collapsed, /aria-expanded="false"/);
  assert.match(collapsed, /Show HUD details/);
  assert.match(collapsed, /&#9660;/);
});

test('terrain HUD exposes data eviction as an explicit debug gate', () => {
  assert.match(tileEvictionHudLine(true), /id="tileEvictionLink"/);
  assert.match(tileEvictionHudLine(true), />enabled<\/span>/);
  assert.match(tileEvictionHudLine(false), /data eviction: .*DISABLED/);
});
