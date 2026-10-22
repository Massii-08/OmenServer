'use strict';
// NOURRITURE : COMPTER EN POINTS DE FAIM, BORNER LE TEMPS.
//
// Massii, 19/10 : « L'important c'est la VITESSE : pas de choix qui font trop durer. Et dans le pire
// des cas, il y a la viande de zombie. »
//
// Mesure live (monde neuf, 13 min) : les bots progressaient vite (outils pierre, four, deux ouvriers
// déjà au fer) MAIS la nourriture leur faisait perdre du temps, pour deux raisons liées.
//   1. ON COMPTAIT MAL. Seule la viande CUITE comptait comme réserve (`cookedCount >= 4`). Un bot avec
//      10 chairs putréfiées ou de la viande crue repartait chasser — alors que le réflexe de faim
//      (reflexes.tryEat) les mange déjà, le cuit d'abord, la détresse ensuite. Manger n'était pas le
//      problème : COMPTER l'était. Une seule mesure désormais : les POINTS de faim vanilla.
//   2. ON NE BORNAIT PAS LE TEMPS. Une sortie « nourriture » = balayage de butin 20 s + remontée
//      /home safe 90 s + 3 vagues de chasse de 120 s + cuisson + pêche jusqu'à 300 s (×2 avec le
//      trajet vers l'eau connue) : ~6 minutes d'un bot qui ne travaille pas. Pire : `withTimeout` ne
//      CANCELLE rien, la routine continuait en fond après son délai.
//      Ici, UN budget total partagé par toutes les phases (createBudget) et des jetons qui coupent
//      pour de vrai (boundedToken) — un plafond qui n'est pas appliqué est un plafond qui ment.
//
// Module PUR : aucune dépendance au bot ni à l'horloge en dur (injectable) → testable sans serveur.
// Les orchestrateurs qui s'en servent (ensureFood, huntCookGoal) sont dans foodRun.js.

// ─── 1) COMPTER ─────────────────────────────────────────────────────────────────────────────────
// Points de faim vanilla (Java). Le cuit vaut toujours plus que son cru ; la chair putréfiée vaut 4
// en vanilla mais donne l'effet Faim : on la décote à 2 — elle reste une VRAIE nourriture de secours
// (c'est elle qui sauve un bot affamé après un combat), pas un trophée.
// `suspicious_stew` est mangé en détresse par le réflexe mais compte 0 : ses effets sont aléatoires
// (Poison, Wither…), on ne bâtit pas une réserve dessus.
const FOOD_POINTS = Object.freeze({
  // cuit / préparé
  cooked_beef: 8, cooked_porkchop: 8, cooked_mutton: 6, cooked_chicken: 6, cooked_salmon: 6,
  cooked_cod: 5, cooked_rabbit: 5, bread: 5, baked_potato: 5, mushroom_stew: 6, rabbit_stew: 10,
  beetroot_soup: 6, pumpkin_pie: 8, golden_carrot: 6, apple: 4, carrot: 3, melon_slice: 2,
  sweet_berries: 2, glow_berries: 2, cookie: 2, beetroot: 1, dried_kelp: 1, honey_bottle: 6,
  // cru
  beef: 3, porkchop: 3, mutton: 2, chicken: 2, rabbit: 3, cod: 2, salmon: 2, tropical_fish: 1, potato: 1,
  // chair putréfiée (4 vanilla, décotée : effet Faim)
  rotten_flesh: 2,
});

// Seuils. Le kit se contente de moins que ce que `ensureFood` vise : le premier est un plancher de
// survie (≈ 60 % de la barre), le second le niveau au-dessus duquel ça ne vaut PAS une sortie.
const STOCK_POINTS = 12;          // `food_stock` du kit mappeur
const ENSURE_SKIP_POINTS = 20;    // `ensureFood` : au-dessus, on ne sort pas
const SURFACE_TRIP_POINTS = 6;    // remontée /home safe : seulement si on est vraiment à sec
const RAW_PIECE_POINTS = 3;       // une pièce de viande crue ≈ 3 points : « target en pièces » → points
// « Proie en vue » : même rayon que la chasse elle-même. 32 jusqu'au 22/10 — or le serveur envoie les
// animaux jusqu'à 96 blocs (entity-tracking-range) : une vache à 40 blocs, DANS bot.entities, ne
// comptait pas, et la chasse rendait `no_prey:no_passive` (17 fois en 1 h de chrono). Cf. huntReach.js.
const HUNT_SIGHT_RADIUS = require('./huntReach').HUNT_REACH_RADIUS;

const _hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Points de faim en poche. `inv` = carte {nom: quantité} (celle de `buildCtxInv`) — ou, par
 * tolérance, la liste `[{name, count}]` de `bot.inventory.items()` : le code du bot manipule les
 * DEUX formes, et une lecture dans la mauvaise forme ne plante jamais, elle rend juste 0 (piège #61).
 * Tout ce qui n'est pas comestible, ou dont la quantité n'a pas de sens, est ignoré. Pur.
 */
function foodPoints(inv) {
  if (!inv || typeof inv !== 'object') return 0;
  let total = 0;
  const add = (name, count) => {
    if (typeof name !== 'string' || !_hasOwn(FOOD_POINTS, name)) return;   // ni `constructor` ni `toString`
    const n = Number(count);
    if (!(n > 0) || !Number.isFinite(n)) return;
    total += FOOD_POINTS[name] * n;
  };
  if (Array.isArray(inv)) {
    for (const it of inv) { if (it) add(it.name, it.count); }
  } else {
    for (const name of Object.keys(inv)) add(name, inv[name]);
  }
  return total;
}

// ─── 2) BORNER LE TEMPS ─────────────────────────────────────────────────────────────────────────
// Les plafonds de la consigne. UN budget total par sortie, que toutes les phases se partagent.
const FOOD_RUN_BUDGET_MS = 60000;     // ensureFood : TOTAL
const FOOD_RUN_TIMEOUT_MS = 70000;    // garde-fou du timer : le budget + 10 s de marge d'exécution
const HUNT_COOK_BUDGET_MS = 60000;    // huntCookGoal appelé seul (kit, hook de descente, démarrage mappeur)
const HUNT_COOK_TIMEOUT_MS = 70000;   // garde-fou autour de ces appels
const LOOT_SWEEP_MS = 8000;           // balayage de butin
const LOOT_SWEEP_RADIUS = 10;
const SURFACE_TRIP_MS = 30000;        // remontée /home safe : secureSpot 6 s + warmup 9 s, une relance au pire
const HUNT_WAVE_MS = 45000;           // UNE vague de chasse
const HUNT_MAX_KILLS = 4;             // proies par vague (le jeton coupe plus tôt si le but est atteint)
const FISH_MS = 40000;                // pêche locale
const FISH_RADIUS = 16;               // eau à ≤ 16 blocs, jamais de trajet vers une eau lointaine
const FISH_MIN_MS = 12000;            // en dessous, la ligne n'a même pas le temps de mordre
const FISH_TARGET = 4;
const MIN_PHASE_MS = 3000;            // on ne démarre pas une phase avec moins que ça en caisse
// Cuisson : 200 ticks par pièce en vanilla ; le four se POSE puis se REPREND (portable).
const SMELT_ITEM_MS = 10000;
const SMELT_OVERHEAD_MS = 8000;
const SMELT_SLACK_MS = 3000;
const COOK_MIN_RAW = 2;               // poser/reprendre un four pour UNE pièce ne vaut pas le temps

/**
 * Budget de temps partagé. `now` injectable (tests). Une valeur de total invalide donne un budget
 * NUL : on échoue vers le COURT, jamais vers l'infini.
 */
function createBudget(totalMs, now = Date.now) {
  const t0 = now();
  const total = Number.isFinite(Number(totalMs)) ? Math.max(0, Number(totalMs)) : 0;
  const left = () => Math.max(0, total - (now() - t0));
  return {
    total,
    left,
    elapsed: () => now() - t0,
    expired: () => left() <= 0,
    // Le plafond d'UNE phase, rogné par ce qui reste du TOTAL.
    take: (capMs) => {
      const cap = Number(capMs);
      return Number.isFinite(cap) ? Math.max(0, Math.min(cap, left())) : 0;
    },
  };
}

/**
 * Jeton d'annulation DÉRIVÉ : annulé si le parent l'est (tâche annulée), si on le coupe nous-mêmes
 * (fin de la vague / délai écoulé) ou si `stopWhen()` devient vrai (objectif atteint). C'est ce qui
 * rend un plafond RÉEL : `withTimeout` rend la main à l'appelant mais ne stoppe pas la promesse, qui
 * continuait de chasser en fond — le jeton, lui, est relu à chaque tour de boucle des skills.
 * `parent` et `stopWhen` sont relus à CHAQUE lecture (un getter, pas une copie).
 */
function boundedToken(parent, stopWhen) {
  let local = false;
  const token = {
    get cancelled() {
      if (local) return true;
      try { if (parent && parent.cancelled) return true; } catch (e) { /* jeton illisible : on ne coupe pas */ }
      try { if (typeof stopWhen === 'function' && stopWhen()) return true; } catch (e) { /* idem */ }
      return false;
    },
    set cancelled(v) { local = !!v; },
  };
  return { token, cancel() { local = true; } };
}

/**
 * PUR — combien de pièces crues cuire, vu le temps qui reste ?
 * Cuire = poser un four (portable, EN POCHE), 10 s par pièce, le reprendre. Sans four en poche ou
 * avec moins de 2 pièces on garde le cru : il se mange (3 points contre 8 cuit, mais tout de suite).
 * @returns {{cook:number, maxMs:number, reason:'ok'|'no_furnace'|'few_raw'|'no_time'}}
 */
function cookPlan({ raw = 0, furnace = false, leftMs = 0 } = {}) {
  if (!furnace) return { cook: 0, maxMs: 0, reason: 'no_furnace' };
  const have = Number(raw);
  if (!(have >= COOK_MIN_RAW)) return { cook: 0, maxMs: 0, reason: 'few_raw' };
  const left = Number(leftMs);
  const room = Number.isFinite(left) ? Math.floor((left - SMELT_OVERHEAD_MS) / SMELT_ITEM_MS) : 0;
  const cook = Math.min(have, room);
  if (!(cook >= COOK_MIN_RAW)) return { cook: 0, maxMs: 0, reason: 'no_time' };
  return { cook, maxMs: cook * SMELT_ITEM_MS + SMELT_SLACK_MS, reason: 'ok' };
}

/**
 * PUR — pêcher ? Seulement avec une canne EN POCHE (on ne la fabrique pas, on ne part pas chasser
 * la ficelle) et s'il reste de quoi laisser mordre. L'eau, elle, est vérifiée par `fishCatch`
 * (rayon FISH_RADIUS) : pas d'eau à portée → il rend `no_water` aussitôt, sans voyage.
 * @returns {{fish:boolean, ms:number, reason:'ok'|'no_rod'|'no_time'}}
 */
function fishPlan({ rod = false, leftMs = 0 } = {}) {
  if (!rod) return { fish: false, ms: 0, reason: 'no_rod' };
  const left = Number(leftMs);
  if (!(Number.isFinite(left) && left >= FISH_MIN_MS)) return { fish: false, ms: 0, reason: 'no_time' };
  return { fish: true, ms: Math.min(FISH_MS, left), reason: 'ok' };
}

// ─── 3) RAMASSER APRÈS UN COMBAT ────────────────────────────────────────────────────────────────
// Un zombie laisse de la chair putréfiée (2 points, de quoi tenir), une araignée de la ficelle (la
// canne qui débloque la pêche). `bot.pvp` ne ramasse rien : tout restait au sol.
const COMBAT_LOOT_RADIUS = 6;
const COMBAT_LOOT_ITEMS = 4;
const COMBAT_LOOT_MS = 5000;
const COMBAT_LOOT_HOSTILE_RADIUS = 8;   // un hostile plus près que ça : le combat n'est pas fini
const COMBAT_LOOT_NEAR = 4;             // un objet « sur le chemin » : l'interruption est négligeable
const COMBAT_LOOT_SETTLE_MS = 400;       // laisser le butin arriver et le gardien de Movements rendre la nominale
// Neutres : classés « Hostile mobs » par mineflayer mais qu'on ne combat jamais (cf. survival.js).
const _NEUTRAL = new Set(['enderman']);

/** Le mobs qu'on vient de combattre était-il un hostile ? (`target` = {name, kind, type} relevé au début du combat) */
function isHostileKill(target) {
  if (!target || typeof target !== 'object') return false;
  if (target.name && _NEUTRAL.has(target.name)) return false;
  return target.kind === 'Hostile mobs' || target.type === 'hostile';
}

/**
 * PUR — faut-il ramasser MAINTENANT, à la fin d'un combat ?
 *
 * s = { target: {name,kind,type}|null  — ce qu'on combattait,
 *       hostilesNear: bool             — un hostile à ≤ COMBAT_LOOT_HOSTILE_RADIUS,
 *       migrating: bool,               — migration en cours (EXCLUSIVE : elle possède le pathfinder),
 *       busy: bool,                    — survie / armure / noyade / autre ramassage en vol,
 *       goalActive: bool,              — `bot.pathfinder.goal` non nul (un AUTRE trajet),
 *       dropDist: nombre|null }        — distance du plus proche objet au sol (null = aucun)
 *
 * Le pathfinder n'a qu'UN but : poser le nôtre vole le trajet en cours (GoalChanged — la classe de bug
 * n°1 du 19/10). D'où : rien pendant une migration, rien si un autre trajet court SAUF pour un objet
 * à ≤ 4 blocs (détour négligeable), et seulement après un HOSTILE — le gibier chassé a déjà son propre
 * ramassage (`huntPassive`), lui faire concurrence = deux `goto` qui se volent la place.
 * @returns {{go:boolean, reason:string}}
 */
function shouldLootAfterCombat(s) {
  if (!s || typeof s !== 'object') return { go: false, reason: 'no_state' };
  if (s.busy) return { go: false, reason: 'busy' };
  if (s.migrating) return { go: false, reason: 'migrating' };
  if (!isHostileKill(s.target)) return { go: false, reason: 'not_hostile' };
  if (s.hostilesNear) return { go: false, reason: 'hostiles' };
  // `Number(null) === 0` : « pas d'objet » ne doit JAMAIS se lire « objet à 0 bloc »
  const d = (s.dropDist === null || s.dropDist === undefined) ? NaN : Number(s.dropDist);
  if (!(Number.isFinite(d) && d >= 0)) return { go: false, reason: 'no_drop' };
  if (s.goalActive && d > COMBAT_LOOT_NEAR) return { go: false, reason: 'trip_in_progress' };
  return { go: true, reason: 'ok' };
}

module.exports = {
  FOOD_POINTS, foodPoints,
  STOCK_POINTS, ENSURE_SKIP_POINTS, SURFACE_TRIP_POINTS, RAW_PIECE_POINTS, HUNT_SIGHT_RADIUS,
  FOOD_RUN_BUDGET_MS, FOOD_RUN_TIMEOUT_MS, HUNT_COOK_BUDGET_MS, HUNT_COOK_TIMEOUT_MS,
  LOOT_SWEEP_MS, LOOT_SWEEP_RADIUS, SURFACE_TRIP_MS, HUNT_WAVE_MS, HUNT_MAX_KILLS,
  FISH_MS, FISH_RADIUS, FISH_MIN_MS, FISH_TARGET, MIN_PHASE_MS,
  SMELT_ITEM_MS, SMELT_OVERHEAD_MS, SMELT_SLACK_MS, COOK_MIN_RAW,
  createBudget, boundedToken, cookPlan, fishPlan,
  COMBAT_LOOT_RADIUS, COMBAT_LOOT_ITEMS, COMBAT_LOOT_MS, COMBAT_LOOT_HOSTILE_RADIUS, COMBAT_LOOT_NEAR, COMBAT_LOOT_SETTLE_MS,
  isHostileKill, shouldLootAfterCombat,
};
