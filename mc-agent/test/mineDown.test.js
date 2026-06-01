'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { mineDown } = require('../skills/mineDown');

function makeBot(belowNames) {
  let i = 0;
  const calls = { dig: 0 };
  return {
    calls,
    inventory: { items: () => [{ name: 'diamond_pickaxe' }] },
    entity: { position: { offset: (dx, dy) => ({ k: dy }) } },
    blockAt: (p) => {
      // p.k = -1 (sous les pieds) ou -2
      if (p.k === -1) { const n = belowNames[i] || 'air'; return { name: n }; }
      return { name: belowNames[i + 1] || 'stone' };
    },
    equip: async () => {},
    dig: async () => { calls.dig++; i++; },
  };
}

test('mineDown: vide en dessous → void_below', async () => {
  const r = await mineDown(makeBot(['air']), { count: 3 });
  assert.deepStrictEqual(r, { ok: false, reason: 'void_below' });
});

test('mineDown: lave en dessous → danger_below', async () => {
  const r = await mineDown(makeBot(['lava']), { count: 3 });
  assert.deepStrictEqual(r, { ok: false, reason: 'danger_below' });
});

test('mineDown: creuse n blocs de pierre', async () => {
  const bot = makeBot(['stone', 'stone', 'stone', 'stone']);
  const r = await mineDown(bot, { count: 3 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(bot.calls.dig, 3);
});
