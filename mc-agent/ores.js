'use strict';
// Détection des MINERAIS EXPOSÉS (Phase 1b — le cartographe les note pour aider les récolteurs).
// « Exposé » = au moins une face touche un bloc OUVERT (air/cave_air/void_air, ou tout bloc à
// boundingBox 'empty' sauf la lave) → le minerai est visible et minable depuis une grotte/falaise.
// L'eau COMPTE (minerai visible sous l'eau, minable). La LAVE ne compte PAS comme exposition :
// un minerai accessible UNIQUEMENT via de la lave est un piège mortel pour le bot récolteur, on
// ne veut pas l'envoyer s'y noyer → on le considère non-exposé. Pur/testable (sauf bot.blockAt/findBlocks).

// Vrai Vec3 pour bot.blockAt (leçon dcd874d : un POJO nu throw .floored en vrai mineflayer).
let vec3; try { vec3 = require('vec3'); } catch (e) { vec3 = null; }
function _at(x, y, z) { return vec3 ? vec3(x, y, z) : { x, y, z }; }

const ORE_NAMES = [
  'coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'redstone_ore', 'lapis_ore',
  'diamond_ore', 'emerald_ore',
  'deepslate_coal_ore', 'deepslate_iron_ore', 'deepslate_copper_ore', 'deepslate_gold_ore',
  'deepslate_redstone_ore', 'deepslate_lapis_ore', 'deepslate_diamond_ore', 'deepslate_emerald_ore',
  'nether_gold_ore', 'nether_quartz_ore', 'ancient_debris',
];

const _AIR = new Set(['air', 'cave_air', 'void_air']);
// Un voisin est « ouvert » (= exposition) s'il est de l'air, OU tout bloc traversable (boundingBox
// 'empty') SAUF la lave. L'eau passe le filtre → compte comme exposition (minerai visible/minable).
function _isOpen(block) {
  if (!block) return false;                              // non chargé/inconnu → pas une exposition (conservateur)
  if (_AIR.has(block.name)) return true;
  return block.boundingBox === 'empty' && block.name !== 'lava';
}

// Les 6 voisins orthogonaux (±x, ±y, ±z).
const _OFFS = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

/**
 * PUR — un minerai en `pos` est-il exposé ? true si AU MOINS UN des 6 voisins orthogonaux est ouvert.
 * Garde-fous : bot/blockAt manquants → false. Voisin null (chunk non chargé) = pas une exposition.
 */
function isExposed(bot, pos) {
  if (!pos || !bot || typeof bot.blockAt !== 'function') return false;
  const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
  for (const [dx, dy, dz] of _OFFS) {
    if (_isOpen(bot.blockAt(_at(x + dx, y + dy, z + dz)))) return true;
  }
  return false;
}

/**
 * Scanne les minerais exposés autour du bot (best-effort, jamais de crash).
 * Résout les ids via le registry (skip silencieux des noms absents), appelle findBlocks, puis
 * filtre les positions par isExposed. Retourne [{material, x, y, z}] (coords floored) ou [].
 */
function scanExposedOres(bot, opts = {}) {
  const { maxDistance = 48, count = 40 } = opts;
  try {
    if (!bot || typeof bot.blockAt !== 'function' || typeof bot.findBlocks !== 'function') return [];
    const reg = bot.registry && bot.registry.blocksByName;
    if (!reg) return [];
    const ids = [];
    for (const name of ORE_NAMES) {
      const hit = reg[name];
      if (hit && typeof hit.id === 'number') ids.push(hit.id); // skip noms absents (vieille version)
    }
    if (ids.length === 0) return [];
    const positions = bot.findBlocks({ matching: ids, maxDistance, count }) || [];
    const out = [];
    for (const p of positions) {
      const block = bot.blockAt(_at(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)));
      if (!block) continue;                               // chunk non chargé → skip
      if (!isExposed(bot, p)) continue;
      out.push({ material: block.name, x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
    }
    return out;
  } catch (e) {
    return [];                                            // best-effort, jamais de crash
  }
}

// Événement de mémoire du monde (même style que caveFoundEvent dans worldMemory.js).
function exposedOreFoundEvent(world, material, pos) {
  return {
    type: 'exposed_ore_found', world, material,
    x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z),
  };
}

module.exports = { ORE_NAMES, isExposed, scanExposedOres, exposedOreFoundEvent };
