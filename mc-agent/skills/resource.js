'use strict';
// Boucle RESSOURCE (objectif `resource`, role worker) : lit worlds[<monde>].ores de la mémoire de
// monde du groupe (positions 3D EXACTES de minerais notés par les cartographes), choisit les
// cibles (priorité diamant>fer>… + proximité, cf. ores.js), navigue, mine avec la bonne pioche, et
// MET À JOUR LA CARTE : `ore_mined` (miné) / `ore_gone` (constaté absent) sont routés par le manager
// vers la store du groupe (remove_ore) → l'ore disparaît du fichier mémoire et de la carte.
// Une cible INATTEIGNABLE n'est PAS retirée (elle existe peut-être encore) — juste skippée localement.
//
// MODE QUOTA (opts.quota) : compteur par TYPE (quota.js, ex. 15💎/15 or/64 redstone/64 lapis/64 fer) —
//  - ne vise QUE les types encore manquants (allowTypes), s'arrête quand tout est atteint (quota_done) ;
//  - claims anti-collision entre bots (opts.claims, fichier partagé TTL) : une ore claimée par un
//    autre bot est re-éligible après 30 s (sa claim peut expirer) ;
//  - mémoire LIVE (opts.reloadMemory) : carte vide/épuisée → attente active (resource_waiting) +
//    re-lecture (les cartographes ajoutent encore) ; au-delà de maxIdleMs sans cible → starved ;
//  - inventaire plein → opts.cleanup (toss du junk de creusage — sous terre il n'y a pas de coffre,
//    et le deposit legacy jetterait AUSSI la pioche) ; sinon deposit legacy + noteBanked.
const { nextOreTarget, oreKey, listOres } = require('../ores');
const { bestToolFor } = require('../tools');
const { isOre } = require('../worldMemory');
const { createQuotaTracker } = require('../quota');

let vec3; try { vec3 = require('vec3'); } catch (e) { vec3 = null; }
function _pos(t) { return vec3 ? vec3(t.x, t.y, t.z) : { x: t.x, y: t.y, z: t.z }; }

const BUSY_RETRY_MS = 30000;   // ore claimée par un autre : re-tentée après ce délai

// Coupe le mouvement résiduel (même garde-fou que gather : collectBlock peut laisser son goal actif).
function _stopResidual(bot) {
  try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
  try {
    if (bot.setControlState) ['forward', 'back', 'left', 'right', 'sneak', 'jump'].forEach((c) => bot.setControlState(c, false));
  } catch (e) {}
}

function _items(bot) {
  try { return ((bot.inventory && bot.inventory.items()) || []).map((i) => ({ name: i.name, count: i.count })); }
  catch (e) { return []; }
}

/**
 * runResource(bot, opts, token) → {ok:true, mined[, done]} | {ok:true, mined, cancelled}
 *                               | {ok:false, reason, mined}
 *  memory/worldKey : mémoire de monde + clé (sinon bot._worldMemory/_worldKey)
 *  emit      : hook events (resource_* / ore_mined / ore_gone / quota_*)
 *  goto      : async (target) => void — navigation BORNÉE vers (x,y,z), throw si inatteignable
 *              (injectée par index.js : withTimeout + persistance par progrès ; identité dans les tests)
 *  onTarget  : hook async avant chaque cible (survie : settleSurvivalKit/escapeWater)
 *  pickTier  : () => number — meilleur palier de pioche en poche (filtre les cibles inminables)
 *  deposit   : async (bot) => {ok} — dépôt coffre legacy (inventaire plein, hors mode quota)
 *  quota     : {type: n} — active le mode quota (cf. en-tête)
 *  claims    : {tryClaim(key), refresh(key), release(key)} — anti-collision multi-bots
 *  reloadMemory : () => memory — re-lecture de la carte live (mode quota)
 *  cleanup   : async (bot) => void — toss du junk quand l'inventaire est plein (mode quota)
 *  sleep/now/waitMs/maxIdleMs : injectables (tests)
 */
async function runResource(bot, opts = {}, token = null) {
  const emit = opts.emit || (() => {});
  let memory = opts.memory || bot._worldMemory || null;
  const wkey = opts.worldKey || bot._worldKey || null;
  const doGoto = opts.goto;
  const onTarget = opts.onTarget || null;
  const deposit = opts.deposit || null;
  const cleanup = opts.cleanup || null;
  const pickTier = opts.pickTier || null;
  const claims = opts.claims || null;
  const reload = opts.reloadMemory || null;
  const tracker = opts.quota ? createQuotaTracker(opts.quota) : null;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const clock = opts.now || Date.now;
  const waitMs = opts.waitMs != null ? opts.waitMs : 5000;
  const maxIdleMs = opts.maxIdleMs != null ? opts.maxIdleMs : 600000;

  const skip = new Set();        // cibles traitées (minées/absentes/ratées) : on ne re-vise jamais 2×
  const busyUntil = new Map();   // oreKey → ts : claimée par un autre bot, re-éligible après
  let mined = 0;
  let idleSince = null;
  let lastProgress = '';

  function emitProgress() {
    if (!tracker) return;
    const counts = tracker.progress(_items(bot));
    const j = JSON.stringify(counts);
    if (j !== lastProgress) { lastProgress = j; emit({ type: 'quota_progress', counts }); }
  }

  emit({ type: 'resource_start', world: wkey, ores: listOres(memory, wkey).length,
         quota: tracker ? tracker.target : null });
  emitProgress();

  while (true) {
    if (token && token.cancelled) return { ok: true, mined, cancelled: true };

    // Quota atteint ? (vérifié en tête : un bot peut démarrer déjà servi)
    if (tracker && tracker.met(_items(bot))) {
      emitProgress();
      emit({ type: 'quota_done', mined });
      emit({ type: 'resource_done', mined });
      return { ok: true, mined, done: true };
    }

    const from = bot.entity && bot.entity.position;
    if (!from) return { ok: false, reason: 'no_pos', mined };
    const tier = typeof pickTier === 'function' ? pickTier() : pickTier;

    // Exclusions du tour : déjà traitées + claimées par d'autres (re-éligibles après délai).
    const now = clock();
    const skipNow = new Set(skip);
    for (const [k, until] of busyUntil) {
      if (until > now) skipNow.add(k); else busyUntil.delete(k);
    }
    const allowTypes = tracker ? tracker.remainingTypes(_items(bot)) : undefined;
    const target = nextOreTarget(memory, wkey, from, {
      skip: skipNow, allowTypes,
      pickTier: (typeof tier === 'number' ? tier : undefined),
    });

    if (!target) {
      if (!reload) break;                              // legacy : carte épuisée → done
      if (idleSince == null) idleSince = now;
      if (now - idleSince > maxIdleMs) {
        emit({ type: 'resource_starved', mined, idleMs: now - idleSince });
        return { ok: false, reason: 'starved', mined };
      }
      emit({ type: 'resource_waiting', world: wkey });
      await sleep(waitMs);
      if (token && token.cancelled) return { ok: true, mined, cancelled: true };
      memory = reload() || memory;                     // les cartographes ajoutent encore
      continue;
    }
    idleSince = null;
    const key = oreKey(target);

    // Claim anti-collision : un autre bot la tient → skip temporaire (sa claim peut expirer).
    if (claims && !claims.tryClaim(key)) {
      busyUntil.set(key, now + BUSY_RETRY_MS);
      continue;
    }
    skip.add(key);
    emit({ type: 'resource_target', material: target.material, x: target.x, y: target.y, z: target.z });
    // Survie d'abord (settleSurvivalKit/escapeWater injectés) : on règle les menaces AVANT le trajet.
    if (onTarget) { try { await onTarget(); } catch (e) {} }
    if (token && token.cancelled) return { ok: true, mined, cancelled: true };

    // Inventaire plein → tri AVANT d'aller miner. Mode quota : toss du junk (cleanup) — pas de
    // coffre sous terre et le deposit legacy jetterait la pioche. Legacy : dépôt coffre (≤12 blocs).
    if (bot.inventory && typeof bot.inventory.emptySlotCount === 'function'
        && bot.inventory.emptySlotCount() <= 1) {
      if (cleanup) {
        try { await cleanup(bot); } catch (e) {}
        emit({ type: 'resource_cleanup' });
      } else if (deposit) {
        const before = _items(bot);
        let d = null;
        try { d = await deposit(bot); } catch (e) {}
        if (tracker) tracker.noteBanked(before, _items(bot));  // le dépôt ne fait pas perdre le compte
        emit({ type: 'resource_deposit', ok: !!(d && d.ok) });
      }
      if (token && token.cancelled) return { ok: true, mined, cancelled: true };
    }

    // Navigation bornée vers la position exacte. Throw = inatteignable → skip local SANS retirer
    // de la carte + release de la claim (un autre bot — mieux placé/équipé — pourra retenter).
    try { await doGoto(target); }
    catch (e) {
      _stopResidual(bot);
      if (claims) claims.release(key);
      emit({ type: 'resource_unreachable', x: target.x, y: target.y, z: target.z });
      continue;
    }
    if (token && token.cancelled) return { ok: true, mined, cancelled: true };

    // Le minerai est-il toujours là ? (déjà miné par un joueur/bot, ou jamais existé → carte MAJ)
    // N'importe quel minerai à la position notée est bon à prendre (le cartographe a pu noter la
    // variante stone et le bloc être deepslate — position exacte = vérité).
    const block = bot.blockAt ? bot.blockAt(_pos(target)) : null;
    if (!block || !isOre(block.name)) {
      if (claims) claims.release(key);
      emit({ type: 'ore_gone', world: wkey, x: target.x, y: target.y, z: target.z });
      continue;
    }

    // Équipe la bonne pioche puis mine. collectBlock gère l'approche fine + le ramassage du drop.
    // Re-équipe + retente UNE fois (dig interrompu par aggro/désync, pattern gather).
    if (claims) claims.refresh(key);                   // le dig peut être long
    const tool = bestToolFor(bot, block);
    if (tool) { try { await bot.equip(tool, 'hand'); } catch (e) {} }
    let okMine = false;
    try { await bot.collectBlock.collect(block); okMine = true; }
    catch (e) {
      try {
        const tool2 = bestToolFor(bot, block);
        if (tool2) { try { await bot.equip(tool2, 'hand'); } catch (e2) {} }
        await bot.collectBlock.collect(block); okMine = true;
      } catch (e2) { _stopResidual(bot); }
    }
    if (claims) claims.release(key);                   // minée OU ratée : claim libérée
    if (token && token.cancelled) return { ok: true, mined, cancelled: true };

    if (okMine) {
      mined++;
      emit({ type: 'ore_mined', world: wkey, material: target.material, x: target.x, y: target.y, z: target.z });
      emitProgress();
    } else {
      // échec de minage (≠ absent) : on ne retire PAS de la carte — le bloc est encore là.
      emit({ type: 'resource_failed', x: target.x, y: target.y, z: target.z });
    }
  }

  emit({ type: 'resource_done', mined });
  return { ok: true, mined };
}

module.exports = { runResource };
