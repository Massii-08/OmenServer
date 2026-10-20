'use strict';
// CREEPER : NE FUIR QUE SI LA MÈCHE EST ALLUMÉE (AltoClef MobDefenseChain, 20/10) — décisions PURES.
//
// Avant : un creeper VU (9-11 blocs, calme) suffisait à fuir, se cacher ou abandonner un but
// (`spawn_danger_flee mob:creeper`, `threat_hide`, `survival flee`…). Or un creeper ne fait rien tant
// qu'il ne gonfle pas : vanilla, il commence à gonfler quand sa cible est à < 3 blocs ET en vue, explose
// 1,5 s plus tard, et ANNULE si la cible s'éloigne à > 7 blocs. D'où trois règles :
//   - gonfle et ≤ 7 blocs  → 'flee'      : s'éloigner à ~10 blocs (au-delà de 7, la mèche s'éteint) ;
//   - calme et ≤ 4 blocs   → 'step_away' : s'écarter calmement (il va gonfler) — PAS une raison de se terrer ;
//   - sinon                → 'ignore'    : ni fuite, ni cachette, ni but abandonné.
// On ne le frappe JAMAIS au corps-à-corps (NO_MELEE, gather.js / aura.js).
//
// La mèche : metadata de l'entité (prismarine-entity, tableau indexé par la clé du protocole).
// minecraft-data 1.20.1 → 1.21.11 : clé 16 = `swell_dir` (int, -1 calme, 1 gonfle), clé 18 = `is_ignited`
// (allumé au briquet). Vérifié par creeper.test.js contre minecraft-data ; si le registre est fourni
// (`metadataKeys`), l'index est relu dedans. Metadata absente → calme (jamais de faux « gonfle »).

const SWELL_DIR_INDEX = 16;
const IGNITED_INDEX = 18;
const FUSE_FLEE_RADIUS = 7;    // gonfle à ≤ 7 blocs → fuite (vanilla : la mèche s'éteint au-delà de 7)
const STEP_AWAY_RADIUS = 4;    // calme à ≤ 4 blocs → s'écarter (il gonfle sous 3)
const FLEE_KEEP = 10;          // fuite : se placer à 10 blocs du creeper
const STEP_AWAY_KEEP = 6;      // écart calme : 6 blocs

function _idx(keys, name, fallback) {
  if (Array.isArray(keys)) { const i = keys.indexOf(name); if (i >= 0) return i; }
  return fallback;
}

/** PUR — ce creeper gonfle-t-il (ou a-t-il été allumé) ? Metadata absente → false. */
function isCreeperFusing(entity, metadataKeys) {
  if (!entity || entity.name !== 'creeper') return false;
  const m = entity.metadata;
  if (!m || typeof m !== 'object') return false;
  const swell = m[_idx(metadataKeys, 'swell_dir', SWELL_DIR_INDEX)];
  if (typeof swell === 'number' && swell > 0) return true;
  const ign = m[_idx(metadataKeys, 'is_ignited', IGNITED_INDEX)];
  return ign === true;
}

function _dist(a, b) {
  if (!a || !b) return null;
  const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  return Number.isFinite(d) ? d : null;
}

/**
 * PUR — que faire de ce creeper ? null si ce n'est pas un creeper.
 * Position du bot inconnue → prudent : 'flee' s'il gonfle, 'step_away' sinon.
 */
function creeperPlan(entity, selfPos, opts = {}) {
  if (!entity || entity.name !== 'creeper') return null;
  const fusing = isCreeperFusing(entity, opts.metadataKeys);
  const d = _dist(selfPos, entity.position);
  if (d == null) return fusing ? 'flee' : 'step_away';
  if (fusing) return d <= FUSE_FLEE_RADIUS ? 'flee' : 'ignore';
  return d <= STEP_AWAY_RADIUS ? 'step_away' : 'ignore';
}

/** PUR — ce creeper est-il une MENACE (fuite / cachette / but abandonné) ? Seulement s'il faut le fuir. */
function creeperIsThreat(entity, selfPos, opts) {
  return creeperPlan(entity, selfPos, opts) === 'flee';
}

/** PUR — point à `keep` blocs du creeper, à l'opposé du bot (XZ ; y du bot, informatif). */
function awayPoint(selfPos, creeperPos, keep) {
  if (!selfPos || !creeperPos) return null;
  let dx = selfPos.x - creeperPos.x;
  let dz = selfPos.z - creeperPos.z;
  let len = Math.hypot(dx, dz);
  if (!len || !Number.isFinite(len)) { dx = 1; dz = 0; len = 1; }
  return { x: creeperPos.x + (dx / len) * keep, y: selfPos.y, z: creeperPos.z + (dz / len) * keep };
}

module.exports = {
  isCreeperFusing, creeperPlan, creeperIsThreat, awayPoint,
  SWELL_DIR_INDEX, IGNITED_INDEX, FUSE_FLEE_RADIUS, STEP_AWAY_RADIUS, FLEE_KEEP, STEP_AWAY_KEEP,
};
