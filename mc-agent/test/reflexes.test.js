'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { tryEat, shouldFlee, installReflexes } = require('../reflexes');

function fakeBot({ food = 20, health = 20, hasFood = true, threat = null } = {}) {
  const calls = { equipped: [], consumed: 0, handlers: {} };
  return {
    calls, food, health,
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: { items() { return hasFood ? [{ name: 'bread' }] : []; } },
    async equip(item, dest) { calls.equipped.push({ item, dest }); },
    async consume() { calls.consumed++; },
    nearestEntity(pred) { return (threat && pred(threat)) ? threat : null; },
    on(evt, cb) { calls.handlers[evt] = cb; },
  };
}

test('tryEat mange si faim basse ET nourriture en inventaire', async () => {
  const bot = fakeBot({ food: 5, hasFood: true });
  assert.strictEqual(await tryEat(bot), true);
  assert.strictEqual(bot.calls.consumed, 1);
});

test('tryEat ne fait rien si rassasié', async () => {
  const bot = fakeBot({ food: 20 });
  assert.strictEqual(await tryEat(bot), false);
  assert.strictEqual(bot.calls.consumed, 0);
});

test('tryEat ne fait rien sans nourriture en inventaire', async () => {
  const bot = fakeBot({ food: 3, hasFood: false });
  assert.strictEqual(await tryEat(bot), false);
});

test('shouldFlee vrai si PV bas', () => {
  assert.strictEqual(shouldFlee(fakeBot({ health: 5 })), true);
});

test('shouldFlee vrai si creeper proche même en pleine vie', () => {
  const creeper = { type: 'mob', name: 'creeper', position: { x: 3, y: 64, z: 0 } };
  assert.strictEqual(shouldFlee(fakeBot({ health: 20, threat: creeper })), true);
});

test('shouldFlee faux si plein PV et aucune menace', () => {
  assert.strictEqual(shouldFlee(fakeBot({ health: 20, threat: null })), false);
});

test('installReflexes branche un handler sur l event health', () => {
  const bot = fakeBot();
  installReflexes(bot, { emit() {}, fleeFrom() {} });
  assert.strictEqual(typeof bot.calls.handlers.health, 'function');
});
