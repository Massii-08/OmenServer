'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('./stoneDig');

test('pickTier : pierre ou mieux > bois > rien', () => {
  assert.strictEqual(S.pickTier([{ name: 'wooden_pickaxe' }, { name: 'stone_pickaxe' }]), 'stone');
  assert.strictEqual(S.pickTier([{ name: 'iron_pickaxe' }]), 'stone');
  assert.strictEqual(S.pickTier([{ name: 'wooden_pickaxe' }]), 'wood');
  assert.strictEqual(S.pickTier([{ name: 'stone_axe' }]), null);
  assert.strictEqual(S.pickTier(null), null);
});

test('stoneBatchWant : pioche pierre → on complète le LOT (32), jamais moins que le but', () => {
  assert.strictEqual(S.stoneBatchWant({ count: 8, have: 0, tier: 'stone' }), 32);
  assert.strictEqual(S.stoneBatchWant({ count: 8, have: 20, tier: 'stone' }), 12);
  assert.strictEqual(S.stoneBatchWant({ count: 12, have: 30, tier: 'stone' }), 12, 'le but prime quand le lot est déjà là');
});

test('stoneBatchWant : pioche en bois (fragile) ou cartographe → le besoin du but seulement', () => {
  assert.strictEqual(S.stoneBatchWant({ count: 3, have: 0, tier: 'wood' }), 3);
  assert.strictEqual(S.stoneBatchWant({ count: 8, have: 0, tier: 'stone', isMapper: true }), 8);
  assert.strictEqual(S.stoneBatchWant({ count: 0, tier: null }), 1);
});

test('stoneStairPlan : escalier jusqu\'à Y20 au plus, 40 paliers, seulement avec une pioche et assez haut', () => {
  assert.deepStrictEqual(S.stoneStairPlan({ y: 70, tier: 'stone' }), { targetY: 20, maxDepth: 40 });
  assert.deepStrictEqual(S.stoneStairPlan({ y: 70, tier: 'wood' }), { targetY: 20, maxDepth: 40 });
  assert.strictEqual(S.stoneStairPlan({ y: 70, tier: null }), null);
  assert.strictEqual(S.stoneStairPlan({ y: 21, tier: 'stone' }), null, 'déjà au fond');
  assert.strictEqual(S.stoneStairPlan({ y: undefined, tier: 'stone' }), null);
});
