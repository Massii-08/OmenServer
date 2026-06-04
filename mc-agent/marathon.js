'use strict';
// Objectif MARATHON : accumuler 64× diamant, redstone, lapis, or (raw+ingot) — compté sur
// INVENTAIRE + COFFRE DE BASE (world.banked) — en maintenant des réserves (bois/food/torches/outil)
// sur la durée. Décisions PURES (testables sans serveur) ; le dispatch réel vit dans index.js.

const MARATHON_TARGETS = { diamond: 64, redstone: 64, lapis_lazuli: 64, gold: 64 };

// Seuils de réserve à DEUX niveaux (retour Massii 2026-06-04 12:15 : « descendre CHARGÉ ») :
//  - LOW   = déclencheurs de secours EN PROFONDEUR (remonter seulement si vraiment bas) ;
//  - READY = gate de DESCENTE (on ne descend que pleinement chargé — un gros chargement initial
//    vaut mieux que beaucoup d'allers-retours : chaque remontée est longue et dangereuse).
const RESERVES = {
  foodLow: 3,         // portions cuites : en-dessous (ET faim entamée) → supply run surface
  foodReady: 16,      // gate descente : grosse réserve cuite (vers un stack)
  woodLow: 4,         // "unités bois" = bûches + planches/4 : en-dessous → supply run surface
  woodReady: 64,      // gate descente : ~1 stack de bûches équivalent (table+bâtons+pioches+torches)
  torchLow: 4,        // torches : en-dessous → craft (charbon+bâtons) ou restock si pas de quoi
  torchReady: 48,     // gate descente : long branch-mine éclairé sans remontée
  pickaxesReady: 3,   // gate descente : 2-3 pioches fer pré-craftées (rechange sous terre)
  invFullSlots: 2,    // slots vides ≤ 2 → déposer au coffre de base
  scaffoldKeep: 32,   // cobble(+deepslate) gardé au deposit (murage lave + bridging)
  ironKeep: 9,        // fer gardé au deposit (3 pioches de rechange potentielles)
  coalKeep: 16,       // charbon gardé au deposit (torches)
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

  // Tolérance ±2 alignée sur le garde-fou wrong_depth de branchMine.
  const targetY = miningYFor(counts);
  const atDepth = ctx.y !== undefined && ctx.y <= targetY + 2;

  // Inventaire plein AVANT tout (P34, run#40 : pioche cassée avec slots 0 → le kit ne peut RIEN
  // crafter sans place → wedge ; déposer ne demande pas de pioche).
  // P33 : base à >200 blocs → RENTRER d'abord (déposer exige d'être à la base ; sinon faux
  // chest_lost → re-base en route → banked orphelin, vécu run#39 : 13 redstone perdus de vue).
  if (ctx.emptySlots !== undefined && ctx.emptySlots <= RESERVES.invFullSlots) {
    if (ctx.hasBase && ctx.homeDist !== undefined && ctx.homeDist > 200) return 'go_home';
    return ctx.hasBase ? 'deposit' : 'base';
  }

  // Sans pioche fer, rien ne mine le diamant/redstone/or → re-kit prioritaire.
  if (n(ctx.inv, 'iron_pickaxe') < 1) return 'pickaxe';

  // P23 (3 morts près du spawn monde) : après un RESPAWN loin de la base (>200 blocs), rentrer
  // D'ABORD — travailler sur place re-mourait dans la même zone hostile, à 760 blocs du coffre.
  if (ctx.hasBase && ctx.homeDist !== undefined && ctx.homeDist > 200) return 'go_home';

  // GATE DE DESCENTE (Massii 12:15) : tant qu'on est EN HAUT (pas à la profondeur de minage),
  // on ne descend que PLEINEMENT chargé — bois ~1 stack, bouffe ~16, 3 pioches, ~48 torches.
  // ctx.foodCompromise : monde sans animaux (restocks food ratés ×3, faim pleine) → on n'attend
  // pas l'impossible, la nourriture ne bloque plus (le bois/torches/pioches restent exigés).
  const preparing = ctx.y !== undefined && ctx.y > targetY + 2;
  if (preparing) {
    // P48 : zone re-déforestée → woodCompromise (3 restocks bois ratés + ≥24 unités en poche).
    if (woodUnits(ctx.inv) < RESERVES.woodReady
        && !(ctx.woodCompromise && woodUnits(ctx.inv) >= 24)) return 'restock';
    if (cookedFood(ctx.inv) < RESERVES.foodReady && !ctx.foodCompromise) return 'restock';
    if (n(ctx.inv, 'iron_pickaxe') < RESERVES.pickaxesReady) {
      return (n(ctx.inv, 'iron_ingot') + n(ctx.inv, 'raw_iron') >= 3) ? 'spare_pickaxe' : 'iron';
    }
    if (n(ctx.inv, 'torch') < RESERVES.torchReady) {
      if (n(ctx.inv, 'coal') + n(ctx.inv, 'charcoal') >= 1 || woodUnits(ctx.inv) >= 2) return 'torches';
      return 'restock';
    }
  }

  // Réserves de SURFACE (food + bois) → un seul trip combiné. ⚠️ AVANT toute logique de descente
  // (P8 vécu run#9 : la branche !hasBase court-circuitait ce check → descente le ventre vide).
  // P12 (run#11 : zone sans animaux → restock infini avec faim 20/20) : le stock de bouffe est une
  // ASSURANCE — on ne bloque que si le stock est bas ET que la faim est réellement entamée (≤12).
  // ctx.hunger absent (anciens appels/tests) → comportement strict conservé.
  if (cookedFood(ctx.inv) < RESERVES.foodLow
      && (ctx.hunger === undefined || ctx.hunger <= 12)) return 'restock';
  if (woodUnits(ctx.inv) < RESERVES.woodLow) return 'restock';

  // Torches : craftables sur place si charbon dispo (le bois vient d'être garanti ci-dessus).
  if (n(ctx.inv, 'torch') < RESERVES.torchLow) {
    if (n(ctx.inv, 'coal') + n(ctx.inv, 'charcoal') >= 1) return 'torches';
    if (woodUnits(ctx.inv) >= 2) return 'torches'; // charbon de bois (smeltCharcoal) sur place
    return 'restock';
  }

  // Réserve de murage (lave) : à sec en profondeur → re-miner de la pierre/deepslate sur place.
  if (n(ctx.inv, 'cobblestone') + n(ctx.inv, 'cobbled_deepslate') < 8) return 'scaffold';

  // Pioche de rechange : JAMAIS sous 2 pioches (P18, run#22 : 2 cassées + 0 fer → picks 0 →
  // kit stall à -55 → mort). Fer dispo → craft ; sinon on va re-miner du fer TOUT DE SUITE.
  if (n(ctx.inv, 'iron_pickaxe') < 2) {
    if (n(ctx.inv, 'iron_ingot') + n(ctx.inv, 'raw_iron') >= 3) return 'spare_pickaxe';
    return 'iron';
  }

  // Armure (P41) : plastron dès que le fer le permet — le kit seul ne tournait que pioches=0.
  if (ctx.armored === false
      && n(ctx.inv, 'iron_ingot') + n(ctx.inv, 'raw_iron') >= 8
      && n(ctx.inv, 'iron_chestplate') < 1) return 'armor';

  // Base (coffre posé, world.home) : exigée dès qu'on arrive en profondeur — les deposits en dépendent.
  if (!ctx.hasBase) return atDepth ? 'base' : 'descend';

  if (ctx.y !== undefined && ctx.y > targetY + 2) return 'descend';
  if (ctx.y !== undefined && ctx.y < targetY - 2) return 'ascend';
  return 'mine';
}

/** P45 : agrège le contenu de TOUS les coffres connus (le churn de bases ne perd plus le butin). */
function sumBanked(chestContents) {
  const out = {};
  for (const key of Object.keys(chestContents || {})) {
    const c = chestContents[key] || {};
    for (const it of Object.keys(c)) out[it] = (out[it] || 0) + c[it];
  }
  return out;
}

module.exports = {
  MARATHON_TARGETS, RESERVES, COOKED, sumBanked,
  marathonCounts, marathonMet, miningYFor, cookedFood, woodUnits, nextAction,
};
