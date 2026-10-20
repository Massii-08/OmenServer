'use strict';
// VERROU DE BUT PATHFINDER (fuite creeper, 20/10) — un réflexe de survie qui pose un but ne doit pas
// se le faire voler par le planner au tick suivant.
//
// Mesuré (run 20/10, 11 morts « blown up by Creeper » en 1 h) : `creeper_avoid` posait son but de fuite
// et, LA MÊME MILLISECONDE, `explore.js:113` (le but `logs` du planner) posait le sien
// (`explore_waypoint` au même ts) — le bot repartait vers le creeper et mourait 0,4-2,7 s plus tard.
// Le pathfinder n'a qu'UN but (piège #72a) : le dernier appel gagne.
//
// `installGoalHold(pathfinder, state)` enveloppe `pathfinder.setGoal` : tant que `state.until` n'est
// pas dépassé, tout appel ÉTRANGER (planner, goto, pvp, stopMotion → setGoal(null)) est IGNORÉ et compté.
// Le propriétaire du verrou passe par `holdSetGoal(pathfinder, state, goal)`.
//
// Pourquoi ignorer plutôt que ré-imposer notre but après coup : ré-imposer fait rejeter le goto
// étranger en GoalChanged → le skill échoue instantanément → le planner reboucle (garde anti-boucle-
// chaude : 8 tours < 150 ms = `stalled hot_loop`). Ignoré, le goto étranger reste simplement EN ATTENTE
// (il n'a pas reçu `goal_updated`) : il se résout quand notre but est atteint, ou se rejette au prochain
// vrai changement de but — la tâche est SUSPENDUE pendant la fuite, pas cassée.
// Durée bornée par l'appelant (quelques secondes) : un verrou ne peut pas geler le bot.

const WRAPPED = Symbol.for('mca.goalHold.wrapped');

/** État neuf (à garder au NIVEAU MODULE de index.js, piège #56). */
function createHoldState() {
  return { until: 0, bypass: false, dropped: 0, owner: null };
}

/** PUR — le verrou est-il actif à l'instant `now` ? */
function isHeld(state, now) {
  return !!state && Number.isFinite(state.until) && now < state.until;
}

/** Enveloppe `pathfinder.setGoal` une seule fois. `now` injectable. Retourne true si posé. */
function installGoalHold(pathfinder, state, now = Date.now) {
  if (!pathfinder || typeof pathfinder.setGoal !== 'function' || !state) return false;
  if (pathfinder.setGoal[WRAPPED]) return true;
  const orig = pathfinder.setGoal;
  const held = function (goal, dynamic) {
    if (!state.bypass && isHeld(state, now())) { state.dropped++; return undefined; }
    return orig.apply(this, arguments);
  };
  held[WRAPPED] = true;
  pathfinder.setGoal = held;
  return true;
}

/** Pose `goal` en traversant le verrou (propriétaire). */
function holdSetGoal(pathfinder, state, goal, dynamic = false) {
  state.bypass = true;
  try { return pathfinder.setGoal(goal, dynamic); } finally { state.bypass = false; }
}

/** Arme (ou prolonge) le verrou jusqu'à `until`. */
function hold(state, until, owner) {
  state.until = Math.max(state.until || 0, until);
  state.owner = owner || state.owner;
}

/** Relâche le verrou ; rend le nombre d'appels ignorés pendant l'épisode. */
function release(state) {
  const n = state.dropped;
  state.until = 0; state.dropped = 0; state.owner = null;
  return n;
}

module.exports = { createHoldState, isHeld, installGoalHold, holdSetGoal, hold, release };
