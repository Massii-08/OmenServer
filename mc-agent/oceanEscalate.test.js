'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { recordOceanStuck, DEFAULT_THRESHOLD } = require('./oceanEscalate');

test('1er ocean_stuck → pas de relocate forcé (blip toléré, escapeWater suffit)', () => {
  const r = recordOceanStuck([], 1000);
  assert.equal(r.forceRelocate, false);
  assert.deepEqual(r.times, [1000]);
});

test('2e ocean_stuck dans la fenêtre → relocate FORCÉ (baie persistante, live ResBot1)', () => {
  const r = recordOceanStuck([1000], 5000);
  assert.equal(r.forceRelocate, true);
  assert.deepEqual(r.times, [1000, 5000]);
});

test('ocean_stuck hors fenêtre → compteur réinitialisé (pas de relocate)', () => {
  const r = recordOceanStuck([1000], 1000 + 200000);  // >180 s plus tard
  assert.equal(r.forceRelocate, false);
  assert.deepEqual(r.times, [1000 + 200000]);
});

test('seuil/fenêtre configurables', () => {
  const r = recordOceanStuck([100, 200], 300, { threshold: 3, windowMs: 1000 });
  assert.equal(r.forceRelocate, true);                 // 3 dans la fenêtre
  const r2 = recordOceanStuck([100], 300, { threshold: 3, windowMs: 1000 });
  assert.equal(r2.forceRelocate, false);               // seulement 2
});

test('entrées non finies ignorées ; times absent → []', () => {
  const r = recordOceanStuck(undefined, 500);
  assert.deepEqual(r.times, [500]);
  const r2 = recordOceanStuck([NaN, null, 400], 500, { windowMs: 1000 });
  assert.deepEqual(r2.times, [400, 500]);
});

test('défaut : seuil = 2', () => {
  assert.equal(DEFAULT_THRESHOLD, 2);
});
