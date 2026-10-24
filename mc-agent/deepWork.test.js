'use strict';
const test = require('node:test');
const assert = require('node:assert');
const D = require('./deepWork');

const STONE = { name: 'deepslate', boundingBox: 'block' };
const AIR = { name: 'air', boundingBox: 'empty' };
// Monde : sol plein sous y=-54, air au-dessus ; `over` surcharge des cases ("x,y,z" → bloc).
function world(over = {}) {
  return (q) => {
    const k = q.x + ',' + q.y + ',' + q.z;
    if (k in over) return over[k];
    return q.y < -54 ? STONE : AIR;
  };
}
const P = { x: 10.5, y: -54, z: 20.5 };
const T = 1_800_000_000_000;

test('deepSpotCheck : sol plein, air sec autour → sûr', () => {
  assert.deepStrictEqual(D.deepSpotCheck(world(), P), { ok: true });
});

test('deepSpotCheck : vide sous les pieds, lave ou eau voisines, fluide aux pieds → refus', () => {
  assert.strictEqual(D.deepSpotCheck(world({ '10,-55,20': AIR }), P).why, 'no_floor');
  assert.strictEqual(D.deepSpotCheck(world({ '12,-55,21': { name: 'lava', boundingBox: 'empty' } }), P).why, 'lava_near');
  assert.strictEqual(D.deepSpotCheck(world({ '9,-53,19': { name: 'water', boundingBox: 'empty' } }), P).why, 'water_near');
  assert.strictEqual(D.deepSpotCheck(world({ '10,-54,20': { name: 'water', boundingBox: 'empty' } }), P).why, 'fluid');
  assert.strictEqual(D.deepSpotCheck(world({ '10,-56,20': null }), P).why, 'unknown');
  assert.strictEqual(D.deepSpotCheck(() => null, P).why, 'unknown');
});

test('shouldRefreshDeepWork : seulement sous -40, 1/min, sur avance de 16 blocs ou toutes les 10 min', () => {
  assert.strictEqual(D.shouldRefreshDeepWork({ pos: { x: 0, y: -39, z: 0 }, last: null, now: T }), false);
  assert.strictEqual(D.shouldRefreshDeepWork({ pos: P, last: null, now: T }), true);
  assert.strictEqual(D.shouldRefreshDeepWork({ pos: P, last: null, now: T, lastTryAt: T - 30000 }), false);
  const last = { x: 10, y: -54, z: 20, at: T - 60000 };
  assert.strictEqual(D.shouldRefreshDeepWork({ pos: P, last, now: T }), false);
  assert.strictEqual(D.shouldRefreshDeepWork({ pos: { x: 30, y: -54, z: 20 }, last, now: T }), true);
  assert.strictEqual(D.shouldRefreshDeepWork({ pos: P, last: Object.assign({}, last, { at: T - 11 * 60000 }), now: T }), true);
});

test('deepWorkWarpPlan : chantier profond récent, bot en surface → /home work', () => {
  const w = { x: 10, y: -54, z: 20, at: T - 5 * 60000 };
  assert.deepStrictEqual(D.deepWorkWarpPlan({ deepWork: w, pos: { x: 0, y: 70, z: 0 }, now: T }), { warp: true, why: 'ok' });
  assert.strictEqual(D.deepWorkWarpPlan({ deepWork: null, pos: { x: 0, y: 70, z: 0 }, now: T }).why, 'none');
  assert.strictEqual(D.deepWorkWarpPlan({ deepWork: Object.assign({}, w, { at: T - 7 * 3600000 }), pos: { x: 0, y: 70, z: 0 }, now: T }).why, 'stale');
  assert.strictEqual(D.deepWorkWarpPlan({ deepWork: Object.assign({}, w, { y: -20 }), pos: { x: 0, y: 70, z: 0 }, now: T }).why, 'shallow');
  assert.strictEqual(D.deepWorkWarpPlan({ deepWork: w, pos: { x: 0, y: -40, z: 0 }, now: T }).why, 'already_deep');
});

test('deepWorkWarpPlan : 2 morts récentes à ≤ 16 blocs du chantier = camp → escalier', () => {
  const w = { x: 10, y: -54, z: 20, at: T - 60000 };
  const deaths = [{ x: 12, y: -54, z: 20, at: T - 60000 }, { x: 8, y: -54, z: 22, at: T - 120000 }];
  assert.strictEqual(D.deepWorkWarpPlan({ deepWork: w, pos: { x: 0, y: 70, z: 0 }, now: T, deaths }).why, 'camped');
  // une seule mort, ou des morts anciennes / lointaines : on y retourne
  assert.strictEqual(D.deepWorkWarpPlan({ deepWork: w, pos: { x: 0, y: 70, z: 0 }, now: T, deaths: deaths.slice(0, 1) }).warp, true);
  const old = deaths.map((d) => Object.assign({}, d, { at: T - 20 * 60000 }));
  assert.strictEqual(D.deepWorkWarpPlan({ deepWork: w, pos: { x: 0, y: 70, z: 0 }, now: T, deaths: old }).warp, true);
});

test('deepWorkLanded / deepWorkLoad', () => {
  const w = { x: 10, y: -54, z: 20, at: T };
  assert.strictEqual(D.deepWorkLanded(w, { x: 11, y: -54, z: 21 }), true);
  assert.strictEqual(D.deepWorkLanded(w, { x: 10, y: 64, z: 20 }), false, 'refusé : toujours en surface');
  assert.strictEqual(D.deepWorkLanded(w, { x: 60, y: -54, z: 20 }), false, 'home work posé ailleurs');
  assert.deepStrictEqual(D.deepWorkLoad({ deepWork: { x: 10.7, y: -54, z: 20.2, at: T } }, T + 1000), { x: 10, y: -54, z: 20, at: T });
  assert.strictEqual(D.deepWorkLoad({ deepWork: { x: 1, y: 2, z: 3, at: T + 5000 } }, T), null, 'date future = mémo d ailleurs');
  assert.strictEqual(D.deepWorkLoad({}, T), null);
  assert.strictEqual(D.deepWorkLoad(null, T), null);
});
