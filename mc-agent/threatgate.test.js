'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { hasLineOfSight, realThreat, woodHidePlan, woodHideStateAt, WOOD_HIDE_RESET_MS } = require('./threatgate');

const solidAt = (set) => (p) => (set.has(p.x + ',' + p.y + ',' + p.z) ? { boundingBox: 'block', name: 'stone' } : { boundingBox: 'empty', name: 'air' });

test('hasLineOfSight : champ libre → vrai', () => {
  assert.strictEqual(hasLineOfSight({ x: 0.5, y: 65.6, z: 0.5 }, { x: 10.5, y: 65.5, z: 0.5 }, solidAt(new Set())), true);
});

test('hasLineOfSight : un mur plein entre les deux → faux', () => {
  const wall = new Set(['5,65,0']);
  assert.strictEqual(hasLineOfSight({ x: 0.5, y: 65.6, z: 0.5 }, { x: 10.5, y: 65.5, z: 0.5 }, solidAt(wall)), false);
});

test('hasLineOfSight : les blocs des extrémités sont ignorés, une herbe (empty) ne bloque pas', () => {
  const ends = new Set(['0,65,0', '10,65,0']);
  assert.strictEqual(hasLineOfSight({ x: 0.5, y: 65.6, z: 0.5 }, { x: 10.5, y: 65.5, z: 0.5 }, solidAt(ends)), true);
});

test('hasLineOfSight : blockAt qui lève → pas de masquage (vrai)', () => {
  assert.strictEqual(hasLineOfSight({ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, () => { throw new Error('x'); }), true);
});

const skel = (id, x, y, z) => ({ id, name: 'skeleton', kind: 'Hostile mobs', height: 1.99, position: { x, y, z } });
const pos = { x: 0.5, y: 64, z: 0.5 };

test('realThreat : squelette à 10 derrière un mur → pas une menace', () => {
  const wall = new Set();
  for (let y = 60; y < 70; y++) wall.add('5,' + y + ',0');
  const r = realThreat({ pos, entities: [skel(1, 10.5, 64, 0.5)], blockAt: solidAt(wall) });
  assert.strictEqual(r, null);
});

test('realThreat : squelette à 10 en champ libre → menace', () => {
  const r = realThreat({ pos, entities: [skel(1, 10.5, 64, 0.5)], blockAt: solidAt(new Set()) });
  assert.ok(r); assert.strictEqual(r.id, 1); assert.ok(Math.abs(r.dist - 10) < 0.01);
});

test('realThreat : à ≤ 6 blocs, compte même sans ligne de vue', () => {
  const wall = new Set();
  for (let y = 60; y < 70; y++) wall.add('3,' + y + ',0');
  const r = realThreat({ pos, entities: [skel(2, 5.5, 64, 0.5)], blockAt: solidAt(wall) });
  assert.ok(r); assert.strictEqual(r.id, 2);
});

test('realThreat : hors rayon → null ; menace ignorée non rapprochée → null', () => {
  assert.strictEqual(realThreat({ pos, entities: [skel(1, 20.5, 64, 0.5)], blockAt: solidAt(new Set()) }), null);
  const ign = [{ id: 1, x: 10.5, y: 64, z: 0.5, dist: 10 }];
  assert.strictEqual(realThreat({ pos, entities: [skel(1, 10.5, 64, 0.5)], blockAt: solidAt(new Set()), ignore: ign }), null);
});

test('realThreat : menace ignorée qui SE RAPPROCHE (> 2 blocs) redevient une menace', () => {
  const ign = [{ id: 1, x: 10.5, y: 64, z: 0.5, dist: 10 }];
  const r = realThreat({ pos, entities: [skel(1, 7.5, 64, 0.5)], blockAt: solidAt(new Set()), ignore: ign });
  assert.ok(r); assert.strictEqual(r.id, 1);
});

test('realThreat : même position ± 2 (entité respawnée, autre id) → reste ignorée', () => {
  const ign = [{ id: 1, x: 10.5, y: 64, z: 0.5, dist: 10 }];
  const r = realThreat({ pos, entities: [skel(9, 11.5, 64, 1.5)], blockAt: solidAt(new Set()), ignore: ign });
  assert.strictEqual(r, null);
});

test('woodHidePlan : 1re menace → hide ; même menace immobile → skip static ; 2 faites → skip max', () => {
  const t = { id: 1, x: 10.5, y: 64, z: 0.5, dist: 10.5 };
  assert.deepStrictEqual(woodHidePlan({ threat: t, hides: 0, last: null }), { act: 'hide', why: 'threat' });
  assert.deepStrictEqual(woodHidePlan({ threat: t, hides: 1, last: t }), { act: 'skip', why: 'static' });
  const other = { id: 2, x: -10, y: 64, z: 0, dist: 10 };
  assert.deepStrictEqual(woodHidePlan({ threat: other, hides: 2, last: t }), { act: 'skip', why: 'max_hides' });
  assert.deepStrictEqual(woodHidePlan({ threat: other, hides: 1, last: t }), { act: 'hide', why: 'threat' });
  assert.strictEqual(woodHidePlan({ threat: null }).act, 'none');
});

test('woodHidePlan : même menace qui s\'est approchée → hide', () => {
  const last = { id: 1, x: 10.5, y: 64, z: 0.5, dist: 10.5 };
  const now = { id: 1, x: 6.5, y: 64, z: 0.5, dist: 6.4 };
  assert.strictEqual(woodHidePlan({ threat: now, hides: 1, last }).act, 'hide');
});

test('woodHideStateAt : état conservé dans la fenêtre, oublié après 10 min', () => {
  const s = { hides: 2, since: 1000, last: { id: 1 }, ignore: [{ id: 1 }] };
  assert.strictEqual(woodHideStateAt(s, 2000).hides, 2);
  assert.strictEqual(woodHideStateAt(s, 1000 + WOOD_HIDE_RESET_MS + 1).hides, 0);
  assert.strictEqual(woodHideStateAt(null, 5).hides, 0);
});
