'use strict';
// ─── PLANNER ORPHELIN (live 24/10, NethBot1 session 599 + NethBot2 session 583) ──────────────────
// Deux charges sur squelette ENCHAÎNÉES (la 2e démarre ~200 ms après la fin de la 1re) : la 1re a coupé
// le planner et attend que son skill rende la main pour le relancer ; la 2e fait `taskCtl.begin` → le
// jeton de la 1re est annulé (sa relance abandonne, en silence) et la 2e voit `prevTask = 'skeleton_rush'`
// → elle ne se croit pas débitrice du planner → `taskCtl.cancel()`. Plus AUCUN runner, plus de tâche
// active : le watchdog historique (plannerWatchdog.js) exige `taskCtl.active === 'autonomous'` et un runner
// vivant → il ne voit RIEN. 18 min (NethBot1) et 24 min (NethBot2) sans un `goal`, phase diamant figée.
// PUR : 1) la dette de relance qui se TRANSMET d'une préemption à la suivante ; 2) le filet « orphelin ».

const ORPHAN_IDLE_MS = 3 * 60 * 1000;     // plus un `goal` depuis 3 min…
const ORPHAN_CONFIRM_MS = 30 * 1000;      // …et orphelin observé sur 2 passages (30 s) : pas une transition
const ORPHAN_GAP_MS = 3 * 60 * 1000;      // une relance au plus toutes les 3 min

// Tâches posées par un ORDRE JOUEUR : on ne les écrase jamais (le joueur a la main).
const PLAYER_ORDER_TASKS = new Set(['come', 'follow', 'goto', 'guard', 'loiter', 'pvp', 'take']);

/**
 * Une préemption (charge squelette, fuite…) doit-elle relancer le planner en partant ?
 * Oui si elle a coupé le planner (ou une migration, qu'il reprendra) — OU si elle a coupé une autre
 * préemption qui, elle, le DEVAIT (la dette se transmet ; sinon elle meurt avec le jeton annulé).
 */
function rushResumesPlanner({ prevTask, outerOwes } = {}) {
  if (prevTask === 'autonomous' || prevTask === 'migration') return true;
  return prevTask === 'skeleton_rush' && !!outerOwes;
}

/**
 * → { fire, why, idleS, orphan }   (`orphan` : l'état orphelin tient — l'appelant horodate `orphanSince`)
 * s : { now, chain (objectif à chaîne en cours), alive, runners, owner (taskCtl.active), parked (stop/afk
 *       joueur), lastGoalAt, orphanSince (0 = pas encore vu), lastFireAt, migrating, shelter, sleeping,
 *       nightHold, skillInFlight, survivalBusy }
 */
function plannerOrphanVerdict(s = {}) {
  const now = Number.isFinite(s.now) ? s.now : Date.now();
  const last = Number.isFinite(s.lastGoalAt) && s.lastGoalAt > 0 ? s.lastGoalAt : now;
  const idleS = Math.round(Math.max(0, now - last) / 1000);
  const no = (why, orphan = false) => ({ fire: false, why, idleS, orphan });
  if (!s.chain) return no('no_chain');
  if (!s.alive) return no('dead');
  if ((s.runners || 0) > 0) return no('running');           // un planner vit : l'autre watchdog le surveille
  if (s.parked) return no('player_parked');
  if (s.owner && PLAYER_ORDER_TASKS.has(s.owner)) return no('player_order');
  if (s.migrating) return no('migrating');
  if (s.shelter) return no('shelter');
  if (s.sleeping) return no('sleeping');
  if ((s.nightHold || 0) > 0) return no('night_hold');
  if ((s.skillInFlight || 0) > 0) return no('skill');
  if (s.survivalBusy) return no('survival_busy');
  // À partir d'ici : personne ne fait tourner le planner et rien de légitime ne le retient.
  if (now - last < ORPHAN_IDLE_MS) return no('fresh', true);
  if (Number.isFinite(s.lastFireAt) && s.lastFireAt > 0 && now - s.lastFireAt < ORPHAN_GAP_MS) return no('cooldown', true);
  if (!(s.orphanSince > 0) || now - s.orphanSince < ORPHAN_CONFIRM_MS) return no('confirming', true);
  return { fire: true, why: 'orphan', idleS, orphan: true };
}

module.exports = {
  rushResumesPlanner, plannerOrphanVerdict, PLAYER_ORDER_TASKS,
  ORPHAN_IDLE_MS, ORPHAN_CONFIRM_MS, ORPHAN_GAP_MS,
};
