'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const s = require('./sectors');

const ORIGIN = { x: 0, z: 0 };
const D2R = Math.PI / 180;

test('sectorRange : count<=1 → cercle complet', () => {
  assert.strictEqual(s.sectorRange(0, 1).full, true);
  assert.strictEqual(s.sectorRange(0, 0).full, true);
});

test('sectorRange : 4 mappers → wedges qui SE RECOUVRENT (pas de trou aux frontières)', () => {
  const r0 = s.sectorRange(0, 4, 15);
  const r1 = s.sectorRange(1, 4, 15);
  // la frontière géométrique entre secteur 0 (centre 0°) et secteur 1 (centre 90°) est à 45°
  const boundary = Math.PI / 4;
  assert.ok(s.inSector(boundary, r0) && s.inSector(boundary, r1), 'la frontière est dans LES DEUX (recouvrement)');
  // un point clairement dans le secteur 0 (est, 0°) n'est PAS dans le secteur 1
  assert.ok(s.inSector(0, r0) && !s.inSector(0, r1));
});

test('headingOf : est/nord/ouest/sud (convention atan2(dz,dx))', () => {
  assert.ok(Math.abs(s.headingOf(ORIGIN, { x: 10, z: 0 }) - 0) < 1e-9);
  assert.ok(Math.abs(s.headingOf(ORIGIN, { x: 0, z: 10 }) - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(s.headingOf(ORIGIN, { x: -10, z: 0 }) - Math.PI) < 1e-9);
  assert.ok(Math.abs(s.headingOf(ORIGIN, { x: 0, z: -10 }) - (3 * Math.PI) / 2) < 1e-9);
});

test('inSector : full=true toujours vrai ; wrap autour de 0 géré', () => {
  assert.ok(s.inSector(123, { full: true }));
  const wrap = { start: 300 * D2R, end: 60 * D2R };  // traverse 0
  assert.ok(s.inSector(0, wrap) && s.inSector(350 * D2R, wrap) && s.inSector(30 * D2R, wrap));
  assert.ok(!s.inSector(180 * D2R, wrap));
});

test('filterToSector : ne garde que les waypoints du wedge', () => {
  const wps = [{ x: 10, z: 0 }, { x: 0, z: 10 }, { x: -10, z: 0 }, { x: 0, z: -10 }]; // E, N, O, S
  const kept = s.filterToSector(wps, ORIGIN, s.sectorRange(0, 4, 15)); // secteur est
  assert.deepStrictEqual(kept, [{ x: 10, z: 0 }]);
  assert.strictEqual(s.filterToSector(wps, ORIGIN, { full: true }).length, 4); // full → tout
});

test('isCellMapped / skipMapped : ignore les cellules déjà cartographiées', () => {
  const mem = { worlds: { w: { biomes: [{ name: 'forest', x: 0, z: 0 }], caves: [] } } };
  assert.ok(s.isCellMapped(mem, 'w', 10, 10));      // même cellule 128 que (0,0)
  assert.ok(!s.isCellMapped(mem, 'w', 200, 0));     // cellule 128 différente
  assert.ok(!s.isCellMapped(mem, 'autremonde', 0, 0));
  const wps = [{ x: 10, z: 10 }, { x: 200, z: 0 }];
  assert.deepStrictEqual(s.skipMapped(wps, mem, 'w'), [{ x: 200, z: 0 }]); // la cellule mappée retirée
});
