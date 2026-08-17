'use strict';
// `craft <objet> [n]` : fabrique via une recette dispo (table proche si nécessaire).

const { planksPlan, plankNeed } = require('../planks');

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

function _invMap(bot) {
  const out = {};
  for (const it of (((bot.inventory && bot.inventory.items()) || []))) {
    if (it && it.name) out[it.name] = (out[it.name] || 0) + (it.count || 0);
  }
  return out;
}

// PLANCHES HÉTÉROGÈNES — le blocage du bouclier (world_mn14 : 235 `craft_failed:table_present`,
// 5 `no_recipe`, 0 succès en 3 h alors que 3 boucliers étaient sortis plus tôt dans le run).
//
// minecraft-data n'a AUCUNE recette « n'importe quelles planches » : le bouclier en a 12, une par
// essence, chacune exigeant 6 planches de CETTE essence (`recipesFor` filtre essence par essence
// via `bot.inventory.count`). Avec 3 oak + 3 birch il rend `[]` → `no_recipe`. Ce n'est donc PAS
// `bot.craft` qui levait : le libellé `craft_failed:table_present` vient de `withCraftingTable`
// (index.js), qui l'appose dès qu'une table est à portée QUEL QUE SOIT l'échec interne — et une
// table l'était toujours, le terrain en est jonché. Les 5 `no_recipe` bruts sont les rares fois
// où aucune table n'était en vue et où le bot a posé la sienne : la vraie raison affleurait alors.
//
// Remède : convertir des bûches (30 à 240 en poche pendant tout le run) pour qu'UNE essence
// atteigne le compte. Générique — bouclier, table, bâtons, pioche bois, tout ce qui prend des
// planches en profite, aucun cas particulier. Borné : une passe, jamais de nouvelle tentative.
//
// `reason` n'est renseigné QUE quand le bois était réellement en cause : sur tous les autres
// chemins le retour de craftItem reste octet pour octet celui d'avant (des tests le figent en
// deepStrictEqual, et un champ surprise dans un résultat d'échec est une dette, pas un service).
async function _homogenizePlanks(bot, id, table) {
  // Vieux stub / bot partiel : on ne tente rien plutôt que de planter (contrat inchangé).
  if (typeof bot.recipesAll !== 'function') return { ok: false };
  const items = bot.registry && bot.registry.items;
  if (!items) return { ok: false };

  const inv = _invMap(bot);
  // Le besoin se LIT dans les recettes (delta prismarine-recipe), il n'est jamais codé en dur :
  // 6 bouclier / 4 table / 3 pioche / 2 bâtons sortent tous du même chemin.
  let need = 0;
  for (const r of ((bot.recipesAll(id, null, table) || []))) {
    const delta = (((r && r.delta) || [])).map((d) => ({ name: (items[d.id] || {}).name, count: d.count }));
    const n = plankNeed(delta, inv);
    if (n > 0 && (need === 0 || n < need)) need = n;
  }
  // Aucune recette ne bute sur les planches (autre ingrédient manquant, table absente pour un
  // 3×3, recette sans bois…) → on ne brûle pas de bûches pour rien.
  if (!need) return { ok: false };

  const plan = planksPlan(inv, need);
  if (plan.action === 'none') return { ok: false };                          // l'échec vient d'ailleurs
  if (plan.action !== 'craft_planks') return { ok: false, reason: plan.reason };
  const r = await craftItem(bot, { name: plan.plankName, count: plan.logs, _fixPlanks: false });
  return r.ok ? { ok: true, reason: 'crafted' } : { ok: false, reason: 'planks_craft_failed' };
}

// `_fixPlanks: false` = garde-fou anti-récursion pour le craft des planches lui-même. Il est
// redondant (la recette des planches n'en CONSOMME pas → `plankNeed` rend 0), mais deux crans
// valent mieux qu'un sur un chemin qui tourne en boucle 3 h dans le noir.
async function craftItem(bot, { name, count = 1, _fixPlanks = true } = {}) {
  const id = _itemId(bot, name);
  if (id == null) return { ok: false, reason: 'unknown_item' };
  const table = _nearestTable(bot);
  let recipes = bot.recipesFor(id, null, 1, table) || [];
  if (!recipes.length && !table) recipes = bot.recipesFor(id, null, 1, null) || []; // recette 2x2 sans table
  if (!recipes.length) {
    if (!_fixPlanks) return { ok: false, reason: 'no_recipe' };
    const fix = await _homogenizePlanks(bot, id, table);
    if (fix.ok) recipes = bot.recipesFor(id, null, 1, table) || [];
    // ⚠️ `reason` reste EXACTEMENT 'no_recipe' : `craftSmart` (index.js) teste cette chaîne pour
    // décider d'aller chercher une table. Le détail voyage à côté, dans `planks`, et seulement
    // quand le bois était en cause (sinon le résultat est identique à celui d'avant le correctif).
    if (!recipes.length) {
      const out = { ok: false, reason: 'no_recipe' };
      if (fix.reason) out.planks = fix.reason;
      return out;
    }
  }
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
