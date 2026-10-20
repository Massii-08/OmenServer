'use strict';
// But `iron_cave` (Massii 20/10) : le fer des grottes AVANT le branch-mine aveugle à Y16.
// SATISFIABLE-OU-SAUTABLE : sans grappe valable (ctx.ironCave null), la chaîne d'avant est intacte.
const { test } = require('node:test');
const assert = require('node:assert');
const { firstUnmet, IRON_ARMOR_CHAIN, DIAMOND_ARMOR_CHAIN, LUMBERJACK_CHAIN, chainFor } = require('../goals');

const CAVE = { key: 'cave:1,2,0', x: 20, y: 40, z: 2, count: 4, dist: 30, ores: [] };
const ctx = (inv, o = {}) => Object.assign({ inv, worn: [], y: 64, hasTable: false }, o);
const KIT = { stone_pickaxe: 3, wooden_pickaxe: 1, crafting_table: 1, stick: 4, furnace: 1,
  stone_sword: 1, stone_axe: 1, cobblestone: 12, oak_planks: 24 };

test('iron_cave précède descend_y16 et iron_deep dans IRON_ARMOR_CHAIN (et donc DIAMOND_ARMOR_CHAIN)', () => {
  for (const chain of [IRON_ARMOR_CHAIN, DIAMOND_ARMOR_CHAIN]) {
    const n = chain.map((g) => g.name);
    assert.ok(n.includes('iron_cave'));
    assert.ok(n.indexOf('iron_cave') < n.indexOf('descend_y16'));
    assert.ok(n.indexOf('iron_cave') < n.indexOf('iron_deep'));
  }
  assert.strictEqual(chainFor('iron_armor').find((g) => g.name === 'iron_cave').skill, 'caveIron');
});

test('bûcheron : pas de chasse au fer en grotte (il reste en surface)', () => {
  assert.ok(!LUMBERJACK_CHAIN.some((g) => g.name === 'iron_cave' || g.skill === 'caveIron'));
});

test('grappe connue + fer manquant → but = iron_cave', () => {
  assert.strictEqual(firstUnmet(IRON_ARMOR_CHAIN, ctx(KIT, { ironCave: CAVE })).name, 'iron_cave');
});

test('aucune grappe → sauté, retombe sur descend_y16 puis iron_deep (comportement historique)', () => {
  assert.strictEqual(firstUnmet(IRON_ARMOR_CHAIN, ctx(KIT, { ironCave: null })).name, 'descend_y16');
  assert.strictEqual(firstUnmet(IRON_ARMOR_CHAIN, ctx(KIT)).name, 'descend_y16');
  assert.strictEqual(firstUnmet(IRON_ARMOR_CHAIN, ctx(KIT, { y: 16 })).name, 'iron_deep');
});

test('déjà à Y16 avec une grappe connue → la grotte passe avant le tunnel', () => {
  assert.strictEqual(firstUnmet(IRON_ARMOR_CHAIN, ctx(KIT, { y: 16, ironCave: CAVE })).name, 'iron_cave');
});

test('besoin en fer couvert (lingots + brut) → grappe ignorée', () => {
  const inv = Object.assign({}, KIT, { iron_pickaxe: 1, iron_ingot: 10, raw_iron: 14 });   // 24 ≥ 24
  const g = firstUnmet(IRON_ARMOR_CHAIN, ctx(inv, { ironCave: CAVE }));
  assert.notStrictEqual(g && g.name, 'iron_cave');
  assert.notStrictEqual(g && g.name, 'descend_y16');
});

test('armure portée complète → rien à faire même avec une grappe', () => {
  const full = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];
  assert.strictEqual(firstUnmet(IRON_ARMOR_CHAIN, ctx({}, { worn: full, ironCave: CAVE })), null);
});
