'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { pickFuelByPriority } = require('./smelt');

const FUEL = ['coal', 'charcoal', 'oak_planks', 'oak_log']; // ordre = priorité (§0-bis)

test('pickFuelByPriority : charbon préféré au bois même si le bois est 1er en inventaire', () => {
  const inv = [{ name: 'oak_log', count: 10 }, { name: 'coal', count: 3 }];
  assert.strictEqual(pickFuelByPriority(inv, FUEL).name, 'coal');
});

test('pickFuelByPriority : charcoal préféré au bois', () => {
  const inv = [{ name: 'oak_planks', count: 8 }, { name: 'charcoal', count: 2 }];
  assert.strictEqual(pickFuelByPriority(inv, FUEL).name, 'charcoal');
});

test('pickFuelByPriority : sans charbon → repli sur le bois (ordre de la liste)', () => {
  const inv = [{ name: 'oak_log', count: 4 }, { name: 'oak_planks', count: 4 }];
  assert.strictEqual(pickFuelByPriority(inv, FUEL).name, 'oak_planks'); // planks avant log dans FUEL
});

test('pickFuelByPriority : aucun combustible → null', () => {
  assert.strictEqual(pickFuelByPriority([{ name: 'dirt', count: 1 }], FUEL), null);
  assert.strictEqual(pickFuelByPriority([], FUEL), null);
  assert.strictEqual(pickFuelByPriority(null, FUEL), null);
});
