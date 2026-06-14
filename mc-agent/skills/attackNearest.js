'use strict';
// Attaque l'entité hostile la plus proche via mineflayer-pvp (approche + frappe en boucle).

/** Attaque le mob hostile le plus proche (fallback : n'importe quel mob). False si rien. */
function attackNearest(bot) {
  let victim = bot.nearestEntity((e) => e && (e.type === 'mob' || e.type === 'hostile') && e.kind === 'Hostile mobs');
  if (!victim) victim = bot.nearestEntity((e) => e && (e.type === 'mob' || e.type === 'hostile'));
  if (!victim) { bot.chat('rien a attaquer ici'); return false; }
  bot.pvp.attack(victim);
  return true;
}

module.exports = { attackNearest };
