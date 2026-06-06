'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { Y_OPT, TIER_FOR, listPicks, bestTier, cheapestPickFor, pickaxePlan, mostLackingType } = require('./gear');

test('Y_OPT : bandes de spawn 1.18+ (diamant/redstone profond, lapis 0, or -16, fer 16)', () => {
  assert.strictEqual(Y_OPT.diamond, -58);
  assert.strictEqual(Y_OPT.redstone, -58);
  assert.strictEqual(Y_OPT.lapis, 0);
  assert.strictEqual(Y_OPT.gold, -16);
  assert.strictEqual(Y_OPT.iron, 16);
});

test('listPicks/bestTier : tri par palier, -1 sans pioche', () => {
  const items = [{ name: 'iron_pickaxe', count: 1 }, { name: 'stone_pickaxe', count: 2 }, { name: 'bread', count: 5 }];
  const picks = listPicks(items);
  assert.deepStrictEqual(picks.map((p) => p.name), ['stone_pickaxe', 'iron_pickaxe']);
  assert.strictEqual(bestTier(items), 3);
  assert.strictEqual(bestTier([]), -1);
});

test('cheapestPickFor : roche nue → la moins chère ; ore → la meilleure', () => {
  const items = [{ name: 'stone_pickaxe', count: 1 }, { name: 'iron_pickaxe', count: 1 }];
  assert.strictEqual(cheapestPickFor(items, 'deepslate'), 'stone_pickaxe');
  assert.strictEqual(cheapestPickFor(items, 'stone'), 'stone_pickaxe');
  assert.strictEqual(cheapestPickFor(items, 'deepslate_diamond_ore'), 'iron_pickaxe');
  assert.strictEqual(cheapestPickFor(items, 'ancient_debris'), 'iron_pickaxe');
  assert.strictEqual(cheapestPickFor([], 'stone'), null);
});

test('pickaxePlan : tier 3 manquant + lingots → craft iron_pickaxe', () => {
  const items = [{ name: 'stone_pickaxe', count: 1 }, { name: 'iron_ingot', count: 5 }, { name: 'stick', count: 8 }];
  const plan = pickaxePlan(items, ['diamond', 'iron']);
  assert.deepStrictEqual(plan, { craft: 'iron_pickaxe', why: 'tier3_needed' });
});

test('pickaxePlan : aucune pioche + cobble → craft stone_pickaxe ; sinon needs', () => {
  assert.deepStrictEqual(
    pickaxePlan([{ name: 'cobblestone', count: 10 }, { name: 'stick', count: 4 }], ['iron']),
    { craft: 'stone_pickaxe', why: 'no_pick' });
  assert.deepStrictEqual(pickaxePlan([], ['iron']), { ok: false, needs: 'cobble_or_sticks' });
});

test('pickaxePlan : pioche d\'avance (≥2 stone picks) pour le tunnel', () => {
  const items = [{ name: 'stone_pickaxe', count: 1 }, { name: 'iron_pickaxe', count: 1 },
    { name: 'cobblestone', count: 30 }, { name: 'stick', count: 10 }];
  assert.deepStrictEqual(pickaxePlan(items, ['lapis']), { craft: 'stone_pickaxe', why: 'spare' });
  // déjà 2 stone picks → ok
  const items2 = [...items, { name: 'stone_pickaxe', count: 1 }];
  assert.deepStrictEqual(pickaxePlan(items2, ['lapis']), { ok: true });
});

test('mostLackingType : déficit RELATIF max (l\'or 0/15 bat le fer 32/64)', () => {
  const p = {
    diamond: { have: 15, target: 15 },
    gold: { have: 0, target: 15 },
    iron: { have: 32, target: 64 },
  };
  assert.strictEqual(mostLackingType(p), 'gold');
  assert.strictEqual(mostLackingType({ a: { have: 5, target: 5 } }), null);
  assert.strictEqual(mostLackingType({}), null);
});

test('TIER_FOR : diamant/or/redstone exigent fer (3), lapis/fer pierre (2)', () => {
  assert.strictEqual(TIER_FOR.diamond, 3);
  assert.strictEqual(TIER_FOR.gold, 3);
  assert.strictEqual(TIER_FOR.redstone, 3);
  assert.strictEqual(TIER_FOR.lapis, 2);
  assert.strictEqual(TIER_FOR.iron, 2);
});

test('pickaxePlan : raw_iron (sans lingots) suffit — la fonte est faite par le caller', () => {
  const items = [{ name: 'stone_pickaxe', count: 1 }, { name: 'raw_iron', count: 30 }, { name: 'stick', count: 8 }];
  assert.deepStrictEqual(pickaxePlan(items, ['diamond']), { craft: 'iron_pickaxe', why: 'tier3_needed' });
});
