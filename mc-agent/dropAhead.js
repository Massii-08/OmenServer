'use strict';
// DESCENTE — `drop_ahead` au même endroit = changer de CAP (run 20/10, NethBot1 session 235).
//
// Vécu : `goal_failed descend_y16 reason:drop_ahead` ×4 en 5 ms, puis `autonomous_retry in_s:90`, et
// rebelote. `descendDiagonal` prend son cap dans `bot.entity.yaw` (arrondi au cardinal) : relancé du
// même point avec le même regard, il retrouve le même vide au même palier — l'échec est garanti. Le
// filet existant (`workStuck`) ne s'arme que pour une descente PAR LE CHANTIER (`_workSet`), pas pour
// un premier puits.
// Règle : au 2e `drop_ahead` à ≤ 8 blocs d'un précédent dans les 10 min, TOURNER de 90° (le planner
// relancera la descente dans la nouvelle direction) ; au 4e au même endroit (les 4 cardinaux y sont
// passés), se DÉCALER de 30-50 blocs à pied sur un cap qui tourne (angle d'or, comme workDrown).
// PUR (horloge et positions en argument).

const RADIUS = 8;
const WINDOW_MS = 10 * 60 * 1000;
const SHIFT_AT = 4;                 // 4e échec au même endroit → les 4 cardinaux ont été essayés
const SHIFT_MIN = 30;
const SHIFT_MAX = 50;
const MAX_SITES = 32;

function _ok(p) { return !!(p && Number.isFinite(p.x) && Number.isFinite(p.z)); }

/**
 * Enregistre un `drop_ahead` et décide.
 * @param sites [{x,z,t}] précédents (NON muté)
 * @returns { sites, count, action: 'none'|'turn'|'shift' } — count = nb d'échecs à cet endroit, celui-ci compris.
 */
function noteDropAhead(sites, pos, now) {
  const kept = (Array.isArray(sites) ? sites : [])
    .filter((s) => _ok(s) && Number.isFinite(s.t) && s.t <= now && now - s.t < WINDOW_MS);
  if (!_ok(pos)) return { sites: kept, count: 0, action: 'none' };
  const near = kept.filter((s) => Math.hypot(s.x - pos.x, s.z - pos.z) <= RADIUS).length;
  const next = kept.concat([{ x: pos.x, z: pos.z, t: now }]).slice(-MAX_SITES);
  const count = near + 1;
  let action = 'none';
  if (count >= SHIFT_AT) action = 'shift';
  else if (count >= 2) action = 'turn';
  return { sites: next, count, action };
}

/** PUR — yaw tourné de 90° (sens horaire mineflayer), normalisé dans ]-π, π]. */
function turnYaw(yaw) {
  let y = (Number.isFinite(yaw) ? yaw : 0) + Math.PI / 2;
  while (y > Math.PI) y -= 2 * Math.PI;
  while (y <= -Math.PI) y += 2 * Math.PI;
  return y;
}

/** PUR — point de décalage 30-50 blocs, cap qui tourne avec `seed` (angle d'or). `{x, z, yaw}`. */
function shiftTarget(pos, seed = 0) {
  const n = Number.isFinite(seed) ? seed : 0;
  const angle = (n * 2.39996323) % (Math.PI * 2);
  const dist = SHIFT_MIN + ((n * 7) % (SHIFT_MAX - SHIFT_MIN + 1));
  const dx = Math.cos(angle), dz = Math.sin(angle);
  return {
    x: Math.round(pos.x + dist * dx),
    z: Math.round(pos.z + dist * dz),
    yaw: Math.atan2(-dx, -dz),                 // regarder dans le sens de la marche (formule bot.lookAt)
  };
}

module.exports = { noteDropAhead, turnYaw, shiftTarget, RADIUS, WINDOW_MS, SHIFT_AT, SHIFT_MIN, SHIFT_MAX };
