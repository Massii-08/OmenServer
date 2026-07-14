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

test('IRON_ARMOR_CHAIN: kit prêt SANS nourriture → la descente n est PAS bloquée (chasse = hook best-effort)', () => {
  // vécu live : un but food_stock bloquant stallait à vie sur no_prey (zone vidée de ses proies)
  // (3 pioches : le pré-stock spare_picks est satisfait → on isole bien le comportement food)
  const inv = {
    stone_pickaxe: 3, wooden_pickaxe: 1, crafting_table: 1, stick: 4, furnace: 1,
    cobblestone: 12, oak_planks: 8,
  };
  const g = firstUnmet(IRON_ARMOR_CHAIN, ctx(inv, [], 64));
  assert.strictEqual(g.name, 'descend_y16');
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

// --- Churn-breaker no_pickaxe (run homedeath 2026-07-13) : pioche cassée à Y16 avec cobble+sticks+
// table en poche → le planner doit crafter une pioche PIERRE direct (jamais repasser par le bois). ---
test('firstUnmet: cobble+sticks+table, PAS de bois ni pioche → saute à stone_pickaxe (pas logs/wooden)', () => {
  const c = ctx({ cobblestone: 5, stick: 4, crafting_table: 1 }, [], 16);
  const g = firstUnmet(IRON_ARMOR_CHAIN, c);
  assert.strictEqual(g && g.name, 'stone_pickaxe');
});

test('firstUnmet: sans matériaux stone-pick (0 cobble) → repasse bien par logs (comportement inchangé)', () => {
  const c = ctx({}, [], 70);
  const g = firstUnmet(IRON_ARMOR_CHAIN, c);
  assert.strictEqual(g && g.name, 'logs');
});

test('firstUnmet: cobble mais PAS de sticks → PAS de raccourci (il faut du bois pour les sticks) → logs', () => {
  const c = ctx({ cobblestone: 5, crafting_table: 1 }, [], 16);
  const g = firstUnmet(IRON_ARMOR_CHAIN, c);
  assert.strictEqual(g && g.name, 'logs');
});

// --- Pré-stock pioches (fix n°3 mur de l'eau) : descendre avec 3 pioches pierre — une casse ne
// force plus l'arrêt du minage (vécu homedeath cycle 6 : la pioche cassait pendant la descente PUIS
// en minant, avant les ~27 fer d'iron_deep). Exigé EN SURFACE seulement (y>30) : sous terre, 1
// pioche suffit (exiger 3 avec 0 stick = remontée bois avec 2 pioches valides en poche = churn).
test('IRON_ARMOR_CHAIN: surface + kit + 1 seule pioche pierre → but = spare_picks (pré-stock 3)', () => {
  const inv = { stone_pickaxe: 1, crafting_table: 1, stick: 8, furnace: 1, cobblestone: 12, oak_planks: 8 };
  const g = firstUnmet(IRON_ARMOR_CHAIN, ctx(inv, [], 64));
  assert.strictEqual(g.name, 'spare_picks');
});

test('IRON_ARMOR_CHAIN: surface + 3 pioches pierre → pré-stock satisfait, but = descend_y16', () => {
  const inv = { stone_pickaxe: 3, crafting_table: 1, stick: 8, furnace: 1, cobblestone: 12, oak_planks: 8 };
  const g = firstUnmet(IRON_ARMOR_CHAIN, ctx(inv, [], 64));
  assert.strictEqual(g.name, 'descend_y16');
});

test('IRON_ARMOR_CHAIN: SOUS TERRE (y=16) + 1 pioche → PAS de pré-stock (continue de miner : iron_deep)', () => {
  const inv = { stone_pickaxe: 1, crafting_table: 1, stick: 6, furnace: 1, cobblestone: 12, oak_planks: 8 };
  const g = firstUnmet(IRON_ARMOR_CHAIN, ctx(inv, [], 16));
  assert.strictEqual(g.name, 'iron_deep');
});

test('IRON_ARMOR_CHAIN: sous terre 0 pioche + matériaux → re-craft en place (stone_pickaxe, a752743)', () => {
  const inv = { crafting_table: 1, stick: 6, furnace: 1, cobblestone: 8, oak_planks: 8 };
  const g = firstUnmet(IRON_ARMOR_CHAIN, ctx(inv, [], 16));
  assert.strictEqual(g.name, 'stone_pickaxe');
});

test('IRON_ARMOR_CHAIN: pioche FER en poche → jamais de pré-stock pierre', () => {
  const inv = { iron_pickaxe: 1, crafting_table: 1, stick: 8, furnace: 1, cobblestone: 12, oak_planks: 8 };
  const g = firstUnmet(IRON_ARMOR_CHAIN, ctx(inv, [], 64));
  assert.notStrictEqual(g && g.name, 'spare_picks');
  assert.notStrictEqual(g && g.name, 'cobble_spare');
});

test('chaînes armure : le minage profond est en SERPENTIN (profil anti-eau du pipeline diamant)', () => {
  // fix n°2 water-wall : le couloir droit longeait les nappes sans avancer ; le serpentin tourne
  // au contact de l'eau (+ scellement frontal branchMine). IRON_CHAIN (pioche) reste en couloir.
  const { IRON_CHAIN } = require('../goals');
  const ironDeep = IRON_ARMOR_CHAIN.find((g) => g.name === 'iron_deep');
  const diaDeep = DIAMOND_ARMOR_CHAIN.find((g) => g.name === 'diamonds_armor');
  assert.strictEqual(ironDeep.args.serpentine, true);
  assert.strictEqual(diaDeep.args.serpentine, true);
  const ironChainDeep = IRON_CHAIN.find((g) => g.name === 'iron_deep');
  assert.ok(!ironChainDeep || !ironChainDeep.args.serpentine, 'IRON_CHAIN (objectif pioche) inchangé');
});

// --- Fix n°4 water-wall : le DERNIER MÈTRE de T1 (vécu live NethBot3, 85× armor_no_progress).
// Un bot qui reprend avec pioche fer + fer brut banké a TOUS les buts amont « met » via I(c) →
// jamais de bois ni de four cette session → le smelt d'ensureArmor échoue en silence (0 combustible,
// 0 four) → boucle armor_no_progress à vie. La chaîne doit exiger combustible + four AVANT iron_armor.
test('IRON_ARMOR_CHAIN: pioche fer + 24 raw_iron mais 0 combustible → but = armor_fuel', () => {
  const inv = { iron_pickaxe: 1, raw_iron: 24, cobblestone: 12, crafting_table: 1, furnace: 1 };
  const g = firstUnmet(IRON_ARMOR_CHAIN, ctx(inv, [], 64));
  assert.strictEqual(g.name, 'armor_fuel');
});

test('IRON_ARMOR_CHAIN: fer brut + charbon mais PAS de four → armor_cobble puis armor_furnace', () => {
  const noCobble = { iron_pickaxe: 1, raw_iron: 24, coal: 4, crafting_table: 1 };
  assert.strictEqual(firstUnmet(IRON_ARMOR_CHAIN, ctx(noCobble, [], 64)).name, 'armor_cobble');
  const withCobble = { ...noCobble, cobblestone: 8 };
  assert.strictEqual(firstUnmet(IRON_ARMOR_CHAIN, ctx(withCobble, [], 64)).name, 'armor_furnace');
});

test('IRON_ARMOR_CHAIN: fer brut + charbon + four → but = iron_armor (ensureArmor peut fondre+crafter)', () => {
  const inv = { iron_pickaxe: 1, raw_iron: 24, coal: 4, cobblestone: 12, crafting_table: 1, furnace: 1 };
  const g = firstUnmet(IRON_ARMOR_CHAIN, ctx(inv, [], 64));
  assert.strictEqual(g.name, 'iron_armor');
});

test('IRON_ARMOR_CHAIN: lingots DÉJÀ fondus (pas de smelt à faire) → pas d exigence combustible', () => {
  const inv = { iron_pickaxe: 1, iron_ingot: 24, cobblestone: 12, crafting_table: 1, furnace: 1 };
  const g = firstUnmet(IRON_ARMOR_CHAIN, ctx(inv, [], 64));
  assert.strictEqual(g.name, 'iron_armor');
});

test('IRON_ARMOR_CHAIN: armure portée → armor_fuel/cobble/furnace restent met (monotone)', () => {
  const full = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];
  assert.strictEqual(firstUnmet(IRON_ARMOR_CHAIN, ctx({}, full)), null);
});
