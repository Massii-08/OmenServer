'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { gather } = require('../skills/gather');

function makeBot({ found = true, hostile = null } = {}) {
  const calls = { equip: [], collect: 0, attack: 0 };
  return {
    calls,
    registry: { blocksByName: { dirt: { id: 3 }, diamond_ore: { id: 56 } } },
    inventory: { items: () => [{ name: 'diamond_shovel' }, { name: 'iron_pickaxe' }] },
    entity: { position: { distanceTo: () => 2 } },
    findBlock: () => (found ? { name: 'dirt', position: {} } : null),
    nearestEntity: () => hostile,
    equip: async (it) => { calls.equip.push(it.name); },
    collectBlock: { collect: async () => { calls.collect++; } },
    pvp: { attack: () => { calls.attack++; } },
  };
}

test('gather: bloc introuvable → {ok:false, not_found}', async () => {
  const r = await gather(makeBot({ found: false }), { name: 'dirt', count: 1 });
  assert.deepStrictEqual(r, { ok: false, reason: 'not_found' });
});

test('gather: équipe le meilleur outil (pelle pour dirt) et ramasse n fois', async () => {
  const bot = makeBot();
  const r = await gather(bot, { name: 'dirt', count: 2 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(bot.calls.collect, 2);
  assert.ok(bot.calls.equip.includes('diamond_shovel'));
});

test('gather: se défend si un hostile est proche', async () => {
  const hostile = { type: 'mob', kind: 'Hostile mobs', position: { distanceTo: () => 3 } };
  const bot = makeBot({ hostile });
  await gather(bot, { name: 'dirt', count: 1 });
  assert.ok(bot.calls.attack >= 1);
});
