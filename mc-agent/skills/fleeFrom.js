'use strict';
const { goals } = require('mineflayer-pathfinder');
const { MELEE_HOSTILES } = require('../reflexes');
// Fuit le HOSTILE le plus proche (GoalInvert : s'éloigner d'un rayon autour de lui).
// Avant : fuyait N'IMPORTE quel mob — y compris une vache (fuite absurde, vécu diagnostic).

// Hostiles à fuir : mêlée (reflexes) + creeper + tireurs/volants. JAMAIS les passifs.
const HOSTILE = new Set([...MELEE_HOSTILES,
  'creeper', 'ghast', 'blaze', 'phantom', 'shulker', 'guardian', 'elder_guardian',
  'evoker', 'ravager', 'warden', 'vex', 'illusioner']);

/** Fait fuir le bot loin du HOSTILE le plus proche. Retourne false s'il n'y a aucun hostile. */
function fleeFrom(bot) {
  const threat = bot.nearestEntity((e) =>
    e && e.position && (e.kind === 'Hostile mobs' || HOSTILE.has(e.name)));
  if (!threat) return false;
  const { x, y, z } = threat.position;
  // GoalInvert(GoalNear) = « éloigne-toi d'au moins 16 blocs de ce point » ; dynamique = recalcule.
  bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalNear(x, y, z, 16)), true);
  return true;
}

module.exports = { fleeFrom };
