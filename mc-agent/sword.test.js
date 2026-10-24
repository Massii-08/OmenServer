'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { swordPlan, swordRank, bestSwordRank } = require('./sword');

const base = (inv, extra) => Object.assign({ inv: Object.assign({ stick: 2 }, inv), tableOk: true, pickCount: 1 }, extra || {});

test('rangs : bois/or ne comptent pas, pierre < fer < diamant < netherite', () => {
  assert.strictEqual(swordRank('wooden_sword'), 0);
  assert.strictEqual(swordRank('golden_sword'), 0);
  assert.strictEqual(swordRank('dirt'), 0);
  assert.ok(swordRank('stone_sword') < swordRank('iron_sword'));
  assert.ok(swordRank('iron_sword') < swordRank('diamond_sword'));
  assert.ok(swordRank('diamond_sword') < swordRank('netherite_sword'));
  assert.strictEqual(bestSwordRank(['stone_sword', 'diamond_sword']), 3);
});

test('aucune épée + 5 diamants (réserve 3) → épée diamant', () => {
  const p = swordPlan(base({ diamond: 5 }));
  assert.deepStrictEqual(p, { name: 'diamond_sword', tier: 'diamond', cost: 2, upgrade: false });
});

test('4 diamants seulement : la réserve pioche passe avant → pierre', () => {
  const p = swordPlan(base({ diamond: 4, cobblestone: 10 }));
  assert.strictEqual(p.name, 'stone_sword');
});

test('pioche de rechange en poche : plus de réserve, 2 diamants suffisent', () => {
  assert.strictEqual(swordPlan(base({ diamond: 2 }, { pickCount: 2 })).name, 'diamond_sword');
});

test('épée pierre saine + marge diamant → amélioration en diamant', () => {
  const p = swordPlan(base({ diamond: 6, stone_sword: 1 }));
  assert.strictEqual(p.name, 'diamond_sword');
  assert.strictEqual(p.upgrade, true);
});

test('épée pierre saine sans diamant : rien (pas de fer → fer)', () => {
  assert.strictEqual(swordPlan(base({ stone_sword: 1, iron_ingot: 20 })), null);
});

test('épée diamant saine : rien', () => {
  assert.strictEqual(swordPlan(base({ diamond_sword: 1, diamond: 40 })), null);
});

test('épée presque cassée (absente de swordsGood) → refaite', () => {
  const p = swordPlan(base({ diamond_sword: 1, diamond: 1, cobblestone: 5 }, { swordsGood: [] }));
  assert.strictEqual(p.name, 'stone_sword');
});

test('fer : seulement au-delà des 3 lingots de la pioche de rechange', () => {
  assert.strictEqual(swordPlan(base({ iron_ingot: 4, cobblestone: 3 })).name, 'stone_sword');
  assert.strictEqual(swordPlan(base({ iron_ingot: 5 })).name, 'iron_sword');
  assert.strictEqual(swordPlan(base({ iron_ingot: 2 }, { pickCount: 2 })).name, 'iron_sword');
});

test('pierre : cobblestone, deepslate ou blackstone (2 blocs)', () => {
  assert.strictEqual(swordPlan(base({ cobbled_deepslate: 2 })).name, 'stone_sword');
  assert.strictEqual(swordPlan(base({ cobblestone: 1 })), null);
});

test('sans bâton ni bois, ou sans table : null (jamais bloquant)', () => {
  assert.strictEqual(swordPlan({ inv: { diamond: 9 }, tableOk: true, pickCount: 1 }), null);
  assert.strictEqual(swordPlan({ inv: { diamond: 9, oak_planks: 2 }, tableOk: true, pickCount: 1 }).name, 'diamond_sword');
  assert.strictEqual(swordPlan(base({ diamond: 9 }, { tableOk: false })), null);
});

test('épée en bois en poche = pas d arme : on fait mieux', () => {
  assert.strictEqual(swordPlan(base({ wooden_sword: 1, cobblestone: 4 })).name, 'stone_sword');
});
