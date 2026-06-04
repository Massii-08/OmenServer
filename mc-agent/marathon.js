'use strict';
// Objectif MARATHON : accumuler 64× diamant, redstone, lapis, or (raw+ingot) — compté sur
// INVENTAIRE + COFFRE DE BASE (world.banked) — en maintenant des réserves (bois/food/torches/outil)
// sur la durée. Décisions PURES (testables sans serveur) ; le dispatch réel vit dans index.js.

const MARATHON_TARGETS = { diamond: 64, redstone: 64, lapis_lazuli: 64, gold: 64 };

// Seuils de réserve — les DÉCLENCHEURS de retour base/surface (cœur de la mission long-terme).
const RESERVES = {
  foodLow: 3,        // portions cuites : en-dessous → supply run surface
  foodTarget: 6,
  woodLow: 2,        // "unités bois" = bûches + planches/4 : en-dessous → supply run surface
  woodTarget: 8,     // bûches à re-gather en surface
  torchLow: 4,       // torches : en-dessous → craft (charbon+bâtons) ou restock si pas de quoi
  torchTarget: 12,
  invFullSlots: 2,   // slots vides ≤ 2 → déposer au coffre de base
  scaffoldKeep: 32,  // cobble(+deepslate) gardé au deposit (murage lave + bridging)
  ironKeep: 6,       // fer gardé au deposit (pioche de rechange)
  coalKeep: 16,      // charbon gardé au deposit (torches)
};

function n(inv, name) { return (inv && inv[name]) || 0; }

/** Fusion inventaire + coffre de base → compte par cible. or = raw_gold + gold_ingot. */
function marathonCounts(inv, banked) {
  const both = (name) => n(inv, name) + n(banked, name);
  return {
    diamond: both('diamond'),
    redstone: both('redstone'),
    lapis_lazuli: both('lapis_lazuli'),
    gold: both('raw_gold') + both('gold_ingot'),
  };
}

function marathonMet(counts) {
  return Object.keys(MARATHON_TARGETS).every((k) => (counts[k] || 0) >= MARATHON_TARGETS[k]);
}

/** Y de minage : -54 (pic diamant/redstone) tant qu'il en manque, puis -16 (pic or, lapis correct). */
function miningYFor(counts) {
  if ((counts.diamond || 0) < MARATHON_TARGETS.diamond) return -54;
  if ((counts.redstone || 0) < MARATHON_TARGETS.redstone) return -54;
  return -16;
}

// Nourriture cuite (mêmes items que goals.COOKED_FOODS — dupliqué ici pour rester pur/sans cycle).
const COOKED = ['cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
  'cooked_rabbit', 'cooked_cod', 'cooked_salmon', 'bread', 'baked_potato'];
function cookedFood(inv) { return COOKED.reduce((s, x) => s + n(inv, x), 0); }

function woodUnits(inv) {
  const logs = Object.keys(inv || {}).filter((k) => k.endsWith('_log')).reduce((s, k) => s + inv[k], 0);
  const planks = Object.keys(inv || {}).filter((k) => k.endsWith('_planks')).reduce((s, k) => s + inv[k], 0);
  return logs + Math.floor(planks / 4);
}

/**
 * Prochaine action de la boucle marathon. ctx = { inv, banked, y, emptySlots, hasBase }.
 * Priorités : done > pickaxe(critique) > base/deposit (inventaire) > restock (surface: food+bois)
 * > torches > spare_pickaxe > descend/ascend > mine.
 */
function nextAction(ctx) {
  const counts = marathonCounts(ctx.inv, ctx.banked);
  if (marathonMet(counts)) return 'done';

  // Sans pioche fer, rien ne mine le diamant/redstone/or → re-kit prioritaire absolu.
  if (n(ctx.inv, 'iron_pickaxe') < 1) return 'pickaxe';

  // Tolérance ±2 alignée sur le garde-fou wrong_depth de branchMine.
  const targetY = miningYFor(counts);
  const atDepth = ctx.y !== undefined && ctx.y <= targetY + 2;

  // Inventaire plein : déposer (ou poser la base ICI — le coffre du kit est en poche).
  if (ctx.emptySlots !== undefined && ctx.emptySlots <= RESERVES.invFullSlots) {
    return ctx.hasBase ? 'deposit' : 'base';
  }

  // Réserves de SURFACE (food + bois) → un seul trip combiné. ⚠️ AVANT toute logique de descente
  // (P8 vécu run#9 : la branche !hasBase court-circuitait ce check → descente le ventre vide).
  if (cookedFood(ctx.inv) < RESERVES.foodLow) return 'restock';
  if (woodUnits(ctx.inv) < RESERVES.woodLow) return 'restock';

  // Torches : craftables sur place si charbon dispo (le bois vient d'être garanti ci-dessus).
  if (n(ctx.inv, 'torch') < RESERVES.torchLow) {
    if (n(ctx.inv, 'coal') + n(ctx.inv, 'charcoal') >= 1) return 'torches';
    if (woodUnits(ctx.inv) >= 2) return 'torches'; // charbon de bois (smeltCharcoal) sur place
    return 'restock';
  }

  // Réserve de murage (lave) : à sec en profondeur → re-miner de la pierre/deepslate sur place.
  if (n(ctx.inv, 'cobblestone') + n(ctx.inv, 'cobbled_deepslate') < 8) return 'scaffold';

  // Pioche de rechange : 2 pioches fer en poche dès que le fer du tunnel le permet.
  if (n(ctx.inv, 'iron_pickaxe') < 2
      && n(ctx.inv, 'iron_ingot') + n(ctx.inv, 'raw_iron') >= 3) return 'spare_pickaxe';

  // Base (coffre posé, world.home) : exigée dès qu'on arrive en profondeur — les deposits en dépendent.
  if (!ctx.hasBase) return atDepth ? 'base' : 'descend';

  if (ctx.y !== undefined && ctx.y > targetY + 2) return 'descend';
  if (ctx.y !== undefined && ctx.y < targetY - 2) return 'ascend';
  return 'mine';
}

module.exports = {
  MARATHON_TARGETS, RESERVES, COOKED,
  marathonCounts, marathonMet, miningYFor, cookedFood, woodUnits, nextAction,
};
