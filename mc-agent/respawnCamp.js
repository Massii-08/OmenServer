'use strict';
// POINT DE RÉAPPARITION CAMPÉ (live 22/10, world_oct22, NethBot3).
//
// Mesuré : 9 morts « slain by Zombie » entre 07:49:11 et 07:51:38 UTC, toutes à quelques secondes d'une
// réapparition au MÊME point (93,64,-50 — un `/spawnpoint` posé par le bot à 07:10:08, raison `base`,
// en lisière de forêt). L'anti-camping existant (deathspots, death_spot_banned, escapeArmed) juge
// l'endroit de la MORT (94,-59 banni) et le moment des morts — jamais le point de RÉAPPARITION lui-même,
// qui restait le camp : l'évasion à pied n'a eu lieu qu'à la 4ᵉ vie (après 66 s terré), et le
// `/spawnpoint` n'a été déplacé (57,67,-23) qu'au bout de 9 morts.
//
// Ce module : la mémoire des VIES (point de réapparition + instant + instant de mort), persistée dans
// le mémo de base (un bot qui meurt toutes les 10 s relance son process, cf. deathLoopTripped), et le
// verdict « ce point est campé » : ≥ 2 vies de < 60 s commencées à ≤ 8 blocs du DERNIER point de
// réapparition, dans les 10 dernières minutes. PUR : aucun bot, aucune horloge en dur.

const LIVES_KEY = 'respawnLives';       // mémo de base : [{ x, z, t, d? }]
const CAMPED_KEY = 'campedRespawns';    // mémo de base : [{ x, z, at, deaths }]
const RESPAWN_CAMP_RADIUS = 8;
const SHORT_LIFE_MS = 60 * 1000;
const RESPAWN_CAMP_MIN_DEATHS = 2;
const LIVES_WINDOW_MS = 10 * 60 * 1000;
const LIVES_CAP = 12;
const CAMPED_TTL_MS = 30 * 60 * 1000;   // un camp oublié après 30 min (les zombies finissent par partir)
const CAMPED_CAP = 6;
const CAMPED_NEAR_RADIUS = 24;          // « près d'un camp » pour poser un lit : même rayon que spawnpointVeto

const _num = (v) => typeof v === 'number' && Number.isFinite(v);
const _arr = (v) => (Array.isArray(v) ? v : []);

/** PUR — vies valides, de moins de `LIVES_WINDOW_MS`, jamais datées du futur, plafonnées aux plus récentes. */
function livesPrune(lives, now) {
  if (!_num(now)) return [];
  const kept = _arr(lives)
    .filter((l) => l && _num(l.x) && _num(l.z) && _num(l.t) && l.t <= now && now - l.t < LIVES_WINDOW_MS)
    .map((l) => (_num(l.d) && l.d >= l.t ? { x: l.x, z: l.z, t: l.t, d: l.d } : { x: l.x, z: l.z, t: l.t }))
    .sort((a, b) => a.t - b.t);
  return kept.length > LIVES_CAP ? kept.slice(kept.length - LIVES_CAP) : kept;
}

/** PUR — une vie commence (spawn/réapparition) à `pos`. Ne mute pas l'entrée. */
function livesNoteSpawn(lives, pos, now) {
  const base = livesPrune(lives, now);
  if (!pos || !_num(pos.x) || !_num(pos.z)) return base;
  return livesPrune(base.concat([{ x: Math.round(pos.x), z: Math.round(pos.z), t: now }]), now);
}

/** PUR — la vie en cours (la dernière sans mort) s'achève à `now`. */
function livesNoteDeath(lives, now) {
  const out = livesPrune(lives, now);
  for (let i = out.length - 1; i >= 0; i--) {
    if (!_num(out[i].d)) { out[i] = Object.assign({}, out[i], { d: now }); break; }
  }
  return out;
}

/**
 * PUR — le DERNIER point de réapparition est-il campé ? Compte les vies BRÈVES (morte < 60 s après le
 * spawn) commencées à ≤ 8 blocs de ce point. null sinon, { x, z, deaths } si ≥ 2.
 */
function campedRespawn(lives, now, opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const radius = _num(o.radius) ? o.radius : RESPAWN_CAMP_RADIUS;
  const minDeaths = _num(o.minDeaths) ? o.minDeaths : RESPAWN_CAMP_MIN_DEATHS;
  const ls = livesPrune(lives, now);
  if (!ls.length) return null;
  const last = ls[ls.length - 1];
  const deaths = ls.filter((l) => _num(l.d) && l.d - l.t < SHORT_LIFE_MS
    && Math.hypot(l.x - last.x, l.z - last.z) <= radius).length;
  return deaths >= minDeaths ? { x: last.x, z: last.z, deaths } : null;
}

/** PUR — vies relues du mémo (absent / ancien format → []). */
function livesLoad(memo, now) {
  return livesPrune(memo && typeof memo === 'object' ? memo[LIVES_KEY] : null, now);
}

/** PUR — COPIE du mémo où seul `respawnLives` change (tout le reste traverse : piège #61). */
function livesMemoWith(memo, lives, now) {
  const base = (memo && typeof memo === 'object' && !Array.isArray(memo)) ? memo : {};
  return Object.assign({}, base, { [LIVES_KEY]: livesPrune(lives, now) });
}

/** PUR — camps encore frais du mémo. */
function campedList(memo, now) {
  if (!_num(now)) return [];
  return _arr(memo && typeof memo === 'object' ? memo[CAMPED_KEY] : null)
    .filter((c) => c && _num(c.x) && _num(c.z) && _num(c.at) && c.at <= now && now - c.at < CAMPED_TTL_MS);
}

/** PUR — COPIE du mémo avec ce camp ajouté (un camp à ≤ 8 blocs d'un connu le remplace). */
function campedMemoWith(memo, camp, now) {
  const base = (memo && typeof memo === 'object' && !Array.isArray(memo)) ? memo : {};
  const list = campedList(base, now)
    .filter((c) => !camp || Math.hypot(c.x - camp.x, c.z - camp.z) > RESPAWN_CAMP_RADIUS);
  if (camp && _num(camp.x) && _num(camp.z)) list.push({ x: camp.x, z: camp.z, at: now, deaths: camp.deaths || 0 });
  return Object.assign({}, base, { [CAMPED_KEY]: list.slice(-CAMPED_CAP) });
}

/** PUR — `pos` est-il à ≤ `radius` d'un camp frais ? Rend le camp, ou null. */
function campedNear(memo, pos, now, radius = CAMPED_NEAR_RADIUS) {
  if (!pos || !_num(pos.x) || !_num(pos.z)) return null;
  return campedList(memo, now).find((c) => Math.hypot(c.x - pos.x, c.z - pos.z) <= radius) || null;
}

/** PUR — le lit mémorisé `{x,y,z}` est-il CE point de réapparition campé ? (on réapparaît à côté du lit) */
function bedIsCampedPoint(bed, camp, radius = RESPAWN_CAMP_RADIUS) {
  if (!bed || !camp || !_num(bed.x) || !_num(bed.z) || !_num(camp.x) || !_num(camp.z)) return false;
  return Math.hypot(bed.x - camp.x, bed.z - camp.z) <= radius;
}

module.exports = {
  LIVES_KEY, CAMPED_KEY, RESPAWN_CAMP_RADIUS, SHORT_LIFE_MS, RESPAWN_CAMP_MIN_DEATHS, LIVES_WINDOW_MS,
  LIVES_CAP, CAMPED_TTL_MS, CAMPED_NEAR_RADIUS,
  livesPrune, livesNoteSpawn, livesNoteDeath, campedRespawn, livesLoad, livesMemoWith,
  campedList, campedMemoWith, campedNear, bedIsCampedPoint,
};
