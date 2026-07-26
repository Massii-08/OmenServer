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

// --- New tests for array name + maxDistance ---

function makeBotRecording({ found = true, hostile = null } = {}) {
  const calls = { equip: [], collect: 0, attack: 0, findBlock: [] };
  return {
    calls,
    registry: {
      blocksByName: {
        dirt: { id: 3 },
        diamond_ore: { id: 56 },
        oak_log: { id: 17 },
        birch_log: { id: 18 },
      },
    },
    inventory: { items: () => [{ name: 'diamond_shovel' }, { name: 'iron_pickaxe' }] },
    entity: { position: { distanceTo: () => 2 } },
    findBlock: (opts) => {
      calls.findBlock.push({ matching: opts.matching, maxDistance: opts.maxDistance });
      return found ? { name: 'oak_log', position: {} } : null;
    },
    nearestEntity: () => hostile,
    equip: async (it) => { calls.equip.push(it.name); },
    collectBlock: { collect: async () => { calls.collect++; } },
    pvp: { attack: () => { calls.attack++; } },
  };
}

test('gather: name as array resolves to union of ids and collects block', async () => {
  const bot = makeBotRecording();
  const r = await gather(bot, { name: ['oak_log', 'birch_log'], count: 1 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(bot.calls.collect, 1);
  // matching should contain both ids, order doesn't matter
  const matching = bot.calls.findBlock[0].matching;
  assert.ok(Array.isArray(matching));
  assert.ok(matching.includes(17));
  assert.ok(matching.includes(18));
  assert.strictEqual(matching.length, 2);
});

test('gather: unknown names in array are silently filtered out', async () => {
  const bot = makeBotRecording();
  const r = await gather(bot, { name: ['oak_log', 'zzz_unknown'], count: 1 });
  assert.strictEqual(r.ok, true);
  const matching = bot.calls.findBlock[0].matching;
  assert.deepStrictEqual(matching, [17]);
});

test('gather: empty array → {ok:false, reason:no_block} with no findBlock call', async () => {
  const bot = makeBotRecording();
  const r = await gather(bot, { name: [], count: 1 });
  assert.deepStrictEqual(r, { ok: false, reason: 'no_block' });
  assert.strictEqual(bot.calls.findBlock.length, 0);
});

test('gather: maxDistance defaults to 64', async () => {
  const bot = makeBotRecording();
  await gather(bot, { name: 'oak_log', count: 1 });
  assert.strictEqual(bot.calls.findBlock[0].maxDistance, 64);
});

test('gather: custom maxDistance is forwarded to findBlock', async () => {
  const bot = makeBotRecording();
  await gather(bot, { name: 'oak_log', count: 1, maxDistance: 32 });
  assert.strictEqual(bot.calls.findBlock[0].maxDistance, 32);
});

test('gather: array with all unknown names → {ok:false, reason:not_found}', async () => {
  const bot = makeBotRecording({ found: false });
  // _ids returns null for all-unknown → treat as not_found
  const r = await gather(bot, { name: ['zzz', 'aaa'], count: 1 });
  assert.deepStrictEqual(r, { ok: false, reason: 'not_found' });
});

// ─── Pas de corps-à-corps sur un creeper pendant la récolte (analyse 26/07) ──
const { defendIfNeeded: _def, NO_MELEE } = require('../skills/gather');

test('defendIfNeeded : creeper → on N\'ENGAGE PAS (son explosion fait ~64 dégâts)', async () => {
  let attacked = null;
  const creeper = { name: 'creeper', type: 'mob', kind: 'Hostile mobs',
                    position: { x: 2, y: 64, z: 0, distanceTo: () => 2 } };
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    nearestEntity: (pred) => (pred(creeper) ? creeper : null),
    inventory: { items: () => [] },
    pvp: { attack: (e) => { attacked = e && e.name; } },
    equip: async () => {},
  };
  const r = await _def(bot);
  assert.strictEqual(r, false);
  assert.strictEqual(attacked, null, 'aucune attaque ne doit partir vers un creeper');
});

test('NO_MELEE couvre les mobs qu\'on fuit déjà ailleurs', () => {
  for (const n of ['creeper', 'wither_skeleton', 'warden']) assert.ok(NO_MELEE.has(n), n);
  assert.ok(!NO_MELEE.has('zombie'), 'un zombie se combat normalement');
});
