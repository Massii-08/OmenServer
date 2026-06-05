'use strict';
// Boucle RESSOURCE (objectif `resource`, role worker) : lit worlds[<monde>].ores de la mémoire de
// monde du groupe (positions 3D EXACTES de minerais EXPOSÉS notés par le cartographe), choisit les
// cibles (priorité diamant>fer>… + proximité, cf. ores.js), navigue, mine avec la bonne pioche, et
// MET À JOUR LA CARTE : `ore_mined` (miné) / `ore_gone` (constaté absent) sont routés par le manager
// vers la store du groupe (remove_ore) → l'ore disparaît du fichier mémoire et de la carte.
// Une cible INATTEIGNABLE n'est PAS retirée (elle existe peut-être encore) — juste skippée localement.
const { nextOreTarget, oreKey, listOres } = require('../ores');
const { bestToolFor } = require('../tools');
const { isOre } = require('../worldMemory');

let vec3; try { vec3 = require('vec3'); } catch (e) { vec3 = null; }
function _pos(t) { return vec3 ? vec3(t.x, t.y, t.z) : { x: t.x, y: t.y, z: t.z }; }

// Coupe le mouvement résiduel (même garde-fou que gather : collectBlock peut laisser son goal actif).
function _stopResidual(bot) {
  try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
  try {
    if (bot.setControlState) ['forward', 'back', 'left', 'right', 'sneak', 'jump'].forEach((c) => bot.setControlState(c, false));
  } catch (e) {}
}

/**
 * runResource(bot, opts, token) → {ok:true, mined} | {ok:true, mined, cancelled} | {ok:false, reason}
 *  memory/worldKey : mémoire de monde + clé (sinon bot._worldMemory/_worldKey)
 *  emit      : hook events (resource_* / ore_mined / ore_gone)
 *  goto      : async (target) => void — navigation BORNÉE vers (x,y,z), throw si inatteignable
 *              (injectée par index.js : withTimeout + persistance par progrès ; identité dans les tests)
 *  onTarget  : hook async avant chaque cible (survie : settleSurvivalKit/escapeWater)
 *  pickTier  : () => number — meilleur palier de pioche en poche (filtre les cibles inminables)
 *  deposit   : async (bot) => {ok} — dépôt coffre quand l'inventaire est plein (skills/deposit)
 */
async function runResource(bot, opts = {}, token = null) {
  const emit = opts.emit || (() => {});
  const memory = opts.memory || bot._worldMemory || null;
  const wkey = opts.worldKey || bot._worldKey || null;
  const doGoto = opts.goto;
  const onTarget = opts.onTarget || null;
  const deposit = opts.deposit || null;
  const pickTier = opts.pickTier || null;

  const skip = new Set(); // cibles traitées (minées/absentes/ratées) : on ne re-vise jamais 2×
  let mined = 0;
  emit({ type: 'resource_start', world: wkey, ores: listOres(memory, wkey).length });

  while (true) {
    if (token && token.cancelled) return { ok: true, mined, cancelled: true };
    const from = bot.entity && bot.entity.position;
    if (!from) return { ok: false, reason: 'no_pos', mined };
    const tier = typeof pickTier === 'function' ? pickTier() : pickTier;
    const target = nextOreTarget(memory, wkey, from, { skip, pickTier: (typeof tier === 'number' ? tier : undefined) });
    if (!target) break; // plus de cible minable → done (idle propre géré par l'appelant)
    skip.add(oreKey(target));
    emit({ type: 'resource_target', material: target.material, x: target.x, y: target.y, z: target.z });
    // Survie d'abord (settleSurvivalKit/escapeWater injectés) : on règle les menaces AVANT le trajet.
    if (onTarget) { try { await onTarget(); } catch (e) {} }
    if (token && token.cancelled) return { ok: true, mined, cancelled: true };

    // Inventaire plein → dépôt AVANT d'aller miner (coffre du camp ≤12 blocs, best-effort).
    if (deposit && bot.inventory && typeof bot.inventory.emptySlotCount === 'function'
        && bot.inventory.emptySlotCount() <= 1) {
      let d = null;
      try { d = await deposit(bot); } catch (e) {}
      emit({ type: 'resource_deposit', ok: !!(d && d.ok) });
      if (token && token.cancelled) return { ok: true, mined, cancelled: true };
    }

    // Navigation bornée vers la position exacte. Throw = inatteignable → skip local SANS retirer
    // de la carte (un autre bot — ou nous, plus tard, mieux équipé — pourra retenter).
    try { await doGoto(target); }
    catch (e) {
      _stopResidual(bot);
      emit({ type: 'resource_unreachable', x: target.x, y: target.y, z: target.z });
      continue;
    }
    if (token && token.cancelled) return { ok: true, mined, cancelled: true };

    // Le minerai est-il toujours là ? (déjà miné par un joueur/bot, ou jamais existé → carte MAJ)
    // N'importe quel minerai à la position notée est bon à prendre (le cartographe a pu noter la
    // variante stone et le bloc être deepslate — position exacte = vérité).
    const block = bot.blockAt ? bot.blockAt(_pos(target)) : null;
    if (!block || !isOre(block.name)) {
      emit({ type: 'ore_gone', world: wkey, x: target.x, y: target.y, z: target.z });
      continue;
    }

    // Équipe la bonne pioche puis mine. collectBlock gère l'approche fine + le ramassage du drop.
    // Re-équipe + retente UNE fois (dig interrompu par aggro/désync, pattern gather).
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
    if (token && token.cancelled) return { ok: true, mined, cancelled: true };

    if (okMine) {
      mined++;
      emit({ type: 'ore_mined', world: wkey, material: target.material, x: target.x, y: target.y, z: target.z });
    } else {
      // échec de minage (≠ absent) : on ne retire PAS de la carte — le bloc est encore là.
      emit({ type: 'resource_failed', x: target.x, y: target.y, z: target.z });
    }
  }

  emit({ type: 'resource_done', mined });
  return { ok: true, mined };
}

module.exports = { runResource };
