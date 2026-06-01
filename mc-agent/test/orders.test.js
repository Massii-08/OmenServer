'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseOrder } = require('../orders');

test('parseOrder: take avec/sans count', () => {
  assert.deepStrictEqual(parseOrder('take dirt 10'), { verb: 'take', args: { name: 'dirt', count: 10 } });
  assert.deepStrictEqual(parseOrder('take diamond_ore'), { verb: 'take', args: { name: 'diamond_ore', count: 1 } });
});

test('parseOrder: follow me uniquement', () => {
  assert.deepStrictEqual(parseOrder('follow me'), { verb: 'follow', args: { who: 'me' } });
  assert.strictEqual(parseOrder('follow Bob'), null); // seul "follow me" est géré
});

test('parseOrder: stop / afk / eat / deposit / guard / give all', () => {
  assert.deepStrictEqual(parseOrder('stop'), { verb: 'stop', args: {} });
  assert.deepStrictEqual(parseOrder('afk'), { verb: 'afk', args: {} });
  assert.deepStrictEqual(parseOrder('eat'), { verb: 'eat', args: {} });
  assert.deepStrictEqual(parseOrder('deposit'), { verb: 'deposit', args: {} });
  assert.deepStrictEqual(parseOrder('guard'), { verb: 'guard', args: {} });
  assert.deepStrictEqual(parseOrder('give all'), { verb: 'giveAll', args: {} });
});

test('parseOrder: give/craft/equip/pvp/tpa/come/goto/mine down', () => {
  assert.deepStrictEqual(parseOrder('give dirt'), { verb: 'give', args: { name: 'dirt' } });
  assert.deepStrictEqual(parseOrder('craft chest 2'), { verb: 'craft', args: { name: 'chest', count: 2 } });
  assert.deepStrictEqual(parseOrder('equip diamond_sword'), { verb: 'equip', args: { name: 'diamond_sword' } });
  assert.deepStrictEqual(parseOrder('pvp Steve'), { verb: 'pvp', args: { player: 'Steve' } });
  assert.deepStrictEqual(parseOrder('tpa me'), { verb: 'tpa', args: { target: 'me' } });
  assert.deepStrictEqual(parseOrder('tpa Alice'), { verb: 'tpa', args: { target: 'Alice' } });
  assert.deepStrictEqual(parseOrder('come'), { verb: 'come', args: {} });
  assert.deepStrictEqual(parseOrder('come here'), { verb: 'come', args: {} });
  assert.deepStrictEqual(parseOrder('goto 10 64 -20'), { verb: 'goto', args: { x: 10, y: 64, z: -20 } });
  assert.deepStrictEqual(parseOrder('mine down 5'), { verb: 'mineDown', args: { count: 5 } });
});

test('parseOrder: casse insensible + inconnu/conversation → null', () => {
  assert.deepStrictEqual(parseOrder('TAKE Dirt 3'), { verb: 'take', args: { name: 'dirt', count: 3 } });
  assert.strictEqual(parseOrder('salut ça va ?'), null);
  assert.strictEqual(parseOrder('can you take a look'), null);
  assert.strictEqual(parseOrder(''), null);
  assert.strictEqual(parseOrder('mine down'), null); // n manquant
});
