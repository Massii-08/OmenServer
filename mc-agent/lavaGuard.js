'use strict';
// LAVE (live 23/10 : 5 morts de mineurs en 30 min — « burned to death », « tried to swim in lava »,
// « … to escape Skeleton » — contre 4 sur 115 en 8 h avant). Mesure dans les journaux (chaque mort, les
// 40 s qui précèdent) : deux familles.
//   1. CREUSER À CÔTÉ DE LA LAVE : ramassage opportuniste de charbon (`ore_grabbed` 0,3 s avant la brûlure),
//      fin d'une collecte (`moves_restored by collect` 0,5 s avant) en plein serpentin à y≈14. Le ramassage
//      n'avait AUCUNE garde lave ; la veine (floodFillVein) non plus ; et la Movements de collectBlock met
//      `dontCreateFlow = false` à chaque collect — ses trajets cassaient des blocs qui retenaient la lave.
//   2. FUIR DANS LA LAVE : `creeper_flee` / `reflex flee` puis la lave 0,5 s plus tard. Le pathfinder refuse
//      d'ENTRER dans une case de lave (blocksToAvoid d'usine) mais rien ne l'écarte des cases qui la BORDENT :
//      une fuite au sprint, un saut parkour ou le recul d'une flèche finissent dedans.
//
// Ce module : décisions PURES (blockAt injecté) + installation sur une Movements de mineflayer-pathfinder.
//   • `lavaFaces` / `lavaAdjacent` — la lave sur les 6 faces d'un bloc (garde des creusages) ;
//   • `lavaStepPenalty` — pénalité d'un PAS (exclusionAreasStep) dans une case qui borde la lave ;
//   • `installLavaGuard` — pénalité de pas + `safeToBreak` qui refuse de casser un bloc qui retient la lave
//     (même quand un plugin a remis `dontCreateFlow` à false : l'eau reste son affaire, la lave non) ;
//   • `strictFor` — fenêtre de FUITE : la pénalité monte juste sous le plafond 100 de la lib (« seulement
//     s'il n'y a vraiment aucune autre issue ») — un rejet sec laisserait un bot acculé sans chemin du tout ;
//   • `lateralHazard` — le pas de zigzag de la charge squelette tombe-t-il dans la lave / le feu ?

const { Vec3 } = require('vec3');

const FACES = Object.freeze([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]);
const LAVA_STEP_PENALTY = 40;     // trajet ordinaire : un détour sec de ≤ 40 blocs par case bordière l'emporte
const LAVA_STEP_STRICT = 95;      // fuite : dernier recours, toujours < 100 (la lib rejette au-delà)
const CACHE_TTL_MS = 1000;        // la lave coule : on ne garde une lecture qu'une seconde
const CACHE_MAX = 20000;

// NIVEAU MODULE (lu depuis l'A* appelé par des timers, piège #56) : fin de la fenêtre de fuite.
let _strictUntil = 0;

function isLavaName(n) { return n === 'lava' || n === 'flowing_lava'; }
function isFireName(n) { return n === 'fire' || n === 'soul_fire'; }
function _name(b) { return (b && b.name) || ''; }
function _read(blockAt, x, y, z) {
  try { return blockAt(new Vec3(x, y, z)); } catch (e) { return null; }
}

/** Ouvre (ou prolonge) la fenêtre de fuite : la lave bordière devient un dernier recours. */
function strictFor(ms, now = Date.now()) {
  if (!Number.isFinite(ms) || ms <= 0) return _strictUntil;
  _strictUntil = Math.max(_strictUntil, now + ms);
  return _strictUntil;
}
function isStrict(now = Date.now()) { return now < _strictUntil; }
function _resetStrict() { _strictUntil = 0; }

/** PUR — positions de lave sur les 6 faces de `pos` (entiers). [] si aucune / entrée invalide. */
function lavaFaces(blockAt, pos) {
  const out = [];
  if (typeof blockAt !== 'function' || !pos) return out;
  const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
  if (![x, y, z].every(Number.isFinite)) return out;
  for (const [dx, dy, dz] of FACES) {
    const b = _read(blockAt, x + dx, y + dy, z + dz);
    if (b && isLavaName(b.name)) out.push({ x: x + dx, y: y + dy, z: z + dz });
  }
  return out;
}
function lavaAdjacent(blockAt, pos) { return lavaFaces(blockAt, pos).length > 0; }

/**
 * PUR — pénalité d'un pas dans la case `block` (exclusionAreasStep). La lib l'appelle sur la case des pieds
 * ET celle de la tête : chacune est jugée sur ses 6 faces (lave dessous = sol de lave, à côté = rebord).
 * @returns {number} 0 | LAVA_STEP_PENALTY | LAVA_STEP_STRICT
 */
function lavaStepPenalty(blockAt, block, opts = {}) {
  try {
    if (!block || !block.position) return 0;
    const near = typeof opts.adjacent === 'function' ? opts.adjacent(block.position) : lavaAdjacent(blockAt, block.position);
    if (!near) return 0;
    return isStrict(opts.now != null ? opts.now : Date.now()) ? LAVA_STEP_STRICT : LAVA_STEP_PENALTY;
  } catch (e) {
    return 0;                                          // jamais d'exception dans l'A*
  }
}

const GUARDED = Symbol.for('mca.lavaGuard.guarded');

/**
 * Accroche le garde-fou lave à une Movements. Idempotent. Les copies `Object.assign`
 * (movement.withTempMovements) héritent du même tableau exclusionAreasStep et du `safeToBreak` enveloppé.
 * @param {object} moves — instance de Movements
 * @param {Function} blockAt — `(p) => bot.blockAt(p)` (reçoit des Vec3)
 * @param {{now?: Function}} [opts]
 * @returns {boolean}
 */
function installLavaGuard(moves, blockAt, opts = {}) {
  try {
    if (!moves || !Array.isArray(moves.exclusionAreasStep) || typeof blockAt !== 'function') return false;
    if (moves[GUARDED]) return true;
    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    const cache = new Map();
    let cacheAt = 0;
    const adjacent = (pos) => {
      const t = now();
      if (t - cacheAt > CACHE_TTL_MS || cache.size > CACHE_MAX) { cache.clear(); cacheAt = t; }
      const k = Math.floor(pos.x) + ',' + Math.floor(pos.y) + ',' + Math.floor(pos.z);
      let v = cache.get(k);
      if (v === undefined) { v = lavaAdjacent(blockAt, pos); cache.set(k, v); }
      return v;
    };
    moves.exclusionAreasStep.push((b) => lavaStepPenalty(blockAt, b, { adjacent, now: now() }));
    const orig = moves.safeToBreak;
    if (typeof orig === 'function') {
      moves.safeToBreak = function safeToBreakNoLava(block) {
        try { if (block && block.position && adjacent(block.position)) return false; } catch (e) { /* lecture ratée */ }
        return orig.call(this, block);
      };
    }
    moves[GUARDED] = true;
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * PUR — case visée par un pas latéral (contrôle 'left'/'right') à `dist` blocs, d'après le yaw mineflayer.
 * prismarine-physics : droite = (+cos yaw, −sin yaw), gauche = (−cos yaw, +sin yaw).
 */
function strafeCell(me, yaw, side, dist = 1) {
  if (!me || !Number.isFinite(yaw) || (side !== 'left' && side !== 'right')) return null;
  const s = side === 'right' ? 1 : -1;
  return {
    x: Math.floor(me.x + s * Math.cos(yaw) * dist),
    y: Math.floor(me.y),
    z: Math.floor(me.z - s * Math.sin(yaw) * dist),
  };
}

/**
 * PUR — le pas latéral du zigzag mène-t-il dans la lave ou le feu ? On sonde à 1 et 2 blocs (l'élan) :
 * case des pieds, et son sol — et, si ce sol est vide, le bloc d'en dessous (on y tomberait).
 * @returns {null|'lava'|'fire'}
 */
function lateralHazard(blockAt, me, yaw, side) {
  if (typeof blockAt !== 'function') return null;
  for (const dist of [1, 2]) {
    const c = strafeCell(me, yaw, side, dist);
    if (!c) return null;
    const cells = [_read(blockAt, c.x, c.y, c.z), _read(blockAt, c.x, c.y - 1, c.z)];
    const floor = cells[1];
    if (floor && floor.boundingBox !== 'block') cells.push(_read(blockAt, c.x, c.y - 2, c.z));
    for (const b of cells) {
      const n = _name(b);
      if (isLavaName(n)) return 'lava';
      if (isFireName(n)) return 'fire';
    }
  }
  return null;
}

/** Limiteur d'events `lava_avoided` : au plus un par `where` toutes les `ms`. */
function createAvoidedThrottle(ms = 10000) {
  const last = new Map();
  return (where, t = Date.now()) => {
    const prev = last.get(where);
    if (prev != null && t - prev < ms) return false;
    last.set(where, t);
    return true;
  };
}

module.exports = {
  FACES, LAVA_STEP_PENALTY, LAVA_STEP_STRICT,
  isLavaName, isFireName, lavaFaces, lavaAdjacent, lavaStepPenalty, installLavaGuard,
  strictFor, isStrict, strafeCell, lateralHazard, createAvoidedThrottle, _resetStrict,
};
