'use strict';
const test = require('node:test');
const assert = require('node:assert');
const N = require('./nightDeep');

const NOW = 10_000_000;
const work = { x: 0, y: 16, z: 0, at: NOW - 60_000 };
const base = { dusk: true, night: false, underground: false, worn: 0, inWater: false, hasPick: true,
  work, pos: { x: 5, y: 72, z: 5 }, now: NOW, deaths: [] };
const plan = (o) => N.duskDeepPlan(Object.assign({}, base, o));

test('duskDeepPlan : de jour, sous terre ou armé (≥ 2 pièces) → rien à décider', () => {
  assert.strictEqual(plan({ dusk: false, night: false }).action, 'none');
  assert.strictEqual(plan({ underground: true }).action, 'none');
  assert.strictEqual(plan({ worn: 2 }).action, 'none');
});

test('duskDeepPlan : nu au crépuscule avec chantier profond → /home work', () => {
  assert.deepStrictEqual(plan({}), { action: 'work_home', why: 'work' });
  assert.strictEqual(plan({ dusk: false, night: true, worn: 1 }).action, 'work_home');
});

test('duskDeepPlan : sans chantier utilisable, avec pioche → descendre', () => {
  assert.strictEqual(plan({ work: null }).action, 'descend');
  assert.strictEqual(plan({ work: { x: 0, y: 60, z: 0, at: NOW } }).why, 'no_work:shallow');
  assert.strictEqual(plan({ work: { x: 0, y: 16, z: 0, at: NOW - 3 * 3600_000 } }).why, 'no_work:stale');
  assert.strictEqual(plan({ pos: { x: 0, y: 20, z: 0 } }).why, 'no_work:already_deep');
  const deaths = [{ x: 1, y: 16, z: 1, at: NOW - 1000 }, { x: 2, y: 17, z: 0, at: NOW - 2000 }];
  assert.strictEqual(plan({ deaths }).why, 'no_work:camped');
});

test('duskDeepPlan : mappeur, bûcheron, eau, sans pioche → abri historique', () => {
  assert.strictEqual(plan({ isMapper: true }).action, 'shelter');
  assert.strictEqual(plan({ isLumberjack: true }).action, 'shelter');
  assert.strictEqual(plan({ inWater: true }).action, 'shelter');
  assert.deepStrictEqual(plan({ work: null, hasPick: false }), { action: 'shelter', why: 'no_pick' });
});

test('undergroundShelterVeto : sous terre, pas d abri sauf urgence réelle', () => {
  assert.strictEqual(N.undergroundShelterVeto({ underground: false, hp: 20 }), false);
  assert.strictEqual(N.undergroundShelterVeto({ underground: true, hp: 20, threatDist: 1 }), true);
  assert.strictEqual(N.undergroundShelterVeto({ underground: true, hp: 4, threatDist: 10 }), true);
  assert.strictEqual(N.undergroundShelterVeto({ underground: true, hp: 4, threatDist: null }), true);
  assert.strictEqual(N.undergroundShelterVeto({ underground: true, hp: 6, threatDist: 2.5 }), false);
});
