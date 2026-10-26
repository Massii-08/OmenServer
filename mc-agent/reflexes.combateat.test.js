'use strict';
// PAS DE BOUCHÉE AU CONTACT (26/10) : NethBot3 en fer complet — `reflex eat` ×6 en 20 s, `reflex fight
// zombie duel:true`, `reflex eat`, `fight_last_stand hp:3.2 dist:2.3`, mort. Le réflexe consulte
// `eatBlocked()` (index.js : eatSafe.combatEatBlocked) avant de lancer la bouchée.
const { test } = require('node:test');
const assert = require('node:assert');
const { installReflexes } = require('./reflexes');

function eatBot() {
  const handlers = {};
  const calls = { equip: 0, consume: 0 };
  const P = { x: 0, y: 64, z: 0, distanceTo() { return 99; } };
  const bot = {
    handlers, calls, health: 11, food: 10, entity: { position: P }, entities: {},
    nearestEntity: () => null, time: { timeOfDay: 6000 },
    inventory: { slots: [], items: () => [{ name: 'cooked_beef', count: 8, slot: 36 }] },
    equip: async () => { calls.equip++; }, consume: async () => { calls.consume++; },
    pathfinder: { setGoal: () => {}, isMoving: () => false }, setControlState: () => {},
    on: (ev, fn) => { handlers[ev] = fn; },
  };
  return bot;
}

test('réflexe : bouchée retenue quand eatBlocked() est vrai (combat au contact)', async () => {
  const bot = eatBot();
  const events = [];
  installReflexes(bot, { emit: (e) => events.push(e), eatBlocked: () => true });
  bot.handlers.health();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(bot.calls.equip, 0);
  assert.strictEqual(bot.calls.consume, 0);
  assert.ok(!events.some((e) => e.action === 'eat'));
});

test('réflexe : bouchée lancée quand eatBlocked() est faux, ou absent (rétro-compat)', async () => {
  for (const opts of [{ eatBlocked: () => false }, {}]) {
    const bot = eatBot();
    installReflexes(bot, Object.assign({ emit: () => {} }, opts));
    bot.handlers.health();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(bot.calls.consume, 1);
  }
});

test('réflexe : eatBlocked() qui lève ne bloque pas la bouchée', async () => {
  const bot = eatBot();
  installReflexes(bot, { emit: () => {}, eatBlocked: () => { throw new Error('x'); } });
  bot.handlers.health();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(bot.calls.consume, 1);
});
