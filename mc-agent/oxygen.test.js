'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { selfAirFromMetadata, installOxygenGuard } = require('./oxygen');

const pk = (id, v, key = 1) => ({ entityId: id, metadata: [{ key, type: 1, value: v }] });

test('selfAirFromMetadata : bot vs autre entité, clé absente, valeurs', () => {
  assert.strictEqual(selfAirFromMetadata(pk(5, 300), 5, 1), 20);
  assert.strictEqual(selfAirFromMetadata(pk(5, 0), 5, 1), 0);
  assert.strictEqual(selfAirFromMetadata(pk(5, 60), 5, 1), 4);
  assert.strictEqual(selfAirFromMetadata(pk(9, 0), 5, 1), null);
  assert.strictEqual(selfAirFromMetadata(pk(5, 0, 3), 5, 1), null);
  assert.strictEqual(selfAirFromMetadata(null, 5, 1), null);
});

function fakeBot() {
  const bot = new EventEmitter();
  bot._client = new EventEmitter();
  bot.entity = { id: 5 };
  return bot;
}

test('installOxygenGuard : écriture étrangère ignorée, air du bot suivi', () => {
  const bot = fakeBot();
  const foreign = [];
  installOxygenGuard(bot, { onForeign: (id) => foreign.push(id) });
  assert.strictEqual(bot.oxygenLevel, 20);
  bot._client.emit('entity_metadata', pk(9, 0));
  bot.oxygenLevel = 0; // mineflayer écrit ensuite
  assert.strictEqual(bot.oxygenLevel, 20);
  assert.deepStrictEqual(foreign, [9]);
  bot._client.emit('entity_metadata', pk(5, 60));
  bot.oxygenLevel = 4;
  assert.strictEqual(bot.oxygenLevel, 4);
});
