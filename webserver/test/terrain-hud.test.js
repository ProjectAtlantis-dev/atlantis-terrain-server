import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTerrainHud,
  hudActionLink,
  renderGameClock,
  setTerrainGotoCollapsed,
  TERRAIN_HUD_LINKS,
  terrainHudHeader,
  tileEvictionHudLine,
} from '../terrain-hud.js';

function makeElement() {
  return {
    style: { cssText: '' },
    dataset: {},
    id: '',
    innerHTML: '',
    listeners: new Map(),
    children: [],
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(name, value) { this[name] = value; },
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(handler);
    },
    dispatch(type, event) {
      for (const handler of this.listeners.get(type) ?? []) handler(event);
    },
  };
}

// createTerrainHud needs only a sliver of the DOM, so stub that rather than
// pull in a full document implementation.
function withFakeDom(run) {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const created = [];
  globalThis.document = {
    createElement: () => {
      const element = makeElement();
      created.push(element);
      return element;
    },
    body: { appendChild() {} },
  };
  globalThis.window = { addEventListener() {}, open() {} };
  try {
    return run(created);
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
}

function hudEvent(id) {
  return { target: { id }, stopPropagation() {}, preventDefault() {} };
}

const noopHudHandlers = Object.fromEntries([
  'onToggleMapMode', 'onToggleSeamMode', 'onToggleTileInspector',
  'onToggleGridlines', 'onToggleRetroMode', 'onToggleBathymetryMap',
  'onToggleClassifierOverlay', 'onToggleWaterOverlay',
  'onToggleHydrographyOverlay', 'onToggleProcgen', 'onToggleRenderBackend',
  'onToggleRoadDebug', 'onToggleTileEviction', 'onOpenGoogleMaps',
  'onStartFastTime', 'onReset', 'onClockAction',
].map(name => [name, () => {}]));

test('the HUD collapse toggle fires on mousedown, not click', () => {
  withFakeDom(created => {
    let collapses = 0;
    createTerrainHud({
      ...noopHudHandlers,
      onToggleCollapsed: () => { collapses += 1; },
    });
    const hud = created[0];

    // The HUD rewrites innerHTML as fps changes, so the button node is often
    // replaced between mousedown and mouseup and the browser then dispatches
    // click on the HUD div instead. Handling mousedown is what makes the
    // arrow reliably clickable.
    hud.dispatch('mousedown', hudEvent('hudToggleLink'));
    assert.equal(collapses, 1);

    // The click listener must only suppress the event, never toggle again, or
    // a click that does survive would collapse and immediately re-expand.
    hud.dispatch('click', hudEvent('hudToggleLink'));
    assert.equal(collapses, 1);
  });
});

test('mousedown on the collapse toggle does not start a text selection', () => {
  withFakeDom(created => {
    createTerrainHud({ ...noopHudHandlers, onToggleCollapsed: () => {} });
    const hud = created[0];
    hud.dispatch('mousedown', hudEvent('hudToggleLink'));
    assert.notEqual(hud.dataset.selecting, 'true');
  });
});

test('retro mode toggles from its HUD link', () => {
  withFakeDom(created => {
    let retroToggles = 0;
    createTerrainHud({
      ...noopHudHandlers,
      onToggleCollapsed: () => {},
      onToggleRetroMode: () => { retroToggles += 1; },
    });
    created[0].dispatch('mousedown', hudEvent('retroModeLink'));
    assert.equal(retroToggles, 1);
  });
});

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

test('terrain HUD owns the classifier operations link', () => {
  assert.equal(TERRAIN_HUD_LINKS.classifierOpsLink, '/classifier.html');
  assert.match(
    hudActionLink('classifierOpsLink', 'classifier ops'),
    /id="classifierOpsLink".*>classifier ops<\/span>/,
  );
});

test('GOTO form submits a town without being replaced by HUD refreshes', () => {
  withFakeDom(created => {
    let requested = '';
    const result = createTerrainHud({
      ...noopHudHandlers,
      gotoTowns: ['Nuuk', 'Ilulissat'],
      onGotoTown: name => {
        requested = name;
        return { ok: true, label: 'Nuuk' };
      },
    });
    result.gotoInput.value = 'Nuuk';
    const form = created.find(element => element.id === 'terrain-goto-form');
    form.dispatch('submit', { preventDefault() {}, stopPropagation() {} });
    assert.equal(requested, 'Nuuk');
    assert.equal(result.gotoStatus.textContent, 'Travelling to Nuuk');
    assert.equal(result.gotoStatus.style.display, 'block');
    assert.ok(result.hud.children.includes(result.hudContent));
  });
});

test('GOTO controls follow the regular HUD collapsed state', () => {
  const gotoPanel = { style: { display: 'block' } };
  setTerrainGotoCollapsed(gotoPanel, true);
  assert.equal(gotoPanel.style.display, 'none');
  setTerrainGotoCollapsed(gotoPanel, false);
  assert.equal(gotoPanel.style.display, 'block');
});
