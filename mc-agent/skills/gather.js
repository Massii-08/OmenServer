'use strict';
// `take <bloc> [n]` : récolte n× le bloc le + proche avec le meilleur outil, en se défendant.
const { bestToolFor, bestWeapon } = require('../tools');
const { NEUTRAL_NO_PROVOKE } = require('../survival');   // bug #3 (Massii) : jamais l'enderman (neutre)
const { explore } = require('./explore');
const { materialFoundEvent, resolveBiome } = require('../worldMemory');

// Expédition bois (Massii 15/07) : quand le spawn est déboisé, revenir chercher 3 bûches à la fois
// = perdre un temps fou (chaque trajet = mort/noyade possible). Si aucun bois LOCAL (voyage requis),
// on fait le PLEIN (≥12 ≈ tout le bootstrap bois : table+pioche+sticks+four) en un seul trajet. Pur.
const WOOD_EXPEDITION = 12;
function woodExpeditionCount(baseCount, localWood) {
  if (localWood) return baseCount;
  return Math.max(baseCount, WOOD_EXPEDITION);
}

function _ids(bot, name) {
  if (!bot.registry || !bot.registry.blocksByName) return null;
  if (Array.isArray(name)) {
    const ids = name
      .map((n) => bot.registry.blocksByName[n])
      .filter(Boolean)
      .map((def) => def.id);
    return ids.length > 0 ? ids : null;
  }
  const def = bot.registry.blocksByName[name];
  return def ? [def.id] : null;
}

/** Mob hostile à portée (≤ radius) du bot, ou null. */
function nearbyHostile(bot, radius = 4) {
  const self = bot.entity && bot.entity.position;
  if (!self) return null;
  return bot.nearestEntity((e) => {
    if (!e || (e.type !== 'mob' && e.type !== 'hostile') || e.kind !== 'Hostile mobs' || !e.position) return false;
    if (NEUTRAL_NO_PROVOKE.has(e.name)) return false;   // bug #3 : jamais l'enderman (neutre)
    const d = e.position.distanceTo ? e.position.distanceTo(self) : 999;
    return d <= radius;
  });
}

// Coupe le mouvement résiduel après un échec de collect : collectBlock peut laisser son goal
// pathfinder actif → le bot continuerait de creuser/marcher vers une cible morte (vu live HarvT6 :
// creusage fantôme vers un diamant inatteignable, danger lave + anti-tell).
function stopResidual(bot) {
  try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
  try {
    if (bot.setControlState) ['forward', 'back', 'left', 'right', 'sneak', 'jump'].forEach((c) => bot.setControlState(c, false));
  } catch (e) {}
}

// Mobs qu'on n'attaque JAMAIS au corps-à-corps pendant la récolte (analyse jeu humain, 26/07) :
// s'approcher d'un creeper l'amorce, et son explosion inflige jusqu'à ~64 dégâts à bout portant —
// soit trois fois les PV max d'un bot nu. Le réflexe de survie (`combatDecision`) sait déjà les
// FUIR ; ici il suffit de ne pas foncer dessus. Idem pour ce qu'on a décidé de fuir par ailleurs.
const NO_MELEE = new Set(['creeper', 'wither_skeleton', 'warden', 'ravager', 'evoker', 'ghast']);

/** Si un hostile est proche : équipe la meilleure arme et l'attaque. true si défense engagée. */
async function defendIfNeeded(bot) {
  const foe = nearbyHostile(bot);
  if (!foe) return false;
  if (foe.name && NO_MELEE.has(foe.name)) return false;   // on le laisse aux réflexes (fuite)
  const w = bestWeapon(bot);
  if (w) { try { await bot.equip(w, 'hand'); } catch (e) {} }
  try { bot.pvp.attack(foe); } catch (e) {}
  return true;
}

/** Récolte `count`× le bloc `name` le + proche. {ok, reason?/got}. `token` = annulation. */
async function gather(bot, { name, count = 1, maxDistance = 64, explore: doExplore = false, collectTimeoutMs = 90000 } = {}, token = null) {
  if (!name || (Array.isArray(name) && name.length === 0)) return { ok: false, reason: 'no_block' };
  // collectBlock.collect peut geler INDÉFINIMENT (cible inminable après approche : lave, désync — aucun
  // timeout interne) → branchMine (opportunisme) figé jusqu'à 900s, HORS de portée des watchdogs
  // (bug review #6, vécu ResBot1 25 min). Borne dure (miroir resource.js) : timeout → reject → le
  // catch existant gère exactement comme un collect rejeté (re-équipe/retry puis stopResidual+failed).
  const collectBounded = (block) => new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; reject(new Error('collect_timeout')); } }, collectTimeoutMs);
    bot.collectBlock.collect(block).then(
      (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } },
      (e) => { if (!done) { done = true; clearTimeout(t); reject(e); } });
  });
  // Bloc inconnu du registre (faute de frappe, version) → not_found NET. Jamais findBlock(matching:null)
  // (comportement indéfini mineflayer) ni exploration pour une cible qui n'existe pas.
  const ids = _ids(bot, name);
  if (!ids) return { ok: false, reason: 'not_found' };
  let got = 0;
  let explorations = 0;
  // Cibles dont le collect a échoué ×2 (enterrées/inatteignables, vu live HarvT6) : on ne s'y
  // racharne pas — findBlock les ignore → l'explore/directed peut chercher AILLEURS.
  const failed = new Set();
  const keyOf = (p) => `${p.x},${p.y},${p.z}`;
  for (let i = 0; i < count; i++) {
    if (token && token.cancelled) return { ok: true, got, cancelled: true };
    await defendIfNeeded(bot);
    let block = bot.findBlock({ matching: ids, maxDistance });
    if (block && failed.has(keyOf(block.position))) block = null; // cible déjà ratée = comme absente
    // Rien à portée → exploration de surface autonome (opt-in `explore`, borné). Le bot voyage en
    // anneaux et re-scanne jusqu'à trouver. Désactivé par défaut : les gather opportunistes (type
    // branchMine à maxDistance:6 sur un minerai entrevu) ne doivent PAS partir roamer 256 blocs.
    if (!block && doExplore && explorations <= count) {
      explorations++;
      // emit : les events explore (explore_directed/explore_waypoint) remontent dans le flux stdout
      // du bot → observables en live (run.log / manager). Sans ça le biais dirigé est invisible.
      const ex = await explore(bot, { name, matching: ids, scanRadius: maxDistance, token, emit: bot._emit || null });
      if (token && token.cancelled) return { ok: true, got, cancelled: true };
      if (ex && ex.ok) {
        block = bot.findBlock({ matching: ids, maxDistance });
        if (block && failed.has(keyOf(block.position))) block = null;
      }
    }
    if (!block) {
      if (got === 0) return { ok: false, reason: 'not_found' };
      break;
    }
    const tool = bestToolFor(bot, block);
    if (tool) { try { await bot.equip(tool, 'hand'); } catch (e) {} }
    // resolveBiome : en 1.21.4 block.biome.name est '' → résolu via registry (sinon material_found muet)
    const biomeName = resolveBiome(bot, block).name;    // capturé avant collect (le bloc devient air)
    try { await collectBounded(block); got++; }
    catch (e) {
      // #2 retours live : un dig peut être interrompu (aggro/mouvement/désync) → re-équipe et retente UNE fois
      try {
        const tool2 = bestToolFor(bot, block);
        if (tool2) { try { await bot.equip(tool2, 'hand'); } catch (e2) {} }
        await collectBounded(block); got++;
      } catch (e2) {
        stopResidual(bot);                       // collectBlock laisse son goal actif → creusage fantôme
        failed.add(keyOf(block.position));       // ne plus viser cette cible morte
        if (doExplore && explorations <= count) { i--; continue; } // l'explore du tour suivant cherche AILLEURS
        if (got === 0) return { ok: false, reason: 'collect_failed' };
        break;
      }
    }
    // Boucle d'apprentissage (1d) : note "ce matériau a été trouvé dans ce biome ici" → mémoire du
    // groupe (event material_found capté par le manager). Robuste datapacks (on n'apprend que l'observé).
    if (bot._emit && bot._worldKey && block.name && biomeName) {
      try { bot._emit(materialFoundEvent(bot._worldKey, block.name, biomeName, block.position)); } catch (e) {}
    }
  }
  return { ok: true, got };
}

module.exports = { gather, nearbyHostile, defendIfNeeded, woodExpeditionCount, WOOD_EXPEDITION, NO_MELEE };
