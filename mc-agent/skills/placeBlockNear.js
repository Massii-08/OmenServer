'use strict';
// Pose `itemName` (ex. crafting_table) sur un bloc solide adjacent au sol du bot.
// Pass 1 : case vide/replaceable adjacente → pose directe.
// Pass 2 : toutes les cases sont solides → creuse une case puis pose (cas underground/enclosed).
const { Vec3 } = require('vec3');
const { bestToolFor } = require('../tools');

// Noms de blocs qu'on peut REMPLACER sans creuser (case traitée comme "libre")
const REPLACEABLE = new Set([
  'air', 'cave_air', 'void_air',
  'short_grass', 'grass', 'tall_grass',
  'fern', 'large_fern',
  'snow', 'seagrass',
]);

// Blocs qu'on ne peut PAS creuser même si boundingBox === 'block'
const NON_DIGGABLE = new Set([
  'bedrock', 'water', 'lava', 'flowing_water', 'flowing_lava',
]);

/**
 * Pose itemName sur le sol adjacent au bot.
 * Retourne { ok:true, pos:Vec3 } ou { ok:false, reason:string }.
 */
async function placeBlockNear(bot, itemName) {
  const item = bot.inventory.items().find((i) => i.name === itemName);
  if (!item) return { ok: false, reason: 'unknown_item' };

  const base = bot.entity.position.floored();
  const dirs = [
    new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(0, 0, -1),
  ];

  // ── Pass 1 : cherche une case libre/replaceable avec sol solide ──────────
  for (const d of dirs) {
    const groundPos = base.plus(d).offset(0, -1, 0);
    const targetPos = base.plus(d);
    const ground = bot.blockAt(groundPos);
    const target = bot.blockAt(targetPos);

    if (!ground || ground.boundingBox !== 'block') continue;
    if (!target) continue;                               // null/unloaded → skip
    if (!REPLACEABLE.has(target.name)) continue;         // not a free cell

    try {
      await bot.equip(item, 'hand');
      await bot.placeBlock(ground, new Vec3(0, 1, 0));
      return { ok: true, pos: base.plus(d) };
    } catch (e) { /* essaie la direction suivante */ }
  }

  // ── Pass 2 : creuse une case solide adjacente puis pose ──────────────────
  for (const d of dirs) {
    const groundPos = base.plus(d).offset(0, -1, 0);
    const targetPos = base.plus(d);
    const ground = bot.blockAt(groundPos);
    const target = bot.blockAt(targetPos);

    if (!ground || ground.boundingBox !== 'block') continue;
    if (!target) continue;                               // unloaded → skip
    if (target.boundingBox !== 'block') continue;        // not a solid block to dig
    if (NON_DIGGABLE.has(target.name)) continue;         // can't dig this
    if (target.name === itemName) continue;              // don't dig what we're placing

    try {
      const tool = bestToolFor(bot, target);
      if (tool) await bot.equip(tool, 'hand');
      await bot.dig(target);
      await bot.equip(item, 'hand');                     // re-equip after dig
      await bot.placeBlock(ground, new Vec3(0, 1, 0));
      return { ok: true, pos: base.plus(d) };
    } catch (e) { /* essaie la direction suivante */ }
  }

  return { ok: false, reason: 'no_space' };
}

module.exports = { placeBlockNear };
