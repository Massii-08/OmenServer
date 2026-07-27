'use strict';
// Escalade « JAM persistant au MÊME endroit » → relocate FORCÉ (live 22/06 SOIR, ResBot2).
// Vécu : ResBot2 figé à (381,65,395) — le jam-watchdog (index.js) émettait `unjam`×12 aux MÊMES
// coords sans JAMAIS escalader : il coupe le saut + creuse les blocs DEVANT (selon le yaw) puis
// stopMotion, et la tâche re-path… droit dans le même obstacle → boucle infinie, 0 descente, 0 minage.
// Les watchdogs flottant (`_floatFails`→relocate) et océan (`recordOceanStuck`) escaladent déjà ; le
// jam-watchdog était le seul SANS issue. Même principe que `recordOceanStuck` mais on exige que les
// jams successifs soient AU MÊME endroit (jams à des endroits différents = flailing normal, chaque
// unjam débloque et le bot avance). PUR (horloge + position passées en argument → testable).

const DEFAULT_WINDOW_MS = 120000;  // 2 min : fenêtre de persistance
const DEFAULT_THRESHOLD = 3;       // 3 unjams ~même spot dans la fenêtre = jam persistant (le dig échoue)
const DEFAULT_SAME_DIST = 4;       // ≤4 blocs (horizontal) = « même endroit »

// ─── 2e TIER : giveUp (relocate PROUVÉ futile) ────────────────────────────────────────────────────
// Live NethBot4 27/07 (world_mn9) : bot NO_GIVE+confine FIGÉ à la surface de son ancre (0,0,~119).
// L'escalade `unjam_relocate` appelle relocateToRegion qui, sous confine+nogive, warpe vers l'ANCRE
// confine = LE SPOT DE JAM lui-même → re-jam → re-escalade… boucle infinie (mesuré : 27 unjam au même
// (-2,-18,119-120), 0 descente, session gelée de 4300 à 77 events). recordJam ré-escaladait sans fin
// (count remis à 0 à chaque escalade). 2e tier : des escalades RÉPÉTÉES au MÊME endroit prouvent que le
// relocate ne débloque pas → giveUp → l'appelant fait process.exit (miroir death_loop/starved) → le
// self-heal respawne un process FRAIS (état pathfinder/jam vidé, planner repart, keepInventory garde le
// fer) qui casse le piège. Un bot productif bouge après relocate → escalades à des spots DIFFÉRENTS →
// compteur remis à 1 → jamais giveUp (protégé).
const DEFAULT_GIVEUP_ESCALATIONS = 3;   // 3 escalades relocate ~même spot dans la fenêtre = futile
const DEFAULT_GIVEUP_WINDOW_MS = 300000; // 5 min : chaque escalade coûte ≥3 jams (~30-60 s), 3 tiennent large

/**
 * Enregistre un `unjam` à (x,z)/`now` et décide s'il faut FORCER un relocate, puis ABANDONNER.
 * @param state  état précédent { x, z, t, count, escCount, escT, escX, escZ } ou null.
 * @param x,z    position horizontale du jam courant.
 * @param now    instant courant (ms).
 * @param opts   { windowMs, threshold, sameDist, giveUpEscalations, giveUpWindowMs }
 * @returns { state, escalate: boolean, giveUp: boolean }
 *          escalate : relocate forcé (count remis à 0, anti-spam).
 *          giveUp   : escalades répétées au même endroit → relocate futile → l'appelant sort du process.
 */
function recordJam(state, x, z, now, opts = {}) {
  const windowMs = opts.windowMs != null ? opts.windowMs : DEFAULT_WINDOW_MS;
  const threshold = opts.threshold != null ? opts.threshold : DEFAULT_THRESHOLD;
  const sameDist = opts.sameDist != null ? opts.sameDist : DEFAULT_SAME_DIST;
  const giveUpEsc = opts.giveUpEscalations != null ? opts.giveUpEscalations : DEFAULT_GIVEUP_ESCALATIONS;
  const giveUpWin = opts.giveUpWindowMs != null ? opts.giveUpWindowMs : DEFAULT_GIVEUP_WINDOW_MS;
  const st = state || {};

  let count = 1;
  if (Number.isFinite(st.t) && now - st.t < windowMs) {
    const d = Math.sqrt((x - st.x) ** 2 + (z - st.z) ** 2);
    if (d <= sameDist) count = (st.count || 0) + 1;   // même endroit → on cumule
  }
  // On propage l'état d'escalade (escCount/escX/escZ/escT) tant qu'on n'escalade pas.
  if (count < threshold) {
    return {
      state: { x, z, t: now, count, escCount: st.escCount, escT: st.escT, escX: st.escX, escZ: st.escZ },
      escalate: false, giveUp: false,
    };
  }
  // ESCALADE : le relocate va être forcé. 2e tier : cette escalade est-elle au ~même endroit qu'une
  // escalade récente ? Si oui, le relocate précédent n'a rien débloqué → on cumule vers giveUp.
  let escCount = 1;
  if (Number.isFinite(st.escT) && now - st.escT < giveUpWin
      && Number.isFinite(st.escX) && Number.isFinite(st.escZ)
      && Math.sqrt((x - st.escX) ** 2 + (z - st.escZ) ** 2) <= sameDist) {
    escCount = (st.escCount || 0) + 1;
  }
  const giveUp = escCount >= giveUpEsc;
  return {
    state: { x, z, t: now, count: 0, escCount: giveUp ? 0 : escCount, escT: now, escX: x, escZ: z },
    escalate: true, giveUp,
  };
}

module.exports = {
  recordJam,
  DEFAULT_WINDOW_MS, DEFAULT_THRESHOLD, DEFAULT_SAME_DIST,
  DEFAULT_GIVEUP_ESCALATIONS, DEFAULT_GIVEUP_WINDOW_MS,
};
