'use strict';
const test = require('node:test');
const assert = require('node:assert');
const T = require('./tunnelDefense');

// Couloir 1×2 orienté est-ouest : murs nord/sud aux deux hauteurs, plafond plein, sol plein.
function corridorX(extra = {}) {
  return (dx, dy, dz) => {
    const k = `${dx},${dy},${dz}`;
    if (k in extra) return extra[k];
    if (dy === -1) return true;            // sol
    if (dy === 2) return true;             // plafond
    if (dz !== 0) return true;             // murs nord/sud
    return false;                          // le couloir lui-même (x quelconque, z = 0)
  };
}

test('cardinalOf : axe dominant, vecteur nul → null', () => {
  assert.deepStrictEqual(T.cardinalOf(5, 1), { dx: 1, dz: 0 });
  assert.deepStrictEqual(T.cardinalOf(-0.5, -3), { dx: 0, dz: -1 });
  assert.strictEqual(T.cardinalOf(0, 0), null);
});

test('tunnelShape : couloir 1×2 → tunnel, deux côtés ouverts (est, ouest)', () => {
  const r = T.tunnelShape(corridorX());
  assert.strictEqual(r.tunnel, true);
  assert.deepStrictEqual(r.open, [{ dx: 1, dz: 0 }, { dx: -1, dz: 0 }]);
});

test('tunnelShape : grotte ouverte (pas de murs) ou ciel → pas un tunnel', () => {
  const cave = (dx, dy) => dy === -1;
  assert.strictEqual(T.tunnelShape(cave).tunnel, false);
  const noRoof = corridorX({ '0,2,0': false });
  assert.strictEqual(T.tunnelShape(noRoof).tunnel, false);
  const buried = () => true;
  assert.strictEqual(T.tunnelShape(buried).tunnel, false, 'pieds dans un bloc plein : pas une position');
});

const base = (o = {}) => Object.assign({
  y: 16, skyLight: 0, shape: T.tunnelShape(corridorX()), health: 14, food: 18, armed: true, hasBlocks: true,
  hostiles: [{ name: 'zombie', x: 3, z: 0.2, dist: 3 }],
}, o);

test('plan : armé, PV corrects, zombie dans le couloir → tenir la position (pas de fuite dans le noir)', () => {
  const r = T.tunnelDefensePlan(base());
  assert.strictEqual(r.action, 'hold');
  assert.strictEqual(r.target, 0);
});

test('plan : PV bas → murer le côté d\'où vient le mob (pas les deux)', () => {
  const r = T.tunnelDefensePlan(base({ health: 6 }));
  assert.strictEqual(r.action, 'wall');
  assert.deepStrictEqual(r.seal, [{ dx: 1, dz: 0 }]);
});

test('plan : désarmé → murer même à PV pleins ; affamé → murer', () => {
  assert.strictEqual(T.tunnelDefensePlan(base({ armed: false, health: 20 })).action, 'wall');
  assert.strictEqual(T.tunnelDefensePlan(base({ food: 4, health: 20 })).action, 'wall');
});

test('plan : mobs des deux côtés → murer les deux bouts', () => {
  const r = T.tunnelDefensePlan(base({ health: 5, hostiles: [
    { name: 'zombie', x: 2, z: 0, dist: 2 }, { name: 'spider', x: -4, z: 0, dist: 4 }] }));
  assert.strictEqual(r.action, 'wall');
  assert.strictEqual(r.seal.length, 2);
});

test('plan : creeper qui approche → on lui coupe le chemin, jamais de mêlée', () => {
  const r = T.tunnelDefensePlan(base({ hostiles: [{ name: 'creeper', x: -5, z: 0, dist: 5 }] }));
  assert.strictEqual(r.action, 'wall');
  assert.deepStrictEqual(r.seal, [{ dx: -1, dz: 0 }]);
  assert.strictEqual(r.reason, 'creeper');
});

test('plan : que des squelettes → couvert (mur), pas de charge dans le couloir', () => {
  const r = T.tunnelDefensePlan(base({ hostiles: [{ name: 'skeleton', x: 8, z: 0, dist: 8 }] }));
  assert.deepStrictEqual([r.action, r.reason], ['wall', 'ranged']);
});

test('plan : surface, ciel, grotte ouverte, aucun bloc → null (la fuite habituelle reste la règle)', () => {
  assert.strictEqual(T.tunnelDefensePlan(base({ y: 70 })).action, null);
  assert.strictEqual(T.tunnelDefensePlan(base({ skyLight: 4 })).action, null);
  assert.strictEqual(T.tunnelDefensePlan(base({ shape: { tunnel: false, open: [] } })).action, null);
  assert.strictEqual(T.tunnelDefensePlan(base({ health: 5, hasBlocks: false })).action, null);
  assert.strictEqual(T.tunnelDefensePlan(base({ hostiles: [{ name: 'zombie', x: 20, z: 0, dist: 20 }] })).action, null);
});

test('plan : menace par un côté muré → on mure tous les côtés ouverts (elle arrivera par l\'un d\'eux)', () => {
  const r = T.tunnelDefensePlan(base({ health: 4, hostiles: [{ name: 'zombie', x: 0, z: 3, dist: 3 }] }));
  assert.strictEqual(r.action, 'wall');
  assert.strictEqual(r.seal.length, 2);
});
