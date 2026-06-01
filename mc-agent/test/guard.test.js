'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { guardTick, guard } = require('../skills/guard');

function makeBot(foe) {
  const calls = { attack: 0, equip: [] };
  return {
    calls,
    inventory: { items: () => [{ name: 'iron_sword' }] },
    nearestEntity: () => foe,
    equip: async (it) => { calls.equip.push(it.name); },
    pvp: { attack: () => { calls.attack++; }, stop: () => {} },
  };
}

test('guardTick: attaque le mob hostile présent avec la meilleure arme', async () => {
  const bot = makeBot({ type: 'mob', kind: 'Hostile mobs', position: {} });
  await guardTick(bot);
  assert.strictEqual(bot.calls.attack, 1);
  assert.ok(bot.calls.equip.includes('iron_sword'));
});

test('guardTick: aucun hostile → ne fait rien', async () => {
  const bot = makeBot(null);
  await guardTick(bot);
  assert.strictEqual(bot.calls.attack, 0);
});

test('guard: retourne une fonction stop()', () => {
  const bot = makeBot(null);
  const stop = guard(bot, { cancelled: false }, { intervalMs: 100000 });
  assert.strictEqual(typeof stop, 'function');
  stop();
});
