'use strict';
// Duel contre UN zombie (23/10, cf. fightBreaker.js) : armé, on se bat jusqu'à 6 PV au lieu de fuir sous
// 12 (ou 16 sans armure). Groupes, creeper, squelette, mappeur : inchangés.
const test = require('node:test');
const assert = require('node:assert');
const { combatDecision, survivalTick } = require('./survival');

test('combatDecision : duel zombie à 8 PV, nu, faim 10 → combat (avant : fuite)', () => {
  assert.strictEqual(combatDecision({ health: 8, hostileCount: 1, armored: false, canDealWith: 6, fightCount: 1, food: 10, duel: true }), 'fight');
  assert.strictEqual(combatDecision({ health: 8, hostileCount: 1, armored: false, canDealWith: 6, fightCount: 1, food: 10 }), 'flee');
});

test('combatDecision : duel sous 6 PV → fuite', () => {
  assert.strictEqual(combatDecision({ health: 5.5, hostileCount: 1, armored: true, canDealWith: 8, fightCount: 1, food: 20, duel: true }), 'flee');
});

test('combatDecision : le duel ne passe jamais devant creeper, lave, flee-only ni le mappeur', () => {
  assert.strictEqual(combatDecision({ health: 15, hostileCount: 1, hasCreeper: true, duel: true }), 'flee');
  assert.strictEqual(combatDecision({ health: 15, hostileCount: 1, lavaNear: true, duel: true }), 'flee');
  assert.strictEqual(combatDecision({ health: 15, hostileCount: 1, preferFlee: true, nearestDist: 6, duel: true }), 'flee');
});

function fakeBot(health, mobs, items) {
  const P = (x) => ({ x, y: -6, z: 0, distanceTo(o) { return Math.hypot(o.x - this.x, o.y - this.y, o.z - this.z); } });
  const ents = {};
  mobs.forEach(([name, d], i) => { ents[i] = { name, kind: 'Hostile mobs', position: P(d) }; });
  const calls = { attack: 0, canEngage: [] };
  return {
    calls,
    entity: { position: P(0) }, entities: ents, health, food: 20,
    time: { timeOfDay: 6000 },
    inventory: { slots: [], items: () => items },
    pvp: { attack: () => { calls.attack++; } },
    equip: async () => {},
    blockAt: () => null,
    pathfinder: { isMoving: () => false },
  };
}

test('survivalTick : un zombie à 9 PV avec épée de pierre → combat, canEngage reçoit duel:true', async () => {
  const bot = fakeBot(9, [['zombie', 2]], [{ name: 'stone_sword' }]);
  const r = await survivalTick(bot, {
    fleeFrom: () => true, lavaNear: () => false, now: () => 1e9,
    canEngage: (a) => { bot.calls.canEngage.push(a); return { ok: true }; },
  });
  assert.strictEqual(r, 'fight');
  assert.strictEqual(bot.calls.attack, 1);
  assert.strictEqual(bot.calls.canEngage[0].duel, true);
});

test('survivalTick : un zombie à 9 PV SANS arme → fuite (inchangé)', async () => {
  const bot = fakeBot(9, [['zombie', 2]], []);
  const r = await survivalTick(bot, { fleeFrom: () => true, lavaNear: () => false, now: () => 2e9 });
  assert.strictEqual(r, 'flee');
});

test('survivalTick : deux zombies à 9 PV avec épée → fuite (règle de groupe inchangée)', async () => {
  const bot = fakeBot(9, [['zombie', 2], ['zombie', 4]], [{ name: 'iron_sword' }]);
  const r = await survivalTick(bot, { fleeFrom: () => true, lavaNear: () => false, now: () => 3e9 });
  assert.strictEqual(r, 'flee');
});

test('survivalTick : un squelette à 9 PV avec épée → pas de duel (fuite)', async () => {
  const bot = fakeBot(9, [['skeleton', 3]], [{ name: 'iron_sword' }]);
  const r = await survivalTick(bot, { fleeFrom: () => true, lavaNear: () => false, now: () => 4e9 });
  assert.strictEqual(r, 'flee');
});
