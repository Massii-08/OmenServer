'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { recordWsiteDrown, DEFAULT_THRESHOLD, DEFAULT_WINDOW_MS } = require('./wsiteDrown');

test('1er sauvetage-noyade au wsite → pas d\'abandon (blip toléré)', () => {
  const r = recordWsiteDrown([], 1000);
  assert.equal(r.abandon, false);
  assert.deepEqual(r.times, [1000]);
});

test('2e sauvetage-noyade dans la fenêtre → abandon du wsite (aquifère adjacent, live world_mn9)', () => {
  const r = recordWsiteDrown([1000], 5000);
  assert.equal(r.abandon, true);
  assert.deepEqual(r.times, [1000, 5000]);
});

test('sauvetage hors fenêtre (>4 min) → compteur réinitialisé (pas d\'abandon)', () => {
  const r = recordWsiteDrown([1000], 1000 + 250000);  // >240 s plus tard
  assert.equal(r.abandon, false);
  assert.deepEqual(r.times, [1000 + 250000]);
});

test('seuil/fenêtre configurables', () => {
  const r = recordWsiteDrown([100, 200], 300, { threshold: 3, windowMs: 1000 });
  assert.equal(r.abandon, true);                       // 3 dans la fenêtre
  const r2 = recordWsiteDrown([100], 300, { threshold: 3, windowMs: 1000 });
  assert.equal(r2.abandon, false);                     // seulement 2
});

test('entrées non finies ignorées ; times absent → []', () => {
  const r = recordWsiteDrown(undefined, 500);
  assert.deepEqual(r.times, [500]);
  const r2 = recordWsiteDrown([NaN, null, 400], 500, { windowMs: 1000 });
  assert.deepEqual(r2.times, [400, 500]);
});

test('défauts : seuil = 2, fenêtre = 4 min', () => {
  assert.equal(DEFAULT_THRESHOLD, 2);
  assert.equal(DEFAULT_WINDOW_MS, 240000);
});
