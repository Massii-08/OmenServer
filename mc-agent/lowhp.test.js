'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { lowHpStep, craftBlockedAtLowHp } = require('./lowhp');

// Cas mesurés le 22/10 : NethBot1/NethBot3 à 3,6-5,3 PV, food 13-14, rien en poche, aucun gain de la
// sortie nourriture — le planner relançait `furnace`/`crafting_table` en boucle jusqu'à la mort.

test('lowHpStep : PV au-dessus du seuil critique → ok (aucun impact sur un bot sain)', () => {
  assert.strictEqual(lowHpStep({ health: 20, food: 2 }), 'ok');
  assert.strictEqual(lowHpStep({ health: 6.01, threatDist: 2 }), 'ok');
  assert.strictEqual(lowHpStep({}), 'ok', 'santé inconnue : ne jamais bloquer sans donnée fiable');
});

test('lowHpStep : de quoi manger et pas de régénération → manger d’abord', () => {
  assert.strictEqual(lowHpStep({ health: 5, food: 13, hasFood: true, threatDist: 3 }), 'eat');
  assert.strictEqual(lowHpStep({ health: 5, food: null, hasFood: true }), 'eat', 'faim inconnue : on mange');
});

test('lowHpStep : régénération en cours (food ≥ 18) → on ne mange pas, on attend', () => {
  assert.strictEqual(lowHpStep({ health: 5, food: 18, hasFood: true }), 'wait');
  assert.strictEqual(lowHpStep({ health: 5, food: 20 }), 'wait');
});

test('lowHpStep : eat_failed répété → on cesse d’essayer de manger (pas de spin)', () => {
  assert.strictEqual(lowHpStep({ health: 5, food: 13, hasFood: true, eatFails: 3, foodRunTriedRecently: true }), 'proceed');
});

test('lowHpStep : hostile collé → se murer une fois, puis attendre tant qu’il est en vue', () => {
  assert.strictEqual(lowHpStep({ health: 4, food: 13, threatDist: 5 }), 'seal');
  assert.strictEqual(lowHpStep({ health: 4, food: 13, threatDist: 5, sealed: true }), 'wait');
  assert.strictEqual(lowHpStep({ health: 4, food: 13, threatDist: 12 }), 'wait');
});

test('lowHpStep : affamé, rien en poche, personne en vue → sortie nourriture, puis on laisse crafter', () => {
  assert.strictEqual(lowHpStep({ health: 5.3, food: 13 }), 'food_run');
  assert.strictEqual(lowHpStep({ health: 5.3, food: 13, foodRunTriedRecently: true }), 'proceed');
  assert.strictEqual(lowHpStep({ health: 5.3, food: 13, threatDist: 40, foodRunTriedRecently: true }), 'proceed');
});

test('craftBlockedAtLowHp : garde l’intention de 0990f4c — pas de craft à PV critiques avec une menace', () => {
  assert.strictEqual(craftBlockedAtLowHp({ health: 4.33, food: 20, threatDist: 4 }), true);
  assert.strictEqual(craftBlockedAtLowHp({ health: 4.33, food: 13, threatDist: 14, foodRunTriedRecently: true }), true);
  assert.strictEqual(craftBlockedAtLowHp({ health: 20, threatDist: 2 }), false);
  // Ni menace, ni nourriture, ni régénération, sortie déjà tentée : attendre ne rend rien.
  assert.strictEqual(craftBlockedAtLowHp({ health: 4.33, food: 13, foodRunTriedRecently: true }), false);
});
