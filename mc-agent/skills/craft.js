'use strict';
// `craft <objet> [n]` : fabrique via une recette dispo (table proche si nécessaire).

function _itemId(bot, name) {
  const def = bot.registry && bot.registry.itemsByName && bot.registry.itemsByName[String(name || '').toLowerCase()];
  return def ? def.id : null;
}

// Deux rayons DISTINCTS : `bot.craft` exige la table à portée de main (TABLE_REACH), mais pour
// SAVOIR qu'une table existe et aller jusqu'à elle il faut regarder bien plus loin (TABLE_SEEK).
// Massii, 26/07 : « il fait plein de crafting alors qu'il y en a à côté, au spawn il y en a une
// vingtaine » — avec un rayon unique de 6, une table posée 10 blocs plus loin était invisible et
// le bot en reposait une par-dessus.
const TABLE_REACH = 6;    // portée de craft (bot.craft)
const TABLE_SEEK = 48;    // portée de RECHERCHE (on marche jusqu'à la table trouvée)

function _nearestTable(bot, maxDistance = TABLE_REACH) {
  const def = bot.registry && bot.registry.blocksByName && bot.registry.blocksByName.crafting_table;
  if (!def) return null;
  return bot.findBlock({ matching: [def.id], maxDistance }) || null;
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

module.exports = { craftItem, _nearestTable, TABLE_REACH, TABLE_SEEK };
