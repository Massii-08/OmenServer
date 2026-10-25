'use strict';
// FAIM — deux portes de plus, toutes deux PURES (run 20/10, world_oct9 : 4 « starved to death » en
// 1 h 20 — NethBot1 11:20, NethBot2 11:41, NethBot3 12:27, MapBot2 11:08).
//
// Ce que disent les logs : chaque fois, `hunt_cook_done before:0 after:0` — ZÉRO point de nourriture
// en poche, pendant des heures. Le bot ne meurt pas faute de MANGER (il mange ce qu'il a : filet 5 s),
// il meurt parce qu'il n'a RIEN et repart quand même :
//   1. il DESCEND sans rien en poche (le hook de descente tente une chasse bornée, puis descend quoi
//      qu'il arrive — même à 0 point) ;
//   2. une fois sous terre, la quête de nourriture (foodRunTick) passe en SOURDINE 15 min après une
//      passe stérile (`food_run_done gained:0 next_min:15`, NethBot3 12:20) : la règle est juste pour
//      une ZONE vidée de gibier, fausse pour un mineur — la remontée l'emmène AILLEURS (/home safe).
//
// Porte 1 (`descentFoodGate`) : avant de descendre, au moins DESCENT_MIN_POINTS points en poche ;
// sinon le planner retente plus tard (la chasse bornée du hook a déjà eu lieu). Sans boucle : au plus
// GATE_MAX_REFUSALS refus par fenêtre de 10 min, PERSISTÉS (le self-healing relance souvent le
// process) — au-delà on descend quand même : creuser vaut mieux que tourner en surface sans gibier
// (la chair de zombie tuée en route compte, cf. food.foodPoints).
// Porte 2 (`undergroundFoodTripDue`) : sous terre, faim ≤ 8 et rien de comestible → la quête part
// malgré la sourdine (cooldown propre, plus court, lui aussi persisté).

const DESCENT_MIN_POINTS = 6;          // ~1 steak, 3 chairs de zombie : de quoi tenir une descente
const GATE_WINDOW_MS = 10 * 60 * 1000;
const GATE_MAX_REFUSALS = 2;
const HERD_GATE_MAX_REFUSALS = 6;    // porte « troupeau connu » : au plus 6 refus / 10 min
const LONG_WINDOW_MS = 30 * 60 * 1000;   // fenêtre longue des refus (24/10)
const LONG_MAX_REFUSALS = 8;            // au-delà : on descend quand même
const MEAL_MIN_POINTS = 2;              // « un repas » : 1 viande crue / 1 chair de zombie
const SURFACE_Y = 45;                  // même plancher que caution.FOOD_SURFACE_Y
const STARVING_HUNGER = 6;              // faim ≤ 6 et poche vide : sortie longue avant toute descente
const STARVING_LONG_TRIP_MS = 15 * 60000;   // une longue tentée depuis < 15 min : on reprend les règles habituelles
const STARVING_MAX_REFUSALS = 16;           // refus « starving » au plus sur 30 min, puis on descend
const UNDER_HUNGER = 8;
const FAMINE_HUNGER = 4;                // surface STÉRILE : on descend quand même, sauf faim ≤ 4 à 0 point
const UNDER_TRIP_COOLDOWN_MS = 4 * 60 * 1000;

function _times(arr, now, windowMs) {
  return (Array.isArray(arr) ? arr : []).filter((t) => Number.isFinite(t) && t <= now && now - t < windowMs);
}

// RUN 21/10 soir (world_oct9, 20:14 → 23:14) : NethBot2 7 refus, NethBot3 10. Sur les 17, 12 suivaient une
// chasse qui venait de répondre `no_prey:no_passive` (rien en vue : zone vidée, nuit, abri) — refuser ne
// pouvait RIEN rapporter : le planner relançait aussitôt la même descente, re-jouait le hook (armure,
// chasse) pour un 2e refus tout aussi vide, ou partait sur un autre but (bois de nuit → `night_hold`).
// Une chasse SANS proie en vue n'est pas une chance de plus : on descend tout de suite (`no_prey`) avec ce
// qu'on a — la chair de zombie tuée en bas compte (food.foodPoints), et la porte 2 remonte à faim ≤ 8.
// Le refus ne garde son sens qu'après une chasse qui a VU du gibier sans le tuer (`hunt_failed`).

/**
 * PUR — peut-on descendre ?
 * s = { points, y, refusals: number[] (horodatages persistés), now, noPrey: bool (la chasse d'avant n'a vu aucune proie),
 *       hunger: number (bot.food), longTripAt: ms (dernière sortie longue tentée, mémo de base),
 *       herdNear: bool (un troupeau connu à ≤ 200 blocs),
 *       herdTried: bool (ce troupeau est déjà marqué raté) }
 * → { allow, reason: 'stocked'|'underground'|'herd_known'|'herd_gate_spent'|'no_prey'|'gate'|'gate_spent', refusals: number[] (à persister), need }
 * Sous la surface on ne bloque jamais (il n'y a plus rien à chasser : c'est la porte 2 qui s'en occupe).
 */
// SURFACE STÉRILE (25/10, monde de 8 h) : 10 refus en 10 min (`herd_known` / `starving`) alors qu'il ne
// restait AUCUN animal à 96 blocs (les animaux ne réapparaissent pas) et que le dernier troupeau visé
// avait rendu 0 (`food_trip_done {arrived:true, got:0}`). Rester en haut ne pouvait rien rapporter ; en
// bas il y a des zombies (chair, food.foodPoints) et la porte 2 remonte à faim ≤ 8.
// `animalsInView === false` (rien à ≤ 64 blocs) ET (`herdBarren` : dernière arrivée bredouille < 30 min,
// OU aucun troupeau connu) → on descend. Garde-fou anti-famine conservé : faim ≤ 4 à 0 point = refus
// `starving` (borné comme avant). `animalsInView` absent = inconnu → comportement d'avant.
function _barrenSurface(s) {
  return s.animalsInView === false && (s.herdBarren === true || s.herdNear !== true);
}

function descentFoodGate(s = {}) {
  const now = Number.isFinite(s.now) ? s.now : Date.now();
  const barren = _barrenSurface(s);
  const refusals = _times(s.refusals, now, GATE_WINDOW_MS);
  // Fenêtre LONGUE (24/10 : `descend_y54` refusé 20 fois chez un bot, 8 chez l'autre — mineurs coincés en
  // surface pendant que les autres minaient) : les refus de 30 min sont gardés et comptés à part. Au-delà de
  // LONG_MAX_REFUSALS on descend quoi qu'il arrive — une heure en surface à attendre du gibier tue le quota,
  // et sous terre la porte 2 (undergroundFoodTripDue) remonte à faim ≤ 8.
  const longRefusals = _times(s.refusals, now, LONG_WINDOW_MS);
  // AFFAMÉ ET À SEC (24/10 : 3 famines en 35 min, la faim tombe de 9 à 1 en ~2 min de minage) : faim ≤ 6 et
  // 0 point en poche → on NE descend PAS, on fait d'abord la sortie longue (foodTrip.longTripDue). Passe
  // AVANT la fenêtre longue (elle laisserait descendre à vide). Bornée : une sortie longue tentée depuis
  // < 15 min (`longTripAt`) rend la main aux règles habituelles, et au-delà de STARVING_MAX_REFUSALS refus
  // en 30 min on descend quand même (la chair de zombie du fond compte).
  const pts0 = Number(s.points) || 0;
  const hunger = Number(s.hunger);
  const lt = Number(s.longTripAt);
  const longRecent = Number.isFinite(lt) && lt > 0 && lt <= now && now - lt < STARVING_LONG_TRIP_MS;
  const barrenOk = barren && !(pts0 <= 0 && Number.isFinite(hunger) && hunger <= FAMINE_HUNGER);
  if (pts0 <= 0 && Number.isFinite(hunger) && hunger <= STARVING_HUNGER && Number.isFinite(s.y) && s.y >= SURFACE_Y && !longRecent && !barrenOk) {
    if (longRefusals.length >= STARVING_MAX_REFUSALS) return { allow: true, reason: 'starving_spent', refusals: longRefusals, need: DESCENT_MIN_POINTS };
    return { allow: false, reason: 'starving', refusals: longRefusals.concat([now]), need: DESCENT_MIN_POINTS };
  }
  if (longRefusals.length >= LONG_MAX_REFUSALS && Number.isFinite(s.y) && s.y >= SURFACE_Y
      && !((Number(s.points) || 0) >= DESCENT_MIN_POINTS)) {
    return { allow: true, reason: 'gate_long_spent', refusals: longRefusals, need: DESCENT_MIN_POINTS };
  }
  const need = DESCENT_MIN_POINTS;
  const points = Number(s.points) || 0;
  if (points >= need) return { allow: true, reason: 'stocked', refusals, need };
  if (!(Number.isFinite(s.y) && s.y >= SURFACE_Y)) return { allow: true, reason: 'underground', refusals, need };
  if (barrenOk) return { allow: true, reason: 'barren_surface', refusals, need };
  // 23/10 : ZÉRO point en poche et un troupeau CONNU à portée de marche (`herdNear`, huntReach.knownHerdNear
  // ≤ 200 blocs) → descendre, c'est mourir de faim au fond (NethBot1 15:40, NethBot3 15:45 : `gate_spent`
  // puis « starved to death » alors que `herds_seen` rapportait 6-12 bêtes). La porte ne se dépense plus :
  // le planner retente, et chaque nouvelle tentative rejoue la chasse et l'expédition vers ce troupeau.
  // Borné par la mémoire des troupeaux elle-même (TTL 1 h, oubli à l'arrivée bredouille, cellule ratée 20 min).
  // BORNÉE : 6 refus en 10 min, ou troupeau visé déjà marqué raté (une chasse ne l'a pas atteint) → on
  // descend avec ce qu'on a (sinon un bot devant une bête injoignable restait jusqu'à 1 h en surface).
  if (points <= 0 && s.herdNear === true) {
    if (s.herdTried === true || refusals.length >= HERD_GATE_MAX_REFUSALS) return { allow: true, reason: 'herd_gate_spent', refusals, need };
    return { allow: false, reason: 'herd_known', refusals: longRefusals.concat([now]), need };
  }
  if (s.noPrey === true) return { allow: true, reason: 'no_prey', refusals, need };
  if (refusals.length >= GATE_MAX_REFUSALS) return { allow: true, reason: 'gate_spent', refusals, need };
  // Un repas en poche (viande crue, chair de zombie comprise : food.foodPoints) et déjà un refus : on
  // descend — on mange aussi sous terre, et une seconde attente en surface ne rapporte presque jamais rien.
  if (points >= MEAL_MIN_POINTS && refusals.length >= 1) return { allow: true, reason: 'some_food', refusals, need };
  return { allow: false, reason: 'gate', refusals: longRefusals.concat([now]), need };
}

/**
 * PUR — sous terre, affamé et à sec : la remontée nourriture est-elle due, sourdine ou pas ?
 * s = { y, food, foodItems, now, lastTripAt }
 */
function undergroundFoodTripDue(s = {}) {
  if (!(Number.isFinite(s.y) && s.y < SURFACE_Y)) return false;
  if (!(Number.isFinite(s.food) && s.food <= UNDER_HUNGER)) return false;
  const stock = Number(s.foodItems);
  if (Number.isFinite(stock) && stock > 0) return false;      // il a de quoi manger : au filet d'agir
  const now = Number.isFinite(s.now) ? s.now : Date.now();
  const last = Number(s.lastTripAt);
  if (Number.isFinite(last) && last > 0 && last <= now && now - last < UNDER_TRIP_COOLDOWN_MS) return false;
  return true;
}

/** PUR — état persisté lu depuis le mémo de base (champ `foodGate`), toujours bien formé. */
function foodGateLoad(st) {
  const o = (st && st.foodGate && typeof st.foodGate === 'object') ? st.foodGate : {};
  return {
    refusals: Array.isArray(o.refusals) ? o.refusals.filter(Number.isFinite) : [],
    lastUnderTripAt: Number.isFinite(o.lastUnderTripAt) ? o.lastUnderTripAt : 0,
  };
}

module.exports = {
  descentFoodGate, undergroundFoodTripDue, foodGateLoad,
  STARVING_HUNGER, STARVING_LONG_TRIP_MS, STARVING_MAX_REFUSALS,
  FAMINE_HUNGER,
  DESCENT_MIN_POINTS, GATE_WINDOW_MS, LONG_WINDOW_MS, LONG_MAX_REFUSALS, MEAL_MIN_POINTS, GATE_MAX_REFUSALS, HERD_GATE_MAX_REFUSALS, SURFACE_Y, UNDER_HUNGER, UNDER_TRIP_COOLDOWN_MS,
};
