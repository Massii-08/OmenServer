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

// --- depositFiltered (marathon) -----------------------------------------------------------------
const { depositFiltered } = require('../skills/deposit');

function makeBot2({ chest = true, items = [], container = [] } = {}) {
  const calls = { deposits: [], closed: 0 };
  return {
    calls,
    registry: { blocksByName: { chest: { id: 54 }, barrel: { id: 55 }, trapped_chest: { id: 56 } } },
    inventory: { items: () => items.map((it) => ({ name: it[0], type: it[2] || 1, count: it[1] })) },
    findBlock: () => (chest ? { position: {} } : null),
    openContainer: async () => ({
      deposit: async (type, meta, count) => { calls.deposits.push({ type, count }); },
      containerItems: () => container.map((it) => ({ name: it[0], count: it[1] })),
      close: () => { calls.closed++; },
    }),
  };
}

test('depositFiltered: dépose les valuables en entier, garde le surplus-list au seuil', async () => {
  const bot = makeBot2({
    items: [['diamond', 5], ['redstone', 30], ['cobblestone', 50], ['iron_pickaxe', 2], ['torch', 12]],
    container: [['diamond', 5], ['redstone', 30], ['cobblestone', 18]],
  });
  const r = await depositFiltered(bot, {
    only: ['diamond', 'redstone', 'lapis_lazuli', 'raw_gold', 'gold_ingot'],
    surplus: { cobblestone: 32 },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.deposited.diamond, 5);
  assert.strictEqual(r.deposited.redstone, 30);
  assert.strictEqual(r.deposited.cobblestone, 18);   // 50 - 32 gardés
  assert.strictEqual(r.deposited.iron_pickaxe, undefined); // outils JAMAIS déposés
  assert.strictEqual(r.deposited.torch, undefined);
  // lecture du coffre → banked
  assert.strictEqual(r.chest.diamond, 5);
  assert.strictEqual(r.chest.redstone, 30);
  assert.strictEqual(bot.calls.closed, 1);
});

test('depositFiltered: surplus sous le seuil → rien déposé pour cet item', async () => {
  const bot = makeBot2({ items: [['cobblestone', 20]], container: [] });
  const r = await depositFiltered(bot, { only: [], surplus: { cobblestone: 32 } });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.deposited, {});
});

test('depositFiltered: pas de coffre → no_chest', async () => {
  const r = await depositFiltered(makeBot2({ chest: false }), { only: ['diamond'] });
  assert.deepStrictEqual(r, { ok: false, reason: 'no_chest' });
});

test('depositFiltered: piles multiples du même item sommées', async () => {
  const bot = makeBot2({ items: [['diamond', 64], ['diamond', 10]], container: [['diamond', 74]] });
  const r = await depositFiltered(bot, { only: ['diamond'] });
  assert.strictEqual(r.deposited.diamond, 74);
  assert.strictEqual(r.chest.diamond, 74);
});
