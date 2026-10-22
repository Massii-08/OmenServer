'use strict';
// FUIR D'ABORD, CREUSER ENSUITE — décision PURE (20/10, run sessions ≥ 310).
//
// Mesuré (deaths.py sur 87 morts, 2 h 30) : 14 morts < 30 s après un respawn, dont 11 de NethBot3 en
// boucle au même point (-52, 86), de nuit. Séquence type, à chaque fois :
//   +0,4 s  spawned
//   +0,6 s  spawn_guard act=hide reason=hostile_near mob=zombie dist=0,3…6,1
//   +0,6 s  threat_hide → shelter dig_in      (le bot reste PLANTÉ à creuser son puits)
//   +3 s    reflex fight zombie · reflex flee
//   +5 s    shelter abort no_fall / void_below (le puits n'a même pas abouti)
//   +5,1 s  dead
// Creuser un puits de 3 + toit prend 3-10 s IMMOBILE ; avec un zombie à 2 blocs c'est une mort assurée
// (hard : ~3-4 coups). La règle d'hier (« se terrer, pas courir », run 10) reste juste QUAND RIEN N'EST
// AU CONTACT : on ne creuse qu'une fois qu'aucun hostile n'est à ≤ RESPAWN_FLEE_NEAR. Sinon on SPRINTE
// d'abord à ≥ RESPAWN_FLEE_KEEP blocs du barycentre des menaces, dans la direction opposée.

const RESPAWN_FLEE_NEAR = 8;      // un hostile à ≤ 8 blocs interdit de creuser sur place
// LIVE 22/10 (NethBot1 session 206, 5 morts en 85 s au point de réapparition) : `spawn_guard hide
// skeleton dist:10.2` puis `threat_hide skeleton dist:8.3` — un ARCHER à 8-16 blocs ne déclenchait pas
// la fuite (seuil mêlée de 8), le bot creusait sous ses flèches. Un tireur compte jusqu'à sa portée d'arc,
// et une meute (≥ 2 hostiles à ≤ 12) aussi : on ne creuse pas au milieu d'elle.
const RESPAWN_FLEE_NEAR_RANGED = 16;
const RESPAWN_FLEE_CROWD = 2;
const RESPAWN_FLEE_CROWD_RADIUS = 12;
const RESPAWN_FLEE_KEEP = 24;     // destination : ≥ 24 blocs du barycentre des menaces
const RESPAWN_FLEE_SCAN = 16;     // barycentre calculé sur les menaces à ≤ 16 blocs
const RESPAWN_FLEE_LEG_MS = 8000; // une jambe de fuite (ré-évaluée ensuite)
const RESPAWN_FLEE_LEGS = 2;      // au plus 2 jambes, puis on se terre quand même (jamais planté à l'infini)
const RESPAWN_STUCK_MS = 1500;    // < 1 bloc parcouru en 1,5 s = coincé (l'aura reprend le droit de frapper)
const RESPAWN_STUCK_MOVE = 1;

function _d(a, b) { return Math.hypot(a.x - b.x, (a.y || 0) - (b.y || 0), a.z - b.z); }

/**
 * PUR — faut-il fuir avant de creuser, et vers où ?
 * @param {{self:{x,y,z}, threats:Array<{x,y,z}>, near?:number, keep?:number, scan?:number}} o
 *   threats = positions des hostiles à craindre (déjà filtrées : pas d'enderman calme, creeper calme exclu) ;
 *   `ranged:true` sur un tireur (squelette…) : compte jusqu'à RESPAWN_FLEE_NEAR_RANGED
 * @returns {null | {dest:{x,z}, hostiles:number, dist:number}}  null = rien à ≤ near → on peut creuser
 */
function respawnFleePlan(o) {
  const opts = (o && typeof o === 'object') ? o : {};
  const self = opts.self;
  if (!self || !Number.isFinite(self.x) || !Number.isFinite(self.z)) return null;
  const near = Number.isFinite(opts.near) ? opts.near : RESPAWN_FLEE_NEAR;
  const keep = Number.isFinite(opts.keep) ? opts.keep : RESPAWN_FLEE_KEEP;
  const scan = Number.isFinite(opts.scan) ? opts.scan : RESPAWN_FLEE_SCAN;
  const list = (Array.isArray(opts.threats) ? opts.threats : [])
    .filter((t) => t && Number.isFinite(t.x) && Number.isFinite(t.z))
    .map((t) => ({ t, d: _d(self, t) }));
  const nearRanged = Number.isFinite(opts.nearRanged) ? opts.nearRanged : RESPAWN_FLEE_NEAR_RANGED;
  let close = list.filter((x) => x.d <= near || (x.t.ranged && x.d <= nearRanged));
  if (!close.length) {
    const crowd = list.filter((x) => x.d <= RESPAWN_FLEE_CROWD_RADIUS);
    if (crowd.length >= RESPAWN_FLEE_CROWD) close = crowd;
  }
  if (!close.length) return null;
  const group = list.filter((x) => x.d <= scan);
  let cx = 0, cz = 0;
  for (const g of group) { cx += g.t.x / group.length; cz += g.t.z / group.length; }
  let dx = self.x - cx, dz = self.z - cz;
  let len = Math.hypot(dx, dz);
  if (!len || !Number.isFinite(len) || len < 0.5) {
    // Encerclé (barycentre sur le bot) : fuir à l'opposé du PLUS PROCHE, sinon vers +x.
    const n = close.slice().sort((a, b) => a.d - b.d)[0].t;
    dx = self.x - n.x; dz = self.z - n.z; len = Math.hypot(dx, dz);
    if (!len || !Number.isFinite(len)) { dx = 1; dz = 0; len = 1; }
  }
  const dist = Math.min(...close.map((x) => x.d));
  return {
    dest: { x: Math.round(cx + (dx / len) * keep), z: Math.round(cz + (dz / len) * keep) },
    hostiles: group.length,
    dist: Math.round(dist * 10) / 10,
  };
}

/** PUR — coincé ? (parcouru < RESPAWN_STUCK_MOVE pendant RESPAWN_STUCK_MS). */
function fleeStuck(sample, pos, now) {
  if (!sample || !pos) return false;
  if (now - sample.t < RESPAWN_STUCK_MS) return false;
  return Math.hypot(pos.x - sample.x, pos.z - sample.z) < RESPAWN_STUCK_MOVE;
}

module.exports = {
  respawnFleePlan, fleeStuck,
  RESPAWN_FLEE_NEAR, RESPAWN_FLEE_NEAR_RANGED, RESPAWN_FLEE_CROWD, RESPAWN_FLEE_CROWD_RADIUS, RESPAWN_FLEE_KEEP, RESPAWN_FLEE_SCAN, RESPAWN_FLEE_LEG_MS, RESPAWN_FLEE_LEGS,
  RESPAWN_STUCK_MS, RESPAWN_STUCK_MOVE,
};
