'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { giveItem, giveAll } = require('../skills/give');

function makeBot(names) {
  const calls = { tossed: [] };
  return {
    calls,
    players: {},
    inventory: { items: () => names.map((n) => ({ name: n, type: 1 })) },
    lookAt: async () => {},
    tossStack: async (it) => { calls.tossed.push(it.name); },
  };
}

test('giveItem: rien à donner → {ok:false,no_item}', async () => {
  const r = await giveItem(makeBot(['stone']), { name: 'dirt' }, 'Bob');
  assert.deepStrictEqual(r, { ok: false, reason: 'no_item' });
});

test('giveItem: jette tous les stacks correspondants', async () => {
  const bot = makeBot(['dirt', 'dirt', 'stone']);
  const r = await giveItem(bot, { name: 'dirt' }, 'Bob');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(bot.calls.tossed, ['dirt', 'dirt']);
});

test('giveAll: vide tout l\'inventaire', async () => {
  const bot = makeBot(['dirt', 'stone']);
  const r = await giveAll(bot, {}, 'Bob');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(bot.calls.tossed.length, 2);
  assert.deepStrictEqual(await giveAll(makeBot([]), {}, 'Bob'), { ok: false, reason: 'empty' });
});
