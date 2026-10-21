'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { mapperNightPlan, HOME_SHELTER_FAIL_TTL_MS } = require('./mapperNight');

const NOW = 1_800_000_000_000;

test('mapperNightPlan : home sain → on rentre', () => {
  assert.deepStrictEqual(mapperNightPlan({ homeSet: true, deathsNearHome: 0, hostileNearHome: false, homeShelterFailedAt: 0, now: NOW }), { go: true, why: 'home' });
});

test('mapperNightPlan : pas de home → ici', () => {
  assert.strictEqual(mapperNightPlan({ homeSet: false, now: NOW }).why, 'no_home');
});

test('mapperNightPlan : UNE mort récente au home suffit (le veto camp en exige 2) → ici', () => {
  const r = mapperNightPlan({ homeSet: true, deathsNearHome: 1, now: NOW });
  assert.deepStrictEqual(r, { go: false, why: 'deaths_near_home' });
});

test('mapperNightPlan : hostile vu près du home → ici', () => {
  assert.strictEqual(mapperNightPlan({ homeSet: true, deathsNearHome: 0, hostileNearHome: true, now: NOW }).why, 'hostile_near_home');
});

test('mapperNightPlan : abri raté au home récemment → ici ; passé le TTL → on y retourne', () => {
  assert.strictEqual(mapperNightPlan({ homeSet: true, homeShelterFailedAt: NOW - 60000, now: NOW }).why, 'home_shelter_failed');
  assert.strictEqual(mapperNightPlan({ homeSet: true, homeShelterFailedAt: NOW - HOME_SHELTER_FAIL_TTL_MS - 1, now: NOW }).go, true);
  assert.strictEqual(mapperNightPlan({ homeSet: true, homeShelterFailedAt: NOW + 5000, now: NOW }).go, true);   // horloge reculée
});
