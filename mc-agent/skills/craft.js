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

// Clé d'une table dans la LISTE NOIRE des tables inutilisables (cf. `_nearestTable` / `exclude`) :
// les coordonnées ENTIÈRES du bloc, « x,y,z ». `Math.floor` (pas `|0`, qui tronque vers zéro :
// -2.1 donnerait -2 au lieu du bloc -3), et surtout pas `Vec3.toString()` — son format « (x, y, z) »
// n'est pas un contrat de la lib. Une position fractionnaire désigne le bloc qui la contient.
function tableKey(pos) {
  return Math.floor(pos.x) + ',' + Math.floor(pos.y) + ',' + Math.floor(pos.z);
}

// Table de craft la plus proche dans `maxDistance`.
//
// `opts.exclude` = LISTE NOIRE de tables INUTILISABLES : tout objet exposant `has(clé)` (clé =
// `tableKey`) — en pratique un `createExpiringSet`. Run du 17-18/08 (216 sessions) :
// `reclaim_failed` ×11 565 et `table_recycled` ×11 440, quasi 1:1. Une table INATTEIGNABLE (dans le
// tunnel d'un autre, derrière un mur, au-dessus d'un vide) était re-vue à CHAQUE craft : marche de
// 30 s, reprise ratée, table neuve semée — puis rebelote au craft suivant, à l'infini.
//
// Sans `exclude`, le chemin est EXACTEMENT l'historique (un seul `findBlock` — des tests figent la
// forme de l'appel, et le `hasTable` du contexte planner passe aussi par là). Avec, `findBlock` ne
// suffit plus : il ne rend que la PLUS PROCHE, donc si c'est justement la table interdite on reste
// aveugle à toutes les autres. On demande plusieurs candidates (`findBlocks`, count 16 : ça borne
// le coût du scan), on les TRIE nous-mêmes par distance au bot (l'ordre rendu par la lib n'est pas
// un contrat) et on prend la 1re non exclue. `null` si toutes le sont — y compris le cas limite où
// les 16 plus proches sont noires : le bot en pose alors une neuve, qu'il reprend ensuite.
function _nearestTable(bot, maxDistance = TABLE_REACH, opts = {}) {
  const def = bot.registry && bot.registry.blocksByName && bot.registry.blocksByName.crafting_table;
  if (!def) return null;
  const exclude = opts && opts.exclude;
  if (!exclude) return bot.findBlock({ matching: [def.id], maxDistance }) || null;

  const found = bot.findBlocks({ matching: [def.id], maxDistance, count: 16 }) || [];
  const from = bot.entity && bot.entity.position;
  // Distance² maison : les positions rendues peuvent être des Vec3 OU des objets nus (stubs).
  // Sans position du bot on garde l'ordre de la lib (qui trie déjà par distance, mais sans le garantir).
  const d2 = (p) => (p.x - from.x) ** 2 + (p.y - from.y) ** 2 + (p.z - from.z) ** 2;
  const ordered = from ? found.slice().sort((a, b) => d2(a) - d2(b)) : found;
  for (const pos of ordered) {
    if (exclude.has(tableKey(pos))) continue;
    const block = bot.blockAt(pos);
    if (block) return block;      // chunk évaporé entre deux appels → blockAt nul → candidate suivante
  }
  return null;
}

function _invMap(bot) {
  const out = {};
  for (const it of (((bot.inventory && bot.inventory.items()) || []))) {
    if (it && it.name) out[it.name] = (out[it.name] || 0) + (it.count || 0);
  }
  return out;
}

// ─── EFFET DU CRAFT (19/10) ───────────────────────────────────────────────────────────────────
// NethBot2, mesuré en live : juste après une téléportation, `goal planks` émis 111× en 2,2 s (un
// toutes les ~20 ms), AUCUN `goal_failed`, puis le serveur expulse le bot (flood de paquets : chaque
// tour envoyait un craft). `craftItem` rendait `{ok:true}` dès que `bot.craft` ne levait pas — or
// `bot.craft` ne lève que sur une erreur CLIENT (ingrédient absent de l'inventaire local, table
// requise mais non fournie) : un craft que le SERVEUR ignore (fenêtre périmée, état désynchronisé
// après un tp) « réussit » en silence, et le planner relance le même but à l'infini.
// Deux façons connues (lues dans mineflayer) d'obtenir « craft réussi, produit absent » :
//   1. le serveur ignore les clics (fenêtre périmée, état désynchronisé après un tp) ;
//   2. l'inventaire est PLEIN : `putSelectedItemRange` n'a ni case vide ni pile à compléter et JETTE
//      le résultat au sol (« no room => drop it ») — `bot.craft` rend la main normalement, les
//      ingrédients sont consommés, le produit est par terre. Un worker qui hoarde bûches + pierres
//      (une pile par roche : deepslate, tuff, diorite…) y arrive vite. Piste probable de l'incident
//      ci-dessus, NON confirmée en live : dans ce cas `craft_no_effect` est le bon verdict, et le
//      remède de fond (libérer une case avant de crafter) reste à faire en amont.
// On exige donc de VOIR le produit arriver : la quantité en inventaire doit AUGMENTER par rapport à
// l'avant-craft. Sondage toutes les 50 ms, 600 ms au plus — de quoi absorber un inventaire local en
// retard sans geler le planner plus d'une demi-seconde par tour. Sinon `craft_no_effect`, qui sort
// par le chemin des échecs explicites ({ok:false} → failStreak 4× → stalled) au lieu de tourner.
//   ⚠️ Cette raison est volontairement DISTINCTE de 'no_recipe' / 'craft_failed' : `craftSmart`
//   (index.js) teste ces deux chaînes EXACTES pour décider d'aller chercher une table de craft 3×3.
//   Une désync n'est pas une recette 3×3 manquante — poser une table n'y changerait rien.
const EFFECT_POLL_MS = 50;       // pas du sondage
const EFFECT_TIMEOUT_MS = 600;   // au-delà : craft_no_effect

const _realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Quantité de `itemName` en inventaire (somme des piles) ; `null` si l'inventaire est illisible
// (vieux stub sans `inventory.items`, ou qui lève) — l'appelant ne peut alors RIEN vérifier.
function _countOf(bot, itemName) {
  try {
    const list = bot.inventory && typeof bot.inventory.items === 'function' ? bot.inventory.items() : null;
    if (!Array.isArray(list)) return null;
    let n = 0;
    for (const it of list) if (it && it.name === itemName) n += (it.count || 0);
    return n;
  } catch (e) { return null; }
}

// Attend de voir `itemName` dépasser `before` en inventaire. La 1re lecture a lieu SANS attendre :
// d'après le code de mineflayer, quand il y a de la place le résultat est déjà déposé dans
// l'inventaire local quand `bot.craft` rend la main (grabResult → putAway ; pour une table,
// copyInventory à la fermeture de la fenêtre) — le chemin normal ne coûte donc rien, et aucune
// autre tâche n'a pu s'intercaler entre la fin du craft et cette lecture (un équipement concurrent
// ne peut pas fausser le constat). Les attentes ne servent qu'au cas où l'inventaire local serait
// en retard sur le serveur.
async function _awaitCraftEffect(bot, itemName, before, sleep) {
  for (let waited = 0; ; waited += EFFECT_POLL_MS) {
    const now = _countOf(bot, itemName);
    if (now === null || now > before) return true;     // null : devenu illisible en route → on ne bloque pas
    if (waited >= EFFECT_TIMEOUT_MS) return false;
    await sleep(EFFECT_POLL_MS);
  }
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
async function _homogenizePlanks(bot, id, table, sleep) {
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
  const r = await craftItem(bot, { name: plan.plankName, count: plan.logs, _fixPlanks: false, _sleep: sleep });
  return r.ok ? { ok: true, reason: 'crafted' } : { ok: false, reason: 'planks_craft_failed' };
}

// `_fixPlanks: false` = garde-fou anti-récursion pour le craft des planches lui-même. Il est
// redondant (la recette des planches n'en CONSOMME pas → `plankNeed` rend 0), mais deux crans
// valent mieux qu'un sur un chemin qui tourne en boucle 3 h dans le noir.
// `_sleep` = attente injectable du sondage d'effet (tests) ; défaut setTimeout. Même convention
// « sous-tiret = réservé aux tests / à la récursion » que `_fixPlanks`.
async function craftItem(bot, { name, count = 1, _fixPlanks = true, _sleep } = {}) {
  const id = _itemId(bot, name);
  if (id == null) return { ok: false, reason: 'unknown_item' };
  const sleep = typeof _sleep === 'function' ? _sleep : _realSleep;
  const table = _nearestTable(bot);
  let recipes = bot.recipesFor(id, null, 1, table) || [];
  if (!recipes.length && !table) recipes = bot.recipesFor(id, null, 1, null) || []; // recette 2x2 sans table
  if (!recipes.length) {
    if (!_fixPlanks) return { ok: false, reason: 'no_recipe' };
    const fix = await _homogenizePlanks(bot, id, table, sleep);
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
  // Le produit est celui DEMANDÉ : `recipesFor(id, …)` ne rend que des recettes qui le fabriquent.
  // Lu AVANT le craft — un stock préexistant ne doit pas passer pour un effet.
  const produced = String(name).toLowerCase();
  const before = _countOf(bot, produced);
  try { await bot.craft(recipes[0], count, table || undefined); }
  catch (e) { return { ok: false, reason: 'craft_failed' }; }
  // Inventaire illisible (vieux stub partiel) : rien à constater, contrat historique `{ok:true}`.
  if (before === null) return { ok: true };
  return (await _awaitCraftEffect(bot, produced, before, sleep))
    ? { ok: true }
    : { ok: false, reason: 'craft_no_effect' };
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

module.exports = { craftItem, _nearestTable, tableKey, tablePlan, TABLE_REACH, TABLE_SEEK, EFFECT_POLL_MS, EFFECT_TIMEOUT_MS };
