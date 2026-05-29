'use strict';
// Construit un snapshot sérialisable de l'état de jeu, donné au cerveau LLM.

function round(n) { return Math.round(n * 10) / 10; }

/** Snapshot sérialisable de l'état courant à partir de l'objet bot Mineflayer. */
function snapshot(bot) {
  const pos = (bot.entity && bot.entity.position) || { x: 0, y: 0, z: 0 };
  const players = Object.keys(bot.players || {}).filter((n) => n !== bot.username);
  const nearbyMobs = Object.values(bot.entities || {})
    .filter((e) => e && e.type === 'mob' && e.position)
    .map((e) => ({ name: e.name, distance: round(e.position.distanceTo(pos)) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 5);
  return {
    username: bot.username,
    health: bot.health == null ? null : bot.health,
    food: bot.food == null ? null : bot.food,
    position: { x: round(pos.x), y: round(pos.y), z: round(pos.z) },
    players,
    nearbyMobs,
  };
}

module.exports = { snapshot };
