'use strict';
// `craft <objet> [n]` : fabrique via une recette dispo (table proche si nécessaire).

function _itemId(bot, name) {
  const def = bot.registry && bot.registry.itemsByName && bot.registry.itemsByName[String(name || '').toLowerCase()];
  return def ? def.id : null;
}

function _nearestTable(bot) {
  const def = bot.registry && bot.registry.blocksByName && bot.registry.blocksByName.crafting_table;
  if (!def) return null;
  return bot.findBlock({ matching: [def.id], maxDistance: 6 }) || null;
}

async function craftItem(bot, { name, count = 1 } = {}) {
  const id = _itemId(bot, name);
  if (id == null) return { ok: false, reason: 'unknown_item' };
  const table = _nearestTable(bot);
  let recipes = bot.recipesFor(id, null, 1, table) || [];
  if (!recipes.length && !table) recipes = bot.recipesFor(id, null, 1, null) || []; // recette 2x2 sans table
  if (!recipes.length) return { ok: false, reason: 'no_recipe' };
  try { await bot.craft(recipes[0], count, table || undefined); }
  catch (e) { return { ok: false, reason: 'craft_failed' }; }
  return { ok: true };
}

module.exports = { craftItem, _nearestTable };
