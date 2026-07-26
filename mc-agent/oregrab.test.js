'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { isWantedOre, canHarvest, shouldGrab, isValuableDrop } = require('./oregrab');

test('isWantedOre : fer et deepslate fer, pas le remblai', () => {
  assert.strictEqual(isWantedOre('iron_ore'), true);
  assert.strictEqual(isWantedOre('deepslate_iron_ore'), true);
  assert.strictEqual(isWantedOre('coal_ore'), true);
  assert.strictEqual(isWantedOre('diamond_ore'), true);
  assert.strictEqual(isWantedOre('stone'), false);
  assert.strictEqual(isWantedOre('dirt'), false);
  assert.strictEqual(isWantedOre(null), false);
  assert.strictEqual(isWantedOre(undefined), false);
});

test('canHarvest : aucun outil requis → toujours oui', () => {
  assert.strictEqual(canHarvest({ name: 'dirt' }, 42), true);
  assert.strictEqual(canHarvest({ name: 'dirt' }, null), true);
});

test('canHarvest : outil requis → seulement le bon (sinon on casse le fer pour RIEN)', () => {
  const ironOre = { name: 'iron_ore', harvestTools: { 274: true, 257: true } };
  assert.strictEqual(canHarvest(ironOre, 274), true);
  assert.strictEqual(canHarvest(ironOre, 257), true);
  assert.strictEqual(canHarvest(ironOre, 270), false);   // pioche en bois → 0 drop
  assert.strictEqual(canHarvest(ironOre, null), false);  // main nue
});

test('canHarvest : clés de harvestTools en chaîne (JSON) acceptées', () => {
  assert.strictEqual(canHarvest({ harvestTools: { '274': true } }, 274), true);
});

test('canHarvest : bloc absent → non', () => {
  assert.strictEqual(canHarvest(null, 274), false);
});

test('shouldGrab : au calme → oui', () => {
  assert.strictEqual(shouldGrab({ health: 20 }), true);
  assert.strictEqual(shouldGrab({}), true);
});

test('shouldGrab : jamais au détriment de la survie ni d une tâche critique', () => {
  assert.strictEqual(shouldGrab({ busy: true }), false);
  assert.strictEqual(shouldGrab({ digging: true }), false);
  assert.strictEqual(shouldGrab({ inWater: true }), false);
  assert.strictEqual(shouldGrab({ hostilesNear: true }), false);
  assert.strictEqual(shouldGrab({ health: 6 }), false);
  assert.strictEqual(shouldGrab({ health: 8 }), false);
  assert.strictEqual(shouldGrab({ health: 9 }), true);
});

// ─── VALUABLE_DROPS : ramasser ce qui SERT quand ça traîne au sol ───────────────────────────────
// Massii, live 26/07 : « si il y a des item qui leur servent (genre diamant) il doivent les
// prendre ». Un minerai miné hors de portée de ramassage auto tombe au sol et y reste.
test('isValuableDrop : les ressources qui font avancer la chaîne', () => {
  for (const n of ['diamond', 'raw_iron', 'iron_ingot', 'coal', 'emerald', 'gold_ingot', 'raw_gold', 'redstone', 'lapis_lazuli']) {
    assert.strictEqual(isValuableDrop(n), true, n + ' devrait être ramassé');
  }
});

test('isValuableDrop : on ne se détourne PAS pour du remblai ou du décor', () => {
  for (const n of ['cobblestone', 'dirt', 'gravel', 'andesite', 'oak_leaves', 'poppy', 'seeds']) {
    assert.strictEqual(isValuableDrop(n), false, n + ' ne vaut pas un détour');
  }
});

test('isValuableDrop : entrée vide/inconnue → false (jamais de détour à l aveugle)', () => {
  assert.strictEqual(isValuableDrop(''), false);
  assert.strictEqual(isValuableDrop(null), false);
  assert.strictEqual(isValuableDrop('bloc_inexistant'), false);
});
