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
const SURFACE_Y = 45;                  // même plancher que caution.FOOD_SURFACE_Y
const UNDER_HUNGER = 8;
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
 * s = { points, y, refusals: number[] (horodatages persistés), now, noPrey: bool (la chasse d'avant n'a vu aucune proie) }
 * → { allow, reason: 'stocked'|'underground'|'no_prey'|'gate'|'gate_spent', refusals: number[] (à persister), need }
 * Sous la surface on ne bloque jamais (il n'y a plus rien à chasser : c'est la porte 2 qui s'en occupe).
 */
function descentFoodGate(s = {}) {
  const now = Number.isFinite(s.now) ? s.now : Date.now();
  const refusals = _times(s.refusals, now, GATE_WINDOW_MS);
  const need = DESCENT_MIN_POINTS;
  const points = Number(s.points) || 0;
  if (points >= need) return { allow: true, reason: 'stocked', refusals, need };
  if (!(Number.isFinite(s.y) && s.y >= SURFACE_Y)) return { allow: true, reason: 'underground', refusals, need };
  if (s.noPrey === true) return { allow: true, reason: 'no_prey', refusals, need };
  if (refusals.length >= GATE_MAX_REFUSALS) return { allow: true, reason: 'gate_spent', refusals, need };
  return { allow: false, reason: 'gate', refusals: refusals.concat([now]), need };
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
  DESCENT_MIN_POINTS, GATE_WINDOW_MS, GATE_MAX_REFUSALS, SURFACE_Y, UNDER_HUNGER, UNDER_TRIP_COOLDOWN_MS,
};
