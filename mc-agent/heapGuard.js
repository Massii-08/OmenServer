'use strict';
// OOM « au même endroit » du branch-mine (run 22-23/10) — décisions PURES, aucun bot.
//
// Mesuré (≈85 sessions crashées « JavaScript heap out of memory ») : le heap passe de 150 à 620 Mo en
// 10-25 s SANS aucun event, et la relance (self-healing) re-crashe 21-30 s plus tard AU MÊME ENDROIT
// (NethBot3 : (67,15,136) sessions 238→250, (-223,-22,248) 265→283, (-8,15,-57) 306→307). La séquence
// commune : `iron_deep`/`gift_iron` → `branchMine:enter` → quelques pas → silence → OOM pendant une
// approche du serpentin. La cause exacte n'est pas tranchée (cf. rapport) ; ce module porte :
//   1. le seuil/throttle de l'event `heap_high` (échantillonneur de index.js) ;
//   2. le DISJONCTEUR DE POSITION : la dernière position connue dans branchMine est persistée (mémo
//      base) et effacée à la sortie NORMALE de branchMine. Un process qui démarre et retrouve une
//      marque récente à ≤ 4 blocs de lui = le précédent est mort là, en plein branch-mine → on décale
//      le départ du serpentin au lieu de relancer le même tunnel sur la même case.
//
// Pourquoi la DERNIÈRE position et pas seulement celle d'entrée : dans les sessions crashées le bot
// avait déjà miné et posé une torche avant de mourir (306 : torche posée à (-8,15,-63), OOM à
// (-8,15,-55)) — une marque effacée au premier bloc miné n'aurait jamais rien détecté.

const HEAP_HIGH_MB = 400;           // seuil d'émission (limite du process : 640 Mo)
const HEAP_HIGH_THROTTLE_MS = 5000; // au plus 1 event / 5 s
const CRASH_TTL_MS = 3 * 60000;     // une marque de plus de 3 min n'est plus un « crash au même endroit »
const CRASH_RADIUS = 4;             // ≤ 4 blocs (3D) de la marque
const MARK_MIN_INTERVAL_MS = 3000;  // persistance de la marque : au plus 1 écriture / 3 s
const SHIFT_MIN = 8;                // décalage du départ : 8..12 blocs
const SHIFT_SPAN = 5;
const BM_MARK_KEY = 'bmLast';       // clé du mémo base

function _num(v) { return typeof v === 'number' && Number.isFinite(v); }

/** Faut-il émettre `heap_high` maintenant ? */
function shouldEmitHeapHigh(heapUsedMb, lastEmitAt, now, opts = {}) {
  const thr = _num(opts.thresholdMb) ? opts.thresholdMb : HEAP_HIGH_MB;
  const thr2 = _num(opts.throttleMs) ? opts.throttleMs : HEAP_HIGH_THROTTLE_MS;
  if (!_num(heapUsedMb) || !_num(now) || heapUsedMb <= thr) return false;
  return !_num(lastEmitAt) || now - lastEmitAt >= thr2;
}

/** Libellé court d'un but pathfinder (« GoalNear(1,15,-3 r3) »), null sans but. Ne lève jamais. */
function goalLabel(goal) {
  try {
    if (!goal) return null;
    const name = (goal.constructor && goal.constructor.name) || 'Goal';
    const c = ['x', 'y', 'z'].filter((k) => _num(goal[k])).map((k) => Math.round(goal[k]));
    const r = _num(goal.rangeSq) ? ' r' + Math.round(Math.sqrt(goal.rangeSq)) : '';
    return c.length ? `${name}(${c.join(',')}${r})` : name;
  } catch (e) { return 'Goal'; }
}

/** Marque persistable (copie des coordonnées : `bot.entity.position` est muté en place). */
function bmMark(pos, now, phase) {
  if (!pos || ![pos.x, pos.y, pos.z, now].every(_num)) return null;
  const r1 = (v) => Math.round(v * 10) / 10;
  return { x: r1(pos.x), y: r1(pos.y), z: r1(pos.z), at: now, phase: phase || null };
}

/** Écrire la marque maintenant ? (première écriture toujours, puis au plus 1 / MARK_MIN_INTERVAL_MS) */
function shouldPersistMark(lastWriteAt, now, minMs = MARK_MIN_INTERVAL_MS) {
  if (!_num(now)) return false;
  return !_num(lastWriteAt) || now - lastWriteAt >= minMs;
}

/** La marque `saved` désigne-t-elle un crash récent à ≤ radius blocs de `pos` ? */
function isCrashSpot(saved, pos, now, opts = {}) {
  if (!saved || !pos || ![saved.x, saved.y, saved.z, saved.at, pos.x, pos.y, pos.z, now].every(_num)) return false;
  const ttl = _num(opts.ttlMs) ? opts.ttlMs : CRASH_TTL_MS;
  const radius = _num(opts.radius) ? opts.radius : CRASH_RADIUS;
  if (saved.at > now || now - saved.at > ttl) return false;          // futur (autre monde) ou périmée
  return Math.hypot(pos.x - saved.x, pos.y - saved.y, pos.z - saved.z) <= radius;
}

/**
 * Nouveau départ : 8..12 blocs PERPENDICULAIREMENT au cap précédent (côté tiré au sort), même couche ;
 * le nouveau cap est cette perpendiculaire (on ne repart pas vers la case qui a tué le process).
 * `heading` absent → cap +x par défaut.
 */
function crashShiftTarget(pos, heading, rng = Math.random) {
  if (!pos || ![pos.x, pos.y, pos.z].every(_num)) return null;
  const h = heading && (heading.dx || heading.dz)
    ? { dx: Math.sign(heading.dx || 0), dz: heading.dx ? 0 : Math.sign(heading.dz || 0) }
    : { dx: 1, dz: 0 };
  const left = rng() < 0.5;
  const perp = left ? { dx: -h.dz || 0, dz: h.dx || 0 } : { dx: h.dz || 0, dz: -h.dx || 0 };
  const d = SHIFT_MIN + Math.min(SHIFT_SPAN - 1, Math.floor(rng() * SHIFT_SPAN));
  return {
    x: Math.floor(pos.x) + perp.dx * d,
    y: Math.floor(pos.y),
    z: Math.floor(pos.z) + perp.dz * d,
    dist: d,
    heading: perp,
  };
}

module.exports = {
  HEAP_HIGH_MB, HEAP_HIGH_THROTTLE_MS, CRASH_TTL_MS, CRASH_RADIUS, MARK_MIN_INTERVAL_MS,
  SHIFT_MIN, SHIFT_SPAN, BM_MARK_KEY,
  shouldEmitHeapHigh, goalLabel, bmMark, shouldPersistMark, isCrashSpot, crashShiftTarget,
};
