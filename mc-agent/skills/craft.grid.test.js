'use strict';
// GRILLE 2×2 / CURSEUR (21/10, mesure « zéro → armure », NethBot2 : `crafting_table` craft_no_effect ×4
// en 2,5 s avec 9 planches de bouleau et 24 cases vides). Remède : Échap (close_window 0) avant un
// craft si la grille locale est encombrée, et après un no_effect, puis UNE seconde tentative.
const { test } = require('node:test');
const assert = require('node:assert');
const { craftItem, craftGridLeftovers, GRID_RESET_SETTLE_MS } = require('./craft');
const registry = require('prismarine-registry')('1.21.4');
const { Recipe } = require('prismarine-recipe')(registry);

// Même bot que craft.test.js (vraies recettes, mécanique recipesFor/craft de mineflayer), sans table.
function craftBot(inv) {
  const counts = Object.assign({}, inv);
  const bot = {
    registry, counts,
    inventory: {
      items: () => Object.keys(counts).filter((n) => counts[n] > 0)
        .map((name, i) => ({ name, count: counts[name], type: registry.itemsByName[name].id, slot: 9 + i })),
      count: (id) => { const d = registry.items[id]; return d ? (counts[d.name] || 0) : 0; },
    },
    findBlock: () => null,
    recipesFor(itemType, metadata, minResultCount, craftingTable) {
      const min = minResultCount == null ? 1 : minResultCount;
      return Recipe.find(itemType, metadata).filter((r) => {
        if (r.requiresTable && !craftingTable) return false;
        const craftCount = Math.ceil(min / r.result.count);
        for (const d of r.delta) if (bot.inventory.count(d.id) + d.count * craftCount < 0) return false;
        return true;
      });
    },
    recipesAll(itemType, metadata, craftingTable) {
      return Recipe.find(itemType, metadata).filter((r) => !r.requiresTable || craftingTable);
    },
    async craft(recipe, count) {
      for (let i = 0; i < (count == null ? 1 : count); i++) {
        for (const d of recipe.delta) {
          const name = registry.items[d.id].name;
          const next = (counts[name] || 0) + d.count;
          if (next < 0) throw new Error('missing ingredient');
          counts[name] = next;
        }
      }
    },
  };
  return bot;
}
function fakeSleep() { const log = []; const fn = async (ms) => { log.push(ms); }; fn.log = log; return fn; }

test('craftGridLeftovers : cases 0-4 occupées + curseur ; rien sans slots', () => {
  const slots = new Array(46).fill(null);
  slots[2] = { name: 'birch_planks', count: 1 };
  slots[9] = { name: 'dirt', count: 3 };                       // inventaire utile : ignoré
  assert.deepStrictEqual(craftGridLeftovers({ slots, selectedItem: { name: 'cobblestone' } }), { slots: [2], cursor: true });
  assert.deepStrictEqual(craftGridLeftovers({ items: () => [] }), { slots: [], cursor: false });
  assert.deepStrictEqual(craftGridLeftovers(null), { slots: [], cursor: false });
});

test('no_effect puis Échap → 2e tentative qui produit → {ok:true, gridReset:true}', async () => {
  const bot = craftBot({ birch_planks: 9 });
  const real = bot.craft;
  let calls = 0;
  const closed = [];
  bot.closeWindow = (w) => { closed.push(w); };
  bot.craft = async (...a) => { calls++; if (calls === 1) return; return real(...a); };   // 1er : ignoré du serveur
  const sleep = fakeSleep();
  const r = await craftItem(bot, { name: 'crafting_table', count: 1, _sleep: sleep });
  assert.deepStrictEqual(r, { ok: true, gridReset: true });
  assert.strictEqual(calls, 2);
  assert.deepStrictEqual(closed, [bot.inventory], 'on ferme l\'inventaire du JOUEUR, rien d\'autre');
  assert.ok(sleep.log.includes(GRID_RESET_SETTLE_MS));
  assert.strictEqual(bot.counts.crafting_table, 1);
});

test('no_effect persistant : UNE seule seconde tentative, raison craft_no_effect conservée', async () => {
  const bot = craftBot({ birch_planks: 9 });
  let calls = 0;
  bot.closeWindow = () => {};
  bot.craft = async () => { calls++; };
  const r = await craftItem(bot, { name: 'crafting_table', count: 1, _sleep: fakeSleep() });
  assert.deepStrictEqual(r, { ok: false, reason: 'craft_no_effect', gridReset: true });
  assert.strictEqual(calls, 2);
});

test('une AUTRE fenêtre ouverte (four) : on ne la ferme pas, pas de 2e tentative', async () => {
  const bot = craftBot({ birch_planks: 9 });
  let calls = 0; let closed = 0;
  bot.currentWindow = { id: 3, type: 'minecraft:furnace' };
  bot.closeWindow = () => { closed++; };
  bot.craft = async () => { calls++; };
  const r = await craftItem(bot, { name: 'crafting_table', count: 1, _sleep: fakeSleep() });
  assert.deepStrictEqual(r, { ok: false, reason: 'craft_no_effect' });
  assert.strictEqual(calls, 1);
  assert.strictEqual(closed, 0);
});

test('grille encombrée côté local AVANT le craft → Échap d\'abord, puis craft normal (un seul)', async () => {
  const bot = craftBot({ birch_planks: 9 });
  const order = [];
  bot.inventory.slots = new Array(46).fill(null);
  bot.inventory.slots[1] = { name: 'birch_planks', count: 1 };
  bot.closeWindow = () => { order.push('close'); bot.inventory.slots[1] = null; };
  const real = bot.craft;
  bot.craft = async (...a) => { order.push('craft'); return real(...a); };
  const r = await craftItem(bot, { name: 'crafting_table', count: 1, _sleep: fakeSleep() });
  assert.deepStrictEqual(r, { ok: true, gridReset: true });
  assert.deepStrictEqual(order, ['close', 'craft']);
});

test('grille propre et craft qui produit : résultat EXACT d\'avant (aucun Échap)', async () => {
  const bot = craftBot({ birch_planks: 9 });
  let closed = 0;
  bot.inventory.slots = new Array(46).fill(null);
  bot.closeWindow = () => { closed++; };
  assert.deepStrictEqual(await craftItem(bot, { name: 'crafting_table', count: 1, _sleep: fakeSleep() }), { ok: true });
  assert.strictEqual(closed, 0);
});
