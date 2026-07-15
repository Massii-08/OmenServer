'use strict';
// Ban-zone des CAMPS DE MORT (piste n°2 rapport water-wall) — en hard, les mobs armés
// s'accumulent à un spot et y épinglent le bot (vécu Bot2 : imminent_bookmark_death ×25 au même
// xyz, 1,8 PV, toute la fin du run). Détection PURE : ≥2 alertes « mort imminente » ESPACÉES
// (≥20 s, anti-rafale du watchdog 1 s) dans un rayon de 64 → la zone est bannie (TTL 15 min,
// le temps que les mobs brûlent au jour/se dispersent) → le caller déclenche une FUITE active.
// État process-local (perdu au respawn process : très bien, la carte des dangers se réapprend).

const RADIUS = 64;
const MIN_GAP_MS = 20000;
const THRESHOLD = 2;
const TTL_MS = 900000; // 15 min

function _dist(ax, az, bx, bz) { return Math.hypot(ax - bx, az - bz); }

function _alive(z, now, ttlMs) {
  const last = z.hits.length ? z.hits[z.hits.length - 1] : 0;
  return (now - last) <= ttlMs;
}

/**
 * Enregistre une alerte « mort imminente » en (x,z) à `now`.
 * → {zones, newlyBanned, zone} — newlyBanned=true UNE seule fois par zone (déclenche la fuite).
 */
function note(zones, x, z, now, opts = {}) {
  const radius = opts.radius || RADIUS;
  const minGapMs = opts.minGapMs || MIN_GAP_MS;
  const threshold = opts.threshold || THRESHOLD;
  const ttlMs = opts.ttlMs || TTL_MS;
  const kept = (zones || []).filter((zn) => _alive(zn, now, ttlMs));
  let zone = kept.find((zn) => _dist(zn.x, zn.z, x, z) <= radius);
  let newlyBanned = false;
  if (!zone) {
    zone = { x, z, hits: [now], bannedAt: null };
    kept.push(zone);
  } else {
    const last = zone.hits[zone.hits.length - 1];
    if (now - last >= minGapMs) {
      zone.hits.push(now);
      if (!zone.bannedAt && zone.hits.length >= threshold) {
        zone.bannedAt = now;
        newlyBanned = true;
      }
    }
  }
  return { zones: kept, newlyBanned, zone };
}

/** La position (x,z) est-elle dans une zone bannie encore fraîche ? */
function isBanned(zones, x, z, now, opts = {}) {
  const radius = opts.radius || RADIUS;
  const ttlMs = opts.ttlMs || TTL_MS;
  return (zones || []).some((zn) => zn.bannedAt
    && (now - zn.bannedAt) <= ttlMs
    && _dist(zn.x, zn.z, x, z) <= radius);
}

module.exports = { note, isBanned, RADIUS, TTL_MS };
