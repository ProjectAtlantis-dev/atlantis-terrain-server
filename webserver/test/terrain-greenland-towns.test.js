import assert from 'node:assert/strict';
import test from 'node:test';
import { findGreenlandTown, GREENLAND_TOWNS } from '../terrain-greenland-towns.js';

test('the town catalogue contains Greenland\'s 17 towns', () => {
  assert.equal(GREENLAND_TOWNS.length, 17);
  assert.equal(new Set(GREENLAND_TOWNS.map(town => town.name)).size, 17);
});

test('town lookup ignores case and surrounding whitespace', () => {
  assert.equal(findGreenlandTown('  iLuLiSsAt ').name, 'Ilulissat');
  assert.equal(findGreenlandTown('not a town'), null);
  assert.equal(findGreenlandTown(''), null);
});

test('town lookup accepts historical Danish names and diacritics', () => {
  assert.equal(findGreenlandTown('Godthåb').name, 'Nuuk');
  assert.equal(findGreenlandTown('Scoresbysund').name, 'Ittoqqortoormiit');
});
