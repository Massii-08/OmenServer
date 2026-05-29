'use strict';
const { goals } = require('mineflayer-pathfinder');
/** Déplace le bot vers une coordonnée (GoalBlock) via pathfinder. */
async function goto(bot, { x, y, z } = {}) {
  if ([x, y, z].some((v) => typeof v !== 'number')) throw new Error('goto requires numeric x,y,z');
  await bot.pathfinder.goto(new goals.GoalBlock(x, y, z));
}
module.exports = { goto };
