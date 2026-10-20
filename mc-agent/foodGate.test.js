'use strict';
const test = require('node:test');
const assert = require('node:assert');
const G = require('./foodGate');

const T = 1_800_000_000_000;

test('descentFoodGate : 6 points ou plus → on descend', () => {
  const r = G.descentFoodGate({ points: 6, y: 70, refusals: [], now: T });
  assert.deepStrictEqual([r.allow, r.reason], [true, 'stocked']);
});

test('descentFoodGate : 0 point en surface → refus, horodatage ajouté (à persister)', () => {
  const r = G.descentFoodGate({ points: 0, y: 70, refusals: [], now: T });
  assert.deepStrictEqual([r.allow, r.reason, r.need], [false, 'gate', G.DESCENT_MIN_POINTS]);
  assert.deepStrictEqual(r.refusals, [T]);
});

test('descentFoodGate : 2 refus dans les 10 min → on descend quand même (pas de boucle en zone sans gibier)', () => {
  const r = G.descentFoodGate({ points: 0, y: 70, refusals: [T - 60000, T - 30000], now: T });
  assert.deepStrictEqual([r.allow, r.reason], [true, 'gate_spent']);
  const later = G.descentFoodGate({ points: 0, y: 70, refusals: [T - 11 * 60000, T - 10.5 * 60000], now: T });
  assert.strictEqual(later.allow, false, 'refus anciens expirés → la porte se referme');
});

test('descentFoodGate : déjà sous terre → jamais bloqué (la porte 2 prend le relais)', () => {
  const r = G.descentFoodGate({ points: 0, y: 30, refusals: [], now: T });
  assert.deepStrictEqual([r.allow, r.reason], [true, 'underground']);
});

test('undergroundFoodTripDue : sous terre, faim ≤ 8, rien en poche → oui ; sinon non', () => {
  assert.strictEqual(G.undergroundFoodTripDue({ y: 15, food: 8, foodItems: 0, now: T, lastTripAt: 0 }), true);
  assert.strictEqual(G.undergroundFoodTripDue({ y: 15, food: 9, foodItems: 0, now: T }), false);
  assert.strictEqual(G.undergroundFoodTripDue({ y: 15, food: 4, foodItems: 3, now: T }), false);
  assert.strictEqual(G.undergroundFoodTripDue({ y: 60, food: 4, foodItems: 0, now: T }), false);
});

test('undergroundFoodTripDue : cooldown propre de 4 min (pas de yo-yo surface/fond)', () => {
  assert.strictEqual(G.undergroundFoodTripDue({ y: 15, food: 2, foodItems: 0, now: T, lastTripAt: T - 60000 }), false);
  assert.strictEqual(G.undergroundFoodTripDue({ y: 15, food: 2, foodItems: 0, now: T, lastTripAt: T - G.UNDER_TRIP_COOLDOWN_MS }), true);
});

test('foodGateLoad : mémo absent ou malformé → état vide bien formé', () => {
  assert.deepStrictEqual(G.foodGateLoad(null), { refusals: [], lastUnderTripAt: 0 });
  assert.deepStrictEqual(G.foodGateLoad({ foodGate: { refusals: [1, 'x'], lastUnderTripAt: 5 } }), { refusals: [1], lastUnderTripAt: 5 });
});
