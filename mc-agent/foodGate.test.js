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

test('descentFoodGate : la chasse d\'avant n\'a vu AUCUNE proie → on descend tout de suite (refuser ne rapporte rien)', () => {
  const r = G.descentFoodGate({ points: 0, y: 70, refusals: [], now: T, noPrey: true });
  assert.deepStrictEqual([r.allow, r.reason], [true, 'no_prey']);
  assert.deepStrictEqual(r.refusals, [], 'aucun refus consommé ni persisté');
});

test('descentFoodGate : chasse ratée SUR du gibier vu (noPrey faux/absent) → le refus garde son sens', () => {
  assert.strictEqual(G.descentFoodGate({ points: 0, y: 70, refusals: [], now: T, noPrey: false }).allow, false);
  assert.strictEqual(G.descentFoodGate({ points: 0, y: 70, refusals: [], now: T }).allow, false);
});

// ── 23/10 (NethBot1 « starved to death » 15:40 UTC, NethBot3 15:45) : `food_gate need:6 points:0 allow:false`
// puis `allow:true reason:gate_spent` → descente à 0 point → mort de faim au fond, alors que `herds_seen`
// rapportait 6-12 bêtes toutes les 30 s. Un troupeau CONNU à ≤ 200 blocs = une vraie chance de manger :
// à 0 point, la porte ne se « dépense » plus (ni gate_spent, ni no_prey).
test('descentFoodGate : 0 point + troupeau connu à portée → JAMAIS gate_spent, on reste chercher à manger', () => {
  const r = G.descentFoodGate({ points: 0, y: 70, refusals: [T - 60000, T - 30000], now: T, herdNear: true });
  assert.deepStrictEqual([r.allow, r.reason], [false, 'herd_known']);
});

test('descentFoodGate : 0 point + troupeau connu → même une chasse « sans proie » ne fait pas descendre', () => {
  const r = G.descentFoodGate({ points: 0, y: 70, refusals: [], now: T, noPrey: true, herdNear: true });
  assert.deepStrictEqual([r.allow, r.reason], [false, 'herd_known']);
});

test('descentFoodGate : troupeau connu MAIS des points en poche, ou sous terre → règle d avant', () => {
  const spent = { y: 70, refusals: [T - 60000, T - 30000], now: T, herdNear: true };
  assert.deepStrictEqual([G.descentFoodGate(Object.assign({ points: 3 }, spent)).allow, G.descentFoodGate(Object.assign({ points: 3 }, spent)).reason], [true, 'gate_spent']);
  assert.strictEqual(G.descentFoodGate({ points: 0, y: 20, refusals: [], now: T, herdNear: true }).reason, 'underground');
  assert.strictEqual(G.descentFoodGate({ points: 0, y: 70, refusals: [T - 60000, T - 30000], now: T, herdNear: false }).reason, 'gate_spent');
});

test('descentFoodGate : refus « troupeau connu » horodatés (traçables) sans jamais ouvrir la porte', () => {
  const r = G.descentFoodGate({ points: 0, y: 70, refusals: [T - 1000, T - 2000, T - 3000], now: T, herdNear: true });
  assert.strictEqual(r.allow, false);
  assert.ok(r.refusals.length >= 3);
});

// ── borne de la porte « troupeau connu » (pas d'arrêt d'1 h en surface devant une bête injoignable) ──
test('descentFoodGate : 6 refus en 10 min → la porte troupeau s ouvre (herd_gate_spent)', () => {
  const refusals = [1, 2, 3, 4, 5, 6].map((k) => T - k * 30000);
  const r = G.descentFoodGate({ points: 0, y: 70, refusals, now: T, herdNear: true });
  assert.deepStrictEqual([r.allow, r.reason], [true, 'herd_gate_spent']);
  assert.strictEqual(G.HERD_GATE_MAX_REFUSALS, 6);
  const r5 = G.descentFoodGate({ points: 0, y: 70, refusals: refusals.slice(0, 5), now: T, herdNear: true });
  assert.deepStrictEqual([r5.allow, r5.reason], [false, 'herd_known']);
});

test('descentFoodGate : refus vieux de plus de 10 min ne comptent pas', () => {
  const refusals = [1, 2, 3, 4, 5, 6].map((k) => T - G.GATE_WINDOW_MS - k * 1000);
  assert.strictEqual(G.descentFoodGate({ points: 0, y: 70, refusals, now: T, herdNear: true }).reason, 'herd_known');
});

test('descentFoodGate : le troupeau visé est déjà marqué raté → herd_gate_spent (on descend avec ce qu on a)', () => {
  const r = G.descentFoodGate({ points: 0, y: 70, refusals: [], now: T, herdNear: true, herdTried: true });
  assert.deepStrictEqual([r.allow, r.reason], [true, 'herd_gate_spent']);
});

// ── 24/10 : mineurs coincés en surface (descend_y54 food_gate ×20 / ×8) ──
test('descentFoodGate : un repas en poche + 1 refus → on descend (some_food)', () => {
  const r = G.descentFoodGate({ points: 3, y: 70, refusals: [T - 60000], now: T });
  assert.deepStrictEqual([r.allow, r.reason], [true, 'some_food']);
  const r0 = G.descentFoodGate({ points: 3, y: 70, refusals: [], now: T });
  assert.deepStrictEqual([r0.allow, r0.reason], [false, 'gate']);
});
test('descentFoodGate : 8 refus en 30 min → on descend même à 0 point (troupeau connu compris)', () => {
  const refusals = [1, 2, 3, 4, 5, 6, 7, 8].map((k) => T - k * 3 * 60000);
  const r = G.descentFoodGate({ points: 0, y: 70, refusals, now: T, herdNear: true });
  assert.deepStrictEqual([r.allow, r.reason], [true, 'gate_long_spent']);
});
test('descentFoodGate : les refus persistés couvrent la fenêtre longue', () => {
  const r = G.descentFoodGate({ points: 0, y: 70, refusals: [T - 20 * 60000], now: T, herdNear: true });
  assert.strictEqual(r.allow, false);
  assert.strictEqual(r.refusals.length, 2);
});

// ─── Surface stérile (25/10) ────────────────────────────────────────────────────────────────────
{
  const G2 = require('./foodGate');
  const base = { y: 70, now: 1e12, refusals: [] };
  test('surface stérile : aucun animal en vue + dernier troupeau bredouille → descend (plus de herd_known)', () => {
    const r = G2.descentFoodGate(Object.assign({}, base, { points: 0, hunger: 8, herdNear: true, animalsInView: false, herdBarren: true }));
    assert.strictEqual(r.allow, true);
    assert.strictEqual(r.reason, 'barren_surface');
  });
  test('surface stérile : aucun animal + aucun troupeau connu, faim 6 → descend (plus de starving)', () => {
    const r = G2.descentFoodGate(Object.assign({}, base, { points: 0, hunger: 6, animalsInView: false }));
    assert.strictEqual(r.reason, 'barren_surface');
  });
  test('surface stérile : garde-fou anti-famine — faim ≤ 4 à 0 point → refus starving', () => {
    const r = G2.descentFoodGate(Object.assign({}, base, { points: 0, hunger: 4, animalsInView: false, herdBarren: true }));
    assert.strictEqual(r.allow, false);
    assert.strictEqual(r.reason, 'starving');
  });
  test('surface stérile : de la chair de zombie en poche, faim 3 → descend (ce n est plus la famine à sec)', () => {
    const r = G2.descentFoodGate(Object.assign({}, base, { points: 2, hunger: 3, animalsInView: false }));
    assert.strictEqual(r.allow, true);
  });
  test('animaux EN VUE ou troupeau connu pas encore bredouille → règles d avant', () => {
    assert.strictEqual(G2.descentFoodGate(Object.assign({}, base, { points: 0, hunger: 8, herdNear: true, animalsInView: true, herdBarren: true })).reason, 'herd_known');
    assert.strictEqual(G2.descentFoodGate(Object.assign({}, base, { points: 0, hunger: 8, herdNear: true, animalsInView: false, herdBarren: false })).reason, 'herd_known');
    assert.strictEqual(G2.descentFoodGate(Object.assign({}, base, { points: 0, hunger: 8, herdNear: true })).reason, 'herd_known', 'inconnu = avant');
  });
}
