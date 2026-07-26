'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { craftItem, tablePlan } = require('../skills/craft');

function makeBot({ hasRecipe = true } = {}) {
  const calls = { craft: 0 };
  return {
    calls,
    registry: { itemsByName: { chest: { id: 54 } }, blocksByName: { crafting_table: { id: 58 } } },
    findBlock: () => null,
    recipesFor: () => (hasRecipe ? [{ id: 1 }] : []),
    craft: async () => { calls.craft++; },
  };
}

test('craft: objet inconnu → unknown_item', async () => {
  const r = await craftItem(makeBot(), { name: 'zzz', count: 1 });
  assert.deepStrictEqual(r, { ok: false, reason: 'unknown_item' });
});

test('craft: pas de recette → no_recipe', async () => {
  const r = await craftItem(makeBot({ hasRecipe: false }), { name: 'chest', count: 1 });
  assert.deepStrictEqual(r, { ok: false, reason: 'no_recipe' });
});

test('craft: succès', async () => {
  const bot = makeBot();
  const r = await craftItem(bot, { name: 'chest', count: 1 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(bot.calls.craft, 1);
});

// --- tablePlan : anti-semis de tables de craft (retour Massii 26/07, photo) -------------------
test('tablePlan: table DEJA a portee → on ne pose rien (bug du semis)', () => {
  assert.strictEqual(tablePlan({ tableInReach: true, tableSeen: true, hasTableItem: true }), 'use_existing');
  // même avec une table en poche : l'échec vient des matériaux, pas de la table
  assert.strictEqual(tablePlan({ tableInReach: true, hasTableItem: false }), 'use_existing');
});

test('tablePlan: table en poche et rien a portee → on pose la sienne', () => {
  assert.strictEqual(tablePlan({ tableInReach: false, tableSeen: false, hasTableItem: true }), 'place');
});

test('tablePlan: table ABANDONNEE en vue et poche vide → on la recycle', () => {
  assert.strictEqual(tablePlan({ tableInReach: false, tableSeen: true, hasTableItem: false }), 'recycle');
});

test('tablePlan: rien nulle part → fabriquer puis poser', () => {
  assert.strictEqual(tablePlan({}), 'craft_then_place');
});
