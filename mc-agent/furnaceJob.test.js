'use strict';
const test = require('node:test');
const assert = require('node:assert');
const F = require('./furnaceJob');

test('fuelLoadPlan : charbon d abord, juste ce qu il faut', () => {
  assert.deepStrictEqual(F.fuelLoadPlan([{ name: 'coal', count: 5 }, { name: 'oak_planks', count: 20 }], 12),
    { loads: [{ name: 'coal', qty: 2 }], units: 16, smeltable: 12 });
});

test('fuelLoadPlan : un seul charbon contre beaucoup de planches → les planches (fondent plus)', () => {
  const p = F.fuelLoadPlan([{ name: 'coal', count: 1 }, { name: 'oak_planks', count: 20 }], 12);
  assert.deepStrictEqual(p.loads, [{ name: 'oak_planks', qty: 8 }]);
  assert.strictEqual(p.smeltable, 12);
});

test('fuelLoadPlan : pas de combustible → rien ; bâtons ignorés', () => {
  assert.deepStrictEqual(F.fuelLoadPlan([{ name: 'stick', count: 30 }], 8), { loads: [], units: 0, smeltable: 0 });
});

test('furnaceJobPlan : 8+ minerais + four + combustible → lancer', () => {
  assert.deepStrictEqual(F.furnaceJobPlan({ raw: 9, hasFurnace: true, items: [{ name: 'coal', count: 3 }] }), { act: 'start', count: 9 });
  assert.strictEqual(F.furnaceJobPlan({ raw: 7, hasFurnace: true, items: [{ name: 'coal', count: 3 }] }).act, null, 'moins de 8');
  assert.strictEqual(F.furnaceJobPlan({ raw: 9, hasFurnace: false, items: [{ name: 'coal', count: 3 }] }).act, null);
  assert.strictEqual(F.furnaceJobPlan({ raw: 9, hasFurnace: true, items: [{ name: 'oak_planks', count: 2 }] }).act, null, '3 fontes de combustible seulement');
});

test('furnaceJobPlan : four en cours → attendre, ramasser quand prêt et proche, abandonner trop loin/trop vieux', () => {
  const job = { pos: { x: 0, y: 0, z: 0 }, count: 8, at: 0, readyAt: F.jobReadyAt(0, 8) };
  assert.strictEqual(job.readyAt, 83000);
  assert.strictEqual(F.furnaceJobPlan({ job, now: 50000, dist: 5 }).act, 'wait');
  assert.strictEqual(F.furnaceJobPlan({ job, now: 90000, dist: 5 }).act, 'collect');
  assert.strictEqual(F.furnaceJobPlan({ job, now: 90000, dist: 60 }).act, 'wait', 'prêt mais loin : au retour');
  // Loin = on ATTEND (le fer reste dans le four) — oublier le four, c'était perdre son contenu (22/10).
  assert.strictEqual(F.furnaceJobPlan({ job, now: 90000, dist: 200 }).act, 'wait');
  assert.strictEqual(F.furnaceJobPlan({ job, now: F.SMELT_JOB_ABANDON_MS + 1, dist: 5 }).act, 'abandon');
});

test('furnaceJobPlan : loin ET de quoi relancer un four ici → on abandonne le vieux pour repartir', () => {
  const job = { pos: { x: 0, y: 0, z: 0 }, count: 8, at: 0, readyAt: F.jobReadyAt(0, 8) };
  const items = [{ name: 'coal', count: 4 }];
  assert.deepStrictEqual(F.furnaceJobPlan({ job, now: 90000, dist: 200, raw: 9, hasFurnace: true, items }),
    { act: 'abandon', why: 'far' });
  assert.strictEqual(F.furnaceJobPlan({ job, now: 90000, dist: 200, raw: 3, hasFurnace: true, items }).act, 'wait');
  assert.strictEqual(F.furnaceJobPlan({ job, now: 90000, dist: 60, raw: 9, hasFurnace: true, items }).act, 'wait',
    'à portée de retour : on ne l abandonne pas');
});

test('furnaceJobPlan : un four vieux de 30 min n est plus oublié (le contenu attend), 2 h oui', () => {
  const job = { pos: { x: 0, y: 0, z: 0 }, count: 8, at: 0, readyAt: F.jobReadyAt(0, 8) };
  assert.strictEqual(F.furnaceJobPlan({ job, now: 30 * 60000, dist: 200 }).act, 'wait');
  assert.ok(F.SMELT_JOB_ABANDON_MS >= 2 * 3600 * 1000);
});

test('furnaceJobRestore : relit le four du mémo (relance du process), refuse un mémo abîmé ou périmé', () => {
  const j = { pos: { x: -237, y: 26, z: 242 }, count: 14, at: 1000, readyAt: 150000 };
  assert.deepStrictEqual(F.furnaceJobRestore({ furnaceJob: j }, 2000), j);
  assert.strictEqual(F.furnaceJobRestore({}, 2000), null);
  assert.strictEqual(F.furnaceJobRestore(null, 2000), null);
  assert.strictEqual(F.furnaceJobRestore({ furnaceJob: { pos: { x: 'a', y: 1, z: 2 }, count: 3, at: 1 } }, 2000), null);
  assert.strictEqual(F.furnaceJobRestore({ furnaceJob: j }, 1000 + F.SMELT_JOB_ABANDON_MS + 1), null);
  assert.strictEqual(F.furnaceJobRestore({ furnaceJob: Object.assign({}, j, { at: 5000 }) }, 2000), null, 'futur = mémo d un autre monde');
});

test('furnaceCollectRoute : à côté / à pied / par /home work / plus tard', () => {
  const R = F.furnaceCollectRoute;
  assert.strictEqual(R({ dist: 2, dy: 0, workDist: null }), 'here');
  assert.strictEqual(R({ dist: 20, dy: 2, workDist: null }), 'walk');
  // NethBot1 12:03 : four 40 blocs SOUS la surface, chantier `work` à côté → /home work, pas 40 s de pathfinder
  assert.strictEqual(R({ dist: 45, dy: 40, workDist: 6 }), 'warp_work');
  assert.strictEqual(R({ dist: 300, dy: 10, workDist: 4 }), 'warp_work');
  assert.strictEqual(R({ dist: 45, dy: 40, workDist: null }), 'walk', 'pas de chantier : on tente à pied');
  assert.strictEqual(R({ dist: 14, dy: -10, workDist: 4 }), 'walk', 'four AU-DESSUS, tout près (galerie voisine) : à pied, pas de TP en plein branch-mine');
  assert.strictEqual(R({ dist: 300, dy: 10, workDist: null }), 'later');
  assert.strictEqual(R({ dist: 300, dy: 10, workDist: 40 }), 'later', 'le chantier est ailleurs');
  assert.strictEqual(R({ dist: 300, dy: 10, workDist: 4, inWater: true }), 'later', 'jamais de /home depuis l eau');
  assert.strictEqual(R({ dist: null, dy: 0, workDist: null }), 'walk');
});
