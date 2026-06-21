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
