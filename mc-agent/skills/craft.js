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

// Décision PURE : que faire quand un craft 3×3 a échoué ?
// Massii, 26/07 (2e retour, photo à l'appui) : « il continue à spam les craft » — des traînées de
// tables sur tout le parcours des bots. Mécanisme mesuré : le bot marchait jusqu'à une table
// existante, le craft échouait quand même (matériaux manquants, PAS la table), et il retombait
// dans la branche « fabrique + pose une table neuve » — juste à côté de celle sur laquelle il se
// tenait. Une table semée par craft raté. S'ajoutaient les tables ABANDONNÉES quand une mort
// (difficulté hard) ou un timeout coupait le cycle avant la reprise.
//   - 'use_existing'     : une table est DÉJÀ à portée de craft → en poser une 2e ne peut rien
//                          changer, l'échec vient d'ailleurs. On ne jonche pas.
//   - 'recycle'          : une table posée est en vue → aller la REPRENDRE plutôt que d'en
//                          fabriquer une neuve (le terrain se nettoie au lieu de se joncher).
//   - 'place'            : table en poche → la poser.
//   - 'craft_then_place' : dernier recours, fabriquer puis poser.
function tablePlan({ tableInReach = false, tableSeen = false, hasTableItem = false } = {}) {
  if (tableInReach) return 'use_existing';
  if (hasTableItem) return 'place';
  if (tableSeen) return 'recycle';
  return 'craft_then_place';
}

module.exports = { craftItem, _nearestTable, tablePlan, TABLE_REACH, TABLE_SEEK };
