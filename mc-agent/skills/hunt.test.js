'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { huntPassive } = require('./hunt');

const at = (x) => ({ x, y: 64, z: 0, distanceTo(o) { return Math.abs(this.x - o.x); } });
function fakeBot(entities) {
  const attacked = [];
  return {
    attacked,
    entity: { position: at(0) },
    nearestEntity: (f) => entities.filter(f).sort((a, b) => Math.abs(a.position.x) - Math.abs(b.position.x))[0] || null,
    equip: async () => {},
    pvp: { attack: (e) => { attacked.push(e.name); e.isValid = false; }, stop() {} },
  };
}

test('huntPassive names:[sheep] : ignore la vache plus proche, tue le mouton (laine du lit)', async () => {
  const bot = fakeBot([{ name: 'cow', position: at(3), isValid: true }, { name: 'sheep', position: at(10), isValid: true }]);
  const r = await huntPassive(bot, { count: 1, maxDistance: 32, names: ['sheep'] }, null, { sleep: async () => {}, goto: async () => {}, pickupMs: 0 });
  assert.deepStrictEqual(bot.attacked, ['sheep']);
  assert.strictEqual(r.kills, 1);
});

test('huntPassive sans names : comportement historique (le passif le plus proche)', async () => {
  const bot = fakeBot([{ name: 'cow', position: at(3), isValid: true }, { name: 'sheep', position: at(10), isValid: true }]);
  await huntPassive(bot, { count: 1 }, null, { sleep: async () => {}, goto: async () => {}, pickupMs: 0 });
  assert.deepStrictEqual(bot.attacked, ['cow']);
});

test('huntPassive names:[sheep] : mouton hors rayon → 0 kill', async () => {
  const bot = fakeBot([{ name: 'sheep', position: at(60), isValid: true }]);
  const r = await huntPassive(bot, { count: 1, maxDistance: 48, names: ['sheep'] }, null, { sleep: async () => {} });
  assert.strictEqual(r.kills, 0);
});
