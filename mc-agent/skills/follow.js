'use strict';
const { goals } = require('mineflayer-pathfinder');
/** Fait suivre un joueur (GoalFollow dynamique). Retourne false si le joueur n'est pas visible. */
function follow(bot, { player } = {}) {
  if (!player) throw new Error('follow requires a player name');
  const target = bot.players[player] && bot.players[player].entity;
  if (!target) { bot.chat(`je ne te vois pas, ${player}`); return false; }
  bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
  return true;
}
module.exports = { follow };
