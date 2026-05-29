'use strict';
const { goals } = require('mineflayer-pathfinder');
// Fuit la menace la plus proche en posant un GoalInvert (s'éloigner d'un rayon autour d'elle).

/** Fait fuir le bot loin du mob le plus proche. Retourne false s'il n'y a aucune menace. */
function fleeFrom(bot) {
  const threat = bot.nearestEntity((e) => e && e.type === 'mob' && e.position);
  if (!threat) return false;
  const { x, y, z } = threat.position;
  // GoalInvert(GoalNear) = « éloigne-toi d'au moins 16 blocs de ce point » ; dynamique = recalcule.
  bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalNear(x, y, z, 16)), true);
  return true;
}

module.exports = { fleeFrom };
