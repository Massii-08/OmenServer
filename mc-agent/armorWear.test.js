'use strict';
const test = require('node:test');
const assert = require('assert');
const W = require('./armorWear');
const { isNearlyBroken } = require('./gear');
const { diamondArmorNext } = require('./diaArmor');

test('seuil : diamant à 90 %, fer à 85 %', () => {
  assert.strictEqual(W.wearThresholdFor('diamond_chestplate'), 0.90);
  assert.strictEqual(W.wearThresholdFor('netherite_boots'), 0.90);
  assert.strictEqual(W.wearThresholdFor('iron_chestplate'), 0.85);
  assert.strictEqual(W.wearThresholdFor('diamond_pickaxe'), 0.85);
});

test('isNearlyBroken : plastron diamant à 87 % = encore bon, à 92 % = à remplacer', () => {
  const p = (used) => ({ name: 'diamond_chestplate', maxDurability: 528, durabilityUsed: used });
  assert.strictEqual(isNearlyBroken(p(Math.round(528 * 0.87))), false);
  assert.strictEqual(isNearlyBroken(p(Math.round(528 * 0.92))), true);
  const i = { name: 'iron_chestplate', maxDurability: 240, durabilityUsed: Math.round(240 * 0.87) };
  assert.strictEqual(isNearlyBroken(i), true, 'le fer garde son seuil 85 %');
});

test('canEquipOver : jamais de fer par-dessus un diamant usé', () => {
  assert.strictEqual(W.canEquipOver({ name: 'iron_chestplate' }, { name: 'diamond_chestplate', broken: true }), false);
});
test('canEquipOver : pièce usée jamais ré-enfilée', () => {
  assert.strictEqual(W.canEquipOver({ name: 'diamond_chestplate', broken: true }, { name: 'iron_chestplate' }), false);
});
test('canEquipOver : diamant sain remplace diamant usé, pas un sain', () => {
  assert.strictEqual(W.canEquipOver({ name: 'diamond_chestplate' }, { name: 'diamond_chestplate', broken: true }), true);
  assert.strictEqual(W.canEquipOver({ name: 'diamond_chestplate' }, { name: 'diamond_chestplate' }), false);
});
test('canEquipOver : mieux par-dessus, slot vide accepté', () => {
  assert.strictEqual(W.canEquipOver({ name: 'diamond_leggings' }, { name: 'iron_leggings' }), true);
  assert.strictEqual(W.canEquipOver({ name: 'iron_leggings' }, null), true);
});

test('equipPlan : la boucle mesurée ne se reproduit pas', () => {
  // plastron diamant usé porté + fer en poche → rien ; puis l'inverse (diamant usé en poche) → rien.
  assert.deepStrictEqual(W.equipPlan([{ name: 'iron_chestplate' }], [{ name: 'diamond_chestplate', broken: true }]), []);
  assert.deepStrictEqual(W.equipPlan([{ name: 'diamond_chestplate', broken: true }], [{ name: 'iron_chestplate' }]), []);
  assert.deepStrictEqual(W.equipPlan([{ name: 'diamond_boots' }], [{ name: 'iron_boots' }]), [{ name: 'diamond_boots', slot: 'feet' }]);
});

test('recraft : 10 min de refroidissement par slot', () => {
  const now = 1e9;
  const m = { torso: now - 5 * 60e3, legs: now - 11 * 60e3 };
  assert.strictEqual(W.recraftCooling(m, 'torso', now), true);
  assert.strictEqual(W.recraftCooling(m, 'legs', now), false);
  assert.deepStrictEqual(W.coolingSlots(m, now), ['torso']);
});

test('ironCraftBlocked : slot diamant (même usé) → pas de fer', () => {
  assert.strictEqual(W.ironCraftBlocked('diamond_leggings'), true);
  assert.strictEqual(W.ironCraftBlocked('iron_leggings'), false);
  assert.strictEqual(W.ironCraftBlocked(null), false);
});

test('diamondArmorNext : slot en refroidissement → pas de reforge, on passe au suivant', () => {
  const inv = { diamond: 30 };
  const r = diamondArmorNext({ inv, worn: [], pocketGood: [], pickCount: 1, tableOk: true, cooldownSlots: ['torso'] });
  assert.deepStrictEqual(r && r.name, 'diamond_leggings');
  const r2 = diamondArmorNext({ inv, worn: [], pocketGood: [], pickCount: 1, tableOk: true });
  assert.deepStrictEqual(r2 && r2.name, 'diamond_chestplate');
});
