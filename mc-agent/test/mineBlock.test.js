'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { mineBlock, collectWood } = require('../skills/mineBlock');

function fakeBot({ found = true } = {}) {
  const calls = { collected: [], chat: [], findArgs: [] };
  return {
    calls,
    registry: { blocksByName: { oak_log: { id: 17 }, stone: { id: 1 } } },
    findBlock(opts) { calls.findArgs.push(opts); return found ? { position: { x: 1, y: 2, z: 3 } } : null; },
    chat(m) { calls.chat.push(m); },
    collectBlock: { async collect(b) { calls.collected.push(b); } },
  };
}

test('mineBlock exige un nom de bloc', async () => {
  await assert.rejects(mineBlock(fakeBot(), {}), /name/);
});

test('mineBlock collecte le bloc trouvé et retourne true', async () => {
  const bot = fakeBot({ found: true });
  const ok = await mineBlock(bot, { name: 'oak_log' });
  assert.strictEqual(ok, true);
  assert.strictEqual(bot.calls.collected.length, 1);
});

test('mineBlock prévient et retourne false si le bloc est introuvable', async () => {
  const bot = fakeBot({ found: false });
  const ok = await mineBlock(bot, { name: 'oak_log' });
  assert.strictEqual(ok, false);
  assert.strictEqual(bot.calls.chat.length, 1);
});

test('collectWood cherche un type de bûche et collecte', async () => {
  const bot = fakeBot({ found: true });
  const ok = await collectWood(bot, { count: 3 });
  assert.strictEqual(ok, true);
  assert.ok(bot.calls.collected.length >= 1);
});
