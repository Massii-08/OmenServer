'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { invCount, buildCtxInv, MVP_CHAIN, firstUnmet } = require('./goals');

// Faux bot : inventaire = liste d'items {name, count}
function fakeBot(items) {
  return { inventory: { items: () => items.map((i) => ({ name: i[0], count: i[1] })) } };
}

test('invCount somme les piles du meme item', () => {
  const bot = fakeBot([['oak_planks', 4], ['oak_planks', 3], ['stick', 2]]);
  const inv = buildCtxInv(bot);
  assert.strictEqual(invCount(inv, 'oak_planks'), 7);
  assert.strictEqual(invCount(inv, 'stick'), 2);
  assert.strictEqual(invCount(inv, 'cobblestone'), 0);
});

test('firstUnmet renvoie le 1er but non satisfait dans l\'ordre', () => {
  // inventaire vide -> 1er but = recolter du bois
  let ctx = { inv: {}, hasTable: false };
  assert.strictEqual(firstUnmet(MVP_CHAIN, ctx).name, 'logs');

  // a deja 3 logs -> but suivant = planks
  ctx = { inv: { oak_log: 3 }, hasTable: false };
  assert.strictEqual(firstUnmet(MVP_CHAIN, ctx).name, 'planks');

  // objectif atteint (a une pioche pierre) -> firstUnmet = null
  ctx = { inv: { stone_pickaxe: 1 }, hasTable: true };
  assert.strictEqual(firstUnmet(MVP_CHAIN, ctx), null);
});

test('la chaine MVP ne contient plus de but place_table', () => {
  assert.ok(!MVP_CHAIN.some((g) => g.name === 'place_table'));
});

test('ordre exact de la chaine MVP (7 buts)', () => {
  assert.deepStrictEqual(
    MVP_CHAIN.map((g) => g.name),
    ['logs', 'planks', 'crafting_table', 'sticks', 'wooden_pickaxe', 'cobblestone', 'stone_pickaxe'],
  );
});

test('a une table en inventaire (pas posee) -> but suivant = sticks', () => {
  // crafting_table dans l\'inv suffit (portable) ; hasTable est ignore
  const ctx = { inv: { oak_planks: 12, crafting_table: 1 }, hasTable: false };
  assert.strictEqual(firstUnmet(MVP_CHAIN, ctx).name, 'sticks');
});

test('a table + planks + sticks -> but suivant = wooden_pickaxe', () => {
  const ctx = { inv: { crafting_table: 1, oak_planks: 6, stick: 4 }, hasTable: false };
  assert.strictEqual(firstUnmet(MVP_CHAIN, ctx).name, 'wooden_pickaxe');
});
