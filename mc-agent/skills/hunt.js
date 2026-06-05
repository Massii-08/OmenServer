'use strict';
// Chasse de mobs PASSIFS pour se nourrir (kit de survie) : tue jusqu'à `count` proies proches
// (meilleure arme équipée), attend la mort (borné), va ramasser les drops sur place.
// N'engage JAMAIS un hostile ici (la défense est gérée par survival.js/reflexes).
const { nearestPassive } = require('../survival');
const { bestWeapon } = require('../tools');
let pfGoals; try { pfGoals = require('mineflayer-pathfinder').goals; } catch (e) { pfGoals = null; }

/**
 * huntPassive(bot, {count, maxDistance}, token, deps) → {ok, kills}
 * deps.sleep injectable (tests). Chaque proie : attaque pvp → poll mort (≤20s) → ramasse les drops.
 */
async function huntPassive(bot, { count = 1, maxDistance = 32 } = {}, token = null, deps = {}) {
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const killTimeoutMs = deps.killTimeoutMs || 20000;
  let kills = 0;
  for (let i = 0; i < count; i++) {
    if (token && token.cancelled) break;
    const prey = nearestPassive(bot, maxDistance);
    if (!prey) break;                                       // plus de proie → on rend ce qu'on a
    const w = bestWeapon(bot);
    if (w) { try { await bot.equip(w, 'hand'); } catch (e) {} }
    let last = prey.position;
    try { bot.pvp.attack(prey); } catch (e) {}
    const t0 = Date.now();
    while (prey.isValid && Date.now() - t0 < killTimeoutMs) {
      if (token && token.cancelled) break;
      if (prey.position) last = prey.position;              // suivre la proie (elle fuit)
      await sleep(250);
    }
    try { bot.pvp.stop(); } catch (e) {}
    if (prey.isValid) break;                                // pas tuée (enfuie/timeout) → stop propre
    kills++;
    // ramasser les drops : aller sur le lieu de mort (pickup automatique au contact)
    try {
      if (deps.goto) await deps.goto(last);
      else if (pfGoals && bot.pathfinder && bot.pathfinder.goto) {
        await bot.pathfinder.goto(new pfGoals.GoalNear(last.x, last.y, last.z, 1));
      }
    } catch (e) { /* drops perdus → tant pis, proie suivante */ }
    await sleep(deps.pickupMs != null ? deps.pickupMs : 800);
  }
  return { ok: kills > 0, kills };
}

module.exports = { huntPassive };
