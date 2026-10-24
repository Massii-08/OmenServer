'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { diamondFree, cautionNight } = require('./freeRoam');

const DIA = ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots'];

test('diamant complet porté → libre', () => {
  assert.strictEqual(diamondFree(DIA), true);
  assert.strictEqual(diamondFree(new Set(DIA)), true);
  assert.strictEqual(diamondFree(['netherite_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots']), true);
});

test('3 pièces diamant + 1 fer, fer complet, nu → pas libre', () => {
  assert.strictEqual(diamondFree(['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'iron_boots']), false);
  assert.strictEqual(diamondFree(['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']), false);
  assert.strictEqual(diamondFree([]), false);
  assert.strictEqual(diamondFree(null), false);
});

test('cautionNight : la nuit disparaît pour le diamant complet, intacte pour les autres', () => {
  assert.strictEqual(cautionNight(true, DIA), false);
  assert.strictEqual(cautionNight(null, DIA), false);
  assert.strictEqual(cautionNight(true, ['iron_helmet']), true);
  assert.strictEqual(cautionNight(null, []), null);
  assert.strictEqual(cautionNight(false, []), false);
});
