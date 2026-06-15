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
 * opts = { skip?: Set|Array de clés oreKey, pickTier?: number, priority?: string[],
 *          allowTypes?: Set|Array de matériaux de BASE (mode quota : seuls les types
 *          encore manquants sont visés), maxDist?: number (cibles au-delà ignorées —
 *          mieux vaut miner LOCAL que traverser la carte, phase 2) }.
 * Exclut skip + tier + types + distance ; dédup par oreKey. Ore ou null.
 */
function nextOreTarget(memory, world, from, opts = {}) {
  const priority = (opts && opts.priority) || DEFAULT_PRIORITY;
  const skipSet = opts.skip instanceof Set ? opts.skip
    : Array.isArray(opts.skip) ? new Set(opts.skip) : null;
  const allowSet = opts.allowTypes instanceof Set ? opts.allowTypes
    : Array.isArray(opts.allowTypes) ? new Set(opts.allowTypes) : null;
  const hasTierFilter = typeof opts.pickTier === 'number';
  // H7+ EXCLUSION DURE des minerais NOYÉS (wet) : active par défaut en mode quota/cave-first
  // (preferExposed≠false). Un minerai adjacent à l'eau n'est JAMAIS une cible — même seul, même
  // prioritaire (diamant) : on le SACRIFIE, la survie prime (décision Massii). Legacy distance-pure
  // (preferExposed:false) → wet encore éligible (rétro-compat stricte). opts.excludeWet force la valeur.
  const excludeWet = opts.excludeWet != null ? !!opts.excludeWet : (opts.preferExposed !== false);

  const maxDist2 = (typeof opts.maxDist === 'number' && from) ? opts.maxDist * opts.maxDist : null;
  const seen = new Set();
  const cands = [];
  for (const o of listOres(memory, world)) {
    const key = oreKey(o);
    if (seen.has(key)) continue;       // dédup par position
    seen.add(key);
    if (skipSet && skipSet.has(key)) continue;
    if (excludeWet && o.wet) continue;                 // noyé → jamais ciblé (exclusion DURE, anti-noyade)
    if (allowSet && !allowSet.has(oreBase(o.material))) continue;
    if (hasTierFilter && requiredPickTier(o.material) > opts.pickTier) continue;
    if (maxDist2 != null) {
      const dx = o.x - from.x, dy = o.y - from.y, dz = o.z - from.z;
      if (dx * dx + dy * dy + dz * dz > maxDist2) continue;
    }
    cands.push(o);
  }
  if (!cands.length) return null;

  // Index de priorité : présent dans la liste = son index ; hors liste = après tous les listés.
  const prioIndex = (mat) => {
    const i = priority.indexOf(oreBase(mat));
    return i === -1 ? priority.length : i;
  };

  // Tri : priorité matériau → EXPOSÉ d'abord (G-bis : un diamant exposé en grotte est VISIBLE/minable
  // direct, bien plus facile + sec que le strip-mine aveugle à -58 ; c'est la stratégie joueur réelle)
  // → distance. `exposed` ignoré jusqu'ici (le mappeur le capture mais le bot ressource ne s'en servait
  // pas). opts.preferExposed=false pour rétro-compat (legacy/tests purs distance).
  // H7 : score = sec-exposé (grotte minable, idéal) 2 > sec-enterré (strip) 1 > NOYÉ (adjacent eau) 0.
  // Un minerai `wet` (grotte/poche inondée) est mis EN DERNIER (anti-noyade : isExposed comptait l'eau
  // comme expo → cave-first y fonçait → noyade). opts.preferExposed=false → rétro-compat distance pure.
  const preferExposed = opts.preferExposed !== false;
  const score = (o) => {
    if (!preferExposed) return 0;
    if (o.wet) return 0;                                    // adjacent à l'eau → évité
    return o.exposed ? 2 : 1;                               // sec exposé > sec enterré
  };
  let best = null, bestPrio = Infinity, bestScore = -1, bestDist = Infinity;
  for (const o of cands) {
    const p = prioIndex(o.material);
    const s = score(o);
    const d = _dist3(o, from);
    if (p < bestPrio
        || (p === bestPrio && s > bestScore)
        || (p === bestPrio && s === bestScore && d < bestDist)) {
      best = o; bestPrio = p; bestScore = s; bestDist = d;
    }
  }
  return best;
}

// ───────────────────────────────────────────────────────────────────────────
// Détection des MINERAIS (Phase 1b — le cartographe les note pour les récolteurs).
// « Exposé » = au moins une face touche un bloc OUVERT (air/cave_air/void_air, ou tout bloc à
// boundingBox 'empty' sauf la lave) → minerai visible/minable direct. L'eau COMPTE, la LAVE non
// (piège mortel). Pur/testable (sauf bot.blockAt/findBlocks).

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
const _WATER = new Set(['water', 'flowing_water', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'bubble_column']);
// Un voisin est « ouvert » (= exposition) s'il est de l'air, OU tout bloc traversable (boundingBox
// 'empty') SAUF la lave ET SAUF l'eau. H7+ (décision Massii, survie prime) : l'eau ne compte PLUS
// comme exposition — un minerai dont la seule face ouverte donne sur l'eau est en zone NOYÉE, pas une
// cible sèche minable → isExposed false → le cave-first ne le ciblera jamais (anti-noyade à la racine).
function _isOpen(block) {
  if (!block) return false;                              // non chargé/inconnu → pas une exposition (conservateur)
  if (_AIR.has(block.name)) return true;
  return block.boundingBox === 'empty' && block.name !== 'lava' && !_WATER.has(block.name);
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

// H7+ (cause-racine des noyades) : un minerai est-il ADJACENT À L'EAU ? Rayon élargi à une BOÎTE
// Chebyshev-2 (±2 sur chaque axe) : l'eau à ≤2 blocs est une menace (en minant la roche entre deux
// on PERCE → noyade, vécu live). `_isOpen` ne compte plus l'eau comme exposition (isExposed false) ;
// on tague `wet` pour que nextOreTarget EXCLUE DUREMENT ces minerais — jamais l'eau, on sacrifie le
// minerai (décision Massii, la survie prime). _WATER est défini plus haut (partagé avec _isOpen).
function isWaterAdjacent(bot, pos) {
  if (!pos || !bot || typeof bot.blockAt !== 'function') return false;
  const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;    // le bloc du minerai lui-même
        const b = bot.blockAt(_at(x + dx, y + dy, z + dz));
        if (b && _WATER.has(b.name)) return true;           // 1re eau trouvée → wet (early-exit)
      }
    }
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


// Matériaux QUOTA (bots ressources multi-quota) : les 5 nécessaires, variantes stone + deepslate.
// Sous-ensemble d'ORE_NAMES — le scan complet se limite à eux pour borner la taille de la carte.
const QUOTA_ORE_NAMES = [
  'diamond_ore', 'deepslate_diamond_ore',
  'gold_ore', 'deepslate_gold_ore',
  'redstone_ore', 'deepslate_redstone_ore',
  'lapis_ore', 'deepslate_lapis_ore',
  'iron_ore', 'deepslate_iron_ore',
];

/**
 * Scan COMPLET des minerais dans les chunks chargés (exposés ET enfouis — serveur offline sans
 * anti-xray : le cache client contient tout le Y, données légitimes). Chaque entrée porte
 * `exposed` (calculé via isExposed) : le bot ressource sait s'il devra creuser l'approche finale.
 * Limité aux QUOTA_ORE_NAMES par défaut. Best-effort, jamais de crash. → [{material,x,y,z,exposed}]
 */
function scanAllOres(bot, opts = {}) {
  // maxDistance 256 : un mapper en SURFACE (y≈70) doit voir la deepslate diamond à y=-59
  // (distance verticale ~129 — à 128 les diamants seraient invisibles). findBlocks skip les
  // sections sans id matché au palette → coût borné même avec ce rayon.
  const { maxDistance = 256, count = 3000, names = QUOTA_ORE_NAMES } = opts;
  try {
    if (!bot || typeof bot.blockAt !== 'function' || typeof bot.findBlocks !== 'function') return [];
    const reg = bot.registry && bot.registry.blocksByName;
    if (!reg) return [];
    const ids = [];
    for (const name of names) {
      const hit = reg[name];
      if (hit && typeof hit.id === 'number') ids.push(hit.id); // skip noms absents (vieille version)
    }
    if (ids.length === 0) return [];
    const positions = bot.findBlocks({ matching: ids, maxDistance, count }) || [];
    const out = [];
    for (const p of positions) {
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
      const block = bot.blockAt(_at(x, y, z));
      if (!block) continue;                               // chunk non chargé → skip
      out.push({ material: block.name, x, y, z, exposed: isExposed(bot, p), wet: isWaterAdjacent(bot, p) });
    }
    return out;
  } catch (e) {
    return [];                                            // best-effort, jamais de crash
  }
}

// Event BATCHÉ (1 write backend par scan, pas 1 par ore — le fichier mémoire est gros).
function oresFoundEvent(world, ores) {
  return {
    type: 'ores_found', world,
    ores: (ores || []).map((o) => ({
      material: o.material, x: Math.floor(o.x), y: Math.floor(o.y), z: Math.floor(o.z),
      exposed: !!o.exposed, wet: !!o.wet,                  // H7 : `wet` persisté → bots évitent les noyés
    })),
  };
}

module.exports = {
  TIERS, DEFAULT_PRIORITY, oreBase, requiredPickTier, listOres, oreKey, nextOreTarget,
  ORE_NAMES, QUOTA_ORE_NAMES, isExposed, isWaterAdjacent, scanExposedOres, scanAllOres, exposedOreFoundEvent, oresFoundEvent,
};
