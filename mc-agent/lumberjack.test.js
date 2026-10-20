'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('./lumberjack');

const NOW = 1_800_000_000_000;
const mate = (name, o = {}) => Object.assign({ name, x: 0, z: 0, role: 'worker', at: NOW - 1000, armor: 0 }, o);

test('isWoodGoal : seuls les buts gatherLog', () => {
  assert.strictEqual(L.isWoodGoal({ name: 'logs', skill: 'gatherLog' }), true);
  assert.strictEqual(L.isWoodGoal({ name: 'gift_planks', skill: 'gatherLog' }), true);
  assert.strictEqual(L.isWoodGoal({ name: 'planks', skill: 'craftPlanks' }), false);
  assert.strictEqual(L.isWoodGoal(null), false);
});

test('woodWantFor : plancher 16, plafond 32', () => {
  assert.strictEqual(L.woodWantFor({ args: { count: 3 } }), 16);
  assert.strictEqual(L.woodWantFor({ args: { count: 24 } }), 24);
  assert.strictEqual(L.woodWantFor({ args: { count: 99 } }), 32);
  assert.strictEqual(L.woodWantFor({}), 16);
});

test('logCount : toutes essences, ignore le reste', () => {
  assert.strictEqual(L.logCount({ oak_log: 3, birch_log: 2, oak_planks: 9, stripped_oak_log: 1 }), 6);
  assert.strictEqual(L.logCount(null), 0);
});

test('activeLumberjack : rôle lumberjack FRAIS, jamais soi-même', () => {
  const mates = [mate('A'), mate('B', { role: 'lumberjack' })];
  assert.strictEqual(L.activeLumberjack({ mates, selfName: 'A', now: NOW }), 'B');
  assert.strictEqual(L.activeLumberjack({ mates, selfName: 'B', now: NOW }), null);
  const stale = [mate('B', { role: 'lumberjack', at: NOW - L.LUMBERJACK_FRESH_MS - 1 })];
  assert.strictEqual(L.activeLumberjack({ mates: stale, selfName: 'A', now: NOW }), null);
});

test('woodWaitDecision : bûcheron/mappeur/sans bûcheron → self', () => {
  assert.strictEqual(L.woodWaitDecision({ isLumberjack: true, lumberjack: 'B', now: NOW }).action, 'self');
  assert.strictEqual(L.woodWaitDecision({ isMapper: true, lumberjack: 'B', now: NOW }).action, 'self');
  const d = L.woodWaitDecision({ lumberjack: null, request: { want: 16, at: NOW - 1000 }, now: NOW });
  assert.strictEqual(d.action, 'self');
  assert.strictEqual(d.clear, true, 'une demande sans bûcheron est retirée');
});

test('woodWaitDecision : première fois → request, puis wait, puis timeout à 4 min', () => {
  assert.strictEqual(L.woodWaitDecision({ lumberjack: 'B', request: null, now: NOW }).action, 'request');
  const w = L.woodWaitDecision({ lumberjack: 'B', request: { want: 16, at: NOW - 60000 }, now: NOW });
  assert.strictEqual(w.action, 'wait');
  assert.strictEqual(w.remainingMs, L.WOOD_REQUEST_TTL_MS - 60000);
  const t = L.woodWaitDecision({ lumberjack: 'B', request: { want: 16, at: NOW - L.WOOD_REQUEST_TTL_MS }, now: NOW });
  assert.strictEqual(t.action, 'timeout');
});

test('woodWaitDecision : demande PÉRIMÉE (process d\'il y a longtemps) → nouvelle demande, pas un faux timeout', () => {
  const d = L.woodWaitDecision({ lumberjack: 'B', request: { want: 16, at: NOW - 3 * L.WOOD_REQUEST_TTL_MS }, now: NOW });
  assert.strictEqual(d.action, 'request');
});

test('woodWaitDecision : après un timeout, 10 min d\'autonomie bois', () => {
  const d = L.woodWaitDecision({ lumberjack: 'B', request: null, timedOutAt: NOW - 60000, now: NOW });
  assert.strictEqual(d.action, 'self');
  const d2 = L.woodWaitDecision({ lumberjack: 'B', request: null, timedOutAt: NOW - L.WOOD_REQUEST_COOLDOWN_MS, now: NOW });
  assert.strictEqual(d2.action, 'request');
});

test('preferredLumberjack : le mieux armé, nom en départage, jamais un mappeur', () => {
  const mates = [mate('NethBot2', { armor: 1 }), mate('NethBot3', { armor: 4 }), mate('MapBot1', { role: 'mapper', armor: 4 }),
    mate('NethBot1', { armor: 4 })];
  assert.strictEqual(L.preferredLumberjack({ selfName: 'NethBot2', selfArmor: 1, mates, now: NOW }), 'NethBot1');
  // présence périmée exclue
  const m2 = [mate('NethBot1', { armor: 4, at: NOW - L.LUMBERJACK_FRESH_MS - 5 }), mate('NethBot3', { armor: 4 })];
  assert.strictEqual(L.preferredLumberjack({ selfName: 'NethBot2', selfArmor: 1, mates: m2, now: NOW }), 'NethBot3');
});

test('preferredLumberjack : pas d\'élection si je suis le seul ouvrier', () => {
  const mates = [mate('MapBot1', { role: 'mapper' })];
  assert.strictEqual(L.preferredLumberjack({ selfName: 'NethBot1', selfArmor: 4, mates, now: NOW }), null);
});

test('preferredLumberjack : soi compte avec SON armure, pas celle publiée il y a 60 s', () => {
  const mates = [mate('NethBot1', { armor: 2 }), mate('NethBot2', { armor: 0 })];
  assert.strictEqual(L.preferredLumberjack({ selfName: 'NethBot2', selfArmor: 3, mates, now: NOW }), 'NethBot2');
});

test('lumberjackVerdict : claim à un autre frais → follower ; à moi → keep ; libre → claim si préféré', () => {
  const base = { selfName: 'A', now: NOW };
  assert.strictEqual(L.lumberjackVerdict({ ...base, holder: { by: 'B', at: NOW - 1000 }, preferred: 'A' }), 'follower');
  assert.strictEqual(L.lumberjackVerdict({ ...base, holder: { by: 'A', at: NOW - 1000 }, preferred: 'B' }), 'keep');
  assert.strictEqual(L.lumberjackVerdict({ ...base, holder: null, preferred: 'A' }), 'claim');
  assert.strictEqual(L.lumberjackVerdict({ ...base, holder: null, preferred: 'B' }), 'follower');
  // sticky : déjà bûcheron, claim perdue (expirée) → on la reprend même si un autre serait préféré
  assert.strictEqual(L.lumberjackVerdict({ ...base, holder: null, preferred: 'B', amLumberjack: true }), 'claim');
  // plus aucun coéquipier (preferred null) : un bûcheron rend le rôle
  assert.strictEqual(L.lumberjackVerdict({ ...base, holder: { by: 'A', at: NOW }, preferred: null, amLumberjack: true }), 'release');
});

test('pickWoodRequest : la demande la plus ANCIENNE, quantité bornée par stock − réserve', () => {
  const mates = [
    mate('B', { woodWant: 16, woodAt: NOW - 30000 }),
    mate('C', { woodWant: 24, woodAt: NOW - 90000 }),
    mate('D'),
  ];
  assert.deepStrictEqual(L.pickWoodRequest({ mates, selfName: 'A', now: NOW, stock: 48 }), { to: 'C', amount: 24, want: 24 });
  assert.deepStrictEqual(L.pickWoodRequest({ mates, selfName: 'A', now: NOW, stock: 20 }), { to: 'C', amount: 12, want: 24 });
  // stock trop maigre pour un don utile
  assert.strictEqual(L.pickWoodRequest({ mates, selfName: 'A', now: NOW, stock: 11 }), null);
  // déjà servi / réservé
  assert.deepStrictEqual(L.pickWoodRequest({ mates, selfName: 'A', now: NOW, stock: 48, skip: new Set(['C']) }), { to: 'B', amount: 16, want: 16 });
});

test('pickWoodRequest : demandes expirées, mappeurs et soi-même ignorés', () => {
  const mates = [
    mate('B', { woodWant: 16, woodAt: NOW - L.WOOD_REQUEST_TTL_MS - 1 }),
    mate('M', { role: 'mapper', woodWant: 16, woodAt: NOW - 1000 }),
    mate('A', { woodWant: 16, woodAt: NOW - 1000 }),
    mate('E', { woodWant: 16, woodAt: NOW - 1000, at: NOW - L.LUMBERJACK_FRESH_MS - 1 }),
  ];
  assert.strictEqual(L.pickWoodRequest({ mates, selfName: 'A', now: NOW, stock: 48 }), null);
});

test('tossPlan : répartit la quantité sur les piles de bûches', () => {
  const items = [{ name: 'oak_log', type: 1, count: 10 }, { name: 'stone', type: 2, count: 64 }, { name: 'birch_log', type: 3, count: 20 }];
  assert.deepStrictEqual(L.tossPlan(items, 16), [{ type: 1, name: 'oak_log', count: 10 }, { type: 3, name: 'birch_log', count: 6 }]);
  assert.deepStrictEqual(L.tossPlan(items, 0), []);
});
