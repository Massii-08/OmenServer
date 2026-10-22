'use strict';
// ─── JETON DE L'ABRI DE NUIT (live 22/10, NethBot1 session 152) ─────────────────────────────────
// 4da4587a a donné à l'abri un jeton DÉRIVÉ du jeton de tâche global (`deriveToken(taskToken)`) pour
// que sa borne dure puisse l'annuler. Mais le global peut être DÉJÀ annulé au moment où l'abri démarre :
// `fleeDeathCamp` (via:foot) fait `taskCtl.cancel()` à 952917, le planner sort (`night_hold_end
// reason:cancelled`), et plus rien ne re-pose de jeton vivant. Chaque abri suivant (timer de
// regroupement, toutes les 20 s en lockdown) naissait annulé → `shelterUntilDawn` sortait aussitôt :
// `sealed:false why:cancelled depth:0 took_ms:0-2` ×10, `shelter_reenter count:10`, nuit passée
// dehors, 5 morts à l'aube.
// Règle : un abri ne NAÎT jamais annulé. Il suit le parent s'il est VIVANT ; sinon il ne voit que les
// préemptions POSTÉRIEURES à son démarrage (génération du contrôleur de tâche). Toujours annulable par
// son propre setter (borne dure, aube, watchdog). PUR.

/**
 * @param {{cancelled:boolean}|null} parent  jeton de tâche courant (peut être déjà mort)
 * @param {(() => number)|null} generation   génération du contrôleur (taskCtl.generation)
 * @param {{fresh?:boolean}} opts            fresh = après une boucle d'annulations : seul le setter compte
 */
function shelterToken(parent, generation, opts = {}) {
  const read = () => { try { return typeof generation === 'function' ? generation() : null; } catch (e) { return null; } };
  const forced = !!(opts && opts.fresh);
  const parentAlive = !forced && !!(parent && !parent.cancelled);
  const g0 = forced ? null : read();
  let own = false;
  return {
    inherited: forced ? 'forced_fresh' : (parentAlive ? 'live' : 'fresh'),
    get cancelled() {
      if (own) return true;
      if (forced) return false;
      if (parentAlive && parent.cancelled) return true;
      const g = g0 == null ? null : read();
      return g != null && g !== g0;
    },
    set cancelled(v) { own = !!v; },
  };
}

const SHELTER_CANCEL_LOOP_N = 3;                 // `cancelled` d'affilée…
const SHELTER_CANCEL_LOOP_MS = 2 * 60 * 1000;    // …en moins de 2 min = boucle

/**
 * Série d'abris finis `cancelled`. → { state, loop, count }. `loop` vrai UNE fois (puis série remise à
 * zéro) : l'appelant trace `shelter_cancel_loop` et force un jeton NEUF au prochain abri.
 */
function shelterCancelLoopNote(state, { reason, now } = {}) {
  const t = Number.isFinite(now) ? now : Date.now();
  if (reason !== 'cancelled') return { state: { times: [] }, loop: false, count: 0 };
  const times = ((state && state.times) || []).filter((x) => t - x < SHELTER_CANCEL_LOOP_MS).concat([t]);
  if (times.length >= SHELTER_CANCEL_LOOP_N) return { state: { times: [] }, loop: true, count: times.length };
  return { state: { times }, loop: false, count: times.length };
}

module.exports = { shelterToken, shelterCancelLoopNote, SHELTER_CANCEL_LOOP_N, SHELTER_CANCEL_LOOP_MS };
