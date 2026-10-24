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
//      remède de fond (libérer une case AVANT de crafter) est le bloc « PLACE POUR LE RÉSULTAT »
//      plus bas.
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

// ─── GRILLE 2×2 ET CURSEUR PROPRES (21/10) ────────────────────────────────────────────────────
// Mesure « zéro → armure » (NethBot2, 21/10) : `crafting_table` → `craft_no_effect` ×4 en 2,5 s puis
// retry 90 s, avec 9 planches de bouleau et 24 cases vides en poche. Rien ne manquait : le craft
// partait, le serveur ne rendait rien. Même signature qu'au 20/10 (`stick` → planches : bûches parties,
// planches nulle part) : deux crafts 2×2, juste après un craft 3×3 interrompu (table abandonnée,
// téléportation de squad, abri de nuit). Cause plausible (NON prouvée en live — le log ne voit pas la
// grille) : un objet resté sur le CURSEUR ou dans la GRILLE 2×2 du joueur (cases 1-4, invisibles de
// `inventory.items()` qui ne lit que 9-44). mineflayer pose alors ses ingrédients PAR-DESSUS : le motif
// est faux, la case résultat vide, `bot.craft` rend la main sans rien. Le serveur, lui, ne vide cette
// grille qu'à la FERMETURE de l'inventaire (paquet close_window id 0 — la touche Échap d'un joueur) ;
// mineflayer ne l'envoie jamais pour l'inventaire du joueur. D'où : (1) avant un craft, grille/curseur
// encombrés côté local → on ferme l'inventaire ; (2) après un `craft_no_effect`, même remise à zéro
// (l'état peut n'être faux que côté serveur) et UNE seconde tentative, jamais plus.
// Jamais quand une AUTRE fenêtre est ouverte (four en cours, coffre) : on ne la ferme pas sous un autre.
const GRID_RESET_SETTLE_MS = 400;   // le temps que le serveur renvoie les cases rendues

/** PUR — ce qui encombre la grille 2×2 du joueur : cases 0-4 occupées (0 = résultat) + curseur. */
function craftGridLeftovers(inventory) {
  const out = { slots: [], cursor: false };
  if (!inventory) return out;
  const s = inventory.slots;
  if (Array.isArray(s)) for (let i = 0; i <= 4; i++) if (s[i]) out.slots.push(i);
  out.cursor = !!inventory.selectedItem;
  return out;
}

/** Ferme l'inventaire du joueur (Échap) pour que le serveur rende grille et curseur. true si fait. */
async function _resetPlayerGrid(bot, sleep) {
  if (bot.currentWindow || typeof bot.closeWindow !== 'function' || !bot.inventory) return false;
  try { bot.closeWindow(bot.inventory); } catch (e) { return false; }
  await sleep(GRID_RESET_SETTLE_MS);
  return true;
}

// ─── PLACE POUR LE RÉSULTAT (19/10) ───────────────────────────────────────────────────────────
// Le remède de fond du cas n°2 ci-dessus, l'inventaire PLEIN. `putSelectedItemRange` (mineflayer)
// fusionne le résultat dans les piles NON PLEINES du même item, puis dans la 1re case vide — et sans
// l'un ni l'autre il le JETTE au sol pendant que `bot.craft` rend la main normalement. Les ouvriers
// ramassent en masse terre, gravier, granite, diorite, andésite, tuf, cobbled_deepslate, netherrack :
// une pile par roche, les 36 cases partent vite.
// AVANT de crafter, si l'inventaire n'a AUCUNE case vide ET qu'aucune pile existante du produit ne
// peut en absorber le rendement (count × résultat de la recette), on jette UNE pile de déchet. Le
// contrôle d'effet reste le juge final : s'il n'y a rien de jetable on ne jette rien, le craft se
// fait, et c'est lui qui rendra `craft_no_effect`.
// Les déchets forment une LISTE BLANCHE ordonnée : tout ce qui n'y figure pas — outils, armure,
// nourriture, bois/planches/bâtons, minerais/lingots/charbon, table, four, torches, seau, canne… —
// n'est jamais jeté, par construction (pas une liste d'exclusion qu'un nouvel item contournerait).
//   ⚠️ `quota.junkItems` n'est PAS réutilisable ici. C'est l'inverse : une liste d'EXCLUSION (« tout
//   ce qui n'est pas gardé est du déchet »), écrite pour le mode quota sous terre — elle jetterait les
//   bûches, les seaux, les cannes, le bouclier… ; elle ne garde que la PREMIÈRE pile de cobble (pas
//   32 pièces) ; et elle rend TOUT le déchet d'un coup, sans ordre, alors qu'ici il en faut UNE, la
//   plus anodine d'abord.
//   ℹ️ Recouvrement connu avec `dirt.POSABLE` (le tampon de blocs d'abri) : la terre part en premier.
//   On jette la PLUS PETITE pile du palier — la grosse reste pour sceller un toit — et la terre se
//   re-ramasse en quelques coups de pelle (cf. `needDirtBuffer` au démarrage du cartographe).
const COBBLE_KEEP = 32;   // réserve de cobble (four = 8, outils, murs de lave) : jamais en dessous
// Du plus anodin au moins anodin ; `keep` = quantité TOTALE (toutes piles) qui doit rester APRÈS le jet.
const JUNK_TIERS = [
  { names: ['dirt', 'coarse_dirt', 'rooted_dirt'], keep: 0 },
  { names: ['gravel'], keep: 0 },
  { names: ['granite', 'diorite', 'andesite', 'tuff', 'calcite'], keep: 0 },
  { names: ['netherrack'], keep: 0 },
  { names: ['cobbled_deepslate'], keep: COBBLE_KEEP },   // « au-delà de 32 », par nom
  { names: ['cobblestone'], keep: COBBLE_KEEP },
];
// Remblai : tout ce que JUNK_TIERS sait jeter sert aussi à poser (tours, abris, murs de lave).
const FILL_NAMES = new Set(JUNK_TIERS.reduce((a, t) => a.concat(t.names), []));
const FILL_KEEP = 64;     // stock de remblai qu'on préfère garder AU TOTAL (toutes roches confondues)

// Quelle pile jeter pour libérer UNE case ? Fonction PURE : `items` = [{ name, count, … }] (l'inventaire
// utile, 36 cases) → l'élément choisi (la référence, jamais une copie) ou `null` si rien n'est jetable.
// Palier le plus anodin d'abord (JUNK_TIERS) ; dans un palier, la plus PETITE pile (case libérée au
// moindre coût ; à égalité, la première rencontrée). Une pile de cobble n'est jetable que si le TOTAL
// restant après son départ garde au moins COBBLE_KEEP : sous 32 on ne touche à rien, et une pile
// unique n'est jamais jetée (il resterait 0).
// `opts.exclude` (Set ou tableau de noms) : jamais jeté (le PRODUIT du craft).
// `opts.reserve` ({ nom: quantité }) : ce que la recette CONSOMME. Avant le 23/10 les ingrédients
//   étaient exclus EN BLOC : NethBot1 (session 408) bloqué 55 min, poche pleine de 10 piles de cobble
//   (587), `stone_pickaxe` → `craft_no_effect` en boucle — le cobble, seul déchet en poche, était
//   l'ingrédient, donc intouchable, alors que la recette n'en prend que 3. Désormais une pile
//   d'ingrédient part si le reste couvre la réserve du palier PLUS ce que la recette consomme.
// REMBLAI (FILL_KEEP, 23/10) : on préfère un jet qui laisse ≥ 64 blocs de remblai AU TOTAL (toutes
//   roches confondues : tours, abris, murs de lave). Si aucun jet ne le permet, on retombe sur la
//   règle par palier — une case pour le résultat vaut mieux qu'une pioche jetée au sol par mineflayer.
function pickJunkToToss(items, opts) {
  const ex = opts && opts.exclude;
  const exclude = ex instanceof Set ? ex : new Set(Array.isArray(ex) ? ex : []);
  const rsv = (opts && opts.reserve && typeof opts.reserve === 'object') ? opts.reserve : {};
  const list = (Array.isArray(items) ? items : []).filter((it) => it && it.name && Number(it.count) > 0);
  const total = {};
  let fillTotal = 0;
  for (const it of list) {
    total[it.name] = (total[it.name] || 0) + Number(it.count);
    if (FILL_NAMES.has(it.name)) fillTotal += Number(it.count);
  }
  const pass = (fillFloor) => {
    for (const tier of JUNK_TIERS) {
      let best = null;
      for (const it of list) {
        if (!tier.names.includes(it.name) || exclude.has(it.name)) continue;
        const need = Number(rsv[it.name]) > 0 ? Number(rsv[it.name]) : 0;
        const keep = need > 0 ? Math.max(tier.keep, COBBLE_KEEP) + need : tier.keep;
        if (total[it.name] - Number(it.count) < keep) continue;           // percerait la réserve
        if (fillFloor && fillTotal - Number(it.count) < FILL_KEEP) continue;
        if (!best || Number(it.count) < Number(best.count)) best = it;
      }
      if (best) return best;
    }
    return null;
  };
  return pass(true) || pass(false);
}

// Combien de cases NEUVES faut-il pour loger `outputs` ([{ name, count, stackSize? }]) ? PUR. Chaque
// sortie complète d'abord les piles non pleines du même item (comme mineflayer), le reste prend
// ceil(reste / taille de pile) cases. Le produit ET les résidus (seau rendu, etc.) comptent.
function slotsNeededFor({ items, outputs, stackSize } = {}) {
  let slots = 0;
  const inv = Array.isArray(items) ? items : [];
  for (const o of (Array.isArray(outputs) ? outputs : [])) {
    if (!o || !o.name) continue;
    let left = Number(o.count) > 0 ? Number(o.count) : 1;
    const cap = Number(o.stackSize) > 0 ? Number(o.stackSize) : (Number(stackSize) > 0 ? Number(stackSize) : 64);
    for (const it of inv) {
      if (!it || it.name !== o.name) continue;
      const c = Number(it.stackSize) > 0 ? Number(it.stackSize) : cap;
      left -= Math.max(0, c - (Number(it.count) || 0));
    }
    if (left > 0) slots += Math.ceil(left / cap);
  }
  return slots;
}

// Faut-il faire de la place ? Fonction PURE. Oui ssi AUCUNE case n'est vide (`emptySlots === 0` ; `null`
// = nombre inconnu → on ne jette rien) ET que les piles existantes du produit ne peuvent pas en
// absorber `need` exemplaires (mineflayer complète les piles non pleines AVANT de chercher une case
// vide). `stackSize` = taille de pile par défaut quand une pile n'expose pas la sienne.
// Pessimiste à dessein : un craft qui VIDE une pile d'ingrédients libère une case que ce calcul ne
// voit pas (dernière bûche, dernier lingot) — on jette alors une pile de déchet pour rien. Le coût
// est une pile de terre ; deviner quelles piles la recette videra (mineflayer prend dans la 1re pile
// trouvée) coûterait plus cher en code que ça ne rapporte.
function needsRoomFor({ emptySlots, items, product, need, stackSize } = {}) {
  if (emptySlots !== 0) return false;
  const want = Number(need) > 0 ? Number(need) : 1;
  let room = 0;
  for (const it of (Array.isArray(items) ? items : [])) {
    if (!it || it.name !== product) continue;
    const cap = Number(it.stackSize) > 0 ? Number(it.stackSize) : (Number(stackSize) > 0 ? Number(stackSize) : 64);
    room += Math.max(0, cap - (Number(it.count) || 0));
  }
  return room < want;
}

// Cases vides de l'inventaire utile (9..44) ; `null` si le bot ne permet pas de le savoir (vieux stub).
function _emptySlots(bot) {
  try {
    const inv = bot.inventory;
    if (!inv) return null;
    if (typeof inv.emptySlotCount === 'function') {
      const n = inv.emptySlotCount();
      return Number.isFinite(n) ? n : null;
    }
    if (Array.isArray(inv.slots)) {
      let n = 0;
      for (let i = 9; i <= 44; i++) if (!inv.slots[i]) n++;
      return n;
    }
  } catch (e) { /* illisible → inconnu */ }
  return null;
}

// Ingrédients que la recette CONSOMME (delta négatif) → { nom: quantité pour `crafts` crafts }. Ils ne
// partent jamais sous ce qu'il faut à la recette (cf. pickJunkToToss / opts.reserve).
function _ingredientNeeds(bot, recipe, crafts) {
  const items = bot.registry && bot.registry.items;
  const out = {};
  if (!items || !recipe || !Array.isArray(recipe.delta)) return out;
  const k = Number(crafts) > 0 ? Number(crafts) : 1;
  for (const d of recipe.delta) {
    if (d && d.count < 0 && items[d.id] && items[d.id].name) {
      const n = items[d.id].name;
      out[n] = (out[n] || 0) + (-d.count) * k;
    }
  }
  return out;
}

// Ce que le craft DÉPOSE en poche (delta positif : le produit + les résidus), × `crafts`.
function _outputsOf(bot, recipe, crafts, product, id) {
  const items = bot.registry && bot.registry.items;
  const k = Number(crafts) > 0 ? Number(crafts) : 1;
  const out = [];
  if (items && recipe && Array.isArray(recipe.delta)) {
    for (const d of recipe.delta) {
      if (d && d.count > 0 && items[d.id] && items[d.id].name) {
        out.push({ name: items[d.id].name, count: d.count * k, stackSize: items[d.id].stackSize });
      }
    }
  }
  if (!out.some((o) => o.name === product)) {
    const perCraft = recipe && recipe.result && Number(recipe.result.count) > 0 ? Number(recipe.result.count) : 1;
    const def = items && items[id];
    out.push({ name: product, count: perCraft * k, stackSize: def && def.stackSize });
  }
  return out;
}

// Jette UNE pile visée. `tossStack` (case précise) est préféré : `toss(type, null, count)` prélève dans
// la 1re pile du type, pas forcément celle qu'on a choisie, et ne libérerait alors aucune case.
async function _tossItem(bot, item) {
  try {
    if (typeof bot.tossStack === 'function' && Number.isInteger(item.slot)) { await bot.tossStack(item); return true; }
    if (typeof bot.toss === 'function') { await bot.toss(item.type, null, item.count); return true; }
  } catch (e) { /* case bougée, assertion… : on laisse le craft se faire, le contrôle d'effet tranchera */ }
  return false;
}

// Libère les cases dont le résultat du craft a besoin (produit + résidus). Rend les NOMS des piles
// jetées (tableau, éventuellement vide : de la place, pas d'information, rien de jetable, jet impossible).
// Indépendant du combat : la case est libérée même en pleine bagarre (le craft, lui, se fait quand même —
// sans case, mineflayer jetterait la pioche au sol et le bot bouclerait sans pouvoir creuser).
async function _makeRoom(bot, id, product, recipe, crafts) {
  const emptySlots = _emptySlots(bot);
  if (emptySlots === null) return [];                   // inconnu (vieux stub) : on ne jette rien
  let items = null;
  try { items = typeof bot.inventory.items === 'function' ? bot.inventory.items() : null; } catch (e) { items = null; }
  if (!Array.isArray(items)) return [];
  const def = bot.registry && bot.registry.items && bot.registry.items[id];
  const outputs = _outputsOf(bot, recipe, crafts, product, id);
  const missing = slotsNeededFor({ items, outputs, stackSize: def && def.stackSize }) - emptySlots;
  if (missing <= 0) return [];
  const reserve = _ingredientNeeds(bot, recipe, crafts);
  const exclude = [product].concat(outputs.map((o) => o.name));
  const freed = [];
  let left = items.slice();
  for (let i = 0; i < missing; i++) {
    const junk = pickJunkToToss(left, { exclude, reserve });
    if (!junk) break;
    if (!(await _tossItem(bot, junk))) break;
    freed.push(junk.name);
    left = left.filter((x) => x !== junk);
  }
  return freed;
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
async function _homogenizePlanks(bot, id, table, sleep, freed) {
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
  const r = await craftItem(bot, { name: plan.plankName, count: plan.logs, _fixPlanks: false, _sleep: sleep, _freed: freed });
  return r.ok ? { ok: true, reason: 'crafted' } : { ok: false, reason: 'planks_craft_failed' };
}

// `_fixPlanks: false` = garde-fou anti-récursion pour le craft des planches lui-même. Il est
// redondant (la recette des planches n'en CONSOMME pas → `plankNeed` rend 0), mais deux crans
// valent mieux qu'un sur un chemin qui tourne en boucle 3 h dans le noir.
// `_sleep` = attente injectable du sondage d'effet (tests) ; défaut setTimeout. `_freed` = tableau
// qui cumule les piles jetées par la conversion de planches (récursion) et par le craft lui-même.
// Même convention « sous-tiret = réservé aux tests / à la récursion » que `_fixPlanks`.
//
// Retour : { ok:true } | { ok:false, reason } — + `freed: '<nom>'` UNIQUEMENT si une pile a été jetée
// pour faire de la place (« PLACE POUR LE RÉSULTAT » plus haut ; plusieurs piles → noms séparés par
// une virgule). craft.js n'a pas d'`emit` : l'information voyage dans le résultat, et un résultat où
// rien n'a été jeté reste octet pour octet celui d'avant (des tests le figent en deepStrictEqual).
async function craftItem(bot, { name, count = 1, _fixPlanks = true, _sleep, _freed } = {}) {
  const id = _itemId(bot, name);
  if (id == null) return { ok: false, reason: 'unknown_item' };
  const sleep = typeof _sleep === 'function' ? _sleep : _realSleep;
  const freed = Array.isArray(_freed) ? _freed : [];
  const done = (r) => (freed.length ? Object.assign({}, r, { freed: freed.join(',') }) : r);
  const table = _nearestTable(bot);
  let recipes = bot.recipesFor(id, null, 1, table) || [];
  if (!recipes.length && !table) recipes = bot.recipesFor(id, null, 1, null) || []; // recette 2x2 sans table
  if (!recipes.length) {
    if (!_fixPlanks) return { ok: false, reason: 'no_recipe' };
    const fix = await _homogenizePlanks(bot, id, table, sleep, freed);
    if (fix.ok) recipes = bot.recipesFor(id, null, 1, table) || [];
    // ⚠️ `reason` reste EXACTEMENT 'no_recipe' : `craftSmart` (index.js) teste cette chaîne pour
    // décider d'aller chercher une table. Le détail voyage à côté, dans `planks`, et seulement
    // quand le bois était en cause (sinon le résultat est identique à celui d'avant le correctif).
    if (!recipes.length) {
      const out = { ok: false, reason: 'no_recipe' };
      if (fix.reason) out.planks = fix.reason;
      return done(out);
    }
  }
  // Le produit est celui DEMANDÉ : `recipesFor(id, …)` ne rend que des recettes qui le fabriquent.
  const produced = String(name).toLowerCase();
  // De la place pour le résultat AVANT de crafter (inventaire plein → mineflayer le jetterait au sol).
  for (const tossed of await _makeRoom(bot, id, produced, recipes[0], count)) freed.push(tossed);
  // Grille 2×2 / curseur encombrés AVANT de crafter → Échap (cf. « GRILLE 2×2 ET CURSEUR PROPRES »).
  let reset = false;
  const left = craftGridLeftovers(bot.inventory);
  if (left.slots.length || left.cursor) reset = await _resetPlayerGrid(bot, sleep);
  const withReset = (r) => (reset ? Object.assign({}, r, { gridReset: true }) : r);
  const attempt = async () => {
    // Lu AVANT le craft — un stock préexistant ne doit pas passer pour un effet.
    const before = _countOf(bot, produced);
    try { await bot.craft(recipes[0], count, table || undefined); }
    catch (e) { return { ok: false, reason: 'craft_failed', err: String((e && e.message) || e).slice(0, 120) }; }
    // Inventaire illisible (vieux stub partiel) : rien à constater, contrat historique `{ok:true}`.
    if (before === null) return { ok: true };
    return (await _awaitCraftEffect(bot, produced, before, sleep))
      ? { ok: true }
      : { ok: false, reason: 'craft_no_effect' };
  };
  let r = await attempt();
  // Aucun effet : remise à zéro de la grille côté serveur puis UNE seconde tentative (jamais plus —
  // une désync qui survit à l'Échap n'est pas de ce ressort, le planner a ses propres bornes).
  if (!r.ok && r.reason === 'craft_no_effect' && await _resetPlayerGrid(bot, sleep)) {
    reset = true;
    const recipes2 = bot.recipesFor(id, null, 1, table) || [];
    if (!recipes2.length && !table) recipes2.push(...(bot.recipesFor(id, null, 1, null) || []));
    if (recipes2.length) { recipes[0] = recipes2[0]; r = await attempt(); }
  }
  return done(withReset(r));
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

module.exports = {
  craftItem, _nearestTable, tableKey, tablePlan, TABLE_REACH, TABLE_SEEK, EFFECT_POLL_MS, EFFECT_TIMEOUT_MS,
  pickJunkToToss, needsRoomFor, slotsNeededFor, COBBLE_KEEP, FILL_KEEP, FILL_NAMES, JUNK_TIERS, craftGridLeftovers, GRID_RESET_SETTLE_MS,
};
