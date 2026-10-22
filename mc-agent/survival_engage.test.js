'use strict';
// Règle d'engagement (22/10) : ≥ 2 hostiles exige 18 PV, 1 hostile refusé sous 12 — quelle que soit
// l'heure et l'armure. Les cartographes (preferFlee) gardent leur fuite par défaut.
const test = require('node:test');
const assert = require('node:assert');
const { combatDecision, survivalTick } = require('./survival');

test('combatDecision : 2 hostiles à 14,12 PV en armure, canDealWith 8 → fuite (signature live)', () => {
  const d = combatDecision({ health: 14.12, hostileCount: 2, armored: true, canDealWith: 8, fightCount: 2, night: false, food: 20, capability: 4 });
  assert.strictEqual(d, 'flee');
});

test('combatDecision : 2 hostiles à 18 PV en armure → combat', () => {
  assert.strictEqual(combatDecision({ health: 18, hostileCount: 2, armored: true, canDealWith: 8, fightCount: 2, food: 20 }), 'fight');
});

test('combatDecision : 1 hostile sous 12 PV → fuite, 1 hostile à 12 → comportement actuel', () => {
  assert.strictEqual(combatDecision({ health: 11.5, hostileCount: 1, armored: true, canDealWith: 8, fightCount: 1, food: 20 }), 'flee');
  assert.strictEqual(combatDecision({ health: 12, hostileCount: 1, armored: true, canDealWith: 8, fightCount: 1, food: 20 }), 'fight');
});

test('combatDecision : le mappeur garde sa fuite par défaut / sa riposte à portée', () => {
  assert.strictEqual(combatDecision({ health: 14, hostileCount: 2, preferFlee: true, nearestDist: 2 }), 'fight');
  assert.strictEqual(combatDecision({ health: 20, hostileCount: 1, preferFlee: true, nearestDist: 6 }), 'flee');
});

function fakeBot(health, hostiles) {
  const pos = { x: 0, y: -6, z: 0, distanceTo(o) { return Math.hypot(o.x - this.x, o.y - this.y, o.z - this.z); } };
  const ents = {};
  hostiles.forEach((d, i) => {
    ents[i] = { name: 'zombie', kind: 'Hostile mobs', position: { x: d, y: -6, z: 0, distanceTo(o) { return Math.hypot(o.x - this.x, o.y - this.y, o.z - this.z); } } };
  });
  const calls = { attack: 0 };
  return {
    calls,
    entity: { position: pos }, entities: ents, health, food: 20,
    time: { timeOfDay: 6000 },
    inventory: { slots: [], items: () => [] },
    pvp: { attack: () => { calls.attack++; } },
    equip: async () => {},
    blockAt: () => null,
    pathfinder: { isMoving: () => false },
  };
}

test('survivalTick : canEngage refuse → fuite, aucune attaque, event fight_refused', async () => {
  const bot = fakeBot(20, [2]);
  const evs = [];
  let fled = 0;
  const r = await survivalTick(bot, {
    emit: (e) => evs.push(e), fleeFrom: () => { fled++; return true; }, lavaNear: () => false,
    canEngage: () => ({ ok: false, reason: 'cooldown' }), now: () => 1e9,
  });
  assert.strictEqual(r, 'flee');
  assert.strictEqual(bot.calls.attack, 0);
  assert.strictEqual(fled, 1);
  assert.ok(evs.some((e) => e.type === 'survival' && e.action === 'flee' && e.reason === 'cooldown'));
});

test('survivalTick : canEngage accepte → combat inchangé', async () => {
  const bot = fakeBot(20, [2]);
  const r = await survivalTick(bot, {
    emit: () => {}, fleeFrom: () => true, lavaNear: () => false,
    canEngage: () => ({ ok: true }), now: () => 2e9,
  });
  assert.strictEqual(r, 'fight');
  assert.strictEqual(bot.calls.attack, 1);
});
