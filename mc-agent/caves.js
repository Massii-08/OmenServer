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

// Mur/paroi : bloc chargé, plein, ni eau ni lave (les liquides ne font pas une lèvre).
function _isWall(block) {
  return !!block && !_isOpen(block) && block.name !== 'water' && block.name !== 'lava';
}

/**
 * Heuristique ÉLARGIE (retour live Massii 04/06 : « cave_found n'a JAMAIS fire en jeu ») :
 * le scan sous-les-pieds seul ne suffit pas — le pathfinder ÉVITE précisément de marcher
 * au-dessus des trous. On scanne donc un VOISINAGE autour du bot :
 *   1. sous les pieds (delegue à detectCaveEntrance — compat) ;
 *   2. TROU SOUS UNE LÈVRE : colonne d'air ancrée juste SOUS le plan du sol du bot,
 *      profonde ≥ minDepth, MURÉE (≥2 voisins pleins au sommet → rejette pentes/falaises) ;
 *   3. BOUCHE À FLANC DE COLLINE : ouverture 2-haut TOITURÉE (toit plein) qui PÉNÈTRE
 *      d'au moins 2 blocs dans le terrain (rejette les alcôves d'1 bloc).
 * Budget : ~1000 blockAt max par appel (record() = 1 appel par jambe, pas par tick).
 * Retourne {found, pos} | {found:false}.
 */
function findCaveEntranceNear(bot, p, opts = {}) {
  const { minDepth = 4, scanDown = 14, radius = 8, step = 2 } = opts;
  if (!p || !bot || typeof bot.blockAt !== 'function') return { found: false };
  // 1) sous les pieds (comportement historique — attrape le bot qui marche sur une ouverture)
  const under = detectCaveEntrance(bot, p, { minDepth, scanDown });
  if (under.found) return under;
  const x0 = Math.floor(p.x), z0 = Math.floor(p.z), y0 = Math.floor(p.y);
  const at = (x, y, z) => bot.blockAt(_at(x, y, z));
  const wall = (x, y, z) => _isWall(at(x, y, z));

  // 2) trou sous une lèvre — échantillonne le voisinage (step) ; ancre la colonne à y0-1
  //    (sous le plan du bot) pour ne pas compter l'air libre au-dessus du sol.
  for (let dx = -radius; dx <= radius; dx += step) {
    for (let dz = -radius; dz <= radius; dz += step) {
      if (dx === 0 && dz === 0) continue;
      const x = x0 + dx, z = z0 + dz;
      let depth = 0;
      while (depth < minDepth && _isOpen(at(x, y0 - 1 - depth, z))) depth++;
      if (depth < minDepth) continue;
      const yTop = y0 - 1;
      let walls = 0;
      if (wall(x + 1, yTop, z)) walls++;
      if (wall(x - 1, yTop, z)) walls++;
      if (wall(x, yTop, z + 1)) walls++;
      if (wall(x, yTop, z - 1)) walls++;
      if (walls >= 2) return { found: true, pos: { x, y: yTop, z } };
    }
  }

  // 3) bouche de tunnel à flanc de colline — 8 directions, du plus proche au plus loin.
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (let d = 2; d <= radius; d++) {
    for (const [ux, uz] of DIRS) {
      const x = x0 + ux * d, z = z0 + uz * d;
      for (let y = y0 - 2; y <= y0 + 1; y++) {
        if (!(_isOpen(at(x, y, z)) && _isOpen(at(x, y + 1, z)) && wall(x, y + 2, z))) continue;
        const x2 = x + ux, z2 = z + uz; // pénétration : l'ouverture continue 1 bloc plus loin
        if (_isOpen(at(x2, y, z2)) && _isOpen(at(x2, y + 1, z2)) && wall(x2, y + 2, z2)) {
          return { found: true, pos: { x, y, z } };
        }
      }
    }
  }
  return { found: false };
}

module.exports = { detectCaveEntrance, findCaveEntranceNear };
