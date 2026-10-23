'use strict';
// Duel contre UN zombie (23/10, cf. fightBreaker.js) : la fuite réflexe « PV bas » relevée par la faim
// (6 → 8) ne s'applique plus en duel — on riposte jusqu'à 6 PV. Mesure : `reflex flee` sans raison à
// 6-12 PV sous terre contre un zombie → mort 7 fois sur 7 (6 h de sessions mineurs).
const { test } = require('node:test');
const assert = require('node:assert');
const { installReflexes, shouldFlee } = require('./reflexes');

function zombieBot({ health, food = 15 }) {
  const ents = [{ type: 'mob', name: 'zombie', position: { x: 1, y: 30, z: 0, distanceTo: (p) => Math.abs(1 - p.x) } }];
  return {
    health, food,
    entity: { position: { x: 0, y: 30, z: 0 } },
    on: () => {},
    pathfinder: { setGoal: () => {} },
    setControlState: () => {},
    inventory: { items: () => [] },
    nearestEntity: (pred) => ents.find(pred) || null,
  };
}

test('shouldFlee : 7 PV affamé → fuite, sauf en duel (seuil 6 sans marge)', () => {
  assert.strictEqual(shouldFlee(zombieBot({ health: 7 })), true);
  assert.strictEqual(shouldFlee(zombieBot({ health: 7 }), { duel: true }), false);
  assert.strictEqual(shouldFlee(zombieBot({ health: 5.5 }), { duel: true }), true);
});

function run(isDuel) {
  const bot = zombieBot({ health: 9 });
  const calls = { flee: 0, attack: 0 };
  const { react } = installReflexes(bot, {
    emit: () => {}, fleeFrom: () => { calls.flee++; }, attack: () => { calls.attack++; },
    isDuel, now: () => 100000,
  });
  react();             // 9 PV : rien
  bot.health = 7;      // frappé
  react();
  return calls;
}

test('réflexe : frappé à 7 PV par un zombie seul → riposte en duel, fuite sinon', () => {
  assert.deepStrictEqual(run(() => true), { flee: 0, attack: 1 });
  assert.deepStrictEqual(run(undefined), { flee: 1, attack: 0 });
  assert.deepStrictEqual(run(() => { throw new Error('x'); }), { flee: 1, attack: 0 });   // erreur → pas de duel
});
