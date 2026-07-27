'use strict';
const test = require('node:test');
const assert = require('node:assert');

// ─── NE JAMAIS MINER AVEC LE MAUVAIS OUTIL (Massii, live 27/07) ────────────────────────────────
// « Quasi tous les bots tapent a mains nues ou avec des outils qui ne sont pas des pioches. »
// Deux causes : (1) `equipCached` ne fait RIEN quand aucune pioche n existe -> le bot garde
// l epee qu il avait au combat ; (2) rien ne verifiait que l outil tenu RECOLTE le bloc.
// Or en Minecraft, sans l outil requis le bloc casse et ne donne RIEN (pierre, minerais) — et
// l epee est en plus PENALISEE sur la pierre. Miner ainsi, c est du temps pur perdu.
const { canHarvestWith, HARVEST_UNKNOWN } = require('./tools');

test('recolte : la pierre exige une pioche', () => {
  assert.strictEqual(canHarvestWith('stone', 'iron_pickaxe'), true);
  assert.strictEqual(canHarvestWith('stone', 'iron_sword'), false);
  assert.strictEqual(canHarvestWith('stone', null), false);
});

test('recolte : le minerai de fer exige une pioche pierre ou mieux', () => {
  assert.strictEqual(canHarvestWith('iron_ore', 'stone_pickaxe'), true);
  assert.strictEqual(canHarvestWith('deepslate_iron_ore', 'diamond_pickaxe'), true);
  assert.strictEqual(canHarvestWith('iron_ore', 'wooden_pickaxe'), false);
  assert.strictEqual(canHarvestWith('iron_ore', 'iron_axe'), false);
});

test('recolte : le diamant exige une pioche fer ou mieux', () => {
  assert.strictEqual(canHarvestWith('diamond_ore', 'stone_pickaxe'), false);
  assert.strictEqual(canHarvestWith('diamond_ore', 'iron_pickaxe'), true);
});

test('recolte : le bois se prend meme a mains nues (juste plus lent)', () => {
  assert.strictEqual(canHarvestWith('oak_log', null), true);
  assert.strictEqual(canHarvestWith('dirt', null), true);
});

test('recolte : bloc inconnu => on n empeche RIEN (pas de blocage sur un bloc modde)', () => {
  assert.strictEqual(canHarvestWith('un_bloc_inconnu', null), HARVEST_UNKNOWN);
  assert.strictEqual(HARVEST_UNKNOWN, true);
});
