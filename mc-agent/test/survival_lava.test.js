'use strict';
// Fixes nuit fable1 (2026-07-11) :
//  - combat au bord de la lave → FUITE (ResBot3 « tried to swim in lava » pendant fight zombie) ;
//  - isFleeHostile exporté (garde anti faux-positif floating pendant le combat, mort ResBot1).
const { test } = require('node:test');
const assert = require('node:assert');
const { combatDecision, survivalTick, lavaNearby } = require('../survival');
const { isFleeHostile } = require('../skills/fleeFrom');

// --- combatDecision : lavaNear prime sur le courage ---

test('combatDecision: lave proche → flee même armé/en forme', () => {
  assert.strictEqual(combatDecision({ health: 20, hostileCount: 1, armored: true, hasCreeper: false, lavaNear: true }), 'flee');
});

test('combatDecision: sans lave → fight (rétro-compat, 1 hostile en forme)', () => {
  assert.strictEqual(combatDecision({ health: 20, hostileCount: 1, armored: true, hasCreeper: false, lavaNear: false }), 'fight');
});

test('combatDecision: lavaNear absent (appel historique) → comportement inchangé', () => {
  assert.strictEqual(combatDecision({ health: 20, hostileCount: 1, armored: true, hasCreeper: false }), 'fight');
});

test('combatDecision: calme (0 hostile) → null même avec lave', () => {
  assert.strictEqual(combatDecision({ health: 20, hostileCount: 0, lavaNear: true }), null);
});

// --- survivalTick : câblage lavaNear (injectable) ---

function mkPos(x, y, z) {
  return { x, y, z, distanceTo(o) { return Math.hypot(x - o.x, y - o.y, z - o.z); } };
}

function mkBot({ hostiles = [] } = {}) {
  const entities = {};
  hostiles.forEach((h, i) => { entities[i + 1] = h; });
  return {
    health: 20,
    food: 20,
    entity: { position: mkPos(0, 64, 0) },
    entities,
    inventory: { slots: new Array(45).fill(null), items: () => [] },
    equip: async () => {},
    consume: async () => {},
    pvp: { attack() { this.attacked = true; } },
    nearestEntity(fn) { return Object.values(entities).find(fn) || null; },
    blockAt: () => null,
  };
}

test('survivalTick: hostile + deps.lavaNear=true → flee avec reason lava_near', async () => {
  const bot = mkBot({ hostiles: [{ kind: 'Hostile mobs', name: 'zombie', position: mkPos(2, 64, 0) }] });
  const events = [];
  let fled = false;
  const r = await survivalTick(bot, { emit: (e) => events.push(e), fleeFrom: () => { fled = true; }, lavaNear: () => true });
  assert.strictEqual(r, 'flee');
  assert.ok(fled, 'fleeFrom doit être appelé');
  const ev = events.find((e) => e.type === 'survival' && e.action === 'flee');
  assert.ok(ev && ev.reason === 'lava_near', 'l\'event flee porte reason lava_near');
});

test('survivalTick: hostile + deps.lavaNear=false → fight (rétro-compat)', async () => {
  const bot = mkBot({ hostiles: [{ kind: 'Hostile mobs', name: 'zombie', position: mkPos(2, 64, 0) }] });
  const events = [];
  const r = await survivalTick(bot, { emit: (e) => events.push(e), fleeFrom: () => {}, lavaNear: () => false });
  assert.strictEqual(r, 'fight');
  assert.ok(events.some((e) => e.type === 'survival' && e.action === 'fight'));
});

// --- lavaNearby : scan borné, bot minimal ---

test('lavaNearby: détecte un bloc de lave adjacent', () => {
  const bot = {
    entity: { position: { x: 0.5, y: 64, z: 0.5 } },
    blockAt: (v) => (v.x === 1 && v.y === 64 && v.z === 0 ? { name: 'lava' } : { name: 'stone' }),
  };
  assert.strictEqual(lavaNearby(bot, 3), true);
});

test('lavaNearby: aucun bloc de lave → false', () => {
  const bot = {
    entity: { position: { x: 0.5, y: 64, z: 0.5 } },
    blockAt: () => ({ name: 'stone' }),
  };
  assert.strictEqual(lavaNearby(bot, 3), false);
});

// --- isFleeHostile (garde watchdog combat) ---

test('isFleeHostile: kind Hostile mobs → true ; creeper par nom → true ; vache/null → false', () => {
  assert.strictEqual(isFleeHostile({ kind: 'Hostile mobs', name: 'zombie' }), true);
  assert.strictEqual(isFleeHostile({ kind: 'Passive mobs', name: 'creeper' }), true);
  assert.strictEqual(isFleeHostile({ kind: 'Passive mobs', name: 'cow' }), false);
  assert.strictEqual(isFleeHostile(null), false);
});
