'use strict';
// Mine/ramasse un bloc via mineflayer-collectblock (gère pathfinding + dig).

const WOOD_TYPES = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log'];

/** Résout les ids d'un nom de bloc via le registry minecraft-data chargé par mineflayer. */
function _blockIds(bot, name) {
  const def = bot.registry && bot.registry.blocksByName && bot.registry.blocksByName[name];
  return def ? [def.id] : null;
}

/** Mine le bloc le plus proche du type `name`. Retourne false (et prévient) si introuvable. */
async function mineBlock(bot, { name, count = 1 } = {}) {
  if (!name) throw new Error('mineBlock requires a block name');
  for (let i = 0; i < count; i++) {
    const block = bot.findBlock({ matching: _blockIds(bot, name), maxDistance: 48 });
    if (!block) {
      if (i === 0) { bot.chat(`je ne trouve pas de ${name}`); return false; }
      break; // déjà ramassé au moins 1 : on s'arrête sans râler
    }
    await bot.collectBlock.collect(block);
  }
  return true;
}

/** Ramasse du bois : essaie chaque essence connue jusqu'à en trouver une. */
async function collectWood(bot, { count = 1 } = {}) {
  for (const wood of WOOD_TYPES) {
    const block = bot.findBlock({ matching: _blockIds(bot, wood), maxDistance: 48 });
    if (block) return mineBlock(bot, { name: wood, count });
  }
  bot.chat('je ne vois pas de bois autour');
  return false;
}

module.exports = { mineBlock, collectWood, WOOD_TYPES };
