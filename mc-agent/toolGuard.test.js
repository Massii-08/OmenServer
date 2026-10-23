'use strict';
// OOM 23/10 — la récursion sans fin de mineflayer-tool, prouvée sur la VRAIE classe `Tool` (pas un double).
const { test } = require('node:test');
const assert = require('node:assert');
const { Tool } = require('mineflayer-tool');
const { installToolGuard, noHarvestTool, MAX_DEPTH } = require('./toolGuard');

// Bot minimal : une pioche de PIERRE, inventaire plein (aucune case libre → pas de « main nue »), et un
// compteur d'appels à inventory.items() qui lève au-delà de `cap` — c'est la SEULE façon de sortir de la
// récursion de la lib (sans lui, le test tournerait jusqu'à l'OOM, comme le bot).
function makeBot({ cap = Infinity, empty = 0 } = {}) {
  const pick = { name: 'stone_pickaxe', type: 820, count: 1, slot: 36, nbt: null };
  const state = { itemsCalls: 0 };
  const bot = {
    entity: { effects: {} },
    inventory: {
      items() {
        state.itemsCalls += 1;
        if (state.itemsCalls > cap) throw new Error('itemsCap');
        return [pick];
      },
      emptySlotCount: () => empty,
      slots: [],
    },
    getEquipmentDestSlot: () => 36,
    equip: async () => {},
    unequip: async () => {},
  };
  return { bot, state };
}
// Diamant de deepslate : récolté seulement à la pioche de FER ou mieux.
const diamond = {
  name: 'deepslate_diamond_ore',
  canHarvest: (type) => type === 821 /* iron_pickaxe */,
  digTime: () => 9000,
};
const COLLECT_OPTS = { requireHarvest: true, getFromChest: true, maxTools: 2 };   // ceux de collectblock

test('PREUVE — mineflayer-tool equipForBlock : pas d\'outil récoltant + getFromChest + aucun coffre = récursion SANS FIN qui affame les timers', async () => {
  const CAP = 20000;
  const { bot, state } = makeBot({ cap: CAP });
  const tool = new Tool(bot);                         // chestLocations = [] (jamais configuré chez nous)
  let timerFired = false;
  setTimeout(() => { timerFired = true; }, 0);
  const t0 = Date.now();
  let err = null;
  try { await tool.equipForBlock(diamond, COLLECT_OPTS); } catch (e) { err = e; }
  // Elle ne s'arrête JAMAIS d'elle-même : seule notre levée artificielle au 20 001e appel l'a sortie.
  assert.ok(err, 'equipForBlock ne rend jamais la main tout seul');
  assert.strictEqual(err.message, 'itemsCap', `sortie forcée par le compteur, pas par la lib (${err && err.message})`);
  assert.ok(state.itemsCalls > CAP, `${state.itemsCalls} niveaux de récursion`);
  // Pendant ces 20 000 niveaux, un timer à 0 ms n'a JAMAIS pu tourner : l'event loop est affamée —
  // exactement le silence des journaux (ni heap_high, ni goal_trace, ni aucun event avant l'OOM).
  assert.strictEqual(timerFired, false, 'aucun timer ne tourne pendant la récursion (microtâches seules)');
  assert.ok(Date.now() - t0 < 30000);
});

test('garde — même situation : rejet NoItem immédiat, en une passe, et les timers tournent', async () => {
  const { bot, state } = makeBot({ cap: 1000 });
  const tool = new Tool(bot);
  const capped = [];
  assert.strictEqual(installToolGuard(tool, { onCapped: (i) => capped.push(i) }), true);
  let err = null;
  try { await tool.equipForBlock(diamond, COLLECT_OPTS); } catch (e) { err = e; }
  assert.ok(err, 'rejet');
  assert.strictEqual(err.name, 'NoItem', `NoItem attendu (${err && err.name}: ${err && err.message})`);
  assert.ok(state.itemsCalls < 10, `une seule passe (${state.itemsCalls} lectures d'inventaire)`);
  assert.deepStrictEqual(capped.map((c) => c.reason), ['no_harvest_tool']);
  assert.strictEqual(capped[0].block, 'deepslate_diamond_ore');
  await new Promise((r) => setTimeout(r, 0));          // l'event loop respire
});

test('garde — outil récoltant présent : comportement de la lib inchangé (équipe, aucune coupe)', async () => {
  const { bot } = makeBot();
  const equipped = [];
  bot.equip = async (it) => { equipped.push(it.name); };
  bot.inventory.items = () => [{ name: 'iron_pickaxe', type: 821, count: 1, slot: 10, nbt: null }];
  const tool = new Tool(bot);
  const capped = [];
  installToolGuard(tool, { onCapped: (i) => capped.push(i) });
  await tool.equipForBlock(diamond, COLLECT_OPTS);
  assert.deepStrictEqual(equipped, ['iron_pickaxe']);
  assert.strictEqual(capped.length, 0);
});

test('garde — coffres configurés : on laisse la lib aller les chercher (pas de coupe)', async () => {
  const { bot } = makeBot({ cap: 50 });
  const tool = new Tool(bot);
  tool.chestLocations = [{ x: 0, y: 0, z: 0 }];
  let seenOpts = null;
  const orig = tool.equipForBlock;
  tool.equipForBlock = function (b, o) { seenOpts = o; return Promise.resolve(); };
  installToolGuard(tool);
  await tool.equipForBlock(diamond, COLLECT_OPTS);
  assert.strictEqual(seenOpts.getFromChest, true);
  tool.equipForBlock = orig;
});

test('garde — ceinture : au-delà de MAX_DEPTH appels imbriqués → NoItem', async () => {
  const tool = { bot: makeBot().bot, chestLocations: [] };
  let n = 0;
  tool.equipForBlock = async function (b, o) { n += 1; return this.equipForBlock(b, o); };   // récursion pathologique
  const capped = [];
  installToolGuard(tool, { onCapped: (i) => capped.push(i) });
  let err = null;
  try { await tool.equipForBlock(diamond, { requireHarvest: false }); } catch (e) { err = e; }
  assert.strictEqual(err && err.name, 'NoItem');
  assert.strictEqual(n, MAX_DEPTH);
  assert.ok(capped.some((c) => c.reason === 'depth'));
});

test('garde idempotente ; objet invalide → false sans throw', () => {
  const tool = new Tool(makeBot().bot);
  assert.strictEqual(installToolGuard(tool), true);
  const w = tool.equipForBlock;
  assert.strictEqual(installToolGuard(tool), true);
  assert.strictEqual(tool.equipForBlock, w);
  assert.strictEqual(installToolGuard(null), false);
  assert.strictEqual(installToolGuard({}), false);
});

test('noHarvestTool : case libre = main nue comptée ; bloc sans canHarvest = inconnu (false)', () => {
  const { bot } = makeBot({ empty: 1 });
  assert.strictEqual(noHarvestTool(bot, diamond, { requireHarvest: true }), true);     // main nue ne récolte pas le diamant
  const dirt = { name: 'dirt', canHarvest: () => true };
  assert.strictEqual(noHarvestTool(bot, dirt, { requireHarvest: true }), false);
  assert.strictEqual(noHarvestTool(bot, { name: 'x' }, { requireHarvest: true }), false);
});
