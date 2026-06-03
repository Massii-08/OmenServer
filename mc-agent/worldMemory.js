'use strict';
// Mémoire de monde côté bot (Phase 1). Pur/testable.
//  - CONSOMMATION : charge le fichier --world-memory (bootstrap du groupe), résout la clé de monde,
//    et fournit le CIBLAGE DIRIGÉ d'un matériau (associations APPRISES `finds` d'abord — robuste aux
//    biomes custom des datapacks — sinon amorce vanilla biome→matériau).
//  - PRODUCTION : construit les events stdout que le manager route vers le store
//    (biome_seen / cave_found / material_found).
const fs = require('fs');

// Amorce vanilla matériau→biomes (FALLBACK seulement ; les `finds` appris priment, cf. datapacks).
const VANILLA_HINTS = {
  log: ['forest', 'birch_forest', 'dark_forest', 'taiga', 'old_growth_pine_taiga',
        'old_growth_spruce_taiga', 'jungle', 'savanna', 'grove', 'flower_forest', 'cherry_grove'],
  sand: ['desert', 'beach', 'snowy_beach'],
  sandstone: ['desert'],
  cactus: ['desert'],
  red_sand: ['badlands', 'eroded_badlands', 'wooded_badlands'],
  terracotta: ['badlands', 'eroded_badlands', 'wooded_badlands'],
  snow: ['snowy_plains', 'snowy_taiga', 'grove', 'frozen_peaks', 'snowy_slopes', 'jagged_peaks'],
  ice: ['frozen_river', 'frozen_ocean', 'ice_spikes'],
  bamboo: ['bamboo_jungle', 'jungle'],
};

/** Biomes vanilla susceptibles de contenir `material` (amorce). [] si inconnu. */
function vanillaHint(material) {
  if (!material || typeof material !== 'string') return [];
  if (material === 'log' || material.endsWith('_log')) return VANILLA_HINTS.log;
  return VANILLA_HINTS[material] || [];
}

/** Parse le contenu JSON d'une mémoire. {worlds:{}} si invalide. */
function parseMemory(text) {
  try {
    const m = JSON.parse(text);
    if (m && typeof m === 'object' && m.worlds && typeof m.worlds === 'object') return m;
  } catch (e) { /* fallthrough */ }
  return { worlds: {} };
}

/** Charge le fichier --world-memory. {worlds:{}} si absent/illisible. */
function loadMemory(path) {
  if (!path) return { worlds: {} };
  try { return parseMemory(fs.readFileSync(path, 'utf8')); }
  catch (e) { return { worlds: {} }; }
}

/** Clé du monde courant : label explicite (monde de minage) sinon dimension du bot. */
function worldKey(bot, label) {
  if (label) return String(label);
  const dim = bot && bot.game && bot.game.dimension;
  return dim ? String(dim) : 'unknown';
}

/** Lit le biome d'un bloc → {name, id} (l'un des deux peut manquer sur un biome custom). */
function readBiome(block) {
  const b = block && block.biome;
  if (!b) return { name: null, id: null };
  return { name: b.name || null, id: (b.id !== undefined ? b.id : null) };
}

function biomeSeenEvent(world, block, pos) {
  const { name, id } = readBiome(block);
  return { type: 'biome_seen', world, name, id, x: Math.round(pos.x), z: Math.round(pos.z) };
}
function caveFoundEvent(world, pos) {
  return { type: 'cave_found', world, x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) };
}
function materialFoundEvent(world, material, biomeName, pos) {
  return { type: 'material_found', world, material, biome: biomeName, x: Math.round(pos.x), z: Math.round(pos.z) };
}

function _horiz(ax, az, bx, bz) { return Math.sqrt((ax - bx) ** 2 + (az - bz) ** 2); }

/**
 * Cible dirigée pour aller chercher `material` d'après la mémoire du monde `world`.
 * 1) associations APPRISES (finds) du matériau → biome le + proche connu pour le contenir ;
 * 2) sinon amorce vanilla → biome connu (par nom) le + proche.
 * Retourne {x,z,biome,learned} ou null (rien de connu / hors maxDist).
 */
function directedTarget(memory, world, material, from, opts = {}) {
  const maxDist = opts.maxDist || 1500;
  const w = (memory && memory.worlds && memory.worlds[world]) || {};
  const fx = from ? from.x : 0, fz = from ? from.z : 0;

  const pickNearest = (cands) => {
    let best = null, bestD = Infinity;
    for (const c of cands) {
      const d = _horiz(fx, fz, c.x, c.z);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best && bestD <= maxDist ? best : null;
  };

  // 1) appris
  const finds = (w.finds || []).filter((f) => f.material === material);
  const fromFinds = pickNearest(finds.map((f) => ({ x: f.x, z: f.z, biome: f.biome })));
  if (fromFinds) return { ...fromFinds, learned: true };

  // 2) amorce vanilla
  const hints = vanillaHint(material);
  if (hints.length) {
    const biomes = (w.biomes || []).filter((b) => b.name && hints.includes(b.name));
    const fromBiomes = pickNearest(biomes.map((b) => ({ x: b.x, z: b.z, biome: b.name })));
    if (fromBiomes) return { ...fromBiomes, learned: false };
  }
  return null;
}

module.exports = {
  vanillaHint, parseMemory, loadMemory, worldKey, readBiome,
  biomeSeenEvent, caveFoundEvent, materialFoundEvent, directedTarget,
};
