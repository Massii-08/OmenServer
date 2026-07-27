'use strict';
// Abandon d'un chantier de minage (`chantier`) ADJACENT À UN AQUIFÈRE → oubli du chantier (live 27/07, world_mn9).
// Vécu : 3/5 workers en boucle noyade, 118 sauvetages-noyade cumulés, 0 minerai. Le /home safe RAPIDE de
// onWaterStuck PRÉEMPTE le waterlocked_relocate (seul chemin qui oublie le chantier) → la re-descente /home
// chantier RAMÈNE au même chantier adjacent à l'aquifère → re-noyade → /home safe → … boucle infinie de barbotage.
// Même idée que `recordOceanStuck` : on COMPTE les sauvetages-noyade RAMENANT au chantier dans une fenêtre ;
// au seuil, le chantier est prouvé adjacent à un aquifère → on l'ABANDONNE (`_wsiteMineSet=false`) → la
// re-descente creuse un puits FRAIS ailleurs au lieu de /home chantier. PUR (horloge passée en argument → testable).

const DEFAULT_WINDOW_MS = 240000;  // 4 min : fenêtre de persistance
const DEFAULT_THRESHOLD = 2;       // 2 sauvetages-noyade RAMENANT au chantier dans la fenêtre = aquifère adjacent (le 1er = blip toléré)

/**
 * Enregistre un sauvetage-noyade ramenant au chantier à l'instant `now` et décide s'il faut ABANDONNER le chantier.
 * @param times  tableau d'horodatages (ms) des sauvetages précédents. NON muté.
 * @param now    instant courant (ms).
 * @param opts   { windowMs, threshold }
 * @returns { times: number[], abandon: boolean } — `times` filtré à la fenêtre (+ now inclus).
 */
function recordWorkDrown(times, now, opts = {}) {
  const windowMs = opts.windowMs != null ? opts.windowMs : DEFAULT_WINDOW_MS;
  const threshold = opts.threshold != null ? opts.threshold : DEFAULT_THRESHOLD;
  const arr = (Array.isArray(times) ? times : [])
    .filter((t) => Number.isFinite(t) && now - t < windowMs);
  arr.push(now);
  return { times: arr, abandon: arr.length >= threshold };
}

// ─── 3a : BANNIR le chantier noyé, pas seulement l'oublier (Massii 27/07) ───────────────────────
// L'oubli seul ne suffisait pas : la re-descente re-perçait le MÊME aquifère quelques blocs plus
// loin. Le mécanisme est connu — le réflexe anti-noyade (`/home safe`, rapide) PRÉEMPTE le
// relogement (`waterlocked_relocate`, lent), donc le bot revient au chantier adjacent à la nappe
// et se re-noie. On mémorise le lieu, on refuse d'y re-creuser, et on impose un décalage.
// ⚠️ Périmètre STRICT : rien ici ne touche à `descendDiagonal` (code le plus itéré du projet).

const DROWNED_SITE_RADIUS = 16;             // « le même chantier » : la nappe s'étend au-delà du trou
const DROWNED_SITE_TTL_MS = 30 * 60 * 1000; // un bannissement expire : la carte évolue, la nappe peut être drainée
const OFFSET_MIN = 30;                      // décalage imposé : assez pour percer du terrain NEUF
const OFFSET_MAX = 50;                      // mais pas au point de quitter la poche de confine

function _finite(p) { return !!p && Number.isFinite(p.x) && Number.isFinite(p.z); }

/** Mémorise un chantier noyé (et purge les bannissements expirés). NON mutant. */
function noteDrownedSite(sites, pos, now) {
  const kept = (Array.isArray(sites) ? sites : [])
    .filter((s) => _finite(s) && Number.isFinite(s.at) && (now - s.at) <= DROWNED_SITE_TTL_MS);
  if (!_finite(pos)) return kept;
  return kept.concat([{ x: Math.round(pos.x), z: Math.round(pos.z), at: now }]);
}

/** Ce point retombe-t-il sur un chantier déjà prouvé noyé ? (pur) */
function isDrownedNear(sites, pos, now, radius = DROWNED_SITE_RADIUS) {
  if (!Array.isArray(sites) || !_finite(pos)) return false;
  return sites.some((s) => _finite(s) && Number.isFinite(s.at)
    && (now - s.at) <= DROWNED_SITE_TTL_MS
    && Math.hypot(s.x - pos.x, s.z - pos.z) <= radius);
}

/**
 * Où re-poser le chantier après une noyade ? (pur, DÉTERMINISTE par essai)
 * Un décalage de 30-50 blocs sur un cap qui TOURNE à chaque essai : re-tenter le même cap
 * retomberait dans la même nappe, qui s'étend rarement dans toutes les directions.
 */
function offsetFromDrowned(pos, seed = 0) {
  const base = _finite(pos) ? pos : { x: 0, z: 0 };
  const n = Number.isFinite(seed) ? seed : 0;
  const angle = (n * 2.39996323) % (Math.PI * 2);     // angle d'or : dispersion maximale entre essais
  const dist = OFFSET_MIN + ((n * 7) % (OFFSET_MAX - OFFSET_MIN + 1));
  return {
    x: Math.round(base.x + dist * Math.cos(angle)),
    z: Math.round(base.z + dist * Math.sin(angle)),
  };
}

module.exports = {
  recordWorkDrown, DEFAULT_WINDOW_MS, DEFAULT_THRESHOLD,
  noteDrownedSite, isDrownedNear, offsetFromDrowned,
  DROWNED_SITE_RADIUS, DROWNED_SITE_TTL_MS, OFFSET_MIN, OFFSET_MAX,
};
