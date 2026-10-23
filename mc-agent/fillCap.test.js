'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fillOverflow, fillCapDue, FILL_MAX_STACKS, FILL_CAP_INTERVAL_MS } = require('./fillCap');

const S = (pairs) => pairs.map(([name, count], i) => ({ name, count, slot: 9 + i }));
const names = (arr) => arr.map((x) => x.name + ':' + x.count);

test('constantes : 3 piles, 20 s', () => {
  assert.strictEqual(FILL_MAX_STACKS, 3);
  assert.strictEqual(FILL_CAP_INTERVAL_MS, 20000);
});

test('LIVE NethBot1 : 10 piles de cobble (587) → 7 partent, il en reste 3', () => {
  const inv = S(new Array(9).fill(['cobblestone', 64]).concat([['cobblestone', 11]], [['stone_pickaxe', 1], ['iron_ingot', 5]]));
  const out = fillOverflow(inv);
  assert.strictEqual(out.length, 7);
  assert.strictEqual(out[0].count, 11, 'la plus petite pile d\'abord');
  const left = inv.filter((x) => x.name === 'cobblestone' && !out.includes(x));
  assert.strictEqual(left.length, 3);
  assert.strictEqual(left.reduce((n, x) => n + x.count, 0), 192);
});

test('≤ 3 piles : rien', () => {
  assert.deepStrictEqual(fillOverflow(S([['cobblestone', 64], ['dirt', 64], ['gravel', 64]])), []);
  assert.deepStrictEqual(fillOverflow(S([['stick', 64], ['oak_log', 64], ['coal', 64], ['torch', 64], ['bread', 64]])), []);
});

test('terre et gravier partent avant le cobble', () => {
  const out = fillOverflow(S([['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 64], ['dirt', 30], ['gravel', 5]]));
  assert.deepStrictEqual(names(out), ['dirt:30', 'gravel:5']);
});

test('jamais sous 64 blocs de remblai au total, même au-delà de 3 piles', () => {
  const out = fillOverflow(S([['dirt', 10], ['gravel', 10], ['tuff', 10], ['granite', 10], ['cobblestone', 30]]));
  // 70 au total : jeter 10 laisse 60 < 64 → rien.
  assert.deepStrictEqual(out, []);
});

test('ne jette JAMAIS outils, bois, minerais, nourriture, utilitaires', () => {
  const keep = ['stone_pickaxe', 'iron_sword', 'shield', 'iron_helmet', 'cooked_beef', 'raw_iron', 'iron_ingot', 'coal',
    'oak_log', 'oak_planks', 'stick', 'crafting_table', 'furnace', 'torch', 'white_bed', 'bucket', 'fishing_rod'];
  const inv = S(keep.map((n) => [n, 1]).concat(new Array(6).fill(['cobblestone', 64])));
  for (const it of fillOverflow(inv)) assert.strictEqual(it.name, 'cobblestone');
});

test('entrées bizarres → [] sans crash', () => {
  for (const bad of [undefined, null, 42, 'x', {}]) assert.deepStrictEqual(fillOverflow(bad), []);
});

test('fillCapDue : au plus une passe / 20 s', () => {
  assert.strictEqual(fillCapDue(1000, 0), true);
  assert.strictEqual(fillCapDue(100000, 90000), false);
  assert.strictEqual(fillCapDue(110000, 90000), true);
});
