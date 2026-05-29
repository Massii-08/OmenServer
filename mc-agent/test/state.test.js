'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { snapshot } = require('../state');

function fakePos(x, y, z) {
  return { x, y, z, distanceTo(o) { return Math.hypot(x - o.x, y - o.y, z - o.z); } };
}

test('snapshot retourne vie, faim, position, joueurs et mobs proches triés', () => {
  const selfPos = fakePos(0, 64, 0);
  const bot = {
    username: 'Bot',
    health: 18,
    food: 15,
    entity: { position: selfPos },
    players: { Bot: {}, Massii: {}, Alice: {} },
    entities: {
      1: { type: 'mob', name: 'zombie', position: fakePos(10, 64, 0) },
      2: { type: 'mob', name: 'creeper', position: fakePos(3, 64, 0) },
      3: { type: 'player', name: 'Massii', position: fakePos(1, 64, 0) },
    },
  };
  const s = snapshot(bot);
  assert.strictEqual(s.username, 'Bot');
  assert.strictEqual(s.health, 18);
  assert.strictEqual(s.food, 15);
  assert.deepStrictEqual(s.position, { x: 0, y: 64, z: 0 });
  assert.deepStrictEqual(s.players.sort(), ['Alice', 'Massii']); // pas le bot lui-même
  assert.strictEqual(s.nearbyMobs[0].name, 'creeper'); // le plus proche d'abord
  assert.strictEqual(s.nearbyMobs.length, 2); // les players exclus des mobs
});
