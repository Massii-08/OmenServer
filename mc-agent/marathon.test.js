'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  MARATHON_TARGETS, RESERVES, marathonCounts, marathonMet, miningYFor, nextAction,
} = require('./marathon');

// ctx de base : tout va bien, en profondeur, kit complet → 'mine'
function okCtx(over = {}) {
  return Object.assign({
    inv: {
      iron_pickaxe: 2, stone_sword: 1, crafting_table: 1, furnace: 1,
      cooked_beef: 6, torch: 12, oak_log: 6, oak_planks: 8, stick: 4,
      cobblestone: 24, coal: 8,
    },
    banked: {},
    y: -54,
    emptySlots: 20,
    hasBase: true,
  }, over);
}

test('marathonCounts fusionne inventaire + banked, or = raw_gold + gold_ingot', () => {
  const c = marathonCounts(
    { diamond: 10, raw_gold: 3, gold_ingot: 2, lapis_lazuli: 5 },
    { diamond: 30, redstone: 64, raw_gold: 10 }
  );
  assert.strictEqual(c.diamond, 40);
  assert.strictEqual(c.redstone, 64);
  assert.strictEqual(c.lapis_lazuli, 5);
  assert.strictEqual(c.gold, 15);
});

test('marathonMet vrai seulement si les 4 cibles >= 64', () => {
  assert.strictEqual(marathonMet({ diamond: 64, redstone: 64, lapis_lazuli: 64, gold: 64 }), true);
  assert.strictEqual(marathonMet({ diamond: 64, redstone: 64, lapis_lazuli: 63, gold: 64 }), false);
  assert.strictEqual(marathonMet({ diamond: 0, redstone: 0, lapis_lazuli: 0, gold: 0 }), false);
});

test('miningYFor : -54 tant que diamant ou redstone < 64, puis -16 (or/lapis)', () => {
  assert.strictEqual(miningYFor({ diamond: 0, redstone: 0, lapis_lazuli: 0, gold: 0 }), -54);
  assert.strictEqual(miningYFor({ diamond: 64, redstone: 10, lapis_lazuli: 64, gold: 64 }), -54);
  assert.strictEqual(miningYFor({ diamond: 64, redstone: 64, lapis_lazuli: 0, gold: 0 }), -16);
});

test('nextAction: done quand M(c) atteint (inv + banked)', () => {
  const ctx = okCtx({ banked: { diamond: 64, redstone: 64, lapis_lazuli: 64, gold_ingot: 64 } });
  assert.strictEqual(nextAction(ctx), 'done');
});

test('nextAction: pickaxe est CRITIQUE (avant tout le reste) si aucune pioche fer', () => {
  const ctx = okCtx({ emptySlots: 0 });
  ctx.inv = Object.assign({}, ctx.inv, { iron_pickaxe: 0 });
  assert.strictEqual(nextAction(ctx), 'pickaxe');
});

test('nextAction: base si pas de base et arrivé en profondeur', () => {
  const ctx = okCtx({ hasBase: false });
  assert.strictEqual(nextAction(ctx), 'base');
});

test('nextAction: pas de base exigée tant qu\'on est en surface (descend d\'abord, si CHARGÉ)', () => {
  const ctx = okCtx({ hasBase: false, y: 64, hunger: 20 });
  // gate READY (Massii 12:15) : la descente exige le plein chargement
  ctx.inv = Object.assign({}, ctx.inv, {
    iron_pickaxe: 3, cooked_beef: 16, torch: 48, oak_log: 64, coal: 12,
  });
  assert.strictEqual(nextAction(ctx), 'descend');
});

test('nextAction: deposit quand inventaire plein et base posée', () => {
  const ctx = okCtx({ emptySlots: 2 });
  assert.strictEqual(nextAction(ctx), 'deposit');
});

test('nextAction: inventaire plein SANS base en profondeur → base', () => {
  const ctx = okCtx({ emptySlots: 1, hasBase: false });
  assert.strictEqual(nextAction(ctx), 'base');
});

test('nextAction: restock si nourriture cuite basse', () => {
  const ctx = okCtx();
  ctx.inv = Object.assign({}, ctx.inv, { cooked_beef: 2 });
  assert.strictEqual(nextAction(ctx), 'restock');
});

test('nextAction: restock si bois bas (bûches+planches insuffisantes)', () => {
  const ctx = okCtx();
  ctx.inv = Object.assign({}, ctx.inv, { oak_log: 0, oak_planks: 3 });
  assert.strictEqual(nextAction(ctx), 'restock');
});

test('nextAction: torches à crafter quand basses et charbon dispo', () => {
  const ctx = okCtx();
  ctx.inv = Object.assign({}, ctx.inv, { torch: 2 });
  assert.strictEqual(nextAction(ctx), 'torches');
});

test('nextAction: torches basses SANS charbon ni bois → restock (le bois fera le charbon)', () => {
  const ctx = okCtx();
  ctx.inv = Object.assign({}, ctx.inv, { torch: 2, coal: 0, charcoal: 0, oak_log: 0, oak_planks: 0 });
  assert.strictEqual(nextAction(ctx), 'restock');
});

test('nextAction: spare_pickaxe quand 1 seule pioche fer et du fer en stock', () => {
  const ctx = okCtx();
  ctx.inv = Object.assign({}, ctx.inv, { iron_pickaxe: 1, raw_iron: 3 });
  assert.strictEqual(nextAction(ctx), 'spare_pickaxe');
});

test('nextAction: 1 seule pioche SANS fer → iron (P18 a remplacé l\'ancien laisser-faire)', () => {
  const ctx = okCtx();
  ctx.inv = Object.assign({}, ctx.inv, { iron_pickaxe: 1 });
  assert.strictEqual(nextAction(ctx), 'iron');
});

test('nextAction: descend si trop haut par rapport au Y de minage (chargé)', () => {
  const ctx = okCtx({ y: 30, hunger: 20 });
  ctx.inv = Object.assign({}, ctx.inv, {
    iron_pickaxe: 3, cooked_beef: 16, torch: 48, oak_log: 64, coal: 12,
  });
  assert.strictEqual(nextAction(ctx), 'descend');
});

test('nextAction: ascend si trop bas (Y de minage remonté à -16 après diamant+redstone)', () => {
  const ctx = okCtx({ banked: { diamond: 64, redstone: 64 } });
  assert.strictEqual(nextAction(ctx), 'ascend');
});

test('nextAction: mine par défaut (kit ok, réserves ok, à la bonne profondeur)', () => {
  assert.strictEqual(nextAction(okCtx()), 'mine');
});

test('priorité: deposit avant restock (inventaire plein gagne)', () => {
  const ctx = okCtx({ emptySlots: 0 });
  ctx.inv = Object.assign({}, ctx.inv, { cooked_beef: 0 });
  assert.strictEqual(nextAction(ctx), 'deposit');
});

test('cibles: 64 de chaque, constantes exportées', () => {
  assert.deepStrictEqual(MARATHON_TARGETS, { diamond: 64, redstone: 64, lapis_lazuli: 64, gold: 64 });
  assert.ok(RESERVES.foodLow >= 2 && RESERVES.torchLow >= 2);
});

test('nextAction: scaffold quand réserve de murage à sec en profondeur', () => {
  const ctx = okCtx();
  ctx.inv = Object.assign({}, ctx.inv, { cobblestone: 3 });
  assert.strictEqual(nextAction(ctx), 'scaffold');
});

test('nextAction: cobbled_deepslate compte comme scaffold (pas de faux scaffold-low)', () => {
  const ctx = okCtx();
  ctx.inv = Object.assign({}, ctx.inv, { cobblestone: 0, cobbled_deepslate: 20 });
  assert.strictEqual(nextAction(ctx), 'mine');
});

// P8 (run#9) : la branche !hasBase court-circuitait food/bois → le bot DESCENDAIT le ventre vide
// (« ne jamais partir miner le ventre vide » est une règle cœur de la mission).
test('P8: nourriture basse SANS base → restock AVANT toute descente', () => {
  const ctx = okCtx({ hasBase: false, y: 53 });
  ctx.inv = Object.assign({}, ctx.inv, { cooked_beef: 0 });
  assert.strictEqual(nextAction(ctx), 'restock');
});

test('P8: bois bas SANS base → restock avant descente', () => {
  const ctx = okCtx({ hasBase: false, y: 53 });
  ctx.inv = Object.assign({}, ctx.inv, { oak_log: 0, oak_planks: 0 });
  assert.strictEqual(nextAction(ctx), 'restock');
});

// P12 (run#11) : zone sans animaux → restock infini alors que la FAIM est pleine (20/20).
// Le stock de bouffe est une ASSURANCE : on ne bloque la progression que si (stock bas ET faim entamée).
test('P12: stock 0 mais faim pleine → on continue (mine), pas de restock bloquant', () => {
  const ctx = okCtx({ hunger: 20 });
  ctx.inv = Object.assign({}, ctx.inv, { cooked_beef: 0 });
  assert.strictEqual(nextAction(ctx), 'mine');
});

test('P12: stock 0 ET faim entamée (≤12) → restock', () => {
  const ctx = okCtx({ hunger: 11 });
  ctx.inv = Object.assign({}, ctx.inv, { cooked_beef: 0 });
  assert.strictEqual(nextAction(ctx), 'restock');
});

test('P12: hunger absent (rétro-compat tests) → comportement strict conservé', () => {
  const ctx = okCtx();
  ctx.inv = Object.assign({}, ctx.inv, { cooked_beef: 0 });
  assert.strictEqual(nextAction(ctx), 'restock');
});

// --- Retour Massii 12:15 : « descendre CHARGÉ » — gate READY avant descente -----------------------
function loadedCtx(over = {}) {
  return okCtx(Object.assign({ y: 60, hasBase: false, hunger: 20 }, over, {
    inv: Object.assign({
      iron_pickaxe: 3, stone_sword: 1, crafting_table: 1, furnace: 1,
      cooked_beef: 16, torch: 48, oak_log: 56, oak_planks: 32, stick: 8,
      cobblestone: 32, coal: 12,
    }, (over.inv || {})),
  }));
}

test('gate READY: bois insuffisant (<64 unités) en surface → restock, pas de descente', () => {
  const ctx = loadedCtx({ inv: { oak_log: 6, oak_planks: 8 } });
  assert.strictEqual(nextAction(ctx), 'restock');
});

test('gate READY: nourriture < 16 en surface → restock (sauf compromise)', () => {
  const ctx = loadedCtx({ inv: { cooked_beef: 4 } });
  assert.strictEqual(nextAction(ctx), 'restock');
});

test('gate READY: foodCompromise (monde sans animaux, faim pleine) → la descente passe', () => {
  const ctx = loadedCtx({ inv: { cooked_beef: 0 }, foodCompromise: true });
  assert.strictEqual(nextAction(ctx), 'descend');
});

test('gate READY: 1 seule pioche + fer en stock → spare_pickaxe avant de descendre', () => {
  const ctx = loadedCtx({ inv: { iron_pickaxe: 1, raw_iron: 6 } });
  assert.strictEqual(nextAction(ctx), 'spare_pickaxe');
});

test('gate READY: 1 seule pioche SANS fer → iron (aller chercher du fer à Y16)', () => {
  const ctx = loadedCtx({ inv: { iron_pickaxe: 1 } });
  assert.strictEqual(nextAction(ctx), 'iron');
});

test('gate READY: torches < 48 en surface (charbon dispo) → torches', () => {
  const ctx = loadedCtx({ inv: { torch: 10 } });
  assert.strictEqual(nextAction(ctx), 'torches');
});

test('gate READY: tout chargé → descend', () => {
  assert.strictEqual(nextAction(loadedCtx()), 'descend');
});

test('gate READY ne s\'applique PAS en profondeur (les seuils LOW restent les déclencheurs)', () => {
  // en bas avec des réserves « moyennes » (au-dessus des LOW, en-dessous des READY) → on mine
  const ctx = okCtx({ hunger: 20 });
  ctx.inv = Object.assign({}, ctx.inv, { torch: 12, cooked_beef: 6, oak_log: 6 });
  assert.strictEqual(nextAction(ctx), 'mine');
});

// P18 (run#22) : les 2 pioches cassées + 0 fer en poche → picks 0 → kit stall à -55 → mort.
// Règle : picks <2 ⇒ spare si fer dispo, SINON aller miner du fer tout de suite (action iron).
test('P18: 1 pioche restante SANS fer → iron (re-mine immédiat, jamais tomber à 0)', () => {
  const ctx = okCtx({ hunger: 20 });
  ctx.inv = Object.assign({}, ctx.inv, { iron_pickaxe: 1 });
  assert.strictEqual(nextAction(ctx), 'iron');
});

// P23 (3 morts au spawn monde) : respawn à 760 blocs de la base → le bot travaillait SUR PLACE
// (zone hostile) au lieu de rentrer. Règle : loin de la base (>200) → go_home d'abord.
test('P23: loin de la base (>200 blocs) → go_home avant tout travail local', () => {
  const ctx = okCtx({ hunger: 20, homeDist: 760, y: 64 });
  assert.strictEqual(nextAction(ctx), 'go_home');
});

test('P23: proche de la base → comportement normal (pas de go_home)', () => {
  const ctx = okCtx({ hunger: 20, homeDist: 12 });
  assert.strictEqual(nextAction(ctx), 'mine');
});
