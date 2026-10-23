'use strict';
// LA BOUCLE QUI TUE LE PROCESS (OOM 23/10 : ≈300 sessions « JavaScript heap out of memory » depuis août,
// dont NethBot2 ×6 d'affilée AU MÊME ENDROIT à y=-54, et NethBot1 session 519).
//
// mineflayer-collectblock (CollectBlock.mineBlock) appelle, pour CHAQUE bloc à miner :
//     bot.tool.equipForBlock(block, { requireHarvest: true, getFromChest: true, maxTools: 2 })
// Dans mineflayer-tool 1.2.0 (lib/Tool.js), quand AUCUN objet de l'inventaire ne récolte le bloc
// (`block.canHarvest` faux partout : diamant/or/redstone avec une pioche de pierre, pioche cassée au milieu
// d'un filon…) et que `getFromChest` est vrai, il fait :
//     await retrieveTools(bot, { chestLocations: this.chestLocations, … })   // [] chez nous → rend la main AUSSITÔT
//     await this.equipForBlock(block, options)                                // … et RECOMMENCE
// Récursion sans fin, entièrement en MICROTÂCHES (retrieveTools n'attend rien quand il n'y a aucun coffre) :
// aucun timer ne peut plus tourner, chaque niveau garde sa copie de l'inventaire et sa promesse en attente,
// le tas monte à 640 Mo en ~10 s et V8 tue le process — sans un seul event. Le minerai étant toujours là à
// la relance, le bot re-crashe au même endroit (prouvé : toolGuard.test.js, sur la VRAIE classe Tool).
//
// Parade : on enveloppe `bot.tool.equipForBlock`. Sans coffre configuré, `getFromChest` ne peut RIEN
// apporter : s'il ne reste aucun outil récoltant, on retire `getFromChest` → la lib lève proprement
// `NoItem` (« Bot does not have a harvestable tool! »), collect rejette, l'appelant passe au bloc suivant.
// Ceinture : profondeur d'appels imbriqués bornée (MAX_DEPTH) → rejet `NoItem` au-delà.

const GUARDED = Symbol.for('mca.toolGuard.guarded');
const MAX_DEPTH = 8;

function _noItemError() {
  const e = new Error('Bot does not have a harvestable tool!');
  e.name = 'NoItem';
  return e;
}

/**
 * PUR (lit le bot) — la liste que construit equipForBlock serait-elle VIDE ? Même règle que la lib :
 * objets de l'inventaire (+ « main nue » s'il reste une case libre), filtrés par `block.canHarvest` si
 * `requireHarvest`. Vrai = aucun outil ne récolte ce bloc.
 */
function noHarvestTool(bot, block, options = {}) {
  const items = (bot && bot.inventory && typeof bot.inventory.items === 'function') ? bot.inventory.items() : [];
  const list = Array.isArray(items) ? items.slice() : [];
  const empty = (bot && bot.inventory && typeof bot.inventory.emptySlotCount === 'function') ? bot.inventory.emptySlotCount() : 0;
  if (empty >= 1) list.unshift(undefined);
  if (options && options.requireHarvest) {
    if (!block || typeof block.canHarvest !== 'function') return false;   // inconnu : on laisse la lib décider
    return !list.some((it) => block.canHarvest(it != null ? it.type : null));
  }
  return list.length === 0;
}

/**
 * Enveloppe `tool.equipForBlock` (instance mineflayer-tool). Idempotent. `onCapped({where, reason, block})`
 * est appelé quand la garde coupe une récursion (le rapport, lui, est différé par l'appelant).
 * @returns {boolean} true si la garde est (ou était déjà) posée
 */
function installToolGuard(tool, { onCapped = () => {}, maxDepth = MAX_DEPTH } = {}) {
  try {
    if (!tool || typeof tool.equipForBlock !== 'function') return false;
    if (tool[GUARDED]) return true;
    const orig = tool.equipForBlock;
    let depth = 0;
    const cap = (reason, block) => {
      try { onCapped({ where: 'tool.equipForBlock', reason, block: (block && block.name) || null }); } catch (e) { /* télémétrie */ }
    };
    tool.equipForBlock = function guardedEquipForBlock(block, options, cb) {
      let opts = (options && typeof options === 'object') ? options : {};
      const chests = Array.isArray(this && this.chestLocations) ? this.chestLocations.length : 0;
      if (opts.getFromChest && chests === 0) {
        let none = false;
        try { none = noHarvestTool(this && this.bot, block, opts); } catch (e) { none = false; }
        if (none) {
          cap('no_harvest_tool', block);
          opts = Object.assign({}, opts, { getFromChest: false });   // → la lib lève NoItem au lieu de boucler
        }
      }
      if (depth >= maxDepth) {
        cap('depth', block);
        const err = _noItemError();
        if (typeof cb === 'function') { try { cb(err); } catch (e) { /* callback de l'appelant */ } }
        return Promise.reject(err);
      }
      depth += 1;
      let p;
      try { p = orig.call(this, block, opts, cb); } catch (e) { depth -= 1; throw e; }
      return Promise.resolve(p).finally(() => { depth -= 1; });
    };
    tool[GUARDED] = true;
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { installToolGuard, noHarvestTool, MAX_DEPTH };
