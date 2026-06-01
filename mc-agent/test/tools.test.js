'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { toolCategoryFor, tierRank, bestToolFor, bestWeapon } = require('../tools');

function botWith(names) {
  return { inventory: { items: () => names.map((n) => ({ name: n, type: 1 })) } };
}

test('toolCategoryFor: matériaux', () => {
  assert.strictEqual(toolCategoryFor('dirt'), 'shovel');
  assert.strictEqual(toolCategoryFor('grass_block'), 'shovel');
  assert.strictEqual(toolCategoryFor('stone'), 'pickaxe');
  assert.strictEqual(toolCategoryFor('diamond_ore'), 'pickaxe');
  assert.strictEqual(toolCategoryFor('deepslate_diamond_ore'), 'pickaxe');
  assert.strictEqual(toolCategoryFor('oak_log'), 'axe');
  assert.strictEqual(toolCategoryFor('oak_leaves'), 'shears');
  assert.strictEqual(toolCategoryFor('air'), null);
});

test('tierRank: palier', () => {
  assert.strictEqual(tierRank('wooden_pickaxe'), 0);
  assert.strictEqual(tierRank('diamond_pickaxe'), 4);
  assert.strictEqual(tierRank('netherite_axe'), 5);
  assert.strictEqual(tierRank('apple'), -1);
});

test('bestToolFor: palier le + haut de la bonne catégorie', () => {
  const bot = botWith(['iron_pickaxe', 'diamond_pickaxe', 'stone_shovel']);
  assert.strictEqual(bestToolFor(bot, { name: 'stone' }).name, 'diamond_pickaxe');
  assert.strictEqual(bestToolFor(bot, { name: 'dirt' }).name, 'stone_shovel');
  assert.strictEqual(bestToolFor(bot, { name: 'oak_log' }), null); // pas de hache
  assert.strictEqual(bestToolFor(botWith(['shears']), { name: 'oak_leaves' }).name, 'shears');
});

test('bestWeapon: épée > hache, palier', () => {
  assert.strictEqual(bestWeapon(botWith(['stone_axe', 'wooden_sword'])).name, 'wooden_sword');
  assert.strictEqual(bestWeapon(botWith(['diamond_axe', 'iron_sword'])).name, 'iron_sword');
  assert.strictEqual(bestWeapon(botWith(['netherite_axe'])).name, 'netherite_axe');
  assert.strictEqual(bestWeapon(botWith(['apple'])), null);
});
