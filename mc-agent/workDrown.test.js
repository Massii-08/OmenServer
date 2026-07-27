'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  recordWorkDrown, DEFAULT_THRESHOLD, DEFAULT_WINDOW_MS,
  noteDrownedSite, isDrownedNear, offsetFromDrowned,
  DROWNED_SITE_RADIUS, DROWNED_SITE_TTL_MS, OFFSET_MIN, OFFSET_MAX,
} = require('./workDrown');

test('1er sauvetage-noyade au chantier → pas d\'abandon (blip toléré)', () => {
  const r = recordWorkDrown([], 1000);
  assert.equal(r.abandon, false);
  assert.deepEqual(r.times, [1000]);
});

test('2e sauvetage-noyade dans la fenêtre → abandon du chantier (aquifère adjacent, live world_mn9)', () => {
  const r = recordWorkDrown([1000], 5000);
  assert.equal(r.abandon, true);
  assert.deepEqual(r.times, [1000, 5000]);
});

test('sauvetage hors fenêtre (>4 min) → compteur réinitialisé (pas d\'abandon)', () => {
  const r = recordWorkDrown([1000], 1000 + 250000);  // >240 s plus tard
  assert.equal(r.abandon, false);
  assert.deepEqual(r.times, [1000 + 250000]);
});

test('seuil/fenêtre configurables', () => {
  const r = recordWorkDrown([100, 200], 300, { threshold: 3, windowMs: 1000 });
  assert.equal(r.abandon, true);                       // 3 dans la fenêtre
  const r2 = recordWorkDrown([100], 300, { threshold: 3, windowMs: 1000 });
  assert.equal(r2.abandon, false);                     // seulement 2
});

test('entrées non finies ignorées ; times absent → []', () => {
  const r = recordWorkDrown(undefined, 500);
  assert.deepEqual(r.times, [500]);
  const r2 = recordWorkDrown([NaN, null, 400], 500, { windowMs: 1000 });
  assert.deepEqual(r2.times, [400, 500]);
});

test('défauts : seuil = 2, fenêtre = 4 min', () => {
  assert.equal(DEFAULT_THRESHOLD, 2);
  assert.equal(DEFAULT_WINDOW_MS, 240000);
});

// ─── 3a : le chantier noyé est BANNI, pas seulement oublié ──────────────────────────────────────
// L'oubli seul ne suffisait pas : la re-descente re-perçait le MÊME aquifère quelques blocs plus
// loin (le réflexe anti-noyade `/home safe` préempte le relogement lent). On mémorise donc le lieu
// et on refuse d'y re-creuser, avec un décalage imposé.

test('un chantier noyé est mémorisé', () => {
  const s = noteDrownedSite([], { x: 100, z: -50 }, 1000);
  assert.equal(s.length, 1);
  assert.equal(s[0].x, 100);
  assert.equal(s[0].z, -50);
});

test('re-creuser AU MÊME endroit est refusé', () => {
  const s = noteDrownedSite([], { x: 100, z: -50 }, 1000);
  assert.equal(isDrownedNear(s, { x: 100, z: -50 }, 1000), true);
});

test('re-creuser à quelques blocs est refusé aussi (c est la même nappe)', () => {
  const s = noteDrownedSite([], { x: 100, z: -50 }, 1000);
  assert.equal(isDrownedNear(s, { x: 100 + DROWNED_SITE_RADIUS - 1, z: -50 }, 1000), true);
});

test('au-delà du rayon, le terrain est de nouveau autorisé', () => {
  const s = noteDrownedSite([], { x: 100, z: -50 }, 1000);
  assert.equal(isDrownedNear(s, { x: 100 + DROWNED_SITE_RADIUS + 1, z: -50 }, 1000), false);
});

test('un bannissement expire (la nappe peut avoir été drainée, et la carte évolue)', () => {
  const s = noteDrownedSite([], { x: 100, z: -50 }, 1000);
  assert.equal(isDrownedNear(s, { x: 100, z: -50 }, 1000 + DROWNED_SITE_TTL_MS + 1), false);
});

test('les sites expirés sont purgés au lieu de s accumuler', () => {
  let s = noteDrownedSite([], { x: 0, z: 0 }, 0);
  s = noteDrownedSite(s, { x: 500, z: 500 }, DROWNED_SITE_TTL_MS + 1);
  assert.equal(s.length, 1);
  assert.equal(s[0].x, 500);
});

test('positions absurdes ignorées (jamais de bannissement sur du bruit)', () => {
  assert.deepEqual(noteDrownedSite([], null, 1000), []);
  assert.deepEqual(noteDrownedSite([], { x: NaN, z: 1 }, 1000), []);
  assert.equal(isDrownedNear(null, { x: 0, z: 0 }, 0), false);
  assert.equal(isDrownedNear([{ x: 0, z: 0, at: 0 }], null, 0), false);
});

test('le décalage impose 30-50 blocs de terrain neuf', () => {
  for (let seed = 0; seed < 8; seed++) {
    const p = offsetFromDrowned({ x: 100, z: -50 }, seed);
    const d = Math.hypot(p.x - 100, p.z + 50);
    assert.ok(d >= OFFSET_MIN && d <= OFFSET_MAX, `décalage ${d} hors [${OFFSET_MIN},${OFFSET_MAX}]`);
  }
});

test('deux essais successifs partent dans des directions DIFFÉRENTES', () => {
  const a = offsetFromDrowned({ x: 0, z: 0 }, 0);
  const b = offsetFromDrowned({ x: 0, z: 0 }, 1);
  assert.notDeepEqual(a, b);
});

test('le décalage est déterministe pour un même essai (rejouable, testable)', () => {
  assert.deepEqual(offsetFromDrowned({ x: 7, z: 9 }, 3), offsetFromDrowned({ x: 7, z: 9 }, 3));
});
