'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { nextLoiterAction, loiter } = require('../skills/loiter');

test('nextLoiterAction: mappe la valeur rng vers une catégorie', () => {
  assert.strictEqual(nextLoiterAction(() => 0.0).kind, 'look');
  assert.strictEqual(nextLoiterAction(() => 0.5).kind, 'step');
  assert.strictEqual(nextLoiterAction(() => 0.8).kind, 'sneak');
  assert.strictEqual(nextLoiterAction(() => 0.99).kind, 'idle');
});

test('loiter: retourne stop() qui réinitialise les contrôles', () => {
  const cleared = [];
  const bot = {
    entity: { position: { clone: () => ({ distanceTo: () => 0 }) } },
    look: () => {}, setControlState: (c, v) => { if (v === false) cleared.push(c); },
    pathfinder: { setGoal: () => {} },
  };
  const stop = loiter(bot, null, { rng: () => 0.99 }); // 'idle' → pas de timer cascade immédiate
  assert.strictEqual(typeof stop, 'function');
  stop();
  assert.ok(cleared.includes('sneak'));
});
