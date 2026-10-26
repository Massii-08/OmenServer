'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const E = require('./eatSafe');

test('healEatWanted : blessé (< 16) et faim < 18 → manger pour se soigner', () => {
  assert.strictEqual(E.healEatWanted({ health: 1.1, food: 13 }), true, 'NethBot2 session 606');
  assert.strictEqual(E.healEatWanted({ health: 15.9, food: 17 }), true);
  assert.strictEqual(E.healEatWanted({ health: 16, food: 13 }), false);
  assert.strictEqual(E.healEatWanted({ health: 5, food: 18 }), false, 'la régénération fait le travail');
  assert.strictEqual(E.healEatWanted({ health: 0, food: 10 }), false, 'mort');
  assert.strictEqual(E.healEatWanted({ health: 5 }), false, 'faim inconnue');
});

test('eatEffective : faim montée OU objet consommé ; rien → bouchée factice', () => {
  assert.strictEqual(E.eatEffective({ foodBefore: 17, foodAfter: 20 }), true);
  assert.strictEqual(E.eatEffective({ foodBefore: 17, foodAfter: 17, countBefore: 5, countAfter: 4 }), true);
  assert.strictEqual(E.eatEffective({ foodBefore: 17, foodAfter: 17, countBefore: 5, countAfter: 5 }), false, 'le porc à faim 17');
  assert.strictEqual(E.eatEffective({}), false);
});

test('itemCount : somme des piles du même nom', () => {
  assert.strictEqual(E.itemCount([{ name: 'beef', count: 3 }, { name: 'beef', count: 2 }, { name: 'bread', count: 1 }], 'beef'), 5);
  assert.strictEqual(E.itemCount(null, 'beef'), 0);
});

test('noEffectBackoffMs : 0 au premier raté, puis 15 s, 30 s, plafond 60 s', () => {
  assert.deepStrictEqual([0, 1, 2, 3, 4, 9].map(E.noEffectBackoffMs), [0, 0, 15000, 30000, 60000, 60000]);
});

test('eatLockWaitMs : un equip étranger attend la fin de la bouchée, le repas passe, jamais de gel', () => {
  assert.strictEqual(E.eatLockWaitMs({ lockUntil: 3000, now: 1000 }), 2000);
  assert.strictEqual(E.eatLockWaitMs({ lockUntil: 3000, now: 1000, isFood: true }), 0);
  assert.strictEqual(E.eatLockWaitMs({ lockUntil: 900, now: 1000 }), 0);
  assert.strictEqual(E.eatLockWaitMs({ lockUntil: 1e12, now: 1000 }), E.EAT_LOCK_MS, 'verrou absurde borné');
  assert.strictEqual(E.eatLockWaitMs({}), 0);
});

test('cookFirstWhenHurt : cuire d abord seulement si possible, libre, et PV ≥ 10', () => {
  assert.strictEqual(E.cookFirstWhenHurt({ health: 12, canCook: true, free: true }), true);
  assert.strictEqual(E.cookFirstWhenHurt({ health: 5, canCook: true, free: true }), false, 'en danger : le cru tout de suite');
  assert.strictEqual(E.cookFirstWhenHurt({ health: 12, canCook: true, free: false }), false, 'occupé : pas d attente');
  assert.strictEqual(E.cookFirstWhenHurt({ health: 12, canCook: false, free: true }), false);
});

// ─── PAS DE BOUCHÉE AU CONTACT (26/10) ─────────────────────────────────────────────────────────────
// NethBot3 en fer complet : `reflex eat` ×6 en 20 s, `reflex fight zombie`, `reflex eat`, puis
// `fight_last_stand hp:3.2` et mort — pendant la bouchée il ne frappe pas, le zombie collé l'achève.
const { combatEatBlocked, COMBAT_EAT_REACH } = require('./eatSafe');

test('combatEatBlocked : hostile à ≤ 3,5 blocs, armé → pas de bouchée', () => {
  assert.equal(COMBAT_EAT_REACH, 3.5);
  assert.equal(combatEatBlocked({ nearestDist: 2.3, health: 11, attackDamage: 6 }), true);
  assert.equal(combatEatBlocked({ nearestDist: 3.5, health: 18, attackDamage: 6 }), true);
});

test('combatEatBlocked : hostile plus loin ou absent → on mange', () => {
  assert.equal(combatEatBlocked({ nearestDist: 3.6, health: 11, attackDamage: 6 }), false);
  assert.equal(combatEatBlocked({ nearestDist: null, health: 11, attackDamage: 6 }), false);
  assert.equal(combatEatBlocked({ health: 11, attackDamage: 6 }), false);
});

test('combatEatBlocked : muré dans l\'abri → on mange même au contact', () => {
  assert.equal(combatEatBlocked({ nearestDist: 1.5, health: 11, attackDamage: 6, sealed: true }), false);
});

test('combatEatBlocked : PV ≤ 4 et aucun coup possible → on mange', () => {
  assert.equal(combatEatBlocked({ nearestDist: 2, health: 4, attackDamage: 0 }), false);      // pas d'arme
  assert.equal(combatEatBlocked({ nearestDist: 3.3, health: 3, attackDamage: 6 }), false);    // hors portée de coup
  // PV ≤ 4 mais armé ET à portée de coup : on finit le combat
  assert.equal(combatEatBlocked({ nearestDist: 2, health: 3.2, attackDamage: 6 }), true);
  // pas d'arme mais PV > 4 : on recule / on frappe, on ne mange pas
  assert.equal(combatEatBlocked({ nearestDist: 2, health: 9, attackDamage: 0 }), true);
});
