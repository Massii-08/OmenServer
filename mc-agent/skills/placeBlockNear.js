'use strict';
// Pose `itemName` (ex. crafting_table) sur un bloc solide adjacent au sol du bot.
const { Vec3 } = require('vec3');

async function placeBlockNear(bot, itemName) {
  const item = bot.inventory.items().find((i) => i.name === itemName);
  if (!item) return { ok: false, reason: 'unknown_item' };
  // Référence = le bloc juste sous une case au sol adjacente. On essaie les 4 directions.
  const base = bot.entity.position.floored();
  const dirs = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
  for (const d of dirs) {
    const ground = bot.blockAt(base.plus(d).offset(0, -1, 0));   // sol adjacent
    const target = bot.blockAt(base.plus(d));                     // case où poser (doit être air)
    if (!ground || ground.boundingBox !== 'block') continue;
    if (target && target.name !== 'air') continue;
    try {
      await bot.equip(item, 'hand');
      await bot.placeBlock(ground, new Vec3(0, 1, 0));            // pose sur la face haute du sol
      return { ok: true };
    } catch (e) { /* essaie la direction suivante */ }
  }
  return { ok: false, reason: 'no_space' };
}

module.exports = { placeBlockNear };
