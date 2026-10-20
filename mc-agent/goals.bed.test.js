'use strict';
// LIT (20/10) : la réapparition hors du spawn campé — place et prédicat du but dans les chaînes.
const test = require('node:test');
const assert = require('node:assert');
const { chainFor, LUMBERJACK_CHAIN, firstUnmet } = require('./goals');

test('chaîne armure : but bed APRÈS les outils pierre et l\'épée, AVANT la descente au fer', () => {
  const names = chainFor('iron_armor').map((g) => g.name);
  assert.ok(names.includes('bed'), 'but bed absent');
  assert.ok(names.indexOf('bed') > names.indexOf('stone_pickaxe'));
  assert.ok(names.indexOf('bed') > names.indexOf('t1_sword'));
  assert.ok(names.indexOf('bed') < names.indexOf('descend_y16'));
  assert.ok(chainFor('diamond_armor').some((g) => g.name === 'bed'), 'T2 hérite du lit');
  assert.ok(LUMBERJACK_CHAIN.some((g) => g.name === 'bed'), 'le bûcheron aussi');
});

test('but bed : skill ensureBed ; à faire si mouton connu, SAUTÉ sinon ; le bois se juge par essence', () => {
  const g = chainFor('iron_armor').find((x) => x.name === 'bed');
  assert.strictEqual(g.skill, 'ensureBed');
  assert.strictEqual(g.met({ inv: { oak_log: 3 }, sheepNear: true }), false);
  assert.strictEqual(g.met({ inv: { oak_log: 3 }, sheepNear: false }), true, 'aucun mouton → on ne bloque pas');
  assert.strictEqual(g.met({ inv: { white_wool: 3, oak_planks: 3 } }), false, 'laine + 3 planches même essence');
  assert.strictEqual(g.met({ inv: { white_wool: 3, oak_planks: 2, birch_planks: 1 } }), true, '2+1 essences ne font pas un lit');
  assert.strictEqual(g.met({ inv: { white_bed: 1 } }), false, 'lit en poche → à poser');
  assert.strictEqual(g.met({ inv: { white_bed: 1 }, bedPlaced: true }), true);
  assert.strictEqual(g.met({ inv: {}, sheepNear: true, bedRetryLater: true }), true, 'raté récemment → plus tard');
});

test('chaîne armure : un bot équipé fer n\'est PAS dispensé de lit', () => {
  const g = chainFor('iron_armor').find((x) => x.name === 'bed');
  const worn = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];
  assert.strictEqual(g.met({ inv: { oak_log: 3 }, worn, sheepNear: true }), false);
});

test('bûcheron : le lit passe après SES pièces, avant l\'armure cartographe ; sans mouton la chaîne historique est intacte', () => {
  const base = { inv: { oak_log: 5 }, woodRequest: null, ljOwnArmor: null, mapperTarget: 'MapBot2', giftReady: false };
  assert.strictEqual(firstUnmet(LUMBERJACK_CHAIN, Object.assign({}, base, { sheepNear: true })).name, 'bed');
  assert.strictEqual(firstUnmet(LUMBERJACK_CHAIN, base).name, 'gift_craft');
});
