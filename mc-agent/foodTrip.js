'use strict';
// NOURRITURE — L'EXPÉDITION VERS LE GIBIER (Massii, 19/10 : « l'important c'est la VITESSE, pas de
// choix qui font trop durer ; dans le pire des cas il y a la viande de zombie »).
//
// Mesure live juste après la refonte « points de faim + budget de 60 s » : les sorties nourriture
// sont bien devenues rapides (33 à 352 ms) — mais TOUS les bots restent à 0 point de nourriture :
// `hunt_cook_done reason:no_prey:no_passive` à chaque fois. La chasse ne part que si un animal passif
// est EN VUE (≤ 32 blocs), or il n'y en a aucun autour du spawn (forêt dense), alors que des PLAINES
// sont à ~140 blocs. Affamé = plus de régénération ni de sprint = mort.
//
// Ce module est le CERVEAU PUR de l'ajout, rien d'autre (aucun bot, aucune horloge en dur) :
//   • pickGrazingCell — la cellule de la carte du groupe où il y a probablement des bêtes (la plus proche) ;
//   • shouldFoodTrip  — « faut-il partir ? » (faim + jour + surface + aucun passif en vue + libre) ;
//   • foodTripLeg     — la prochaine JAMBE de marche (le pathfinder ne voit pas au-delà du chargé) ;
//   • triedCells*     — la mémoire des cellules ratées (20 min), persistable dans le mémo de base.
// L'orchestration (QUOI, DANS QUEL ORDRE, SOUS QUEL PLAFOND) vit dans foodRun.runHuntCook ; le câblage
// sur le vrai bot dans index.js (foodTripState / foodTripCell / foodTripWalk…).
const { legHeading, LEG_DIST } = require('./zone');

// ─── Seuils ─────────────────────────────────────────────────────────────────────────────────────
const FOOD_TRIP_POINTS = 6;             // « vraie faim » : moins de 6 points en poche (≈ 3 icônes de faim)
const FOOD_TRIP_MIN_Y = 58;             // surface : plus bas, pas de gibier (et la marche plongerait en grotte)
const FOOD_TRIP_MS = 75000;             // plafond de la MARCHE (hors chasse sur place, qui garde son budget)
// Combien de temps le planner cède le pathfinder à une expédition : la marche + TOUT le budget de la sortie
// qui suit (60 s : chasse sur place, cuisson, pêche) — le pire cas réel d'une expédition.
const FOOD_TRIP_YIELD_MAX_MS = FOOD_TRIP_MS + 60000;
const FOOD_TRIP_MAX_DIST = 160;         // au-delà, l'aller coûte plus que ce qu'il rapporte (cf. waterfind)
// On ne retourne pas là où on vient de regarder : aucun passif à ≤ 32 blocs, et le serveur ne suit les
// animaux que jusqu'à ~48 blocs — un point visé plus près que ça ne nous apprendrait rien (et la
// cellule SOUS nos pieds a un point visé à distance 0 : elle est écartée d'office).
const FOOD_TRIP_MIN_DIST = 48;
const FOOD_TRIP_NEAR = 16;              // rayon du `GoalNearXZ` : on s'arrête à ≤ 16 blocs du but
const FOOD_TRIP_ARRIVED = 24;           // « arrivé » : près du but = on a vu les lieux
const FOOD_TRIP_MIN_LEFT_MS = 20000;    // sous ce reste de budget, la chasse d'après n'aurait pas le temps
const FOOD_TRIP_AVOID_MS = 20 * 60 * 1000;   // une cellule ratée est écartée 20 min
const FOOD_TRIP_AVOID_CAP = 8;          // bornée : la liste voyage dans le mémo de base
const FOOD_TRIP_CELL = 128;             // la grille du backend (`mc_agent_world_memory.GRID`)
// On entre dans la cellule de 32 blocs (un quart) au lieu de viser son arête : le biome d'une cellule
// vient d'UN échantillon, au bord on est aussi bien dans la cellule d'en face — et 32 blocs rentrent
// assez pour la voir sans allonger la marche (même choix que waterfind.WATER_INSET).
const FOOD_TRIP_INSET = 32;
const FOOD_TRIP_MEMO_KEY = 'foodTrips'; // champ du mémo de base (survit aux morts / relances du self-healing)

// Marche par JAMBES (mêmes constantes que la migration de zone, mesurées sur world_mn11) :
// view-distance 6 = 96 blocs chargés ; au-delà le pathfinder est aveugle et rend NoPath en quelques
// secondes (`hop_failed moved:8`). Un but à 140 blocs ne se vise donc JAMAIS d'un seul `goto`.
const FOOD_TRIP_LEG_MS = 30000;         // une jambe de 64 blocs ≈ 15 s ; 30 s pour un terrain vallonné
const FOOD_TRIP_LEG_MIN_MS = 3000;      // on ne démarre pas une jambe avec moins que ça en caisse
const FOOD_TRIP_MAX_LEGS = 8;           // 160 / 64 = 3 jambes droites ; le reste sert aux déviations
const FOOD_TRIP_STUCK_MAX = 2;          // 2 jambes de suite sans avancer (NoPath) → on renonce

// Biomes OÙ IL Y A DU GIBIER (vaches, cochons, moutons, poules, lapins). Liste blanche : tout ce qui
// n'y figure pas est exclu d'office — océans/rivières/plages (eau), désert et badlands (rien),
// champignons, marais, forêt sombre (dangereuse et sans prairie). Une variante rare (old_growth_*,
// windswept_*, snowy_taiga…) n'y est pas : l'ajouter ici suffit.
const GRAZING_BIOMES = Object.freeze([
  'plains', 'sunflower_plains', 'meadow', 'savanna', 'savanna_plateau',
  'flower_forest', 'forest', 'birch_forest', 'taiga', 'snowy_plains', 'cherry_grove',
]);
const _GRAZING = new Set(GRAZING_BIOMES);

const _fin = (v) => typeof v === 'number' && Number.isFinite(v);

/** Nom de biome sans l'espace de noms (`minecraft:plains` → `plains`) ; null si illisible. */
function _biomeName(n) {
  if (typeof n !== 'string' || !n) return null;
  return n.startsWith('minecraft:') ? n.slice('minecraft:'.length) : n;
}

function _clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

/** Coin (SO) de la cellule de grille qui contient la coordonnée — idempotent sur une valeur déjà quantifiée. */
function _corner(v, size) { return Math.floor(v / size) * size; }

/** Comparaison lexicographique de deux tuples numériques (même idiome que zone.pickMigrationTarget). */
function _lex(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

// ─── 1) LES CELLULES ESSAYÉES SANS SUCCÈS ───────────────────────────────────────────────────────
/**
 * Élague une liste de cellules ratées `[{x,z,at}]` : entrées valides seulement, ni expirées ni datées
 * du FUTUR (même paranoïa que zone.pruneFailedTargets : une entrée future écarterait la cellule à vie),
 * les FOOD_TRIP_AVOID_CAP plus récentes, triées par ancienneté. (pur, ne mute jamais l'entrée)
 */
function triedCellsPrune(list, now = Date.now()) {
  const t = _fin(now) ? now : Date.now();
  const out = [];
  for (const e of Array.isArray(list) ? list : []) {
    if (!e || typeof e !== 'object') continue;
    if (!_fin(e.x) || !_fin(e.z) || !_fin(e.at)) continue;
    if (e.at > t || (t - e.at) >= FOOD_TRIP_AVOID_MS) continue;
    out.push({ x: e.x, z: e.z, at: e.at });
  }
  out.sort((a, b) => a.at - b.at);
  return out.slice(-FOOD_TRIP_AVOID_CAP);
}

/**
 * Ajoute une cellule ratée (dédupliquée par cellule : la même cellule ré-essayée rafraîchit sa date).
 * `cell` = ce que rend pickGrazingCell ({x,z}). Cellule illisible → la liste, élaguée. (pur)
 */
function triedCellsAdd(list, cell, now = Date.now(), cellSize = FOOD_TRIP_CELL) {
  const t = _fin(now) ? now : Date.now();
  const kept = triedCellsPrune(list, t);
  if (!cell || !_fin(cell.x) || !_fin(cell.z)) return kept;
  const cx = _corner(cell.x, cellSize), cz = _corner(cell.z, cellSize);
  const others = kept.filter((e) => !(_corner(e.x, cellSize) === cx && _corner(e.z, cellSize) === cz));
  others.push({ x: Math.round(cell.x), z: Math.round(cell.z), at: t });
  return triedCellsPrune(others, t);
}

/** Relit les cellules ratées depuis le mémo de base (ancien format sans le champ → liste vide). (pur) */
function triedCellsLoad(memo, now = Date.now()) {
  return triedCellsPrune(memo && typeof memo === 'object' ? memo[FOOD_TRIP_MEMO_KEY] : null, now);
}

// ─── 2) OÙ ALLER ────────────────────────────────────────────────────────────────────────────────
/**
 * La cellule à gibier la plus proche CONNUE de la carte du groupe. (PUR, DÉTERMINISTE)
 *
 * `biomes` = les cellules de la mémoire de monde (`loadWorldCells().biomes`) : `{name, x, z}` avec
 * (x,z) = coin SO de la cellule de 128² (quantifié par le backend). Le point visé est le plus proche
 * de `from` DANS la cellule, rentré de FOOD_TRIP_INSET blocs (cf. waterfind.nearestWater) : la marche
 * est la plus courte possible — la VITESSE est la consigne — et `dist` est la longueur de CETTE marche.
 *
 * Retenue : nom de biome dans GRAZING_BIOMES, point visé à [minDist, maxDist] de `from`, cellule non
 * écartée par `avoid` (`[{x,z,at}]`, ratées il y a < 20 min). La plus proche gagne ; à distance égale,
 * l'ordre lexicographique du coin (x,z) — jamais l'ordre du tableau, donc deux bots qui lisent la même
 * carte visent la même cellule et un même bot ne bascule pas entre deux cellules équidistantes.
 *
 * @returns {{x:number, z:number, biome:string, dist:number}|null} — null = rien de connu à portée.
 */
function pickGrazingCell({
  from, biomes, maxDist = FOOD_TRIP_MAX_DIST, minDist = FOOD_TRIP_MIN_DIST,
  avoid, now = Date.now(), cellSize = FOOD_TRIP_CELL,
} = {}) {
  if (!from || !_fin(from.x) || !_fin(from.z)) return null;
  const list = Array.isArray(biomes) ? biomes : [];
  if (!list.length) return null;
  const size = _fin(cellSize) && cellSize > 0 ? cellSize : FOOD_TRIP_CELL;
  // Une borne illisible retombe sur le DÉFAUT, jamais sur « pas de borne » : `d > NaN` est faux, donc
  // un maxDist NaN laisserait passer des cellules à l'autre bout de la carte.
  const hi = _fin(maxDist) ? maxDist : FOOD_TRIP_MAX_DIST;
  const lo = _fin(minDist) ? Math.max(0, minDist) : FOOD_TRIP_MIN_DIST;
  // La demi-cellule utilisable est (size-1)/2 : un inset absurde donne le CENTRE, jamais un point hors de la boîte.
  const inset = _clamp(FOOD_TRIP_INSET, 0, Math.floor((size - 1) / 2));
  const avoided = triedCellsPrune(avoid, now);
  const isAvoided = (cx, cz) => avoided.some((a) => _corner(a.x, size) === cx && _corner(a.z, size) === cz);

  let best = null;
  let bestKey = null;
  for (const b of list) {
    if (!b || !_fin(b.x) || !_fin(b.z)) continue;
    const name = _biomeName(b.name);
    if (!name || !_GRAZING.has(name)) continue;               // ni eau, ni désert, ni nom inconnu
    const cx = _corner(b.x, size);
    const cz = _corner(b.z, size);
    const x = Math.round(_clamp(from.x, cx + inset, cx + size - 1 - inset));
    const z = Math.round(_clamp(from.z, cz + inset, cz + size - 1 - inset));
    const dist = Math.hypot(x - from.x, z - from.z);
    if (dist > hi || dist < lo) continue;
    if (isAvoided(cx, cz)) continue;
    const key = [dist, cx, cz];
    if (!bestKey || _lex(key, bestKey) < 0) {
      bestKey = key;
      best = { x, z, biome: name, dist };
    }
  }
  return best;
}

// ─── 3) FAUT-IL PARTIR ? ────────────────────────────────────────────────────────────────────────
/**
 * PUR — faut-il partir en expédition vers le terrain à animaux ?
 *
 * s = { points: nombre            — points de faim EN POCHE (food.foodPoints),
 *       passiveInView: bool       — un passif à ≤ 32 blocs ? (oui → la chasse normale suffit),
 *       isDay: bool|null          — jour/nuit ; null = heure pas encore livrée → on ne part pas,
 *       y: nombre,                — altitude du bot,
 *       migrating: bool,          — migration de zone en cours (elle possède le pathfinder),
 *       ordered: bool,            — tâche d'ORDRE DIRECT en cours (follow, guard, take…),
 *       busy: bool,               — survie / armure / base / noyade / dette de mort / combat,
 *       tripBusy: bool,           — une expédition est déjà en vol (garde de ré-entrée),
 *       canGive?: bool,           — le bot peut se /give à manger (serveur de test, bot OP),
 *       leftMs?: nombre }         — budget restant (absent = pas de contrainte de temps)
 *
 * Le pathfinder n'a qu'UN but : partir marcher 75 s par-dessus une migration ou un ordre le volerait
 * (la classe de bug n°1 du 19/10), d'où ces portes en tête. Puis les quatre conditions de la consigne :
 * vraie faim, jour, surface, aucun gibier en vue. `canGive` : quand le /give existe (ensureFood le
 * lance en dernier recours) il est instantané — marcher 75 s avant lui ne ferait que retarder la
 * nourriture ; l'expédition est faite pour les bots SANS /give, le cas nominal.
 * @returns {{go:boolean, reason:string}}
 */
function shouldFoodTrip(s) {
  const no = (reason) => ({ go: false, reason });
  if (!s || typeof s !== 'object') return no('no_state');
  if (s.canGive) return no('can_give');
  if (s.tripBusy) return no('trip_busy');
  if (s.migrating) return no('migrating');
  if (s.ordered) return no('ordered');
  if (s.busy) return no('busy');
  // `Number(null) === 0` : « pas de donnée » ne doit JAMAIS se lire « zéro point » ni « altitude 0 ».
  const points = (s.points === null || s.points === undefined) ? NaN : Number(s.points);
  const y = (s.y === null || s.y === undefined) ? NaN : Number(s.y);
  if (!Number.isFinite(points) || !Number.isFinite(y)) return no('no_state');
  if (points >= FOOD_TRIP_POINTS) return no('not_hungry');
  if (s.passiveInView) return no('passive_in_view');
  if (s.isDay === false) return no('night');
  if (s.isDay !== true) return no('time_unknown');
  if (y < FOOD_TRIP_MIN_Y) return no('underground');
  if (s.leftMs !== null && s.leftMs !== undefined) {
    const left = Number(s.leftMs);
    if (!(Number.isFinite(left) && left >= FOOD_TRIP_MIN_LEFT_MS)) return no('no_time');
  }
  return { go: true, reason: 'ok' };
}

// ─── 4) COMMENT Y ALLER ─────────────────────────────────────────────────────────────────────────
/**
 * PUR — la prochaine JAMBE de la marche vers `to`. null = arrivé (≤ FOOD_TRIP_ARRIVED) ou entrée illisible.
 *
 * Droit vers le but par bonds de LEG_DIST (64) blocs ; la dernière jambe vise le but lui-même.
 * `stuck` = nombre de jambes consécutives qui n'ont PAS avancé (NoPath sur une colline, un ravin, un
 * étang) : le cap est alors dévié (zone.legHeading : ±40°, croissant, borné à 120°) au lieu de re-viser
 * le MÊME point inatteignable — la cause racine des `moved:1/9` en 24 jambes de la migration.
 * @returns {{x:number, z:number, last:boolean}|null}
 */
function foodTripLeg({ from, to, stuck = 0, legDist = LEG_DIST } = {}) {
  if (!from || !to) return null;
  const fx = Number(from.x), fz = Number(from.z), tx = Number(to.x), tz = Number(to.z);
  if (![fx, fz, tx, tz].every(Number.isFinite)) return null;
  const dist = Math.hypot(tx - fx, tz - fz);
  if (dist <= FOOD_TRIP_ARRIVED) return null;
  const s = Number.isFinite(stuck) ? Math.max(0, Math.floor(stuck)) : 0;
  const leg = _fin(legDist) && legDist > 0 ? legDist : LEG_DIST;
  if (!s && dist <= leg) return { x: Math.round(tx), z: Math.round(tz), last: true };
  const heading = legHeading(Math.atan2(tz - fz, tx - fx), s);
  const len = Math.min(leg, dist);
  return { x: Math.round(fx + len * Math.cos(heading)), z: Math.round(fz + len * Math.sin(heading)), last: false };
}

// ─── 5) SORTIE LONGUE DE DERNIER RECOURS + FAIRE LE PLEIN (24/10) ───────────────────────────────
// Run 24/10 (monde de 22 h, Hard) : 11 morts de mineurs en 35 min dont 3 famines. Séquence type :
// `food_trip {biome:'herd', dist:100, after_fail}` → `food_trip_done {got:0, took_ms:74484, arrived:false,
// aborted:true}` → on recommence. Les animaux NE réapparaissent PAS (nés à la génération des chunks) : les
// troupeaux près du spawn sont mangés, et la marche de 75 s n'atteint jamais un troupeau vivant plus loin.
// Et comme la sortie était marquée « aborted », la cellule n'était même pas écartée : même cible au tour suivant.
//   • poche à 0 ET une sortie courte vient d'échouer (persisté) → UNE expédition LONGUE (4 min, 400 blocs) ;
//   • arrivé au troupeau → on fait le PLEIN (≥ 20 points, jusqu'à 3 vagues), pas un repas.
const FOOD_TRIP_LONG_MS = 240000;              // la marche longue (≈ 4 min)
const FOOD_TRIP_LONG_MAX_DIST = 400;           // ≈ ce que 4 min couvrent en terrain réel
const FOOD_TRIP_LONG_MAX_LEGS = 16;            // 400 / 64 ≈ 7 jambes droites ; le reste pour les déviations
const FOOD_TRIP_LONG_AFTER_FAIL_MS = 30 * 60000;   // une sortie courte ratée depuis < 30 min ouvre la longue
const FOOD_TRIP_LONG_COOLDOWN_MS = 10 * 60000;     // au plus une longue / 10 min (elle coûte 4 min de travail)
const FOOD_TRIP_LONG_MEMO_KEY = 'foodTripLong';    // mémo de base : { shortFailAt, longAt } — survit aux morts
const TRIP_FILL_POINTS = 20;                   // le plein : de quoi ne plus remonter toutes les 10 min
const TRIP_FILL_WAVES = 3;                     // vagues de chasse sur place une fois arrivé
const TRIP_FILL_HUNT_MS = 3 * 45000;           // budget de chasse sur place une fois arrivé (3 vagues)
// Ce que la sortie longue + le plein ajoutent au PIRE cas d'une sortie : à ajouter aux garde-fous des
// appelants (`+ FOOD_TRIP_MS + FOOD_TRIP_LONG_EXTRA_MS`), sinon ils la couperaient en route.
const FOOD_TRIP_LONG_EXTRA_MS = (FOOD_TRIP_LONG_MS - FOOD_TRIP_MS) + TRIP_FILL_HUNT_MS;

/** PUR — l'état persisté de la sortie longue, toujours bien formé (horodatages futurs écartés). */
function longTripLoad(memo, now = Date.now()) {
  const o = memo && typeof memo === 'object' && memo[FOOD_TRIP_LONG_MEMO_KEY] && typeof memo[FOOD_TRIP_LONG_MEMO_KEY] === 'object'
    ? memo[FOOD_TRIP_LONG_MEMO_KEY] : {};
  const ok = (v) => (_fin(v) && v > 0 && v <= now + 60000 ? v : 0);
  return { shortFailAt: ok(o.shortFailAt), longAt: ok(o.longAt) };
}

/**
 * PUR — la sortie longue est-elle due ? Poche à 0 point, une sortie COURTE a échoué il y a < 30 min,
 * et aucune longue depuis 10 min. s = { points, shortFailAt, longAt, now }
 */
function longTripDue(s = {}) {
  const now = _fin(s.now) ? s.now : Date.now();
  // `Number(null) === 0` : « pas de donnée » ne doit jamais se lire « poche vide ».
  const points = (s.points === null || s.points === undefined) ? NaN : Number(s.points);
  if (!(Number.isFinite(points) && points <= 0)) return false;
  const sf = Number(s.shortFailAt);
  if (!(Number.isFinite(sf) && sf > 0 && sf <= now && now - sf < FOOD_TRIP_LONG_AFTER_FAIL_MS)) return false;
  const la = Number(s.longAt);
  if (Number.isFinite(la) && la > 0 && la <= now && now - la < FOOD_TRIP_LONG_COOLDOWN_MS) return false;
  return true;
}

/**
 * PUR — l'état persisté après une expédition. o = { long, failed, got }.
 * Longue (tentée, même sans cible) → `longAt` = maintenant ; courte ratée → `shortFailAt` = maintenant ;
 * une expédition qui a rapporté efface `shortFailAt` (plus de raison d'aller loin).
 */
function longTripRecord(state, o = {}, now = Date.now()) {
  const st = longTripLoad({ [FOOD_TRIP_LONG_MEMO_KEY]: state }, now);
  if (o.long) st.longAt = now;
  else if (o.failed) st.shortFailAt = now;
  if ((Number(o.got) || 0) > 0) st.shortFailAt = 0;
  return st;
}

/** PUR — les plafonds de la marche (courte ou longue). */
function tripLimits(long) {
  return long
    ? { ms: FOOD_TRIP_LONG_MS, maxDist: FOOD_TRIP_LONG_MAX_DIST, maxLegs: FOOD_TRIP_LONG_MAX_LEGS, long: true }
    : { ms: FOOD_TRIP_MS, maxDist: FOOD_TRIP_MAX_DIST, maxLegs: FOOD_TRIP_MAX_LEGS, long: false };
}

/**
 * PUR — l'expédition a-t-elle ÉCHOUÉ (cible à écarter) ? Rien rapporté ET : soit terminée normalement,
 * soit coupée APRÈS une marche complète sans arriver (24/10 : `arrived:false, aborted:true` au bout des
 * 75 s — la cible n'était jamais écartée et re-visée à chaque tour). Coupée EN ROUTE (mort, migration) :
 * pas un échec de la cible.
 * s = { kills, got, aborted, walked, arrived }
 */
function tripFailed(s = {}) {
  if ((Number(s.kills) || 0) > 0 || (Number(s.got) || 0) > 0) return false;
  if (!s.aborted) return true;
  return !!s.walked && !s.arrived;
}

/**
 * PUR — le propriétaire de la tâche active est-il un ORDRE direct (follow, guard, take, migration…) ?
 * 'autonomous' (planner, mappeur) et 'food_run' (la sortie nourriture qui a préempté le planner, 23/10)
 * ne le sont pas : l'expédition peut partir.
 */
function isOrderOwner(owner) {
  return !!(owner && owner !== 'autonomous' && owner !== 'food_run');
}

module.exports = {
  isOrderOwner,
  GRAZING_BIOMES,
  FOOD_TRIP_POINTS, FOOD_TRIP_MIN_Y, FOOD_TRIP_MS, FOOD_TRIP_YIELD_MAX_MS, FOOD_TRIP_MAX_DIST, FOOD_TRIP_MIN_DIST,
  FOOD_TRIP_NEAR, FOOD_TRIP_ARRIVED, FOOD_TRIP_MIN_LEFT_MS, FOOD_TRIP_AVOID_MS, FOOD_TRIP_AVOID_CAP,
  FOOD_TRIP_CELL, FOOD_TRIP_INSET, FOOD_TRIP_MEMO_KEY,
  FOOD_TRIP_LEG_MS, FOOD_TRIP_LEG_MIN_MS, FOOD_TRIP_MAX_LEGS, FOOD_TRIP_STUCK_MAX,
  triedCellsPrune, triedCellsAdd, triedCellsLoad,
  pickGrazingCell, shouldFoodTrip, foodTripLeg,
  FOOD_TRIP_LONG_MS, FOOD_TRIP_LONG_MAX_DIST, FOOD_TRIP_LONG_MAX_LEGS, FOOD_TRIP_LONG_AFTER_FAIL_MS,
  FOOD_TRIP_LONG_COOLDOWN_MS, FOOD_TRIP_LONG_MEMO_KEY, FOOD_TRIP_LONG_EXTRA_MS,
  TRIP_FILL_POINTS, TRIP_FILL_WAVES, TRIP_FILL_HUNT_MS,
  longTripLoad, longTripDue, longTripRecord, tripLimits, tripFailed,
};
