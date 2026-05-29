'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { fleeFrom } = require('../skills/fleeFrom');

function fakeBot({ threat = null } = {}) {
  const calls = { goals: [] };
  return {
    calls,
    entity: { position: { x: 0, y: 64, z: 0 } },
    nearestEntity(pred) { return (threat && pred(threat)) ? threat : null; },
    pathfinder: { setGoal(g, dyn) { calls.goals.push({ g, dyn }); } },
  };
}

test('fleeFrom pose un goal de fuite et retourne true si menace présente', () => {
  const creeper = { type: 'mob', name: 'creeper', position: { x: 2, y: 64, z: 0 } };
  const bot = fakeBot({ threat: creeper });
  assert.strictEqual(fleeFrom(bot), true);
  assert.strictEqual(bot.calls.goals.length, 1);
  assert.strictEqual(bot.calls.goals[0].dyn, true);
});

test('fleeFrom retourne false si aucune menace', () => {
  assert.strictEqual(fleeFrom(fakeBot({ threat: null })), false);
});
