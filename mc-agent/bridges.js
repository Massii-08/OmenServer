'use strict';
// PONTS ÉNORMES EN SURFACE (Massii, 19/10 : « évite que les bots créent des ponts énormes en surface,
// ça ne sert à rien »).
//
// D'où viennent-ils ? mineflayer-pathfinder (lib/movements.js, getMoveForward) POSE un bloc sous la
// case d'arrivée quand elle n'a pas de sol : c'est un pas de PONT, qui coûte `1 + placeCost` (46 chez
// un ouvrier) et n'est rejeté qu'au-delà de 100. Tant que le détour par le relief tient dans le budget
// de l'A* (searchRadius 256, cf. movement.applyPathfinderBounds), le détour gagne ; dès qu'il en sort,
// le pont devient la seule issue — et chaque bloc posé près du chemin le remet à zéro (blockUpdate →
// resetPath → re-planification depuis le bout du pont), d'où des passerelles de dizaines de blocs
// au-dessus des vallées. La même pose sert au saut avec marche posée (getMoveJumpUp).
//
// ⚠️ POURQUOI PAS `placeCost` (vécu, world_ax5) : poser trop cher PARTOUT a figé les bots (1 à 22 blocs
// en 240 s, pose/casse en boucle) — la même pose sert à la TOUR 1×1 qui franchit un ressaut ou sort
// d'un trou. On ne touche donc ni au prix ni aux tours : on interdit la pose là où elle ne sert qu'à
// PONTER, via `exclusionAreasPlace`, le seul crochet PAR BLOC qu'offre la lib (la pénalité s'ajoute au
// coût du mouvement ; au-delà de 100 le mouvement est rejeté).
//
// Décision PURE ici (blockAt injecté, aucun accès bot) ; `installBridgeGuard` l'accroche à une Movements.

const { Vec3 } = require('vec3');

const BRIDGE_FORBID = 1000;     // « interdit » : très au-delà du plafond 100 de la lib (ajouté → rejet sûr)
const SURFACE_MIN_Y = 50;       // au-dessus : la surface (même frontière que l'ancienne bascule pilier)
const VOID_MAX_DEPTH = 4;       // profondeur de vide sondée sous la case de pose
const VOID_FORBID_DEPTH = 3;    // en surface, ≥ 3 blocs de vide sous la pose = vallée/ravin → interdit
const FLUID_SCAN_DEPTH = 4;     // un fluide à ≤ 4 blocs sous la pose = pont sur l'eau → interdit PARTOUT

// L'eau, c'est aussi ce qui vit DANS l'eau : herbes et algues sont des blocs d'eau (waterlogged d'office),
// une colonne de bulles aussi. Sans eux, un lac planté passerait pour un fossé sec.
const _FLUID_RE = /water|lava|seagrass|kelp|bubble_column/;

function _isFluid(b) { return _FLUID_RE.test(String((b && b.name) || '')); }
// « Non physique » = tout ce qui ne porte pas un joueur : air, plantes, neige fine… (boundingBox !== 'block').
function _isSolid(b) { return !!b && b.boundingBox === 'block'; }
function _int(v, dflt) { return (typeof v === 'number' && Number.isFinite(v)) ? v : dflt; }

/**
 * Pénalité de POSE pour `exclusionAreasPlace` de mineflayer-pathfinder. (PUR)
 *
 * `block` = le bloc que la lib passe à `exclusionPlace` : pour un pas de pont c'est la case d'arrivée
 * (niveau des pieds) et le bloc serait posé JUSTE DESSOUS (y-1). On sonde donc la colonne à partir de
 * y-1 vers le bas : blocs non physiques consécutifs (= le vide sous le pont).
 *   (a) un FLUIDE dans cette colonne à ≤ FLUID_SCAN_DEPTH  → BRIDGE_FORBID, en surface comme sous terre ;
 *   (b) sinon, en SURFACE (y ≥ SURFACE_MIN_Y) et ≥ VOID_FORBID_DEPTH blocs de vide → BRIDGE_FORBID ;
 *   (c) sinon 0 — fossé de 1-2 blocs, ravin de grotte, tour sur son propre sol.
 * Un `blockAt` qui rend null (chunk non chargé, hors monde) ARRÊTE la sonde : on juge sur ce qu'on a
 * vu, jamais sur ce qu'on suppose (rien vu → 0, on ne bloque pas).
 *
 * @param {(pos: Vec3) => ?{name: string, boundingBox: string}} blockAt — `(p) => bot.blockAt(p)` ;
 *   reçoit des Vec3 (mineflayer appelle `pos.floored()`, un objet nu le ferait planter — piège #43g)
 * @param {{position: {x:number,y:number,z:number}}} block
 * @param {{surfaceMinY?: number, maxDepth?: number, forbidDepth?: number, fluidDepth?: number}} [opts]
 * @returns {number} 0 ou BRIDGE_FORBID
 */
function voidBridgePenalty(blockAt, block, opts = {}) {
  try {
    if (typeof blockAt !== 'function' || !block || !block.position) return 0;
    const { x, y, z } = block.position;
    if (![x, y, z].every(Number.isFinite)) return 0;
    const o = opts || {};
    const surfaceMinY = _int(o.surfaceMinY, SURFACE_MIN_Y);
    const maxDepth = _int(o.maxDepth, VOID_MAX_DEPTH);
    const forbidDepth = _int(o.forbidDepth, VOID_FORBID_DEPTH);
    const fluidDepth = _int(o.fluidDepth, FLUID_SCAN_DEPTH);
    const scan = Math.max(maxDepth, fluidDepth);
    let depth = 0;
    for (let i = 1; i <= scan; i++) {
      let b = null;
      try { b = blockAt(new Vec3(x, y - i, z)); } catch (e) { b = null; }
      if (!b) break;                                   // inconnu : on s'arrête à ce qu'on SAIT
      if (_isFluid(b)) {
        if (i <= fluidDepth) return BRIDGE_FORBID;     // pont sur (ou dans) l'eau / la lave
        break;                                         // fluide trop loin : il clôt simplement le vide
      }
      if (_isSolid(b)) break;                          // un sol : fin du vide
      if (i <= maxDepth) depth = i;
    }
    if (y >= surfaceMinY && depth >= forbidDepth) return BRIDGE_FORBID;
    return 0;
  } catch (e) {
    return 0;                                          // jamais d'exception dans l'A* du pathfinder
  }
}

const GUARDED = Symbol.for('mca.bridges.guarded');     // marque d'idempotence (recopiée par Object.assign)

/**
 * Accroche le garde-fou anti-pont à une Movements de mineflayer-pathfinder. Idempotent.
 *
 * ⚠️ LA TOUR EST EXEMPTÉE, et c'est indispensable (prouvé par bridges.test.js, A* réelle) : l'A* lit le
 * monde RÉEL, où les blocs d'une tour en cours de planification sont encore de l'AIR. Au 4e étage, la
 * colonne sous les pieds montre donc 3 blocs de vide — la signature exacte d'une vallée — et une
 * pénalité brute plafonne les tours à 3 blocs : un bot au fond d'un puits de 5 en surface n'en sort
 * plus (`noPath`). Seul `getMoveUp` (allow1by1towers) appelle `exclusionPlace` pour une tour : on
 * l'enveloppe d'un compteur de réentrance, et la pénalité vaut 0 tant qu'il est > 0. Comportement des
 * tours STRICTEMENT inchangé ; pont (getMoveForward) et marche posée (getMoveJumpUp) jugés.
 *
 * Le compteur vit dans la closure, partagé par la Movements et ses copies `Object.assign` (cf.
 * movement.withTempMovements, qui recopie le `getMoveUp` enveloppé ET le même tableau
 * `exclusionAreasPlace`) : la temporaire hérite du garde-fou sans rien reposer.
 *
 * @param {object} moves — une instance de `Movements`
 * @param {Function} blockAt — `(p) => bot.blockAt(p)`
 * @param {object} [opts] — transmis à voidBridgePenalty
 * @returns {boolean} true si le garde-fou est (ou était déjà) posé
 */
function installBridgeGuard(moves, blockAt, opts) {
  try {
    if (!moves || !Array.isArray(moves.exclusionAreasPlace) || typeof blockAt !== 'function') return false;
    if (moves[GUARDED]) return true;
    const tower = { depth: 0 };
    const up = moves.getMoveUp;
    if (typeof up === 'function') {
      moves.getMoveUp = function getMoveUpTowerExempt(...args) {
        tower.depth += 1;
        try { return up.apply(this, args); } finally { tower.depth -= 1; }
      };
    }
    moves.exclusionAreasPlace.push((b) => (tower.depth > 0 ? 0 : voidBridgePenalty(blockAt, b, opts)));
    moves[GUARDED] = true;
    return true;
  } catch (e) {
    return false;                                      // best-effort : sans garde-fou, le bot marche quand même
  }
}

module.exports = {
  voidBridgePenalty, installBridgeGuard,
  BRIDGE_FORBID, SURFACE_MIN_Y, VOID_MAX_DEPTH, VOID_FORBID_DEPTH, FLUID_SCAN_DEPTH,
};
