'use strict';
// Sélection de cibles de minage à partir de la mémoire de monde du groupe.
// Module PUR (zéro dépendance, zéro I/O) : choisit la prochaine veine à miner
// par priorité de matériau puis distance 3D. Lu par le bot « ressource ».

// Paliers de pioche (1:1 avec ../tools TIERS, redéclaré localement pour rester pur).
const TIERS = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'];

// Priorité de récolte décroissante (le 1er = plus précieux).
const DEFAULT_PRIORITY = ['ancient_debris', 'diamond', 'emerald', 'gold', 'redstone', 'lapis', 'iron', 'copper', 'coal'];

/** Matériau de base : retire préfixe deepslate_/nether_ et suffixe _ore. Non-string/vide → null. */
function oreBase(material) {
  if (typeof material !== 'string' || !material) return null;
  let m = material;
  if (m.startsWith('deepslate_')) m = m.slice(10);
  else if (m.startsWith('nether_')) m = m.slice(7);
  if (m.endsWith('_ore')) m = m.slice(0, -4);
  return m || null;
}

/** Palier de pioche minimal (index dans TIERS) pour récolter ce minerai. Inconnu → 0 (prudent). */
function requiredPickTier(material) {
  const base = oreBase(material);
  switch (base) {
    case 'ancient_debris': return 4; // diamant
    case 'diamond':
    case 'emerald':
    case 'gold':
    case 'redstone': return 3;       // fer
    case 'iron':
    case 'lapis':
    case 'copper': return 2;         // pierre
    case 'coal': return 0;           // bois (n'importe quelle pioche)
    default: return 0;               // inconnu : on tente
  }
}

/** Vrai si l'entrée est un ore exploitable (material string non vide + x,y,z finis). */
function _isValidOre(o) {
  return o && typeof o.material === 'string' && o.material &&
    Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.z);
}

/** Liste filtrée des ores valides d'un monde, sans muter. [] si memory/world absent. */
function listOres(memory, world) {
  const w = memory && memory.worlds && memory.worlds[world];
  const arr = w && w.ores;
  if (!Array.isArray(arr)) return [];
  return arr.filter(_isValidOre);
}

/** Clé de position "x,y,z" (coords arrondies). */
function oreKey(o) {
  return Math.round(o.x) + ',' + Math.round(o.y) + ',' + Math.round(o.z);
}

/** Distance 3D euclidienne entre deux points {x,y,z}. */
function _dist3(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Prochaine cible de minage : priorité (matériau) puis distance 3D à `from`.
 * opts = { skip?: Set|Array de clés oreKey, pickTier?: number, priority?: string[] }.
 * Exclut skip + ce qui dépasse pickTier ; dédup par oreKey. Retourne l'ore ou null.
 */
function nextOreTarget(memory, world, from, opts = {}) {
  const priority = (opts && opts.priority) || DEFAULT_PRIORITY;
  const skipSet = opts.skip instanceof Set ? opts.skip
    : Array.isArray(opts.skip) ? new Set(opts.skip) : null;
  const hasTierFilter = typeof opts.pickTier === 'number';

  const seen = new Set();
  const cands = [];
  for (const o of listOres(memory, world)) {
    const key = oreKey(o);
    if (seen.has(key)) continue;       // dédup par position
    seen.add(key);
    if (skipSet && skipSet.has(key)) continue;
    if (hasTierFilter && requiredPickTier(o.material) > opts.pickTier) continue;
    cands.push(o);
  }
  if (!cands.length) return null;

  // Index de priorité : présent dans la liste = son index ; hors liste = après tous les listés.
  const prioIndex = (mat) => {
    const i = priority.indexOf(oreBase(mat));
    return i === -1 ? priority.length : i;
  };

  let best = null, bestPrio = Infinity, bestDist = Infinity;
  for (const o of cands) {
    const p = prioIndex(o.material);
    const d = _dist3(o, from);
    if (p < bestPrio || (p === bestPrio && d < bestDist)) {
      best = o; bestPrio = p; bestDist = d;
    }
  }
  return best;
}

module.exports = { TIERS, DEFAULT_PRIORITY, oreBase, requiredPickTier, listOres, oreKey, nextOreTarget };
