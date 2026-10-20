'use strict';
// Migration « bloquée dans une zone déjà vidée » (run10, 20/10) — décisions pures.
// Mesuré sur 10 h 30 / 5 bots : 124 départs → 12 arrivées ; 55 échecs `still_depleted`.
// Les 31 cellules `depleted` de la carte venaient TOUTES de recherches de BOIS (25/29
// `directed_exhausted` sur le but `logs`, biomes forêt/plaine) et dataient de 82 à 888 min :
// 31 disques de 160 blocs couvraient toute la région, le critère d'arrivée était insatisfiable.
const test = require('node:test');
const assert = require('node:assert');
const {
  depletedForZone, DEPLETED_ZONE_MAX_AGE_MS, migrationKeepWalking, MIGRATION_EXTRA_LEGS,
  migrationConfineGraceMs, MIGRATION_CONFINE_GRACE_MS, migrationArrivalOk, MIGRATE_FAR_MIN_DIST,
} = require('./zone');
const { depletedKindFor } = require('./worldMemory');

const NOW = Date.parse('2026-10-20T09:00:00Z');
const iso = (minAgo) => new Date(NOW - minAgo * 60000).toISOString();

test('depletedForZone : écarte les cellules épuisées pour le BOIS', () => {
  const out = depletedForZone([
    { x: 0, z: 0, at: iso(5), kind: 'wood' },
    { x: 10, z: 0, at: iso(5), kind: 'ore' },
  ], NOW);
  assert.deepStrictEqual(out.map((d) => d.x), [10]);
});

test('depletedForZone : âge maximum (60 min) — ISO comme epoch ms', () => {
  assert.strictEqual(DEPLETED_ZONE_MAX_AGE_MS, 60 * 60 * 1000);
  const out = depletedForZone([
    { x: 1, z: 0, at: iso(30) },              // legacy sans kind, jeune → compte
    { x: 2, z: 0, at: iso(61) },              // trop vieille
    { x: 3, z: 0, at: NOW - 10 * 60000 },     // epoch ms
    { x: 4, z: 0, at: (NOW - 10 * 60000) / 1000 },   // epoch s (backend numérique)
  ], NOW);
  assert.deepStrictEqual(out.map((d) => d.x), [1, 3, 4]);
});

test('depletedForZone : sans date, date illisible ou datée du FUTUR → ignorée', () => {
  const out = depletedForZone([
    { x: 1, z: 0 },
    { x: 2, z: 0, at: 'pas une date' },
    { x: 3, z: 0, at: new Date(NOW + 30 * 60000).toISOString() },
    { x: 4, z: 0, at: new Date(NOW + 60000).toISOString() },   // 1 min d'avance : tolérance d'horloge
    null, { z: 0, at: iso(1) },
  ], NOW);
  assert.deepStrictEqual(out.map((d) => d.x), [4]);
});

test('depletedForZone : entrée non-tableau → []', () => {
  assert.deepStrictEqual(depletedForZone(null, NOW), []);
  assert.deepStrictEqual(depletedForZone(undefined, NOW), []);
});

test('le cas réel run10 : 31 cellules bois/legacy toutes > 80 min → arrivée fraîche', () => {
  const real = [[8, 8, 888], [86, 27, 871], [293, -316, 82], [384, -256, 83], [-103, -13, 106]]
    .map(([x, z, a]) => ({ x, z, at: iso(a) }));
  const r = migrationArrivalOk({
    reason: 'depleted', gone: 204, minDist: MIGRATE_FAR_MIN_DIST, distToTarget: 400,
    arrival: { x: 300, z: -300 }, depleted: depletedForZone(real, NOW),
  });
  assert.deepStrictEqual(r, { ok: true, why: 'fresh_ground' });
});

test('depletedKindFor : bois si TOUS les matériaux cherchés sont des troncs', () => {
  assert.strictEqual(depletedKindFor(['oak_log', 'birch_log']), 'wood');
  assert.strictEqual(depletedKindFor('spruce_log'), 'wood');
  assert.strictEqual(depletedKindFor(['crimson_stem']), 'wood');
  assert.strictEqual(depletedKindFor(['iron_ore']), 'ore');
  assert.strictEqual(depletedKindFor(['oak_log', 'iron_ore']), 'ore');   // mélange : prudent
  assert.strictEqual(depletedKindFor([]), null);
  assert.strictEqual(depletedKindFor(null), null);
});

// ─── Continuer à marcher plutôt qu'abandonner ─────────────────────────────────────────────────
const far = (o) => Object.assign({ reason: 'depleted', minDist: 600, extraLegs: 0 }, o);

test('keepWalking : arrivée épuisée/trop courte avant le plancher → on continue', () => {
  assert.strictEqual(migrationKeepWalking(far({ gone: 200, arrivalOk: false, arrivalWhy: 'still_depleted' })), true);
  assert.strictEqual(migrationKeepWalking(far({ gone: 30, arrivalOk: false, arrivalWhy: 'too_short' })), true);
});

test('keepWalking : arrivée réussie au sec → on s’arrête', () => {
  assert.strictEqual(migrationKeepWalking(far({ gone: 200, arrivalOk: true, arrivalWhy: 'fresh_ground' })), false);
});

test('keepWalking : réussie mais les pieds dans l’eau → encore quelques jambes', () => {
  assert.strictEqual(migrationKeepWalking(far({ gone: 500, arrivalOk: true, arrivalWhy: 'far_enough', wet: true })), true);
});

test('keepWalking : bornes — budget de jambes, plancher dépassé, motif non lointain, position illisible', () => {
  assert.strictEqual(migrationKeepWalking(far({ gone: 200, arrivalOk: false, arrivalWhy: 'still_depleted', extraLegs: MIGRATION_EXTRA_LEGS })), false);
  assert.strictEqual(migrationKeepWalking(far({ gone: 600, arrivalOk: false, arrivalWhy: 'still_depleted' })), false);
  assert.strictEqual(migrationKeepWalking({ reason: 'wood', gone: 20, minDist: 64, arrivalOk: false, arrivalWhy: 'too_short', extraLegs: 0 }), false);
  assert.strictEqual(migrationKeepWalking(far({ gone: NaN, arrivalOk: false, arrivalWhy: 'no_position' })), false);
  assert.ok(MIGRATION_EXTRA_LEGS > 0 && MIGRATION_EXTRA_LEGS <= 24);
});

test('arrivée : au-delà du plancher, plus jamais `still_depleted`', () => {
  const r = migrationArrivalOk({
    reason: 'depleted', gone: 600, minDist: 600, distToTarget: 500,
    arrival: { x: 0, z: 0 }, depleted: [{ x: 0, z: 0 }],
  });
  assert.strictEqual(r.ok, true);
});

// ─── Pas de rappel par le confine après un long trek raté ─────────────────────────────────────
test('confineGrace : trek lointain qui n’a pas pu ancrer (eau/sous terre) → délai de grâce', () => {
  assert.strictEqual(migrationConfineGraceMs({ reason: 'depleted', gone: 450, minDist: 600, anchored: false }), MIGRATION_CONFINE_GRACE_MS);
  assert.strictEqual(migrationConfineGraceMs({ reason: 'exhausted', gone: 900, minDist: 600, anchored: false }), MIGRATION_CONFINE_GRACE_MS);
});

test('confineGrace : rien si ancré, trop court, motif proche ou position illisible', () => {
  assert.strictEqual(migrationConfineGraceMs({ reason: 'depleted', gone: 900, minDist: 600, anchored: true }), 0);
  assert.strictEqual(migrationConfineGraceMs({ reason: 'depleted', gone: 300, minDist: 600, anchored: false }), 0);
  assert.strictEqual(migrationConfineGraceMs({ reason: 'wood', gone: 300, minDist: 64, anchored: false }), 0);
  assert.strictEqual(migrationConfineGraceMs({ reason: 'depleted', gone: NaN, minDist: 600, anchored: false }), 0);
});

// ─── Câblage dans index.js (un champ qu'une couche oublie = fonctionnalité morte, piège #61) ─────
const _src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'index.js'), 'utf8');

test('câblage : verdict ET arrivée lisent la carte filtrée (bois/périmé exclus)', () => {
  assert.match(_src, /const depletedNear = depletedForZone\(cells\.depleted, now\)/);
  assert.match(_src, /depleted: depletedForZone\(arrivalCells\.depleted, Date\.now\(\)\)/);
});

test('câblage : jambes supplémentaires avant le verdict d’arrivée', () => {
  const ext = _src.indexOf('migrationKeepWalking({');
  const arr = _src.indexOf('const arrival = migrationArrivalOk({');
  assert.ok(ext > 0 && arr > ext, 'la boucle d’extension précède le jugement d’arrivée');
});

test('câblage : la grâce du confine vit au NIVEAU MODULE et gate l’enforcement', () => {
  assert.match(_src, /^let _confineGraceUntil = 0;/m);
  assert.match(_src, /const graceHold = Date\.now\(\) < _confineGraceUntil;/);
  assert.match(_src, /busy: busy \|\| graceHold/);
  assert.match(_src, /_confineGraceUntil = Date\.now\(\) \+ graceMs;/);
});
