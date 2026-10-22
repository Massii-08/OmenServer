'use strict';
const test = require('node:test');
const assert = require('node:assert');
const TS = require('./tableSpot');

test('recycleWorthIt : table 38 blocs plus haut (cas NethBot3 y15 → y53) = non ; même étage = oui', () => {
  assert.strictEqual(TS.recycleWorthIt({ x: -304, y: 15, z: 331 }, { x: -309, y: 53, z: 342 }), false);
  assert.strictEqual(TS.recycleWorthIt({ x: 0, y: 15, z: 0 }, { x: 10, y: 19, z: 3 }), true);
  assert.strictEqual(TS.recycleWorthIt({ x: 0, y: 15, z: 0 }, { x: 0, y: 9, z: 0 }), true, 'pile 6 = encore oui');
  assert.strictEqual(TS.recycleWorthIt(null, { x: 0, y: 0, z: 0 }), false);
});

test('neighbourhoodUnloaded : diagnostic « unloaded » (après un TP) vs vrai manque de place', () => {
  const u = ['unloaded', 'unloaded', 'unloaded', 'unloaded'];
  assert.strictEqual(TS.neighbourhoodUnloaded({ around: u, under: u }), true);
  assert.strictEqual(TS.neighbourhoodUnloaded({ around: ['air', 'air', 'air', 'air'], under: ['cobblestone', 'air', 'cobblestone', 'air'] }), false);
  assert.strictEqual(TS.neighbourhoodUnloaded(null), false);
});

test('memo no_space : 2 échecs au même endroit → se décaler ; ailleurs ou expiré → non', () => {
  const m = TS.createNoSpaceMemo();
  const p = { x: 10.6, y: 15, z: 3.2 };
  assert.strictEqual(m.shouldShift(p, 0), false);
  assert.strictEqual(m.note(p, 0), 1);
  assert.strictEqual(m.shouldShift(p, 1000), false, '1 échec : on retente sur place');
  assert.strictEqual(m.note({ x: 11.2, y: 15, z: 3.9 }, 2000), 2, 'à 1 bloc près = même endroit');
  assert.strictEqual(m.shouldShift(p, 3000), true);
  assert.strictEqual(m.shouldShift({ x: 30, y: 15, z: 3 }, 3000), false, '20 blocs plus loin : nouvel endroit');
  assert.strictEqual(m.shouldShift(p, 3000 + TS.NO_SPACE_TTL_MS), false, 'oublié après le TTL');
});

function world(map) {
  return (x, y, z) => {
    const n = map[`${x},${y},${z}`];
    if (n === undefined) return null;
    return { name: n, boundingBox: (n === 'air' || n === 'cave_air' || n === 'torch') ? 'empty' : 'block' };
  };
}

test('stepAsideCells : tunnel 1×2 vers l\'est → cases à 2..4 blocs, plus proche d\'abord, jamais à travers un mur', () => {
  const m = {};
  // Tunnel est-ouest à y=15 : x = -1..5 creusé, sol de pierre ; mur (stone) au nord/sud et à x=-2.
  for (let x = -2; x <= 6; x++) {
    m[`${x},14,0`] = 'stone';
    const open = x >= -1 && x <= 5;
    m[`${x},15,0`] = open ? 'air' : 'stone';
    m[`${x},16,0`] = open ? 'cave_air' : 'stone';
    m[`${x},15,1`] = 'stone'; m[`${x},15,-1`] = 'stone'; m[`${x},16,1`] = 'stone'; m[`${x},16,-1`] = 'stone';
  }
  m['3,15,0'] = 'torch';     // une torche au sol ne bloque pas le passage
  const cells = TS.stepAsideCells({ x: 0, y: 15, z: 0 }, world(m));
  assert.deepStrictEqual(cells.map((c) => c.x), [2, 3, 4], 'vers l\'est seulement (ouest : x=-1 puis mur)');
  assert.ok(cells.every((c) => c.z === 0 && c.y === 15));
});

test('stepAsideCells : voisinage non chargé ou case sans sol → rien', () => {
  assert.deepStrictEqual(TS.stepAsideCells({ x: 0, y: 64, z: 0 }, () => null), []);
  const m = { '1,64,0': 'air', '1,65,0': 'air', '2,64,0': 'air', '2,65,0': 'air', '2,63,0': 'air' };
  assert.deepStrictEqual(TS.stepAsideCells({ x: 0, y: 64, z: 0 }, world(m)), [], 'case à 2 blocs au-dessus du vide');
});
