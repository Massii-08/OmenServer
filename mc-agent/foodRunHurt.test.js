'use strict';
// 24/10 : blessé à faim 15-17, rien en poche → la quête de nourriture ne partait qu'à faim ≤ 14
// (FOOD_RUN_HUNGER), alors que sous 18 la régénération est déjà coupée : le bot restait à 1-2 PV.
const { test } = require('node:test');
const assert = require('node:assert');
const { foodRunNeeded, FOOD_RUN_HUNGER } = require('./caution');

test('foodRunNeeded : blessé (< 16 PV) à faim 15-17 et ventre vide → quête prioritaire', () => {
  assert.strictEqual(foodRunNeeded({ food: 17, health: 2, foodItems: 0, now: 1e6, lastRunAt: 0 }), true);
  assert.strictEqual(foodRunNeeded({ food: 17, health: 20, foodItems: 0, now: 1e6, lastRunAt: 0 }), false, 'indemne : inchangé');
  assert.strictEqual(foodRunNeeded({ food: 17, health: 2, foodItems: 3, now: 1e6, lastRunAt: 0 }), false, 'il a à manger : au filet');
  assert.strictEqual(foodRunNeeded({ food: 18, health: 2, foodItems: 0, now: 1e6, lastRunAt: 0 }), false, 'régénère');
  assert.strictEqual(foodRunNeeded({ food: FOOD_RUN_HUNGER, foodItems: 0, now: 1e6, lastRunAt: 0 }), true, 'rétro-compat sans health');
});
