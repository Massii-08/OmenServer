'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { craftItem } = require('../skills/craft');

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
