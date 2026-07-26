'use strict';
// ABRI NOCTURNE (vécu Surv4 : 7 morts de nuit pendant le kit) — le réflexe humain sans armure :
// se creuser un trou de 2 blocs, se boucher au-dessus, ATTENDRE L'AUBE, ressortir en pilier (#7).
// Best-effort : un trou sans toit protège déjà des squelettes/creepers ; les réflexes restent ON.
const { Vec3 } = require('vec3');
const { mineDown } = require('./mineDown');
const { panicWall } = require('./panicWall');
const { pillarUp, SCAFFOLD } = require('./pillarUp');
const { POSABLE } = require('../dirt');
const { bestToolFor } = require('../tools');

// Creuse en ÉQUIPANT le bon outil (Massii 2026-07-26 : « neth1 casse la pierre avec ses mains »).
// Ce module appelait `bot.dig` NU trois fois : la pierre à la main c'est ~7,5 s par bloc contre
// ~1,15 s à la pioche pierre. L'abri nocturne prenait donc des MINUTES, passées à découvert — soit
// exactement la situation qu'il est censé éviter.
async function _digWithTool(bot, block) {
  if (!block) return false;
  try {
    const tool = bestToolFor(bot, block);
    if (tool) { try { await bot.equip(tool, 'hand'); } catch (e) { /* on creuse quand même */ } }
  } catch (e) { /* best-effort */ }
  try { await bot.dig(block); return true; } catch (e) { return false; }
}

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
  const digDown = deps.mineDown || mineDown;          // injectables (tests)
  const wallIn = deps.wallIn || panicWall;
  emit({ type: 'shelter', action: 'dig_in' });

  // 1) se terrer : 2 blocs vers le bas (mineDown a déjà les garde-fous lave/vide)
  const down = await digDown(bot, { depth: 2 }, token);
  let dugIn = !!down.ok;
  if (!down.ok) {
    // PLAN B : SE MURER SUR PLACE (mesure live world_ax4 25/07 — 40 % des abris échouaient :
    // void_below 19, dig_failed 17, danger_below 9 — et un abri raté = une nuit ENTIÈRE à
    // découvert, tous mobs confondus). Creuser n'est pas la seule façon de se mettre à l'abri :
    // un vrai joueur se boxe avec ce qu'il a. panicWall gère même la grotte ouverte (pontage).
    const walled = await wallIn(bot);
    if (!walled || !walled.ok) {
      emit({ type: 'shelter', action: 'abort', reason: down.reason });
      return { ok: false, reason: down.reason };
    }
    emit({ type: 'shelter', action: 'walled_in', placed: walled.placed || 0, after: down.reason });
  }

  // 2) toit : bloc de l'inventaire, sinon on en MINE un (terre/gravier drop sans outil) — auto-suffisant.
  try {
    const head2 = bot.entity.position.floored().offset(0, 2, 0);
    let block = bot.inventory.items().find((i) => SCAFFOLD.includes(i.name));
    if (!block) {
      const feet = bot.entity.position.floored();
      for (const d of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
        const wall = bot.blockAt(feet.plus(d));
        if (wall && wall.boundingBox === 'block' && wall.name !== 'bedrock') {
          await _digWithTool(bot, wall); await sleep(300);
          block = bot.inventory.items().find((i) => SCAFFOLD.includes(i.name));
          if (block) break;
        }
      }
    }
    if (block) {
      for (const d of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
        const wall = bot.blockAt(head2.plus(d));
        if (!wall || wall.boundingBox !== 'block') continue;
        try {
          await bot.equip(block, 'hand');
          await bot.placeBlock(wall, d.scaled(-1));
          const roof = bot.blockAt(head2);
          if (roof && roof.boundingBox === 'block') { emit({ type: 'shelter', action: 'roofed' }); break; }
        } catch (e) { /* paroi suivante */ }
      }
    } else {
      emit({ type: 'shelter', action: 'no_roof' });
    }
  } catch (e) { /* best-effort */ }

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
    if (roof && roof.boundingBox === 'block') await _digWithTool(bot, roof);
  } catch (e) {}
  if (!dugIn) {
    // Muré au niveau du sol : on n'est pas dans un trou, donc pas de pilier — on perce une paroi.
    try {
      const feet = bot.entity.position.floored();
      for (const d of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
        const w = bot.blockAt(feet.plus(d));
        if (w && w.boundingBox === 'block' && w.name !== 'bedrock') { await _digWithTool(bot, w); break; }
      }
    } catch (e) { /* best-effort */ }
    emit({ type: 'shelter', action: 'out', ok: true, mode: 'walled' });
    return { ok: true };
  }
  const up = await pillarUp(bot, { height: 2 }, token, { sleep: deps.pillarSleep || deps.sleep });
  emit({ type: 'shelter', action: 'out', ok: up.ok });
  return { ok: true };
}

/**
 * Décision PURE : comment obtenir le bloc-toit pour sceller l'abri ?
 * inv = [{name,count}] ; ctx = { hasPickaxe, groundMineable }.
 * → { source: 'inventory' | 'mine' | 'none' }.
 */
function roofPlan(inv, ctx = {}) {
  for (const it of inv || []) if (POSABLE.has(it.name) && (it.count || 0) > 0) return { source: 'inventory' };
  if (ctx.groundMineable || ctx.hasPickaxe) return { source: 'mine' };
  return { source: 'none' };
}

/**
 * Décision PURE : faut-il se mettre à l'abri MAINTENANT ? Robuste au niveau de lumière inconnu
 * (mineflayer ne le livre pas toujours) : retombe sur la présence d'hostiles.
 * sig = { night, lightLevel (0-15|null), naked, lowHp, hostilesNear, proactive, underground }.
 * → { shelter: bool, reason }.
 */
function shouldShelter(sig = {}) {
  // SOUS TERRE : jamais d'abri (Massii 16/07) — il y fait TOUJOURS sombre et le mineur en chaîne
  // armure est nu par définition → le trigger 'dark' l'enterrait 10-13 min en boucle DANS sa mine,
  // où « attendre l'aube » ne protège de rien (les mobs de grotte spawnent jour et nuit). Les
  // réflexes combat/fuite + ban-zone couvrent les hostiles souterrains.
  if (sig.underground) return { shelter: false, reason: 'underground' };
  const dark = (sig.lightLevel != null && sig.lightLevel <= 7);
  if (sig.night && (sig.proactive || sig.naked || sig.lowHp)) return { shelter: true, reason: 'night' };
  if (dark && (sig.naked || sig.lowHp || sig.hostilesNear)) return { shelter: true, reason: 'dark' };
  if (sig.hostilesNear && (sig.naked || sig.lowHp)) return { shelter: true, reason: 'hostiles' };
  return { shelter: false, reason: 'safe' };
}

module.exports = { isNightTime, isNight, shelterUntilDawn, roofPlan, shouldShelter };
