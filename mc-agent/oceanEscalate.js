'use strict';
// Escalade « zone océanique/humide PERSISTANTE » → relocate FORCÉ (live 22/06, ResBot1).
// Vécu : ResBot1 piégé dans une baie côtière dont tous les iron_ore mappés proches étaient humides.
// À chaque `ocean_stuck`, escapeWater le SORTAIT de l'eau → le warp/relocate (gaté sur `isInWater`
// APRÈS l'escape) ne se déclenchait jamais ; mais le nearest-first re-ciblait aussitôt les mêmes iron
// humides → ré-entrée dans l'eau → ocean_stuck → escape → … boucle infinie de barbotage, 0 minage,
// `unjam`×7. Même idée que `waterStuckTimes` (index.js) : on COMPTE les ocean_stuck dans une fenêtre ;
// au seuil, la baie est persistante → relocate, peu importe si l'escapeWater de CE tour a (temporairement)
// réussi. PUR (horloge passée en argument → testable).

const DEFAULT_WINDOW_MS = 180000;  // 3 min : fenêtre de persistance
const DEFAULT_THRESHOLD = 2;       // 2 ocean_stuck dans la fenêtre = baie persistante (le 1er = blip toléré)

/**
 * Enregistre un ocean_stuck à l'instant `now` et décide s'il faut FORCER un relocate.
 * @param times  tableau d'horodatages (ms) des ocean_stuck précédents. NON muté.
 * @param now    instant courant (ms).
 * @param opts   { windowMs, threshold }
 * @returns { times: number[], forceRelocate: boolean } — `times` filtré à la fenêtre (+ now inclus).
 */
function recordOceanStuck(times, now, opts = {}) {
  const windowMs = opts.windowMs != null ? opts.windowMs : DEFAULT_WINDOW_MS;
  const threshold = opts.threshold != null ? opts.threshold : DEFAULT_THRESHOLD;
  const arr = (Array.isArray(times) ? times : [])
    .filter((t) => Number.isFinite(t) && now - t < windowMs);
  arr.push(now);
  return { times: arr, forceRelocate: arr.length >= threshold };
}

module.exports = { recordOceanStuck, DEFAULT_WINDOW_MS, DEFAULT_THRESHOLD };
