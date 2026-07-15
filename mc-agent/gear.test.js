'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { Y_OPT, TIER_FOR, listPicks, bestTier, cheapestPickFor, pickaxePlan, mostLackingType, smeltPlan, smeltReady } = require('./gear');

test('Y_OPT : bandes de spawn 1.18+ (diamant/redstone profond, or -16, lapis -12 dense, fer 16)', () => {
  assert.strictEqual(Y_OPT.diamond, -58);
  assert.strictEqual(Y_OPT.redstone, -58);
  assert.strictEqual(Y_OPT.lapis, -12);  // bande dense ~y0, à -12 (sous l'aquifère de surface) : dense+accessible ≫ -58 sec mais stérile
  assert.strictEqual(Y_OPT.gold, -16);   // pic de spawn réel (le fix #10 -54 a été REVERT : gold rare en deepslate)
  assert.strictEqual(Y_OPT.iron, 16);
});

test('listPicks/bestTier : tri par palier, -1 sans pioche', () => {
  const items = [{ name: 'iron_pickaxe', count: 1 }, { name: 'stone_pickaxe', count: 2 }, { name: 'bread', count: 5 }];
  const picks = listPicks(items);
  assert.deepStrictEqual(picks.map((p) => p.name), ['stone_pickaxe', 'iron_pickaxe']);
  assert.strictEqual(bestTier(items), 3);
  assert.strictEqual(bestTier([]), -1);
});

test('cheapestPickFor : roche → la moins chère (durabilité fer > gain vitesse) ; ore → la meilleure', () => {
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

const { armorPlan } = require('./gear');

test('armorPlan : bottes d\'abord (moins chères), respecte ironKeep', () => {
  // 6 lingots, ironKeep 0 → bottes (4) puis casque (5)
  assert.deepStrictEqual(armorPlan([{ name: 'iron_ingot', count: 6 }]).craft, 'iron_boots');
  // ironKeep 4 → spendable 2 → rien
  assert.strictEqual(armorPlan([{ name: 'iron_ingot', count: 6 }], { ironKeep: 4 }), null);
});

test('armorPlan : saute les pièces déjà portées/possédées', () => {
  const items = [{ name: 'iron_ingot', count: 20 }, { name: 'iron_boots', count: 1 }];
  // boots en poche → planifie le casque
  assert.strictEqual(armorPlan(items).craft, 'iron_helmet');
  // boots portées (have) → idem
  assert.strictEqual(armorPlan([{ name: 'iron_ingot', count: 20 }], { have: ['iron_boots'] }).craft, 'iron_helmet');
});

test('armorPlan : set complet possédé → null', () => {
  assert.strictEqual(armorPlan([{ name: 'iron_ingot', count: 30 }],
    { have: ['iron_boots', 'iron_helmet', 'iron_leggings', 'iron_chestplate'] }), null);
});

const { isMinimallyArmored, shieldPlan } = require('./gear');

test('isMinimallyArmored : bottes + casque + bouclier (array)', () => {
  assert.strictEqual(isMinimallyArmored(['iron_boots', 'iron_helmet'], true), true);
  assert.strictEqual(isMinimallyArmored(['iron_boots', 'iron_helmet'], false), false);
  assert.strictEqual(isMinimallyArmored(['iron_boots'], true), false);          // pas de casque
  assert.strictEqual(isMinimallyArmored(['iron_helmet'], true), false);         // pas de bottes
});

test('isMinimallyArmored : accepte un Set + tout palier d\'armure', () => {
  assert.strictEqual(isMinimallyArmored(new Set(['iron_boots', 'iron_helmet']), true), true);
  assert.strictEqual(isMinimallyArmored(new Set(['iron_boots']), true), false);
  // n'importe quel palier compte (diamant)
  assert.strictEqual(isMinimallyArmored(['diamond_boots', 'diamond_helmet'], true), true);
});

test('shieldPlan : 6 planks + 1 fer + pas de bouclier → craft', () => {
  const items = [{ name: 'oak_planks', count: 6 }, { name: 'iron_ingot', count: 1 }];
  assert.deepStrictEqual(shieldPlan(items, false), { craft: 'shield' });
  // bouclier déjà présent → null
  assert.strictEqual(shieldPlan(items, true), null);
  // 5 planks → null
  assert.strictEqual(shieldPlan([{ name: 'oak_planks', count: 5 }, { name: 'iron_ingot', count: 1 }], false), null);
  // 0 fer → null
  assert.strictEqual(shieldPlan([{ name: 'oak_planks', count: 6 }], false), null);
});

// ─── Fonte OPPORTUNISTE (piste n°1 rapport water-wall) : la convergence fer+fuel+four n'arrivait
// jamais au but smeltIron de la chaîne (mort/reboucle avant) → décision PURE appelée par un timer.

test('smeltPlan : fer+fuel+four réunis → go avec count borné', () => {
  const items = [
    { name: 'raw_iron', count: 9 }, { name: 'furnace', count: 1 }, { name: 'coal', count: 4 },
  ];
  const p = smeltPlan(items);
  assert.strictEqual(p.go, true);
  assert.strictEqual(p.count, 8);          // passe bornée à 8 (≈80 s de four)
});

test('smeltPlan : planches et bûches comptent comme fuel (leçon Bot2 : bois+four+fer sans décision)', () => {
  const withPlanks = [
    { name: 'raw_iron', count: 3 }, { name: 'furnace', count: 1 }, { name: 'oak_planks', count: 2 },
  ];
  assert.strictEqual(smeltPlan(withPlanks).go, true);
  const withLogs = [
    { name: 'raw_iron', count: 3 }, { name: 'furnace', count: 1 }, { name: 'birch_log', count: 1 },
  ];
  assert.strictEqual(smeltPlan(withLogs).go, true);
});

test('smeltPlan : pas assez de fer / pas de four / pas de fuel → no-go', () => {
  assert.strictEqual(smeltPlan([{ name: 'raw_iron', count: 2 }, { name: 'furnace', count: 1 }, { name: 'coal', count: 1 }]).go, false);
  assert.strictEqual(smeltPlan([{ name: 'raw_iron', count: 5 }, { name: 'coal', count: 1 }]).go, false);
  assert.strictEqual(smeltPlan([{ name: 'raw_iron', count: 5 }, { name: 'furnace', count: 1 }]).go, false);
  assert.strictEqual(smeltPlan([]).go, false);
});

test('smeltPlan : déjà assez de lingots (≥24 = armure complète) → no-go (rien à gagner)', () => {
  const items = [
    { name: 'raw_iron', count: 9 }, { name: 'furnace', count: 1 }, { name: 'coal', count: 4 },
    { name: 'iron_ingot', count: 24 },
  ];
  assert.strictEqual(smeltPlan(items).go, false);
  assert.strictEqual(smeltPlan(items, { maxIngots: 30 }).go, true);   // seuil injectable
});

test('smeltPlan : count ne dépasse jamais le raw disponible', () => {
  const p = smeltPlan([{ name: 'raw_iron', count: 4 }, { name: 'furnace', count: 1 }, { name: 'coal', count: 2 }]);
  assert.strictEqual(p.count, 4);
});

// smeltReady : la fonte opportuniste ratait la POSE du four en surface mouillée/mouvante (vécu live
// NethBot3 : opportunistic_smelt ok:false + armor_smelt no_furnace) → ne fondre que sur sol stable.
test('smeltReady : au sol + sec + immobile → true', () => {
  assert.strictEqual(smeltReady({ onGround: true, inWater: false, moving: false }), true);
});
test('smeltReady : en eau / en l\'air / en plein pathfinding → false', () => {
  assert.strictEqual(smeltReady({ onGround: true, inWater: true, moving: false }), false);
  assert.strictEqual(smeltReady({ onGround: false, inWater: false, moving: false }), false);
  assert.strictEqual(smeltReady({ onGround: true, inWater: false, moving: true }), false);
  assert.strictEqual(smeltReady({}), false);
});
