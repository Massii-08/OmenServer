'use strict';
// ABRI NOCTURNE (vécu Surv4 : 7 morts de nuit pendant le kit) — le réflexe humain sans armure :
// se creuser un trou de 2 blocs, se boucher au-dessus, ATTENDRE L'AUBE, ressortir en pilier (#7).
// Best-effort : un trou sans toit protège déjà des squelettes/creepers ; les réflexes restent ON.
const { Vec3 } = require('vec3');
const { mineDown } = require('./mineDown');
const { pillarUp, SCAFFOLD } = require('./pillarUp');

/** PUR : est-ce la nuit (hostiles spawnent) ? timeOfDay ∈ [0,24000), nuit ≈ 12800-23200. */
function isNightTime(timeOfDay) {
  if (timeOfDay == null) return false;
  const t = ((timeOfDay % 24000) + 24000) % 24000;
  return t >= 12800 && t <= 23200;
}

/** Nuit côté bot (bot.time.timeOfDay). */
function isNight(bot) {
  return !!(bot && bot.time && isNightTime(bot.time.timeOfDay));
}

/**
 * shelterUntilDawn(bot, token, deps) → {ok, reason?} — creuse, se couvre, attend l'aube, remonte.
 * deps.sleep injectable ; maxWaitMs borne l'attente (nuit MC ≈ 7 min réels ; déf 12 min).
 */
async function shelterUntilDawn(bot, token = null, deps = {}) {
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const emit = deps.emit || (() => {});
  const maxWaitMs = deps.maxWaitMs || 12 * 60 * 1000;
  emit({ type: 'shelter', action: 'dig_in' });

  // 1) se terrer : 2 blocs vers le bas (mineDown a déjà les garde-fous lave/vide)
  const down = await mineDown(bot, { depth: 2 }, token);
  if (!down.ok) { emit({ type: 'shelter', action: 'abort', reason: down.reason }); return { ok: false, reason: down.reason }; }

  // 2) toit best-effort : un bloc posé contre la paroi au niveau de la tête+1 (référence PLEINE, #6)
  try {
    const head2 = bot.entity.position.floored().offset(0, 2, 0);     // case au-dessus de la tête
    const scaffold = bot.inventory.items().find((i) => SCAFFOLD.includes(i.name));
    if (scaffold) {
      for (const d of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
        const wall = bot.blockAt(head2.plus(d));                      // paroi du trou à cette hauteur
        if (!wall || wall.boundingBox !== 'block') continue;
        try {
          await bot.equip(scaffold, 'hand');
          await bot.placeBlock(wall, d.scaled(-1));                   // pose vers le centre du trou
          const roof = bot.blockAt(head2);
          if (roof && roof.boundingBox === 'block') { emit({ type: 'shelter', action: 'roofed' }); break; }
        } catch (e) { /* paroi suivante */ }
      }
    }
  } catch (e) { /* sans toit : le trou protège déjà des tirs/projections */ }

  // 3) attendre l'aube (borné, annulable) — les réflexes survie tournent en parallèle
  const t0 = Date.now();
  while (isNight(bot) && Date.now() - t0 < maxWaitMs) {
    if (token && token.cancelled) return { ok: false, reason: 'cancelled' };
    await sleep(5000);
  }
  emit({ type: 'shelter', action: 'dawn' });

  // 4) ressortir : casser le toit éventuel puis remonter en pilier (#7)
  try {
    const roof = bot.blockAt(bot.entity.position.floored().offset(0, 2, 0));
    if (roof && roof.boundingBox === 'block') await bot.dig(roof);
  } catch (e) {}
  // G (Massii) : sortie via PATHFINDER d'abord (scafoldingBlocks + allow1by1towers gèrent le trou
  // 1×1 nativement, bien plus fiable que le jump+place manuel) ; pillarUp = ultime fallback.
  let up = { ok: false };
  try {
    const goals = require('mineflayer-pathfinder').goals;
    if (goals && goals.GoalY && bot.pathfinder && bot.pathfinder.goto) {
      const fromY = Math.floor(bot.entity.position.y);
      await Promise.race([
        bot.pathfinder.goto(new goals.GoalY(fromY + 2)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ascend_timeout')), 30000)),
      ]);
      if (Math.floor(bot.entity.position.y) >= fromY + 2) up = { ok: true, via: 'pathfinder' };
    }
  } catch (e) {}
  if (!up.ok) up = await pillarUp(bot, { height: 2 }, token, { sleep: deps.pillarSleep || deps.sleep });
  emit({ type: 'shelter', action: 'out', ok: up.ok });
  return { ok: true };
}

module.exports = { isNightTime, isNight, shelterUntilDawn };
