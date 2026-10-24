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

// ── nuit du mineur diamant (24/10 soir) ──
{
  const test = require('node:test');
  const assert = require('assert');
  const { diamondNightPlan } = require('./freeRoam');
  test('diamondNightPlan : non concerné sans diamant complet', () => {
    assert.strictEqual(diamondNightPlan({ free: false, night: true }), 'none');
  });
  test('diamondNightPlan : jour ou sous terre → il travaille', () => {
    assert.strictEqual(diamondNightPlan({ free: true, night: false }), 'work');
    assert.strictEqual(diamondNightPlan({ free: true, night: true, underground: true }), 'work');
  });
  test('diamondNightPlan : nuit en surface + vrai besoin → reste', () => {
    assert.strictEqual(diamondNightPlan({ free: true, night: true, goalName: 'logs' }), 'need');
    assert.strictEqual(diamondNightPlan({ free: true, night: true, goalSkill: 'huntCook' }), 'need');
    assert.strictEqual(diamondNightPlan({ free: true, night: true, foodCritical: true }), 'need');
  });
  test('diamondNightPlan : nuit en surface sans besoin → redescend, sinon abri', () => {
    assert.strictEqual(diamondNightPlan({ free: true, night: true, goalName: 'descend_y54', deepWorkWarp: true }), 'go_deep');
    assert.strictEqual(diamondNightPlan({ free: true, night: true, goalName: 'descend_y54' }), 'shelter');
  });
}
