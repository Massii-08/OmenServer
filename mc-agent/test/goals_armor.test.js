'use strict';
// Chaînes ARMURE (run nether 2026-07-13) : iron_armor (T1) et diamond_armor (T2), 100% auto-craftées
// (0 /give). Prédicats purs : armorNeed (unités restantes pour couvrir les 4 slots au rang minimal),
// armorWornOk (les 4 slots PORTÉS au rang minimal). c.worn = pièces équipées (hors inventaire).
const { test } = require('node:test');
const assert = require('node:assert');
const {
  armorNeed, armorWornOk, chainFor, firstUnmet,
  IRON_ARMOR_CHAIN, DIAMOND_ARMOR_CHAIN,
} = require('../goals');

const ctx = (inv = {}, worn = [], y = 64) => ({ inv, worn, y, hasTable: false });

test('armorNeed: nu → 24 unités pour du fer (4+5+7+8)', () => {
  assert.strictEqual(armorNeed(ctx(), 3), 24);
});

test('armorNeed: casque fer PORTÉ → 19 restants ; bottes en POCHE comptent aussi', () => {
  assert.strictEqual(armorNeed(ctx({}, ['iron_helmet']), 3), 19);
  assert.strictEqual(armorNeed(ctx({ iron_boots: 1 }, ['iron_helmet']), 3), 15);
});

test('armorNeed: le diamant COUVRE le besoin fer (rang ≥), le cuir NON', () => {
  assert.strictEqual(armorNeed(ctx({}, ['diamond_helmet']), 3), 19);
  assert.strictEqual(armorNeed(ctx({}, ['leather_helmet']), 3), 24);
});

test('armorNeed rang 4 : fer complet porté → il faut TOUT le diamant (24)', () => {
  const full = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];
  assert.strictEqual(armorNeed(ctx({}, full), 4), 24);
  assert.strictEqual(armorNeed(ctx({}, full), 3), 0);
});

test('armorWornOk : en poche ne suffit PAS, il faut PORTER', () => {
  const inv = { iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1 };
  assert.ok(!armorWornOk(ctx(inv, []), 3));
  const full = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];
  assert.ok(armorWornOk(ctx({}, full), 3));
  assert.ok(!armorWornOk(ctx({}, ['iron_helmet', 'iron_chestplate', 'iron_leggings']), 3));
});

test('chainFor: iron_armor / diamond_armor sélectionnent les nouvelles chaînes ; défaut inchangé', () => {
  assert.strictEqual(chainFor('iron_armor'), IRON_ARMOR_CHAIN);
  assert.strictEqual(chainFor('diamond_armor'), DIAMOND_ARMOR_CHAIN);
  assert.strictEqual(chainFor('bidon').length > 0, true); // défaut = MVP (rétro-compat)
});

test('IRON_ARMOR_CHAIN: bot nu → premier but = logs (la chaîne fer complète est en amont)', () => {
  const g = firstUnmet(IRON_ARMOR_CHAIN, ctx());
  assert.strictEqual(g.name, 'logs');
});

test('IRON_ARMOR_CHAIN: pioche fer + kit bois sûr + four + food + 24 lingots → but = iron_armor (craft)', () => {
  const inv = {
    iron_pickaxe: 1, crafting_table: 1, stick: 4, furnace: 1, cooked_beef: 6,
    iron_ingot: 24, cobblestone: 12, oak_planks: 8,
  };
  const g = firstUnmet(IRON_ARMOR_CHAIN, ctx(inv));
  assert.strictEqual(g.name, 'iron_armor');
});

test('IRON_ARMOR_CHAIN: kit prêt mais SANS nourriture (surface) → but = food_stock AVANT la descente', () => {
  const inv = {
    stone_pickaxe: 1, wooden_pickaxe: 1, crafting_table: 1, stick: 4, furnace: 1,
    cobblestone: 12, oak_planks: 8,
  };
  const g = firstUnmet(IRON_ARMOR_CHAIN, ctx(inv, [], 64));
  assert.strictEqual(g.name, 'food_stock');
});

test('IRON_ARMOR_CHAIN: fer insuffisant, en surface → descend_y16 ; déjà à Y16 → iron_deep (branch-mine)', () => {
  const inv = {
    iron_pickaxe: 1, crafting_table: 1, stick: 4, furnace: 1, cooked_beef: 6,
    iron_ingot: 2, raw_iron: 1, cobblestone: 12, oak_planks: 8,
  };
  assert.strictEqual(firstUnmet(IRON_ARMOR_CHAIN, ctx(inv, [], 64)).name, 'descend_y16');
  assert.strictEqual(firstUnmet(IRON_ARMOR_CHAIN, ctx(inv, [], 16)).name, 'iron_deep');
});

test('IRON_ARMOR_CHAIN: sous terre SANS food → food_stock ne stalle pas (met via y<45)', () => {
  const inv = {
    iron_pickaxe: 1, crafting_table: 1, stick: 4, furnace: 1,
    iron_ingot: 2, cobblestone: 12, oak_planks: 8,
  };
  const g = firstUnmet(IRON_ARMOR_CHAIN, ctx(inv, [], 16));
  assert.strictEqual(g.name, 'iron_deep'); // pas food_stock ni descend
});

test('IRON_ARMOR_CHAIN: 4 pièces fer craftées mais PAS portées → dernier but = équiper', () => {
  const inv = {
    iron_pickaxe: 1, crafting_table: 1, stick: 4, furnace: 1,
    iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1,
  };
  const g = firstUnmet(IRON_ARMOR_CHAIN, ctx(inv));
  assert.strictEqual(g.name, 'iron_armor_worn');
});

test('IRON_ARMOR_CHAIN: armure fer complète PORTÉE → chaîne finie (monotone, inventaire vide)', () => {
  const full = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];
  assert.strictEqual(firstUnmet(IRON_ARMOR_CHAIN, ctx({}, full)), null);
});

test('DIAMOND_ARMOR_CHAIN: armure fer portée + 24💎 en poche → but = diamond_armor (pas de descente)', () => {
  const full = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];
  const g = firstUnmet(DIAMOND_ARMOR_CHAIN, ctx({ diamond: 24, crafting_table: 1 }, full));
  assert.strictEqual(g.name, 'diamond_armor');
});

test('DIAMOND_ARMOR_CHAIN: armure fer portée, 0💎, en surface → cobble buffer puis descente', () => {
  const full = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];
  const g = firstUnmet(DIAMOND_ARMOR_CHAIN, ctx({ crafting_table: 1, iron_pickaxe: 1 }, full, 64));
  assert.strictEqual(g.name, 'cobble_buffer');
  const g2 = firstUnmet(DIAMOND_ARMOR_CHAIN, ctx({ crafting_table: 1, iron_pickaxe: 1, cobblestone: 20 }, full, 64));
  assert.strictEqual(g2.name, 'descend_y54');
});

test('DIAMOND_ARMOR_CHAIN: à -54 avec quelques 💎 mais pas assez → continue branch_mine (besoin RESTANT)', () => {
  const full = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];
  const g = firstUnmet(DIAMOND_ARMOR_CHAIN, ctx({ crafting_table: 1, iron_pickaxe: 1, cobblestone: 20, diamond: 10 }, full, -54));
  assert.strictEqual(g.name, 'diamonds_armor');
});

test('DIAMOND_ARMOR_CHAIN: pièces diamant partielles portées → le besoin 💎 baisse', () => {
  const worn = ['diamond_boots', 'diamond_helmet', 'iron_chestplate', 'iron_leggings'];
  // restants : jambières 7 + plastron 8 = 15 → 15💎 suffisent
  const g = firstUnmet(DIAMOND_ARMOR_CHAIN, ctx({ diamond: 15, crafting_table: 1 }, worn, -54));
  assert.strictEqual(g.name, 'diamond_armor');
});

test('DIAMOND_ARMOR_CHAIN: armure diamant complète portée → chaîne finie (monotone)', () => {
  const full = ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots'];
  assert.strictEqual(firstUnmet(DIAMOND_ARMOR_CHAIN, ctx({}, full)), null);
});
