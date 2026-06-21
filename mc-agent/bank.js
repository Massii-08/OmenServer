'use strict';
// Banque-en-place (mode quota, no-keepInventory). Module PUR : décide CE QU'ON DÉPOSE dans un
// coffre posé sur place et SI on doit banker maintenant. But : une MORT ne doit pas effacer la
// progression accumulée (vécu live ResBot3 : 5💎+23🔴 → 0 après une noyade). Le coffre reste
// sous terre mais le compte est crédité (tracker.noteBanked) et les items physiques sont saufs.
//
// On ne banke QUE les LIVRABLES finis : diamant, redstone, lapis, lingots d'or/fer. Le BRUT
// (raw_iron/raw_gold) reste en poche — il doit être FONDU en lingots (exigence Massii : livrer
// des lingots), et il sert aussi au craft d'armure. Le brut est bon marché à re-miner → on
// accepte son risque de perte à la mort, on protège le rare (diamant) et le déjà-fini (lingots).

const BANK_DELIVERABLES = new Set([
  'diamond', 'redstone', 'lapis_lazuli', 'gold_ingot', 'iron_ingot',
]);

/**
 * planBank(items, target, opts) → { shouldBank, deposit:[{name,count}] }
 *  - items   : inventaire courant [{name,count}]
 *  - target  : quota {type:n} (non utilisé pour le déclenchement, gardé pour évolutivité)
 *  - opts.threshold : total livrable porté à partir duquel on banke (défaut 24)
 *  - opts.keepIngot : réserve de iron_ingot gardée en poche pour le craft d'armure (défaut 8)
 */
function planBank(items, target, opts = {}) {
  const threshold = opts.threshold != null ? opts.threshold : 24;
  const keepIngot = opts.keepIngot != null ? opts.keepIngot : 8;
  // Les DIAMANTS sont rares (goulot du quota) et un bot meurt souvent avec ~7-15💎 AVANT
  // d'atteindre le seuil général → seuil BAS dédié pour banker les diamants tôt (anti-perte).
  const diamondThreshold = opts.diamondThreshold != null ? opts.diamondThreshold : 6;

  // Agrège les livrables portés par nom.
  const carried = {};
  for (const it of items || []) {
    if (!it || !it.name) continue;
    if (BANK_DELIVERABLES.has(it.name)) {
      carried[it.name] = (carried[it.name] || 0) + (Number(it.count) || 0);
    }
  }
  const totalDeliverable = Object.values(carried).reduce((a, n) => a + n, 0);

  // Construit la liste de dépôt en gardant une réserve de lingots de fer (craft armure).
  const deposit = [];
  for (const [name, count] of Object.entries(carried)) {
    let n = count;
    if (name === 'iron_ingot') n = count - keepIngot;
    if (n > 0) deposit.push({ name, count: n });
  }

  const carriedDiamonds = carried.diamond || 0;
  const trigger = totalDeliverable >= threshold || carriedDiamonds >= diamondThreshold;
  const shouldBank = trigger && deposit.length > 0;
  return { shouldBank, deposit: shouldBank ? deposit : [] };
}

module.exports = { planBank, BANK_DELIVERABLES };
