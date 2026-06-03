'use strict';
// Coordination multi-cartographes (Phase 1c). Pur/testable.
//  - SECTEURS : chaque mapper i (sur N) reçoit un wedge angulaire (heading) avec un léger recouvrement
//    aux frontières → les N mappers s'éventent dans des directions différentes sans laisser de trou.
//  - SKIP : retire les waypoints dont la cellule est DÉJÀ cartographiée (mémoire du groupe) → un mapper
//    frais évite de re-couvrir ce que lui/les autres ont déjà vu (anti-chevauchement entre runs/mappers).

const TAU = 2 * Math.PI;

function _norm(a) { return ((a % TAU) + TAU) % TAU; }

/**
 * Wedge angulaire du mapper `index` parmi `count`, avec recouvrement `overlapDeg` de part et d'autre
 * (anti-trou aux frontières). count<=1 → cercle complet. Retourne {start, end, full} (radians [0,2π)).
 */
function sectorRange(index, count, overlapDeg = 15) {
  if (!count || count <= 1) return { start: 0, end: TAU, full: true };
  const center = (TAU * index) / count;
  const half = Math.PI / count;            // demi-largeur pour paver le cercle
  const ov = (overlapDeg * Math.PI) / 180;
  return { start: _norm(center - half - ov), end: _norm(center + half + ov), full: false };
}

/** Cap (radians, [0,2π)) du point vu depuis `origin` dans le plan x,z. */
function headingOf(origin, point) {
  return _norm(Math.atan2(point.z - origin.z, point.x - origin.x));
}

/** Le cap `angle` est-il dans le wedge `range` ? (gère le wrap autour de 0) */
function inSector(angle, range) {
  if (!range || range.full) return true;
  const a = _norm(angle), s = range.start, e = range.end;
  return s <= e ? (a >= s && a <= e) : (a >= s || a <= e);
}

/** Garde les waypoints dont le cap (depuis origin) tombe dans le secteur. */
function filterToSector(waypoints, origin, range) {
  if (!range || range.full) return waypoints.slice();
  return waypoints.filter((w) => inSector(headingOf(origin, w), range));
}

function _q(v, grid) { return Math.floor(v / grid) * grid; }

/** Cellule (x,z) déjà cartographiée dans la mémoire du monde ? (un biome OU une cave y est noté). */
function isCellMapped(memory, worldKey, x, z, grid = 128) {
  const w = memory && memory.worlds && memory.worlds[worldKey];
  if (!w) return false;
  const qx = _q(x, grid), qz = _q(z, grid);
  const hit = (arr) => (arr || []).some((e) => _q(e.x, grid) === qx && _q(e.z, grid) === qz);
  return hit(w.biomes) || hit(w.caves);
}

/** Retire les waypoints dont la cellule est déjà cartographiée (anti-chevauchement). */
function skipMapped(waypoints, memory, worldKey, grid = 128) {
  return waypoints.filter((w) => !isCellMapped(memory, worldKey, w.x, w.z, grid));
}

module.exports = { sectorRange, headingOf, inSector, filterToSector, isCellMapped, skipMapped };
