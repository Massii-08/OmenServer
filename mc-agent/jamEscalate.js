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

/**
 * Enregistre un `unjam` à (x,z)/`now` et décide s'il faut FORCER un relocate.
 * @param state  état précédent { x, z, t, count } ou null.
 * @param x,z    position horizontale du jam courant.
 * @param now    instant courant (ms).
 * @param opts   { windowMs, threshold, sameDist }
 * @returns { state: {x,z,t,count}, escalate: boolean }
 *          Si escalade : state.count est remis à 0 (anti-spam : re-compte avant de ré-escalader).
 */
function recordJam(state, x, z, now, opts = {}) {
  const windowMs = opts.windowMs != null ? opts.windowMs : DEFAULT_WINDOW_MS;
  const threshold = opts.threshold != null ? opts.threshold : DEFAULT_THRESHOLD;
  const sameDist = opts.sameDist != null ? opts.sameDist : DEFAULT_SAME_DIST;

  let count = 1;
  if (state && Number.isFinite(state.t) && now - state.t < windowMs) {
    const d = Math.sqrt((x - state.x) ** 2 + (z - state.z) ** 2);
    if (d <= sameDist) count = (state.count || 0) + 1;   // même endroit → on cumule
  }
  if (count >= threshold) {
    return { state: { x, z, t: now, count: 0 }, escalate: true };
  }
  return { state: { x, z, t: now, count }, escalate: false };
}

module.exports = { recordJam, DEFAULT_WINDOW_MS, DEFAULT_THRESHOLD, DEFAULT_SAME_DIST };
