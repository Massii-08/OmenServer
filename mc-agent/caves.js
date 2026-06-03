'use strict';
// Détection d'entrée de grotte (Phase 1b — le cartographe la note pour aider les récolteurs).
// Heuristique géométrique (datapack-proof) : sous les pieds, une COLONNE D'AIR verticale d'au moins
// `minDepth` blocs = une ouverture qui descend → entrée de grotte. Pur/testable (sauf bot.blockAt).
// Lave/eau coupent la colonne (un puits de lave n'est pas une entrée de grotte). Coords seulement.

// Vrai Vec3 pour bot.blockAt (leçon dcd874d : un POJO nu throw .floored en vrai mineflayer).
let vec3; try { vec3 = require('vec3'); } catch (e) { vec3 = null; }
function _at(x, y, z) { return vec3 ? vec3(x, y, z) : { x, y, z }; }

const _AIR = new Set(['air', 'cave_air', 'void_air']);
function _isOpen(block) {
  if (!block) return false;                          // non chargé/inconnu → pas une ouverture (conservateur)
  if (_AIR.has(block.name)) return true;
  return block.boundingBox === 'empty' && block.name !== 'water' && block.name !== 'lava';
}

/**
 * Entrée de grotte sous la position `p` ? Scanne `scanDown` blocs vers le bas ; si une colonne d'air
 * continue atteint `minDepth`, c'est une ouverture descendante. Retourne {found, pos} (pos = haut de
 * l'ouverture) | {found:false}.
 */
function detectCaveEntrance(bot, p, { minDepth = 4, scanDown = 14 } = {}) {
  if (!p || !bot || typeof bot.blockAt !== 'function') return { found: false };
  const x = Math.floor(p.x), z = Math.floor(p.z), y0 = Math.floor(p.y);
  let run = 0, top = null;
  for (let dy = 1; dy <= scanDown; dy++) {
    const y = y0 - dy;
    if (_isOpen(bot.blockAt(_at(x, y, z)))) {
      if (run === 0) top = { x, y, z };
      run++;
      if (run >= minDepth) return { found: true, pos: top };
    } else {
      run = 0; top = null;
    }
  }
  return { found: false };
}

module.exports = { detectCaveEntrance };
