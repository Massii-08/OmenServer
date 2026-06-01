'use strict';
// `guard` : tue les mobs hostiles autour jusqu'à annulation (token). Boucle setInterval.
const { bestWeapon } = require('../tools');

function nearestHostile(bot) {
  return bot.nearestEntity((e) => e && e.type === 'mob' && e.kind === 'Hostile mobs' && e.position);
}

/** Un cycle de garde : si hostile, équipe l'arme + attaque. Testable sans timer. */
async function guardTick(bot) {
  const foe = nearestHostile(bot);
  if (!foe) return false;
  const w = bestWeapon(bot);
  if (w) { try { await bot.equip(w, 'hand'); } catch (e) {} }
  try { bot.pvp.attack(foe); } catch (e) {}
  return true;
}

/** Démarre la boucle de garde. Retourne stop() (cleanup). */
function guard(bot, token, { intervalMs = 1000 } = {}) {
  const run = () => { if (!token || !token.cancelled) guardTick(bot).catch(() => {}); };
  const id = setInterval(run, intervalMs);
  run();
  return () => { clearInterval(id); try { bot.pvp.stop(); } catch (e) {} };
}

module.exports = { guard, guardTick, nearestHostile };
