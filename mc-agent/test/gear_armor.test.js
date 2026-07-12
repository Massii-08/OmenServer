'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { bestArmorToEquip } = require('../gear');

const inv = (names) => names.map((n) => ({ name: n, count: 1 }));
const bySlot = (list) => Object.fromEntries(list.map((x) => [x.slot, x.name]));

test('bestArmorToEquip: rien porté + set diamant en poche → équipe les 4 pièces diamant', () => {
  const r = bestArmorToEquip(inv(['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots']), new Set());
  assert.deepStrictEqual(bySlot(r), {
    head: 'diamond_helmet', torso: 'diamond_chestplate', legs: 'diamond_leggings', feet: 'diamond_boots',
  });
});

test('bestArmorToEquip: fer porté + diamant en poche → UPGRADE vers diamant', () => {
  const r = bestArmorToEquip(inv(['diamond_chestplate']), new Set(['iron_chestplate']));
  assert.deepStrictEqual(bySlot(r), { torso: 'diamond_chestplate' });
});

test('bestArmorToEquip: diamant porté + fer en poche → NE downgrade PAS', () => {
  const r = bestArmorToEquip(inv(['iron_helmet']), new Set(['diamond_helmet']));
  assert.deepStrictEqual(r, []);
});

test('bestArmorToEquip: 2 pièces même slot en poche → prend la MEILLEURE matière', () => {
  const r = bestArmorToEquip(inv(['iron_helmet', 'diamond_helmet']), new Set());
  assert.deepStrictEqual(bySlot(r), { head: 'diamond_helmet' });
});

test('bestArmorToEquip: netherite > diamant', () => {
  const r = bestArmorToEquip(inv(['netherite_boots']), new Set(['diamond_boots']));
  assert.deepStrictEqual(bySlot(r), { feet: 'netherite_boots' });
});

test('bestArmorToEquip: même matière déjà portée → rien', () => {
  const r = bestArmorToEquip(inv(['diamond_boots']), new Set(['diamond_boots']));
  assert.deepStrictEqual(r, []);
});

test('bestArmorToEquip: rien en poche → rien', () => {
  assert.deepStrictEqual(bestArmorToEquip([], new Set()), []);
  assert.deepStrictEqual(bestArmorToEquip(inv(['diamond_pickaxe', 'cobblestone']), new Set()), []);
});

// ── armorUpgradePlan (run nether 2026-07-13) : prochaine pièce DIAMANT à crafter — par SLOT
// (rang porté-ou-en-poche < diamant), la moins chère d'abord, gated par les 💎 disponibles.
const { armorUpgradePlan } = require('../gear');

test('armorUpgradePlan: fer complet porté + 24💎 → bottes diamant d abord (la moins chère)', () => {
  const worn = new Set(['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']);
  const r = armorUpgradePlan([{ name: 'diamond', count: 24 }], worn, { material: 'diamond' });
  assert.deepStrictEqual(r, { craft: 'diamond_boots', slot: 'feet', units: 4 });
});

test('armorUpgradePlan: bottes diamant portées + 3💎 → null (casque=5 > 3)', () => {
  const worn = new Set(['diamond_boots', 'iron_helmet']);
  const r = armorUpgradePlan([{ name: 'diamond', count: 3 }], worn, { material: 'diamond' });
  assert.strictEqual(r, null);
});

test('armorUpgradePlan: pièce diamant déjà EN POCHE → ne la re-craft pas, passe à la suivante', () => {
  const items = [{ name: 'diamond', count: 24 }, { name: 'diamond_boots', count: 1 }];
  const r = armorUpgradePlan(items, new Set(), { material: 'diamond' });
  assert.deepStrictEqual(r, { craft: 'diamond_helmet', slot: 'head', units: 5 });
});

test('armorUpgradePlan: netherite porté → slot déjà au-dessus, pas de craft diamant', () => {
  const worn = new Set(['netherite_boots', 'diamond_helmet', 'diamond_leggings', 'diamond_chestplate']);
  const r = armorUpgradePlan([{ name: 'diamond', count: 24 }], worn, { material: 'diamond' });
  assert.strictEqual(r, null);
});
