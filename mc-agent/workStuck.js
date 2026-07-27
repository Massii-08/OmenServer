'use strict';
// Abandon d'un chantier de minage (`chantier`) menant à une IMPASSE SÈCHE → oubli du chantier + relocate (live 27/07, world_mn9).
// Miroir SEC de `wsiteDrown` : vécu NethBot4 en boucle 15× consécutives `descend_via_home_wsite → drop_ahead`,
// 0 minerai, vivant-en-panne. Un échec de descente SEC (drop_ahead/max_depth/air_at_y/lava_ahead) via le chantier
// établi ne faisait RIEN (seul l'échec EAU armait le relocate) → _wsiteMineSet restait true → re-descente /home
// chantier au MÊME puits (galeries minées autour = drop_ahead partout) → boucle infinie. wsiteDrown ne couvre QUE
// le cas noyé. On COMPTE les échecs SECS via le chantier dans une fenêtre ; au seuil, le chantier mène à une impasse
// sèche → on l'ABANDONNE + on ARME le relocate → puits FRAIS 30-50 blocs plus loin. PUR (horloge en argument → testable).

const DEFAULT_WINDOW_MS = 240000;  // 4 min : fenêtre de persistance (miroir exact wsiteDrown)
const DEFAULT_THRESHOLD = 2;       // 2 échecs SECS via le chantier dans la fenêtre = impasse sèche (le 1er = blip toléré)

/**
 * Enregistre un échec de descente SEC via le chantier à l'instant `now` et décide s'il faut ABANDONNER le chantier.
 * @param times  tableau d'horodatages (ms) des échecs SECS précédents. NON muté.
 * @param now    instant courant (ms).
 * @param opts   { windowMs, threshold }
 * @returns { times: number[], abandon: boolean } — `times` filtré à la fenêtre (+ now inclus).
 */
function recordWorkStuck(times, now, opts = {}) {
  const windowMs = opts.windowMs != null ? opts.windowMs : DEFAULT_WINDOW_MS;
  const threshold = opts.threshold != null ? opts.threshold : DEFAULT_THRESHOLD;
  const arr = (Array.isArray(times) ? times : [])
    .filter((t) => Number.isFinite(t) && now - t < windowMs);
  arr.push(now);
  return { times: arr, abandon: arr.length >= threshold };
}

module.exports = { recordWorkStuck, DEFAULT_WINDOW_MS, DEFAULT_THRESHOLD };
