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

// --- P6 (Marathon run#6) -------------------------------------------------------------------------

test('P6a: depth est accepté comme alias de count (3 call-sites passaient depth → 1 seul bloc creusé)', async () => {
  const bot = makeBot(['stone', 'stone', 'stone', 'stone']);
  const r = await mineDown(bot, { depth: 3 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(bot.calls.dig, 3);
});

// Piège #41 vécu live : bot à position fractionnaire (y=53.75, à cheval sur une arête) → creuse
// sous lui mais NE TOMBE PAS (supporté par le voisin) → void_below au tour suivant. Le fix :
// se CENTRER sur le bloc (pathfinder GoalBlock) avant de creuser, et attendre la chute après le dig.
test('P6b: off-center + pathfinder → se centre (goto) avant de creuser', async () => {
  const calls = { dig: 0, goto: 0 };
  const mkpos = (x, y, z) => ({ x, y, z, offset(dx, dy, dz) { return mkpos(x + dx, y + dy, z + dz); } });
  const bot = {
    entity: { position: mkpos(0.95, 54, 0.1) },   // bien hors du centre (0.5, 0.5)
    inventory: { items: () => [{ name: 'iron_pickaxe' }] },
    blockAt: (p) => ({ name: 'stone' }),
    equip: async () => {},
    dig: async () => { calls.dig++; bot.entity.position = mkpos(0.5, bot.entity.position.y - 1, 0.5); },
    pathfinder: { async goto() { calls.goto++; bot.entity.position = mkpos(0.5, 54, 0.5); } },
  };
  const r = await mineDown(bot, { count: 2 });
  assert.strictEqual(r.ok, true);
  assert.ok(calls.goto >= 1, 'doit se centrer via pathfinder avant de creuser');
  assert.strictEqual(calls.dig, 2);
});
