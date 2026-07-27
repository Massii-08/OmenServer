'use strict';
// Abandon d'un chantier de minage (`wsite`) ADJACENT À UN AQUIFÈRE → oubli du wsite (live 27/07, world_mn9).
// Vécu : 3/5 workers en boucle noyade, 118 sauvetages-noyade cumulés, 0 minerai. Le /home safe RAPIDE de
// onWaterStuck PRÉEMPTE le waterlocked_relocate (seul chemin qui oublie le wsite) → la re-descente /home
// wsite RAMÈNE au même wsite adjacent à l'aquifère → re-noyade → /home safe → … boucle infinie de barbotage.
// Même idée que `recordOceanStuck` : on COMPTE les sauvetages-noyade RAMENANT au wsite dans une fenêtre ;
// au seuil, le wsite est prouvé adjacent à un aquifère → on l'ABANDONNE (`_wsiteMineSet=false`) → la
// re-descente creuse un puits FRAIS ailleurs au lieu de /home wsite. PUR (horloge passée en argument → testable).

const DEFAULT_WINDOW_MS = 240000;  // 4 min : fenêtre de persistance
const DEFAULT_THRESHOLD = 2;       // 2 sauvetages-noyade RAMENANT au wsite dans la fenêtre = aquifère adjacent (le 1er = blip toléré)

/**
 * Enregistre un sauvetage-noyade ramenant au wsite à l'instant `now` et décide s'il faut ABANDONNER le wsite.
 * @param times  tableau d'horodatages (ms) des sauvetages précédents. NON muté.
 * @param now    instant courant (ms).
 * @param opts   { windowMs, threshold }
 * @returns { times: number[], abandon: boolean } — `times` filtré à la fenêtre (+ now inclus).
 */
function recordWsiteDrown(times, now, opts = {}) {
  const windowMs = opts.windowMs != null ? opts.windowMs : DEFAULT_WINDOW_MS;
  const threshold = opts.threshold != null ? opts.threshold : DEFAULT_THRESHOLD;
  const arr = (Array.isArray(times) ? times : [])
    .filter((t) => Number.isFinite(t) && now - t < windowMs);
  arr.push(now);
  return { times: arr, abandon: arr.length >= threshold };
}

module.exports = { recordWsiteDrown, DEFAULT_WINDOW_MS, DEFAULT_THRESHOLD };
