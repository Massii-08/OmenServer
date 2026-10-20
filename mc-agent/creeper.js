'use strict';
// CREEPER : NE FUIR QUE SI LA MÈCHE EST ALLUMÉE (AltoClef MobDefenseChain, 20/10) — décisions PURES.
//
// Avant : un creeper VU (9-11 blocs, calme) suffisait à fuir, se cacher ou abandonner un but
// (`spawn_danger_flee mob:creeper`, `threat_hide`, `survival flee`…). Or un creeper ne fait rien tant
// qu'il ne gonfle pas : vanilla, il commence à gonfler quand sa cible est à < 3 blocs ET en vue, explose
// 1,5 s plus tard, et ANNULE si la cible s'éloigne à > 7 blocs. D'où les règles :
//   - gonfle et ≤ 7 blocs  → 'flee'   : s'éloigner à ~10 blocs (au-delà de 7, la mèche s'éteint) ;
//   - calme et ≤ 4,5 blocs → 'flee'   : FUITE FRANCHE aussi (fix 20/10, ci-dessous) ;
//   - sinon                → 'ignore' : ni fuite, ni cachette, ni but abandonné.
// Seul un creeper qui GONFLE est une « menace » au sens cachette/abri (creeperIsThreat) : se terrer
// contre un creeper est inutile (l'explosion traverse les blocs) — on le FUIT, on ne s'emmure pas.
//
// ⚠️ Fix 20/10 — l'ancien « calme et ≤ 4 → 'step_away' (s'écarter à 6 blocs) » TUAIT : 11 morts
// « blown up by Creeper » en 1 h, chacune précédée d'un `creeper_avoid step_away fusing:false` à
// 2,6-4 blocs, mort 0,4-2,7 s plus tard. Un creeper à < 3 blocs gonfle et explose en 1,5 s : le petit
// pas (6 blocs, verrouillé 3 s sans réévaluation, et volé au tick suivant par le planner) ne sortait
// jamais du rayon. La détection de la mèche marche (3 `fusing:true` vus) mais tombe dans le verrou de
// 3 s : la règle de DISTANCE doit suffire même si la mèche n'est jamais vue.
// On ne le frappe JAMAIS au corps-à-corps (NO_MELEE, gather.js / aura.js).
//
// La mèche : metadata de l'entité (prismarine-entity, tableau indexé par la clé du protocole).
// minecraft-data 1.20.1 → 1.21.11 : clé 16 = `swell_dir` (int, -1 calme, 1 gonfle), clé 18 = `is_ignited`
// (allumé au briquet). Vérifié par creeper.test.js contre minecraft-data ; si le registre est fourni
// (`metadataKeys`), l'index est relu dedans. Metadata absente → calme (jamais de faux « gonfle »).

const SWELL_DIR_INDEX = 16;
const IGNITED_INDEX = 18;
const FUSE_FLEE_RADIUS = 7;    // gonfle à ≤ 7 blocs → fuite (vanilla : la mèche s'éteint au-delà de 7)
const CLOSE_FLEE_RADIUS = 4.5;  // calme à ≤ 4,5 blocs → fuite franche (il gonfle sous 3, explose 1,5 s après)
const STEP_AWAY_RADIUS = CLOSE_FLEE_RADIUS;   // compat (ancien nom)
const SAFE_DIST = 8;           // la fuite dure jusqu'à ≥ 8 blocs du creeper
const FLEE_KEEP = 10;          // fuite : se placer à 10 blocs du creeper
const STEP_AWAY_KEEP = FLEE_KEEP;   // compat : plus de « petit pas »

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
 * Position du bot inconnue → prudent : 'flee'.
 */
function creeperPlan(entity, selfPos, opts = {}) {
  if (!entity || entity.name !== 'creeper') return null;
  const fusing = isCreeperFusing(entity, opts.metadataKeys);
  const d = _dist(selfPos, entity.position);
  if (d == null) return 'flee';
  if (fusing) return d <= FUSE_FLEE_RADIUS ? 'flee' : 'ignore';
  return d <= CLOSE_FLEE_RADIUS ? 'flee' : 'ignore';
}

/** PUR — ce creeper est-il une MENACE (cachette / but abandonné) ? Seulement s'il GONFLE à ≤ 7 blocs. */
function creeperIsThreat(entity, selfPos, opts = {}) {
  if (!entity || entity.name !== 'creeper') return false;
  if (!isCreeperFusing(entity, opts.metadataKeys)) return false;
  const d = _dist(selfPos, entity.position);
  return d == null || d <= FUSE_FLEE_RADIUS;
}

/**
 * PUR — la fuite en cours peut-elle s'arrêter ? Oui si le creeper a disparu, ou s'il est à ≥ SAFE_DIST
 * et ne gonfle pas. Un creeper qui gonfle ENCORE à 8-9 blocs : on continue (la mèche s'éteint à > 7,
 * mais un creeper qui suit la reprend aussitôt).
 */
function fleeDone(entity, selfPos, opts = {}) {
  if (!entity || entity.isValid === false || !entity.position) return true;
  const d = _dist(selfPos, entity.position);
  if (d == null) return false;
  if (isCreeperFusing(entity, opts.metadataKeys)) return d > FLEE_KEEP;
  return d >= SAFE_DIST;
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
  isCreeperFusing, creeperPlan, creeperIsThreat, awayPoint, fleeDone,
  SWELL_DIR_INDEX, IGNITED_INDEX, FUSE_FLEE_RADIUS, CLOSE_FLEE_RADIUS, STEP_AWAY_RADIUS, SAFE_DIST, FLEE_KEEP, STEP_AWAY_KEEP,
};
