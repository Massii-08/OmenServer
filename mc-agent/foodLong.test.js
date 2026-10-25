'use strict';
// SORTIE LONGUE DE DERNIER RECOURS + PLEIN AU TROUPEAU + PORTE « AFFAMÉ » (run 24/10, monde de 22 h,
// Hard : 11 morts de mineurs en 35 min dont 3 famines ; `food_trip_done {got:0, arrived:false,
// aborted:true}` au bout des 75 s, la même cible re-visée à chaque tour).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const T = require('./foodTrip');
const G = require('./foodGate');
const { runHuntCook } = require('./foodRun');
const { pickFood, eatWanted } = require('./reflexes');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const MIN = 60000;

// ─── purs ───────────────────────────────────────────────────────────────────────────────────────
test('longTripDue : poche à 0 + sortie courte ratée < 30 min + pas de longue depuis 10 min', () => {
  const now = 100 * MIN;
  assert.strictEqual(T.longTripDue({ points: 0, shortFailAt: now - 5 * MIN, longAt: 0, now }), true);
  assert.strictEqual(T.longTripDue({ points: 2, shortFailAt: now - 5 * MIN, longAt: 0, now }), false, 'un repas en poche : pas de longue');
  assert.strictEqual(T.longTripDue({ points: 0, shortFailAt: 0, longAt: 0, now }), false, 'aucune courte ratée : la courte d abord');
  assert.strictEqual(T.longTripDue({ points: 0, shortFailAt: now - 31 * MIN, longAt: 0, now }), false, 'échec trop vieux');
  assert.strictEqual(T.longTripDue({ points: 0, shortFailAt: now - 5 * MIN, longAt: now - 3 * MIN, now }), false, 'cooldown de la longue');
  assert.strictEqual(T.longTripDue({ points: 0, shortFailAt: now - 5 * MIN, longAt: now - 11 * MIN, now }), true);
  assert.strictEqual(T.longTripDue({ points: null, shortFailAt: now - 5 * MIN, now }), false, 'pas de donnée ≠ 0 point');
});

test('longTripRecord / longTripLoad : persistance (mémo de base), horodatage futur écarté', () => {
  const now = 50 * MIN;
  let st = T.longTripRecord(undefined, { long: false, failed: true }, now);
  assert.deepStrictEqual(st, { shortFailAt: now, longAt: 0 });
  st = T.longTripRecord(st, { long: true, failed: true }, now + MIN);
  assert.deepStrictEqual(st, { shortFailAt: now, longAt: now + MIN });
  st = T.longTripRecord(st, { long: false, failed: false, got: 8 }, now + 2 * MIN);
  assert.strictEqual(st.shortFailAt, 0, 'une expédition qui rapporte efface l échec');
  assert.deepStrictEqual(T.longTripLoad({ [T.FOOD_TRIP_LONG_MEMO_KEY]: { shortFailAt: now + 10 * MIN } }, now), { shortFailAt: 0, longAt: 0 });
});

test('tripFailed : la marche COMPLÈTE sans arriver puis coupée compte comme un échec de la cible', () => {
  assert.strictEqual(T.tripFailed({ kills: 0, got: 0, aborted: true, walked: true, arrived: false }), true, 'le cas du 24/10');
  assert.strictEqual(T.tripFailed({ kills: 0, got: 0, aborted: true, walked: false, arrived: false }), false, 'coupée en route');
  assert.strictEqual(T.tripFailed({ kills: 0, got: 0, aborted: true, walked: true, arrived: true }), false, 'arrivée puis coupée : la cible n est pas en cause');
  assert.strictEqual(T.tripFailed({ kills: 0, got: 0, aborted: false }), true);
  assert.strictEqual(T.tripFailed({ kills: 1, got: 0, aborted: false }), true, '25/10 : un kill sans viande ne sauve pas la cible');
  assert.strictEqual(T.tripFailed({ kills: 4, got: 0, aborted: false, walked: true, arrived: true }), true, 'le cas du 25/10');
  assert.strictEqual(T.tripFailed({ kills: 1, got: 3, aborted: false }), false);
});

test('tripLimits : la longue = 4 min, 400 blocs ; le garde-fou des appelants couvre marche + plein', () => {
  const l = T.tripLimits(true);
  assert.deepStrictEqual([l.ms, l.maxDist, l.long], [240000, 400, true]);
  assert.ok(T.FOOD_TRIP_LEG_MS * l.maxLegs > l.ms, 'la longue est bornée par le temps, pas par le nombre de jambes');
  assert.strictEqual(T.tripLimits(false).ms, T.FOOD_TRIP_MS);
  assert.ok(T.FOOD_TRIP_MS + T.FOOD_TRIP_LONG_EXTRA_MS >= T.FOOD_TRIP_LONG_MS + T.TRIP_FILL_HUNT_MS);
});

// ─── porte de descente ──────────────────────────────────────────────────────────────────────────
test('porte : faim ≤ 6 et poche vide en surface → on ne descend pas (sortie longue d abord), même fenêtre longue dépensée', () => {
  const now = 100 * MIN;
  const many = Array.from({ length: 9 }, (_, i) => now - (i + 1) * MIN);   // ≥ 8 refus/30 min : gate_long_spent d'avant
  const r = G.descentFoodGate({ points: 0, y: 70, hunger: 5, refusals: many, now, longTripAt: 0 });
  assert.strictEqual(r.allow, false);
  assert.strictEqual(r.reason, 'starving');
});

test('porte : après une sortie longue tentée (< 15 min), on reprend les règles habituelles', () => {
  const now = 100 * MIN;
  const r = G.descentFoodGate({ points: 0, y: 70, hunger: 5, refusals: [], now, longTripAt: now - 5 * MIN, noPrey: true });
  assert.strictEqual(r.allow, true);
  assert.strictEqual(r.reason, 'no_prey');
});

test('porte : bornée — au-delà de 16 refus en 30 min on descend quand même', () => {
  const now = 100 * MIN;
  const refusals = Array.from({ length: 16 }, (_, i) => now - (i + 1) * 60000);
  const r = G.descentFoodGate({ points: 0, y: 70, hunger: 4, refusals, now });
  assert.strictEqual(r.allow, true);
  assert.strictEqual(r.reason, 'starving_spent');
});

test('porte : faim 9 ou 2 points en poche → la règle « affamé » ne s applique pas (inchangé)', () => {
  const now = 100 * MIN;
  assert.notStrictEqual(G.descentFoodGate({ points: 0, y: 70, hunger: 9, refusals: [], now }).reason, 'starving');
  assert.notStrictEqual(G.descentFoodGate({ points: 2, y: 70, hunger: 4, refusals: [now - MIN], now }).reason, 'starving');
  assert.strictEqual(G.descentFoodGate({ points: 0, y: 20, hunger: 4, refusals: [], now }).reason, 'underground');
});

// ─── orchestration (dépendances fausses, horloge fausse) ───────────────────────────────────────
function world(over = {}) {
  const c = { t: 1000 };
  const w = {
    inv: {}, passive: false, passiveAfterWalk: true, calls: [], events: [], tried: [], outcomes: [],
    state: { isDay: true, y: 70, migrating: false, ordered: false, busy: false, tripBusy: false, longDue: false },
    cell: { x: 300, z: 0, biome: 'herd', dist: 300, herd: true },
    walkResult: { ok: true, arrived: true, legs: 6 },
    huntGives: { beef: 3 }, fill: true,
    ...over,
  };
  w.deps = {
    now: () => c.t, token: { cancelled: false },
    inventory: () => w.inv,
    passiveInView: () => w.passive,
    hunt: async (o) => {
      w.calls.push('hunt'); c.t += Math.min(20000, o.ms);
      for (const k of Object.keys(w.huntGives)) w.inv[k] = (w.inv[k] || 0) + w.huntGives[k];
      return { ok: true, kills: 1 };
    },
    rawStacks: () => [], hasFurnace: () => false, cook: async () => 0,
    hasRod: () => false, fish: async () => ({ ok: false, caught: 0, reason: 'no_water' }),
    emit: (e) => w.events.push(e),
    tripState: () => Object.assign({}, w.state),
    grazingCell: (o) => { w.calls.push(['cell', o]); return w.cell; },
    tripLock: () => true, tripUnlock: () => {},
    tripWalk: async (o) => { w.calls.push(['walk', o.ms, o.maxLegs]); c.t += 30000; w.passive = w.passiveAfterWalk; return w.walkResult; },
    tripTried: (cell) => w.tried.push(cell),
    tripOutcome: (o) => w.outcomes.push(o),
    tripFill: w.fill,
  };
  return w;
}

test('sortie longue due → marche de 4 min, portée 400, event food_trip long:true', async () => {
  const w = world({ state: Object.assign(world().state, { longDue: true }) });
  await runHuntCook(w.deps, 6);
  const cell = w.calls.find((x) => Array.isArray(x) && x[0] === 'cell');
  assert.deepStrictEqual(cell[1], { long: true, maxDist: 400 });
  const walk = w.calls.find((x) => Array.isArray(x) && x[0] === 'walk');
  assert.deepStrictEqual([walk[1], walk[2]], [240000, T.FOOD_TRIP_LONG_MAX_LEGS]);
  const ev = w.events.find((e) => e.type === 'food_trip');
  assert.strictEqual(ev.long, true);
  assert.ok(w.outcomes.length === 1 && w.outcomes[0].long === true, 'longAt persisté par index.js');
});

test('arrivé au troupeau → on fait le PLEIN (≥ 20 points, plusieurs vagues), pas un repas', async () => {
  const w = world();
  const r = await runHuntCook(w.deps, 4);      // but historique 12 points
  const hunts = w.calls.filter((x) => x === 'hunt').length;
  assert.ok(hunts >= 3, `${hunts} vagues`);
  assert.ok(r.got >= 20, `plein atteint : ${r.got} points`);
});

test('sans la dep tripFill : comportement d avant (une vague)', async () => {
  const w = world({ fill: false });
  await runHuntCook(w.deps, 4);
  assert.strictEqual(w.calls.filter((x) => x === 'hunt').length, 1);
});

test('marche complète sans arriver puis coupée → la cible est écartée et l échec court persisté', async () => {
  const w = world({ walkResult: { ok: true, arrived: false, legs: 8 }, passiveAfterWalk: false });
  // la tâche est annulée pendant la marche (cas live du 24/10)
  const walk = w.deps.tripWalk;
  w.deps.tripWalk = async (o) => { const r = await walk(o); w.deps.token.cancelled = true; return r; };
  const r = await runHuntCook(w.deps, 6);
  assert.strictEqual(r.reason, 'cancelled');
  assert.strictEqual(w.tried.length, 1, 'la cible ne sera plus re-visée au tour suivant');
  assert.strictEqual(w.outcomes[0].failed, true);
  assert.strictEqual(w.outcomes[0].long, false);
  const done = w.events.find((e) => e.type === 'food_trip_done');
  assert.strictEqual(done.aborted, true);
});

test('longue due mais rien à viser → notée tentée (la porte de descente ne retient pas le bot pour rien)', async () => {
  const w = world({ cell: null, state: Object.assign(world().state, { longDue: true }) });
  await runHuntCook(w.deps, 6);
  assert.strictEqual(w.outcomes.length, 1);
  assert.strictEqual(w.outcomes[0].long, true);
  assert.strictEqual(w.events.find((e) => e.type === 'hunt_cook_done').trip, 'no_cell_long');
});

// ─── chair de zombie ────────────────────────────────────────────────────────────────────────────
test('chair de zombie : seule nourriture → choisie, et mangée dès faim ≤ 6', () => {
  assert.strictEqual(pickFood([{ name: 'cobblestone', count: 12 }, { name: 'rotten_flesh', count: 3 }]).name, 'rotten_flesh');
  assert.strictEqual(eatWanted({ food: 6, health: 20 }), true);
  assert.strictEqual(eatWanted({ food: 3, health: 20 }), true);
});

// ─── câblage index.js ───────────────────────────────────────────────────────────────────────────
test('index.js : sortie longue, plein et porte affamé câblés', () => {
  assert.match(SRC, /longDue: \(\(\) => \{/);
  assert.match(SRC, /tripOutcome: \(o\) => foodTripOutcome\(o\)/);
  assert.match(SRC, /tripFill: true/);
  assert.match(SRC, /grazingCell: \(o\) => foodTripCell\(o\)/);
  assert.match(SRC, /hunger: bot\.food, longTripAt/);
  assert.match(SRC, /FOOD_RUN_TIMEOUT_MS \+ FOOD_TRIP_MS \+ FOOD_TRIP_LONG_EXTRA_MS/);
  assert.match(SRC, /HUNT_COOK_TIMEOUT_MS \+ FOOD_TRIP_MS \+ FOOD_TRIP_LONG_EXTRA_MS/);
  assert.match(SRC, /FOOD_TRIP_YIELD_MAX_MS \+ FOOD_TRIP_LONG_EXTRA_MS/);
  assert.match(SRC, /legs < maxLegs/);
});

test('herdBarrenRecord / herdBarrenRecent : arrivé bredouille = horodaté ; rapporté = effacé ; TTL 30 min', () => {
  const now = 1e12, MIN = 60000;
  assert.strictEqual(T.herdBarrenRecord(0, { arrived: true, got: 0 }, now), now);
  assert.strictEqual(T.herdBarrenRecord(now, { arrived: false, got: 0 }, now + MIN), now, 'pas arrivé : on garde');
  assert.strictEqual(T.herdBarrenRecord(now, { arrived: true, got: 4 }, now + MIN), 0, 'rapporté : effacé');
  assert.strictEqual(T.herdBarrenRecent(now, now + 10 * MIN), true);
  assert.strictEqual(T.herdBarrenRecent(now, now + 31 * MIN), false);
  assert.strictEqual(T.herdBarrenRecent(0, now), false);
});
