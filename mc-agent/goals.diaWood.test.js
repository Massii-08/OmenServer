'use strict';
const test = require('node:test');
const assert = require('assert');
const G = require('./goals');

const logsGoal = () => G.diamondChain(192).find((g) => g.name === 'logs');

test('phase diamant : bâtons + table en poche → pas de bois', () => {
  const c = { inv: { stick: 2, crafting_table: 1, diamond: 1 }, worn: [] };
  assert.strictEqual(G.diaWoodEnough(c), true);
  assert.strictEqual(logsGoal().met(c), true);
});
test('phase diamant : planches pour bâtons et table → pas de bois', () => {
  assert.strictEqual(G.diaWoodEnough({ inv: { oak_planks: 6 } }), true);
  assert.strictEqual(G.diaWoodEnough({ inv: { oak_planks: 2 }, hasTable: true }), true);
});
test('phase diamant : ni bâtons ni planches → bois dû (vrai besoin)', () => {
  const c = { inv: { diamond: 1 }, worn: [] };
  assert.strictEqual(G.diaWoodEnough(c), false);
  assert.strictEqual(logsGoal().met(c), false);
});
test('début de partie (aucun diamant) : 6 planches ne dispensent PAS du bois', () => {
  assert.strictEqual(logsGoal().met({ inv: { oak_planks: 6 }, worn: [] }), false);
});
test('phase diamant : pioche fer+ en poche → bois satisfait', () => {
  assert.strictEqual(logsGoal().met({ inv: { diamond_pickaxe: 1 }, worn: [] }), true);
});

test('diaWoodEnough : planches de deux essences ne font pas des bâtons', () => {
  const { diaWoodEnough } = require('./goals');
  assert.strictEqual(diaWoodEnough({ inv: { oak_planks: 1, birch_planks: 1, crafting_table: 1 } }), false);
  assert.strictEqual(diaWoodEnough({ inv: { oak_planks: 2, crafting_table: 1 } }), true);
});
