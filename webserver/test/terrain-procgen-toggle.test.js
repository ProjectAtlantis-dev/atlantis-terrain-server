import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_PROCGEN_ENABLED,
  procgenHudLine,
} from '../terrain-procgen-toggle.js';

test('procgen defaults off and the HUD exposes an opt-in toggle', () => {
  assert.equal(DEFAULT_PROCGEN_ENABLED, false);
  assert.match(procgenHudLine(DEFAULT_PROCGEN_ENABLED), /id="procgenLink"/);
  assert.match(procgenHudLine(DEFAULT_PROCGEN_ENABLED), />off<\/span>/);
  assert.match(procgenHudLine(true), />ON<\/span>/);
});

test('procgen is shown as unavailable on unsupported renderers', () => {
  const line = procgenHudLine(false, false);
  assert.doesNotMatch(line, /id="procgenLink"/);
  assert.match(line, />n\/a<\/span>/);
});
