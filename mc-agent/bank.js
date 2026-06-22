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
  // Seuil BAS (vécu live : les bots meurent — noyade aquifère deepslate, lave — AVANT d'accumuler 12,
  // donc le banking ne se déclenchait jamais et chaque mort remettait tout à 0). Banker tôt = la
  // progression survit aux morts ; le surcoût (pose de coffre tous les 6 items) est négligeable vs
  // perdre 8-12 items à chaque mort. Diamants (rares) bankés encore plus tôt (3).
  const threshold = opts.threshold != null ? opts.threshold : 6;
  const keepIngot = opts.keepIngot != null ? opts.keepIngot : 8;
  const diamondThreshold = opts.diamondThreshold != null ? opts.diamondThreshold : 3;

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

/**
 * planSmeltRaw(items, opts) → [{raw, ingot, count}]
 * Décide quel BRUT (raw_gold/raw_iron) fondre en lingots PENDANT le run (pas seulement à la fin).
 * En no-keepInventory, le brut n'est PAS bankable (cf. BANK_DELIVERABLES) → il s'accumule en poche
 * et une MORT l'efface (vécu live ResBot2 : gold2/iron5 = brut en poche, banked=0, jamais survécu).
 * En le fondant tôt, bank.js banke les LINGOTS (gold_ingot/iron_ingot) → la progression or/fer
 * survit aux morts ET satisfait l'exigence Massii « livrer des lingots FONDUS ».
 *  - opts.minBatch : ne fond un type que s'il atteint ce volume (défaut 8 ; sous ce seuil, l'overhead
 *    de pose du four > le gain). On ne fond JAMAIS le diamant/redstone/lapis (déjà livrables bruts).
 */
function planSmeltRaw(items, opts = {}) {
  const minBatch = opts.minBatch != null ? opts.minBatch : 8;
  const counts = {};
  for (const it of items || []) {
    if (!it || !it.name) continue;
    counts[it.name] = (counts[it.name] || 0) + (Number(it.count) || 0);
  }
  const out = [];
  for (const [raw, ingot] of [['raw_gold', 'gold_ingot'], ['raw_iron', 'iron_ingot']]) {
    const n = counts[raw] || 0;
    if (n >= minBatch) out.push({ raw, ingot, count: n });
  }
  return out;
}

module.exports = { planBank, BANK_DELIVERABLES, planSmeltRaw };
