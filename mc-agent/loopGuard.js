'use strict';
// BOUCLES SANS FIN QUI BLOQUENT L'EVENT LOOP (OOM 23/10, ≈300 sessions « heap out of memory » depuis août).
// Signature : le tas monte jusqu'à la limite (640 Mo) sans qu'AUCUN timer ne tourne — ni l'échantillonneur
// `heap_high` (2 s), ni `goal_trace`, ni le moindre event pendant 10-15 s. Le code fautif tourne d'un seul
// tenant (boucle synchrone, ou chaîne de microtâches qui ne rend jamais la main aux timers).
// Ce module porte deux gardes génériques, PURS (horloge, emit et defer injectés) :
//   1. `createCapReporter` — rapport `sync_loop_capped {where, count}` APRÈS coup (setImmediate : on ne
//      fait aucune écriture au milieu de la boucle qu'on vient de couper), ≤ 1 par `where` / 10 s ;
//   2. `createLoopLagWatch` — retard de l'event loop mesuré par un tick périodique (heure attendue vs
//      heure réelle) → `loop_lag {ms, phase}` au-delà de 2 s. Il ne peut PAS parler pendant une boucle
//      infinie (il est lui-même un timer), mais il chiffre chaque gel qui finit par rendre la main.

const CAP_THROTTLE_MS = 10000;
const LAG_INTERVAL_MS = 1000;
const LAG_THRESHOLD_MS = 2000;

/** Rapporteur `sync_loop_capped`. `report(where, extra)` : compte, et émet (différé, borné) le compte cumulé. */
function createCapReporter({ emit = () => {}, throttleMs = CAP_THROTTLE_MS, now = Date.now,
  defer = (fn) => setImmediate(fn) } = {}) {
  const last = new Map();      // where → dernier envoi
  const pending = new Map();   // where → coupes pas encore rapportées
  function report(where, extra) {
    try {
      const w = String(where || 'unknown');
      pending.set(w, (pending.get(w) || 0) + 1);
      const t = now();
      const prev = last.get(w);
      if (prev != null && t - prev < throttleMs) return false;
      last.set(w, t);
      const count = pending.get(w);
      pending.set(w, 0);
      const ev = Object.assign({}, extra || {}, { type: 'sync_loop_capped', where: w, count });
      defer(() => { try { emit(ev); } catch (e) { /* télémétrie : jamais de throw */ } });
      return true;
    } catch (e) {
      return false;
    }
  }
  return { report };
}

/**
 * Compteur d'itérations pour une boucle à risque : `const over = loopCap(512, 'floodFillVein', rep)` puis
 * `if (over()) break;` en tête de boucle. Vrai (et rapporté) au-delà de `max` tours.
 */
function loopCap(max, where, reporter, extra) {
  let n = 0;
  return () => {
    n += 1;
    if (n <= max) return false;
    if (n === max + 1 && reporter && typeof reporter.report === 'function') {
      reporter.report(where, Object.assign({ max }, extra || {}));
    }
    return true;
  };
}

/**
 * Mesure du retard de l'event loop. `tick(nowMs)` est appelé par un setInterval de `intervalMs` : le retard
 * est l'écart entre l'heure attendue (dernier tick + intervalle) et l'heure réelle. Au-delà de
 * `thresholdMs` → `onLag({ ms, phase })`. Le premier tick ne mesure rien (pas de référence).
 */
function createLoopLagWatch({ intervalMs = LAG_INTERVAL_MS, thresholdMs = LAG_THRESHOLD_MS,
  now = Date.now, onLag = () => {}, phase = () => null } = {}) {
  let lastAt = null;
  function tick(t = now()) {
    let lag = 0;
    if (lastAt != null) lag = Math.max(0, t - (lastAt + intervalMs));
    lastAt = t;
    if (lag > thresholdMs) {
      let ph = null;
      try { ph = phase(); } catch (e) { ph = null; }
      try { onLag({ ms: Math.round(lag), phase: ph }); } catch (e) { /* télémétrie */ }
    }
    return lag;
  }
  return { tick };
}

module.exports = {
  createCapReporter, loopCap, createLoopLagWatch,
  CAP_THROTTLE_MS, LAG_INTERVAL_MS, LAG_THRESHOLD_MS,
};
