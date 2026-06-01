'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { equipItem, eat, _destFor } = require('../skills/equip');

function makeBot({ items = [], food = 10 } = {}) {
  const calls = { equip: [], consume: 0 };
  return {
    calls, food,
    inventory: { items: () => items.map((n) => ({ name: n, type: 1 })) },
    equip: async (it, dest) => { calls.equip.push([it.name, dest]); },
    consume: async () => { calls.consume++; },
  };
}

test('_destFor: slot selon le type', () => {
  assert.strictEqual(_destFor('diamond_helmet'), 'head');
  assert.strictEqual(_destFor('iron_chestplate'), 'torso');
  assert.strictEqual(_destFor('shield'), 'off-hand');
  assert.strictEqual(_destFor('diamond_sword'), 'hand');
});

test('equipItem: objet absent → no_item ; présent → équipé au bon slot', async () => {
  assert.deepStrictEqual(await equipItem(makeBot({ items: ['dirt'] }), { name: 'sword' }), { ok: false, reason: 'no_item' });
  const bot = makeBot({ items: ['diamond_helmet'] });
  const r = await equipItem(bot, { name: 'diamond_helmet' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(bot.calls.equip[0], ['diamond_helmet', 'head']);
});

test('eat: pas de nourriture → no_food ; nourriture → consume', async () => {
  assert.deepStrictEqual(await eat(makeBot({ items: ['dirt'] })), { ok: false, reason: 'no_food' });
  const bot = makeBot({ items: ['bread'] });
  const r = await eat(bot);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(bot.calls.consume, 1);
});

test('eat: déjà plein → full', async () => {
  assert.deepStrictEqual(await eat(makeBot({ items: ['bread'], food: 20 })), { ok: false, reason: 'full' });
});
