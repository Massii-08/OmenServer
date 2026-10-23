'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { noPickWhy } = require('./noPick');

test('noPickWhy : la cause la plus fondamentale d\'abord', () => {
  assert.strictEqual(noPickWhy({ cobble: 0, sticks: 5 }), 'no_cobble');
  assert.strictEqual(noPickWhy({ cobble: 100, sticks: 0, planks: 0, logs: 0 }), 'no_sticks');
  assert.strictEqual(noPickWhy({ cobble: 100, sticks: 0, planks: 4 }), 'unknown', 'des planches → bâtons possibles');
  assert.strictEqual(noPickWhy({ cobble: 587, sticks: 3, emptySlots: 0, rebuildReason: 'craft_no_effect' }), 'inventory_full');
  assert.strictEqual(noPickWhy({ cobble: 587, sticks: 3, emptySlots: 4, rebuildReason: 'no_table:no_space' }), 'no_table:no_space');
  assert.strictEqual(noPickWhy(), 'no_cobble');
});
