'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { deposit } = require('../skills/deposit');

function makeBot({ chest = true, items = ['dirt', 'stone'] } = {}) {
  const calls = { deposit: 0, closed: 0 };
  return {
    calls,
    registry: { blocksByName: { chest: { id: 54 }, barrel: { id: 55 }, trapped_chest: { id: 56 } } },
    inventory: { items: () => items.map((n) => ({ name: n, type: 1, count: 1 })) },
    findBlock: () => (chest ? { position: {} } : null),
    openContainer: async () => ({ deposit: async () => { calls.deposit++; }, close: () => { calls.closed++; } }),
  };
}

test('deposit: pas de coffre → no_chest', async () => {
  assert.deepStrictEqual(await deposit(makeBot({ chest: false })), { ok: false, reason: 'no_chest' });
});

test('deposit: dépose chaque item et ferme', async () => {
  const bot = makeBot();
  const r = await deposit(bot);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(bot.calls.deposit, 2);
  assert.strictEqual(bot.calls.closed, 1);
});
