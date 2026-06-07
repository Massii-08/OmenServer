'use strict';
// Évaluation de chute (affinage « joueur réel », demande Massii 07/06) : un vrai joueur n'a pas
// peur de perdre 2-3 cœurs — on ne PONTE/contourne que si la chute coûterait plus de la MOITIÉ
// des PV courants, ou tombe dans lave/vide. Dégâts de chute ≈ (blocs − 3) HP ; eau en bas = 0
// (raccourci gratuit). Pur/testable : blockAt injectable.

const WATER = new Set(['water', 'flowing_water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);
const LAVA = new Set(['lava', 'flowing_lava']);

/**
 * Sonde verticalement depuis `cell` (1re cellule d'AIR sous le pas) jusqu'au fond.
 * → { depth, surface: 'solid'|'water'|'lava'|'void'|'unknown' }
 *   depth = nb de cellules d'air traversées AVANT la surface trouvée.
 */
function assessDrop(bot, cell, opts = {}) {
  const maxScan = opts.maxScan || 24;
  const at = opts.blockAt || ((q) => bot.blockAt(q));
  for (let d = 0; d < maxScan; d++) {
    let b = null;
    try { b = at({ x: cell.x, y: cell.y - d, z: cell.z }); } catch (e) { return { depth: d, surface: 'unknown' }; }
    if (!b) return { depth: d, surface: 'unknown' };          // chunk non chargé → prudence
    if (LAVA.has(b.name)) return { depth: d, surface: 'lava' };
    if (WATER.has(b.name)) return { depth: d, surface: 'water' };
    if (b.boundingBox === 'block') return { depth: d, surface: 'solid' };
  }
  return { depth: maxScan, surface: 'void' };                 // rien en 24 blocs → gouffre
}

/**
 * Chute acceptable « comme un joueur » ? Eau = toujours oui (0 dégât). Sol dur : il faut être
 * EN FORME (PV ≥ 75% — correction Massii : des chutes répétées à moitié de vie s'accumulent et
 * tuent) ET dégâts estimés (depth+1−3 HP) ≤ 50% des PV courants. Lave/vide/inconnu = non.
 * Sous 75% : pont/évitement, on laisse la régen remonter avant de retenter.
 */
function safeToDrop(assessment, health) {
  if (!assessment) return false;
  if (assessment.surface === 'water') return true;
  if (assessment.surface !== 'solid') return false;
  const hp = (health == null ? 20 : health);
  if (hp < 15) return false;                                  // < ~75% : pas de chute volontaire
  const dmg = Math.max(0, (assessment.depth + 1) - 3);
  return dmg <= Math.max(1, hp / 2);
}

module.exports = { assessDrop, safeToDrop, WATER, LAVA };
