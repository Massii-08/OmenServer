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

test('nextAction: pas de base exigée tant qu\'on est en surface (descend d\'abord)', () => {
  const ctx = okCtx({ hasBase: false, y: 64 });
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

test('nextAction: 1 seule pioche SANS fer → mine quand tout le reste va (le fer viendra du tunnel)', () => {
  const ctx = okCtx();
  ctx.inv = Object.assign({}, ctx.inv, { iron_pickaxe: 1 });
  assert.strictEqual(nextAction(ctx), 'mine');
});

test('nextAction: descend si trop haut par rapport au Y de minage', () => {
  const ctx = okCtx({ y: 30 });
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
