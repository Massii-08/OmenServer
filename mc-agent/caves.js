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

// Eau d'une grotte (Massii 2026-06-22 : « la carto doit savoir où sont les cavernes avec de l'eau
// et les bots doivent les ÉVITER — ils ne savent pas gérer l'eau »). detectCaveEntrance coupe la
// colonne d'air sur l'eau → une grotte PARTIELLEMENT inondée (air en haut, eau au fond) est quand
// même notée comme grotte, et le bot y était envoyé → noyade. Ce scan tague la grotte `flooded`.
const _WATER = new Set(['water', 'flowing_water', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'bubble_column']);

/**
 * La grotte dont le haut d'ouverture est `pos` contient-elle de l'eau ? Scanne `scanDown` blocs vers
 * le bas (± `radius` horizontalement) à la recherche d'un bloc d'eau. PUR (sauf bot.blockAt) ;
 * conservateur (bot/pos manquants → false). → boolean. Émis comme `flooded` dans cave_found.
 */
function detectCaveWater(bot, pos, { scanDown = 14, radius = 1 } = {}) {
  if (!pos || !bot || typeof bot.blockAt !== 'function') return false;
  const x0 = Math.floor(pos.x), y0 = Math.floor(pos.y), z0 = Math.floor(pos.z);
  for (let dy = 0; dy <= scanDown; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const b = bot.blockAt(_at(x0 + dx, y0 - dy, z0 + dz));
        if (b && _WATER.has(b.name)) return true;          // 1re eau trouvée → inondée (early-exit)
      }
    }
  }
  return false;
}

module.exports = { detectCaveEntrance, detectCaveWater };
