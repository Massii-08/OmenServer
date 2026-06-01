'use strict';
// Sélection d'outil/arme : quel outil de l'inventaire pour casser un bloc, quelle arme pour frapper.
// Quasi-pur (lit bot.inventory + nom du bloc). Testable avec un bot mocké.

const TIERS = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'];

/** Score de palier ('diamond_pickaxe' → 4). -1 si pas un item à palier. */
function tierRank(name) {
  const s = String(name || '');
  for (let i = 0; i < TIERS.length; i++) if (s.startsWith(TIERS[i] + '_')) return i;
  return -1;
}

/** Catégorie d'outil idéale pour un nom de bloc, ou null (main). Pur. */
function toolCategoryFor(blockName) {
  const n = String(blockName || '');
  if (/(_log|_wood|_planks|_stem|_hyphae)$|^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|crimson|warped)_(log|wood|planks)|crafting_table|bookshelf|barrel|^chest$/.test(n)) return 'axe';
  if (/(^dirt$|grass_block|^sand$|gravel|^clay$|soul_sand|soul_soil|podzol|mycelium|^snow$|snow_block|farmland|^mud$|_concrete_powder)$/.test(n)) return 'shovel';
  if (/(stone|cobble|deepslate|granite|diorite|andesite|_ore$|obsidian|netherrack|basalt|blackstone|end_stone|terracotta|_concrete$|bricks?$|^furnace$|tuff|calcite|amethyst)/.test(n)) return 'pickaxe';
  if (/(_leaves$|^cobweb$|_wool$|^vine$)/.test(n)) return 'shears';
  return null;
}

/** Meilleur outil de l'inventaire pour ce bloc (palier le + haut de la bonne catégorie), ou null. */
function bestToolFor(bot, block) {
  const cat = toolCategoryFor(block && block.name);
  if (!cat) return null;
  const items = (bot.inventory && bot.inventory.items()) || [];
  let best = null, bestRank = -2;
  for (const it of items) {
    if (!it || !it.name) continue;
    if (cat === 'shears') { if (it.name === 'shears') return it; continue; }
    if (!it.name.endsWith('_' + cat)) continue;
    const r = tierRank(it.name);
    if (r > bestRank) { bestRank = r; best = it; }
  }
  return best;
}

/** Meilleure arme melee (épée > hache, par palier), ou null (poing). */
function bestWeapon(bot) {
  const items = (bot.inventory && bot.inventory.items()) || [];
  let best = null, bestScore = -1;
  for (const it of items) {
    if (!it || !it.name) continue;
    let base = -1;
    if (it.name.endsWith('_sword')) base = 100;
    else if (it.name.endsWith('_axe')) base = 50;
    else continue;
    const score = base + tierRank(it.name);
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return best;
}

module.exports = { TIERS, tierRank, toolCategoryFor, bestToolFor, bestWeapon };
