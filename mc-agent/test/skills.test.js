'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { say } = require('../skills/say');
const { follow } = require('../skills/follow');
const { goto } = require('../skills/goto');

function fakeBot() {
  const calls = { chat: [], setGoal: [] };
  return {
    calls,
    chat(m) { calls.chat.push(m); },
    players: {},
    pathfinder: { setGoal(g, d) { calls.setGoal.push({ g, d }); }, async goto() { calls.gotoCalled = true; } },
  };
}

test('say envoie le message dans le chat', async () => {
  const bot = fakeBot();
  await say(bot, 'coucou');
  assert.deepStrictEqual(bot.calls.chat, ['coucou']);
});

test('say ignore un message vide', async () => {
  const bot = fakeBot();
  await say(bot, '');
  assert.strictEqual(bot.calls.chat.length, 0);
});

test('follow lève une erreur sans nom de joueur', () => {
  assert.throws(() => follow(fakeBot(), {}), /player/);
});

test('follow prévient et retourne false si le joueur n\'est pas visible', () => {
  const bot = fakeBot();
  const ok = follow(bot, { player: 'Massii' });
  assert.strictEqual(ok, false);
  assert.strictEqual(bot.calls.chat.length, 1);
});

test('follow pose un goal et retourne true si le joueur est visible', () => {
  const bot = fakeBot();
  bot.players.Massii = { entity: { id: 42, position: { x: 1, y: 64, z: 1 } } };
  const ok = follow(bot, { player: 'Massii' });
  assert.strictEqual(ok, true);
  assert.strictEqual(bot.calls.setGoal.length, 1);
});

test('goto lève une erreur si les coordonnées ne sont pas numériques', async () => {
  await assert.rejects(goto(fakeBot(), { x: 'a', y: 1, z: 2 }), /numeric/);
});
