'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { attackNearest } = require('../skills/attackNearest');

function fakeBot({ entity = null } = {}) {
  const calls = { attacked: [], chat: [] };
  return {
    calls,
    nearestEntity(pred) { return (entity && pred(entity)) ? entity : null; },
    pvp: { attack(e) { calls.attacked.push(e); } },
    chat(m) { calls.chat.push(m); },
  };
}

test('attackNearest attaque un mob hostile proche et retourne true', () => {
  const zombie = { type: 'mob', name: 'zombie', kind: 'Hostile mobs' };
  const bot = fakeBot({ entity: zombie });
  assert.strictEqual(attackNearest(bot), true);
  assert.strictEqual(bot.calls.attacked[0], zombie);
});

test('attackNearest prévient et retourne false si rien à attaquer', () => {
  const bot = fakeBot({ entity: null });
  assert.strictEqual(attackNearest(bot), false);
  assert.strictEqual(bot.calls.chat.length, 1);
});
