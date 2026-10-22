'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  decideSkeletonResponse, rushMinHp, findCoverCell, zigzagSide,
  RUSH_DIST, CONTACT_DIST,
} = require('./skeletonResponse');

// Situation de base calquée sur les morts live du 22/10 (NethBot1/3) : mineur nu ou presque, épée de
// pierre, cobble en poche, squelette en ligne de vue, aucun zombie collé.
const base = (o = {}) => Object.assign({
  dist: 7, los: true, health: 12, armorPoints: 0, attackDamage: 5, hasShield: false,
  hasBlock: true, meleeOthers: 0, shooters: 1, inWater: false, coverCell: false,
}, o);

test('squelette au CONTACT (aura_hit 2,8 blocs), 9 PV, épée → RUSH (fuir = flèches dans le dos)', () => {
  const r = decideSkeletonResponse(base({ dist: 2.8, health: 9 }));
  assert.equal(r.action, 'rush');
});

test('squelette proche (7 blocs) PV corrects, épée → RUSH', () => {
  assert.equal(decideSkeletonResponse(base({ dist: 7, health: 14 })).action, 'rush');
});

test('squelette proche mais PV trop bas pour courir dessus → couvert si une case cachée existe', () => {
  const r = decideSkeletonResponse(base({ dist: 7, health: 7, coverCell: true }));
  assert.equal(r.action, 'cover');
});

test('pas de case cachée, des blocs en poche → BLOCK (muret), jamais une fuite à découvert', () => {
  const r = decideSkeletonResponse(base({ dist: 12, health: 8, coverCell: false, hasBlock: true }));
  assert.equal(r.action, 'block');
});

test('loin (12 blocs) → on ne traverse pas le champ de tir : cover avant tout', () => {
  const r = decideSkeletonResponse(base({ dist: 12, health: 20, coverCell: true }));
  assert.equal(r.action, 'cover');
});

test('sans ligne de vue → cover (rester caché : ne pas sortir dans son champ)', () => {
  const r = decideSkeletonResponse(base({ los: false, dist: 10, health: 5 }));
  assert.equal(r.action, 'cover');
  assert.equal(r.reason, 'no_los');
});

test('sans arme → pas de rush au-delà du contact (20 coups de poing = mort)', () => {
  const r = decideSkeletonResponse(base({ dist: 6, health: 18, attackDamage: 0, coverCell: true }));
  assert.equal(r.action, 'cover');
});

test('dans l\'eau → flee (on ne pose rien en nageant)', () => {
  assert.equal(decideSkeletonResponse(base({ inWater: true })).action, 'flee');
});

test('zombie collé en plus → flee (mêlée mixte : la logique historique garde la main)', () => {
  const r = decideSkeletonResponse(base({ meleeOthers: 1 }));
  assert.equal(r.action, 'flee');
  assert.equal(r.reason, 'melee_mix');
});

test('deux tireurs → pas de rush (on court sous le feu du second) : cover/block', () => {
  const r = decideSkeletonResponse(base({ dist: 5, health: 18, shooters: 2 }));
  assert.equal(r.action, 'block');
});

test('rien à poser, aucune case cachée, proche et 5 PV avec épée → rush de désespoir plutôt que fuite', () => {
  const r = decideSkeletonResponse(base({ dist: 6, health: 5, hasBlock: false, coverCell: false }));
  assert.equal(r.action, 'rush');
  assert.equal(r.reason, 'no_cover');
});

test('rien à poser, aucune case, loin → flee (dernier recours)', () => {
  const r = decideSkeletonResponse(base({ dist: 14, health: 5, hasBlock: false, coverCell: false }));
  assert.equal(r.action, 'flee');
});

test('rushMinHp : bouclier et armure abaissent le seuil, plancher 4', () => {
  assert.ok(rushMinHp({ dist: 7 }) > rushMinHp({ dist: 7, hasShield: true }));
  assert.ok(rushMinHp({ dist: 7 }) > rushMinHp({ dist: 7, armorPoints: 10 }));
  assert.ok(rushMinHp({ dist: CONTACT_DIST }) < rushMinHp({ dist: RUSH_DIST }));
  assert.ok(rushMinHp({ dist: 2, hasShield: true, armorPoints: 15 }) >= 4);
});

// ─── findCoverCell : tourner un coin ─────────────────────────────────────────────────────────────
// Monde jouet : sol plein à y=63, un pilier 1×2 (x=1, z=1, y=64-65) entre le squelette (x=1, z=10)
// et la case (1, 64, 0). Le bot est en (0, 64, 0) en pleine vue.
function world(extraSolid = []) {
  const solid = new Set(extraSolid.map((p) => p.join(',')));
  return (x, y, z) => y <= 63 || solid.has([x, y, z].join(','));
}

test('findCoverCell : rend la case cachée derrière le pilier la plus proche', () => {
  const isSolid = world([[1, 64, 1], [1, 65, 1]]);
  const c = findCoverCell({ from: { x: 0.5, y: 64, z: 0.5 }, shooter: { x: 1.5, y: 64, z: 10.5 }, isSolid, radius: 3 });
  assert.ok(c, 'une case cachée existe');
  assert.deepEqual([c.x, c.y, c.z], [1, 64, 0]);
});

test('findCoverCell : terrain plat sans obstacle → null', () => {
  const c = findCoverCell({ from: { x: 0.5, y: 64, z: 0.5 }, shooter: { x: 1.5, y: 64, z: 10.5 }, isSolid: world(), radius: 3 });
  assert.equal(c, null);
});

test('findCoverCell : ignore une case sans sol (jamais au-dessus du vide)', () => {
  // pilier présent mais sol creusé sous la case cachée
  const base = world([[1, 64, 1], [1, 65, 1]]);
  const isSolid = (x, y, z) => (x === 1 && y === 63 && z === 0) ? false : base(x, y, z);
  const c = findCoverCell({ from: { x: 0.5, y: 64, z: 0.5 }, shooter: { x: 1.5, y: 64, z: 10.5 }, isSolid, radius: 3 });
  assert.ok(!c || !(c.x === 1 && c.y === 64 && c.z === 0));
});

test('findCoverCell : déjà caché à sa place → la case du bot n\'est jamais rendue (pas de 0 bloc)', () => {
  const isSolid = world([[0, 64, 1], [0, 65, 1]]);
  const c = findCoverCell({ from: { x: 0.5, y: 64, z: 0.5 }, shooter: { x: 0.5, y: 64, z: 10.5 }, isSolid, radius: 3 });
  assert.ok(!c || !(c.x === 0 && c.y === 64 && c.z === 0));
});

test('zigzagSide : alterne gauche/droite à chaque demi-période', () => {
  assert.equal(zigzagSide(0, 400), 'left');
  assert.equal(zigzagSide(450, 400), 'right');
  assert.equal(zigzagSide(850, 400), 'left');
});
