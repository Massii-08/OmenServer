'use strict';
// PLANCHES — décision PURE : quelles bûches convertir pour qu'UNE essence atteigne le compte.
//
// ─── LE MÉCANISME (run world_mn14 : 235 `craft_failed:table_present` + 5 `no_recipe` en 3 h) ───
// minecraft-data ne connaît AUCUNE recette « n'importe quelles planches ». Le bouclier a 12
// recettes CONCRÈTES, une par essence, chacune exigeant 6 planches d'UNE SEULE essence
// (delta mesuré : `pale_oak_planks:-6, iron_ingot:-1`). Idem bâtons (2), table de craft (4),
// pioche bois (3), bateaux… `bot.recipesFor` filtre chaque recette via
// `bot.inventory.count(d.id) + d.count < 0` : avec 3 oak + 3 birch, AUCUNE des 12 ne passe →
// il rend `[]`. Le bot avait pourtant 6 planches — `anyPlanks` (goals.js) les additionne toutes
// essences confondues et jugeait le but faisable. Le craft ne pouvait PAS aboutir : boucle.
//
// La conversion bûche → planches est le seul remède, et elle est gratuite en valeur : le bois
// « équivalent planches » du buffer (goals.js `plank_buffer` : `anyPlanks + anyLog*4 >= 24`) est
// inchangé, et une planche vaut MIEUX qu'une bûche au four (smelt.js `logsToConvert` : 6 fontes
// contre 1,5). Le SEUL usage qui exige des bûches BRUTES est le charbon de bois
// (`smeltCharcoalGoal`, index.js : il lui faut `count + 1` bûches, l'input plus une de combustible)
// → d'où la réserve de 2 bûches ci-dessous, la seule qu'on ne touche jamais.
//
// ⚠️ SOURCES VOLONTAIREMENT RESTREINTES à `_log` et `_stem`. `oak_wood`, `stripped_oak_log`…
// EXISTENT comme items mais minecraft-data 1.21.4 ne porte QU'UNE recette par essence
// (`oak_log → oak_planks`, `crimson_stem → crimson_planks`) : proposer une source non
// craftable ferait promettre au prédicat de goals.js un craft que la skill ne sait pas exécuter
// — exactement la classe de bug qui fait boucler (le prédicat et la skill DOIVENT être d'accord).
// Conservateur par choix : une essence non convertible est déclarée impossible, jamais tentée.

const PLANKS_PER_LOG = 4;      // 1 bûche → 4 planches (miroir de smelt.PLANKS_PER_LOG)
const LOG_RESERVE = 2;         // bûches intouchables : l'input du charbon de bois (index.js)
const LOG_SUFFIXES = ['_log', '_stem'];

// ⚠️ `mushroom_stem` finit par `_stem` et n'est PAS du bois : `mushroom_planks` n'existe pas.
// Sans cette exclusion, `plankable` (goals.js) déclarerait le bouclier faisable à un bot qui
// ramasse un champignon géant, le craft échouerait, et le but se retenterait à l'infini — la
// boucle même qu'on est en train de fermer. Balayage du registre 1.21.4 : c'est le SEUL item
// en `_log`/`_stem` qui n'ouvre sur aucune essence (les 12 vraies essences sont toutes couvertes
// par les recettes bouclier / table / bâtons / pioche bois).
const NOT_WOOD = new Set(['mushroom_stem']);

function _plankBase(name) {
  return name.endsWith('_planks') ? name.slice(0, -'_planks'.length) : null;
}

// `oak_log` → `oak`, `crimson_stem` → `crimson`. Les variantes écorcées/wood sont IGNORÉES
// (aucune recette dans minecraft-data — cf. bandeau).
function _logBase(name) {
  if (name.startsWith('stripped_') || NOT_WOOD.has(name)) return null;
  for (const s of LOG_SUFFIXES) if (name.endsWith(s)) return name.slice(0, -s.length);
  return null;
}

/**
 * PUR — quelles bûches convertir pour qu'UNE essence atteigne `needed` planches ?
 *
 * @param {Object} inventory  noms → comptes ({ oak_planks: 3, birch_planks: 3, oak_log: 30 })
 * @param {number} needed     planches d'UNE MÊME essence exigées par la recette (6 pour le bouclier)
 * @param {Object} [opts]
 * @param {number} [opts.logReserve=LOG_RESERVE] bûches à ne jamais consommer (charbon de bois)
 * @param {number} [opts.perLog=PLANKS_PER_LOG]  planches rendues par bûche
 * @returns {{action:'none'}                                              une essence a déjà le compte
 *          |{action:'craft_planks', plankName, logName, logs, perLog}    convertir puis crafter
 *          |{action:'impossible', reason:'no_logs'|'reserve'}}           échec PROPRE, jamais de boucle
 */
function planksPlan(inventory, needed, opts) {
  const inv = inventory || {};
  const o = opts || {};
  const logReserve = o.logReserve === undefined ? LOG_RESERVE : o.logReserve;
  const perLog = o.perLog === undefined ? PLANKS_PER_LOG : o.perLog;
  const want = Math.max(0, Number(needed) || 0);
  if (want === 0) return { action: 'none' };
  if (!(perLog > 0)) return { action: 'impossible', reason: 'no_logs' };

  const planks = {};                 // essence → planches en poche
  const logs = [];                   // [{ name, base, count }]
  let totalLogs = 0;
  for (const name of Object.keys(inv)) {
    const c = inv[name] || 0;
    if (!(c > 0)) continue;
    const pb = _plankBase(name);
    if (pb) { planks[pb] = (planks[pb] || 0) + c; continue; }
    const lb = _logBase(name);
    if (lb) { logs.push({ name, base: lb, count: c }); totalLogs += c; }
  }

  // Une essence tient déjà le compte : la recette concrète existe, rien à convertir.
  for (const b of Object.keys(planks)) if (planks[b] >= want) return { action: 'none' };

  // On convertit depuis UN SEUL nom de bûche (un craft = une recette répétée N fois).
  let best = null;
  let blockedByReserve = false;
  for (const l of logs) {
    const toCraft = Math.ceil((want - (planks[l.base] || 0)) / perLog);
    if (toCraft > l.count) continue;                       // pas assez de bûches de cette essence
    if (totalLogs - toCraft < logReserve) { blockedByReserve = true; continue; }
    const cand = { action: 'craft_planks', plankName: l.base + '_planks', logName: l.name, logs: toCraft, perLog };
    // Déterministe (les 5 ouvriers doivent décider pareil) : le moins de bûches, puis l'ordre alpha.
    if (!best || cand.logs < best.logs || (cand.logs === best.logs && cand.plankName < best.plankName)) best = cand;
  }
  if (best) return best;
  return { action: 'impossible', reason: blockedByReserve ? 'reserve' : 'no_logs' };
}

/**
 * PUR — combien de planches d'UNE MÊME essence cette recette exige-t-elle, les AUTRES
 * ingrédients étant déjà en poche ?
 *
 * Le `delta` de prismarine-recipe agrège les ingrédients (count < 0) et le résultat (count > 0).
 * On ne rend un besoin QUE si les planches sont le seul ingrédient manquant : si le lingot de fer
 * manque aussi, convertir du bois ne débloquerait rien (on ne brûle pas de bûches pour rien).
 *
 * @param {Array<{name,count}>} delta  delta de la recette, ids déjà résolus en noms
 * @param {Object} inventory           noms → comptes
 * @returns {number} planches requises, ou 0 si la recette n'en consomme pas / si autre chose manque
 */
function plankNeed(delta, inventory) {
  const inv = inventory || {};
  let need = 0;
  let plankIngredients = 0;
  for (const d of (delta || [])) {
    if (!d || !d.name || !(d.count < 0)) continue;
    const want = -d.count;
    if (d.name.endsWith('_planks')) { need = want; plankIngredients += 1; continue; }
    if ((inv[d.name] || 0) < want) return 0;              // un AUTRE ingrédient manque
  }
  return plankIngredients === 1 ? need : 0;
}

module.exports = { planksPlan, plankNeed, PLANKS_PER_LOG, LOG_RESERVE };
