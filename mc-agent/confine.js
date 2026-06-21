'use strict';
// Confinement (test en ARÈNE de minage contrôlée) : garde un bot ressource dans un petit rayon
// autour d'une ancre SÈCHE, au lieu de le disperser via relocateToRegion (qui vise 256..520 blocs
// = HORS d'une arène de 33×33 → le bot atterrit en terrain naturel humide/cavé et n'y revient
// jamais — vécu nuit du 22/06 : ResBot1 warpé à -869 sur un seul floating_relocate). Quand --confine
// "X Z R" est passé, TOUT relocate (nearSpawn/diamondCluster/forest/plain) re-spread dans R de (X,Z).

/** "X Z R" → { x, z, radius } (entiers) ; null si absent/invalide ou radius ≤ 0. */
function parseConfine(s) {
  if (!s) return null;
  const p = String(s).trim().split(/\s+/).map(Number);
  if (p.length < 3 || p.some((n) => !Number.isFinite(n))) return null;
  const x = Math.round(p[0]), z = Math.round(p[1]), radius = Math.round(p[2]);
  if (radius <= 0) return null;
  return { x, z, radius };
}

/** /spreadplayers <x> <z> <spreadDistance=0> <maxRange=radius> false <user> → atterrit à ≤radius de l'ancre. */
function confineSpreadCommand(username, conf) {
  return '/spreadplayers ' + conf.x + ' ' + conf.z + ' 0 ' + conf.radius + ' false ' + username;
}

module.exports = { parseConfine, confineSpreadCommand };
