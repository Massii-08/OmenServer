'use strict';
// Paquet 1 anti-tell : les réflexes de combat/survie ne doivent plus être INSTANTANÉS (0 ms =
// aimbot). reactionMs()/schedule() injectables ; ici on vérifie que l'ACTION est DIFFÉRÉE.
const { test } = require('node:test');
const assert = require('node:assert');
const { installReflexes } = require('../reflexes');

function fakeBot({ food = 20, health = 20, threat = null } = {}) {
  const calls = { handlers: {} };
  return {
    calls, food, health,
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: { items() { return [{ name: 'bread' }]; } },
    async equip() {}, async consume() {},
    nearestEntity(pred) { return (threat && pred(threat)) ? threat : null; },
    on(evt, cb) { calls.handlers[evt] = cb; },
  };
}

test('riposte : ACTION différée par reactionMs (pas d attaque 0 ms)', () => {
  const zombie = { type: 'mob', name: 'zombie', position: { x: 2, y: 64, z: 0, distanceTo: () => 2 } };
  const scheduled = [];
  const attacked = [];
  const bot = fakeBot({ health: 20, threat: zombie });
  installReflexes(bot, {
    emit() {}, fleeFrom() {}, attack: (t) => attacked.push(t),
    reactionMs: () => 300, schedule: (fn, ms) => scheduled.push({ fn, ms }),
  });
  bot.calls.handlers.health();        // baseline (lastHealth=20)
  bot.health = 16; bot.calls.handlers.health(); // frappé
  assert.strictEqual(attacked.length, 0, 'aucune attaque instantanée');
  assert.ok(scheduled.some((s) => s.ms === 300), 'planifiée avec le délai de réaction');
  scheduled.forEach((s) => s.fn());   // le délai s\'écoule
  assert.strictEqual(attacked.length, 1, 'attaque APRÈS le délai');
  assert.strictEqual(attacked[0].name, 'zombie');
});

test('fuite : ACTION différée par reactionMs (télémétrie immédiate, fuite après délai)', () => {
  const scheduled = [];
  let fled = 0;
  const events = [];
  const bot = fakeBot({ health: 5 });   // PV bas → shouldFlee
  installReflexes(bot, {
    emit: (e) => events.push(e), fleeFrom: () => fled++,
    reactionMs: () => 250, schedule: (fn, ms) => scheduled.push({ fn, ms }),
  });
  bot.calls.handlers.health();
  assert.ok(events.some((e) => e.action === 'flee'), 'télémétrie flee immédiate');
  assert.strictEqual(fled, 0, 'pas de fuite 0 ms');
  scheduled.forEach((s) => s.fn());
  assert.ok(fled >= 1, 'fuite après le délai');
});

test('reactionMs absent → comportement SYNCHRONE (rétro-compat)', () => {
  const zombie = { type: 'mob', name: 'zombie', position: { x: 2, y: 64, z: 0, distanceTo: () => 2 } };
  const attacked = [];
  const bot = fakeBot({ health: 20, threat: zombie });
  installReflexes(bot, { emit() {}, fleeFrom() {}, attack: (t) => attacked.push(t) }); // pas de reactionMs
  bot.calls.handlers.health();
  bot.health = 16; bot.calls.handlers.health();
  assert.strictEqual(attacked.length, 1, 'sans reactionMs → instantané comme avant');
});
