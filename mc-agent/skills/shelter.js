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

// ─── L'AUBE N'EST PAS LA FIN DES MONSTRES (live 19/10, spawn sous la canopée d'une vieille forêt) ──
// Mesuré en live : 14 des 17 morts des 10 dernières minutes étaient « shot by Skeleton », avec TOUJOURS
// la même séquence : shelter dig_in → shelter dawn → shelter out → goal logs → reflex fight_ranged →
// reflex flee → take_cover placed:0 ok:false → mort. L'abri sortait dès que `isNight` devenait faux,
// sans regarder si les monstres de la nuit attendaient dehors. À l'ombre d'une canopée, zombies et
// squelettes NE BRÛLENT PAS au lever du jour : ils sont toujours là, et le bot sort droit dans leur arc.
// Étape 3bis : entre l'aube et la sortie, tant qu'un hostile rôde ET que le bot est nu, on RESTE.
const DAWN_WAIT_MAX_MS = 120 * 1000;   // borne DURE : au-delà on sort quand même (VITESSE — le propriétaire veut
                                       // que rien ne traîne ; à découvert sous une canopée ils ne partiront pas)
const DAWN_WAIT_CHECK_MS = 3000;       // on re-vérifie toutes les 3 s
// « Nu » = moins de 2 pièces portées : le mot de caution.CAUTION_MIN_WORN, homes.DEBT_MIN_WORN et
// unstuck.SPAWN_DANGER_MIN_WORN (copié, pas importé — ce module reste léger ; un test épingle les quatre).
const DAWN_WAIT_MIN_WORN = 2;

/**
 * Décision PURE : attendre dans l'abri ou en sortir, à l'aube ? → 'wait' | 'go'.
 * 'wait' SSI le bot est NU (< minWorn pièces) ET des hostiles rôdent ET on n'a pas encore attendu maxMs.
 * Tout le reste → 'go' : un bot armé sort tout de suite, comme avant ; personne dehors, on sort ; et
 * passé la borne on sort quand même. Entrée absurde → 'go' (jamais coincé dans le trou sur une erreur).
 * `worn` inconnu (inventaire illisible) = 0 = nu : on attend, borné — « 0 = prudent », comme les autres gardes.
 * @param {{hostilesNear:number|boolean, waitedMs:number, worn:number, maxMs?:number, minWorn?:number}} opts
 */
function dawnExitDecision(opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const minWorn = Number.isFinite(o.minWorn) ? o.minWorn : DAWN_WAIT_MIN_WORN;
  const maxMs = (Number.isFinite(o.maxMs) && o.maxMs >= 0) ? o.maxMs : DAWN_WAIT_MAX_MS;
  const worn = (Number.isFinite(o.worn) && o.worn > 0) ? o.worn : 0;
  if (worn >= minWorn) return 'go';
  const h = o.hostilesNear;
  const hostiles = Number.isFinite(h) ? h : (h === true ? 1 : 0);
  if (hostiles <= 0) return 'go';
  const waited = (Number.isFinite(o.waitedMs) && o.waitedMs > 0) ? o.waitedMs : 0;
  return waited >= maxMs ? 'go' : 'wait';
}

/**
 * Étape 3bis — rester dans l'abri tant que dawnExitDecision dit 'wait'. Relevés LIVE (jamais mis en
 * cache : le monde bouge pendant l'attente), un toutes les `checkMs`. Le temps attendu est le plus
 * grand de deux compteurs : le CUMUL des pas (avec un sleep instantané, en test, la boucle reste bornée
 * au lieu de tourner sans fin) et l'HORLOGE MURALE (quand le process rame et que les sleeps durent plus
 * que prévu, la borne de 120 s reste de 120 s RÉELLES — « rien ne doit traîner »).
 * Émet UN SEUL event `dawn_wait` à la sortie de l'attente (pas un par tick), et seulement si on a
 * réellement attendu : `hostiles` = ce qui nous a retenus (au début), `hostiles_left` = ce qu'il restait
 * en sortant, `waited_s`, `reason` : 'clear' (dégagé) | 'timeout' (borne atteinte, on sort quand même)
 * | 'armed' (de l'armure est arrivée) | 'cancelled'.
 * @returns {{cancelled:boolean}}
 */
async function _waitOutDawnMobs(bot, token, deps, emit, sleep) {
  const maxMs = Number.isFinite(deps.dawnWaitMaxMs) ? deps.dawnWaitMaxMs : DAWN_WAIT_MAX_MS;
  const checkMs = (Number.isFinite(deps.dawnCheckMs) && deps.dawnCheckMs > 0) ? deps.dawnCheckMs : DAWN_WAIT_CHECK_MS;
  // Un relevé qui LÈVE vaut « rien » : on ne reste jamais coincé dans le trou sur une erreur de lecture.
  const readHostiles = () => {
    try { const v = deps.hostilesNear(); return Number.isFinite(v) ? v : (v ? 1 : 0); } catch (e) { return 0; }
  };
  // Pièces PORTÉES : injecté (index.js : _wornArmor, usées exclues), sinon les slots 5-8 du bot.
  const readWorn = () => {
    try {
      if (typeof deps.worn === 'function') { const v = deps.worn(); return Number.isFinite(v) ? v : 0; }
      const slots = bot && bot.inventory && bot.inventory.slots;
      return Array.isArray(slots) ? slots.slice(5, 9).filter(Boolean).length : 0;
    } catch (e) { return 0; }
  };

  const t0 = Date.now();
  let waitedMs = 0;
  let first = null;          // hostiles quand l'attente a COMMENCÉ (null = on n'a jamais attendu)
  let left = 0;
  let worn = 0;
  const done = (reason) => {
    if (first === null) return;                 // rien attendu → rien à dire
    emit({ type: 'shelter', action: 'dawn_wait', hostiles: first, hostiles_left: left,
      waited_s: Math.round(waitedMs / 1000), reason });
  };
  for (;;) {
    if (token && token.cancelled) { done('cancelled'); return { cancelled: true }; }
    left = readHostiles();
    worn = readWorn();
    if (dawnExitDecision({ hostilesNear: left, waitedMs, worn, maxMs }) !== 'wait') break;
    if (first === null) first = left;
    await sleep(checkMs);
    waitedMs = Math.max(waitedMs + checkMs, Date.now() - t0);
  }
  done(worn >= DAWN_WAIT_MIN_WORN ? 'armed' : (left > 0 ? 'timeout' : 'clear'));
  return { cancelled: false };
}

/**
 * shelterUntilDawn(bot, token, deps) → {ok, reason?} — creuse, se couvre, attend l'aube, remonte.
 * deps.sleep injectable ; maxWaitMs borne l'attente (nuit MC ≈ 7 min réels ; déf 12 min).
 * deps.hostilesNear (() => nb d'hostiles à portée) + deps.worn (() => nb de pièces portées) : l'attente
 * des monstres à l'aube (étape 3bis) — SANS hostilesNear injecté, elle est sautée (comportement d'origine).
 * deps.dawnWaitMaxMs / deps.dawnCheckMs : borne (déf 120 s) et pas (déf 3 s) de cette attente.
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

  // 3bis) L'AUBE N'EST PAS LA FIN DES MONSTRES : bot nu + hostiles dehors → on reste (borné 120 s).
  // Branchement explicite : sans `deps.hostilesNear` l'attente n'existe pas (comportement d'origine).
  if (typeof deps.hostilesNear === 'function') {
    const w = await _waitOutDawnMobs(bot, token, deps, emit, sleep);
    if (w.cancelled) return { ok: false, reason: 'cancelled' };
  }

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

module.exports = {
  isNightTime, isNight, shelterUntilDawn, roofPlan, shouldShelter,
  dawnExitDecision, DAWN_WAIT_MAX_MS, DAWN_WAIT_CHECK_MS, DAWN_WAIT_MIN_WORN,
};
