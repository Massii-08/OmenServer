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
  assert.strictEqual(F.furnaceJobPlan({ job, now: 90000, dist: 200 }).act, 'abandon');
  assert.strictEqual(F.furnaceJobPlan({ job, now: F.SMELT_JOB_ABANDON_MS + 1, dist: 5 }).act, 'abandon');
});
