'use strict';
// MIGRATION BOIS (23/10, live NethBot3 : 0 pièce d'armure, ~50 min de `logs timeout`) :
//   • la cible d'une migration BOIS est une forêt CONNUE (biome boisé ou bûches vues), jamais une
//     autre terre ; à défaut, la cellule inexplorée la plus proche dans la direction des forêts ;
//   • on marche jusqu'à elle (la sortie « arbres en vue à 64 blocs » ne vaut plus avec une cible) ;
//   • une zone d'arrivée bois sans arbres ne cloue plus le bot 20 min derrière `too_soon`/`cooldown`.
const test = require('node:test');
const assert = require('node:assert');
const {
  pickMigrationTarget, pickWoodMigrationTarget, woodSpots, isWoodedBiome, migrationOrigin, woodRetryAvoid,
  migrationEarlyExitOk, migrationArrivalOk, migrationKeepWalking, zoneVerdict, minDistFor,
  zoneStateInit, zoneStateLoad, zoneStateAfterMigration, zoneStateAfterFailedMigration,
  LOGS_NOT_FOUND_MAX, MIN_MINUTES_IN_ZONE, MIN_MINUTES_URGENT, COOLDOWN_URGENT_MS, WOOD_ARRIVED_RADIUS,
} = require('./zone');

const NOW = Date.parse('2026-10-23T20:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const FROM = { x: 0, z: 0 };
const WOOD = { reason: 'wood', minDist: minDistFor('wood'), now: NOW };

test('isWoodedBiome : variantes boisées reconnues, jamais l eau ni la plaine', () => {
  for (const b of ['forest', 'old_growth_birch_forest', 'snowy_taiga', 'windswept_forest', 'dark_forest',
    'swamp', 'mangrove_swamp', 'sparse_jungle', 'cherry_grove', 'old_growth_spruce_taiga']) {
    assert.strictEqual(isWoodedBiome(b), true, b);
  }
  for (const b of ['plains', 'beach', 'river', 'cold_ocean', 'desert', 'lush_caves', '', null]) {
    assert.strictEqual(isWoodedBiome(b), false, String(b));
  }
});

test('bois : jamais une cellule NON boisée (plaine/plage), même seule dans la fourchette', () => {
  const t = pickMigrationTarget({ ...WOOD, from: FROM, biomes: [{ name: 'plains', x: 128, z: 0 }, { name: 'beach', x: 0, z: 256 }] });
  assert.strictEqual(t, null, 'sans forêt connue → null (marche à l aveugle), pas une plaine');
});

test('bois : la forêt connue la plus proche, avant une plaine plus proche', () => {
  const t = pickMigrationTarget({ ...WOOD, from: FROM,
    biomes: [{ name: 'plains', x: 128, z: 0 }, { name: 'old_growth_birch_forest', x: 0, z: 384 }, { name: 'forest', x: 640, z: 0 }] });
  assert.deepStrictEqual({ x: t.x, z: t.z, biome: t.biome }, { x: 0, z: 384, biome: 'old_growth_birch_forest' });
});

test('bois : des bûches VUES récemment comptent comme une forêt connue (finds *_log)', () => {
  const finds = [{ material: 'spruce_log', biome: 'plains', x: 200, z: 0, at: iso(30 * 60000) }];
  const t = pickMigrationTarget({ ...WOOD, from: FROM, biomes: [{ name: 'plains', x: 128, z: 0 }], finds });
  assert.deepStrictEqual({ x: t.x, z: t.z, source: t.source }, { x: 200, z: 0, source: 'logs' });
});

test('bois : une bûche vue il y a > 3 h ne prouve plus rien, un minerai jamais', () => {
  const finds = [
    { material: 'oak_log', biome: 'plains', x: 200, z: 0, at: iso(4 * 3600000) },
    { material: 'iron_ore', biome: 'plains', x: 300, z: 0, at: iso(60000) },
  ];
  assert.strictEqual(woodSpots({ finds, now: NOW }).length, 0);
});

test('bois : une forêt PELÉE (dépôt kind:wood récent) est fuie ; un dépôt minerai, non', () => {
  const biomes = [{ name: 'forest', x: 256, z: 0 }, { name: 'forest', x: 0, z: 640 }];
  const peeled = pickMigrationTarget({ ...WOOD, from: FROM, biomes, depleted: [{ x: 256, z: 0, kind: 'wood', at: iso(600000) }] });
  assert.deepStrictEqual({ x: peeled.x, z: peeled.z }, { x: 0, z: 640 });
  const ore = pickMigrationTarget({ ...WOOD, from: FROM, biomes, depleted: [{ x: 256, z: 0, kind: 'ore', at: iso(600000) }] });
  assert.deepStrictEqual({ x: ore.x, z: ore.z }, { x: 256, z: 0 }, 'le fer épuisé ne coupe pas les arbres');
});

test('bois : forêts connues hors fourchette → cellule INEXPLORÉE la plus proche dans leur direction', () => {
  // Seule forêt connue à 2048 blocs à l'est (> MIGRATE_MAX_DIST) ; les cellules (128,0) et (256,0) sont
  // déjà cartographiées (plaine) → la 1re inexplorée sur le cap est (384,0).
  const biomes = [{ name: 'forest', x: 2048, z: 0 }, { name: 'plains', x: 128, z: 0 }, { name: 'plains', x: 256, z: 0 }];
  const t = pickWoodMigrationTarget({ from: FROM, biomes, minDist: 64, now: NOW });
  assert.deepStrictEqual(t, { x: 384, z: 0, source: 'frontier', biome: null });
});

test('bois : aucune forêt connue du tout → null', () => {
  assert.strictEqual(pickWoodMigrationTarget({ from: FROM, biomes: [{ name: 'plains', x: 128, z: 0 }], now: NOW }), null);
});

test('bois : déterministe (ordre des cellules indifférent)', () => {
  const biomes = [{ name: 'forest', x: 256, z: 0 }, { name: 'taiga', x: 0, z: 256 }, { name: 'plains', x: 128, z: 128 }];
  const a = pickMigrationTarget({ ...WOOD, from: FROM, biomes });
  const b = pickMigrationTarget({ ...WOOD, from: FROM, biomes: biomes.slice().reverse() });
  assert.deepStrictEqual(a, b);
});

test('bois : 2ᵉ migration bois depuis une zone d arrivée bois → la zone et ses voisines sont écartées', () => {
  const anchor = { x: -364, z: 250 };
  const avoid = woodRetryAvoid({ avoid: [], reason: 'wood', lastReason: 'wood', anchor, now: NOW });
  assert.strictEqual(avoid.length, 1);
  const biomes = [{ name: 'forest', x: -256, z: 256 }, { name: 'forest', x: -640, z: 256 }];
  const t = pickMigrationTarget({ ...WOOD, from: anchor, biomes, avoid });
  assert.deepStrictEqual({ x: t.x, z: t.z }, { x: -640, z: 256 }, 'la forêt voisine du même bois rasé (108 b) est sautée');
  // motif précédent différent → rien d'ajouté
  assert.strictEqual(woodRetryAvoid({ avoid: [], reason: 'wood', lastReason: 'exhausted', anchor, now: NOW }).length, 0);
});

test('origine bois = position du bot en surface (live : cible à 98 b de l ancre mais 326 b du bot)', () => {
  const anchor = { x: -482, z: 518 };
  assert.deepStrictEqual(migrationOrigin({ reason: 'wood', anchor, pos: { x: -380, y: 67, z: 200 } }), { x: -380, z: 200 });
  assert.deepStrictEqual(migrationOrigin({ reason: 'wood', anchor, pos: { x: -380, y: 20, z: 200 } }), anchor, 'sous terre : /home safe d abord');
  assert.deepStrictEqual(migrationOrigin({ reason: 'exhausted', anchor, pos: { x: -380, y: 67, z: 200 } }), anchor);
});

test('marche bois avec cible : « arbres en vue » à 64 b ne suffit plus, il faut la forêt visée', () => {
  assert.strictEqual(migrationEarlyExitOk({ reason: 'wood', gone: 80, minDist: 64, distToTarget: 260 }), false);
  assert.strictEqual(migrationEarlyExitOk({ reason: 'wood', gone: 80, minDist: 64, distToTarget: WOOD_ARRIVED_RADIUS }), true);
  assert.strictEqual(migrationEarlyExitOk({ reason: 'wood', gone: 80, minDist: 64, distToTarget: Infinity }), true, 'marche à l aveugle : inchangée');
});

test('jambes supplémentaires bois : tant que la forêt visée n est pas en vue', () => {
  const base = { reason: 'wood', gone: 293, minDist: 64, arrivalOk: true, arrivalWhy: 'moved', extraLegs: 0 };
  assert.strictEqual(migrationKeepWalking({ ...base, distToTarget: 262 }), true);
  assert.strictEqual(migrationKeepWalking({ ...base, distToTarget: 90 }), false);
  assert.strictEqual(migrationKeepWalking({ ...base, distToTarget: Infinity }), false, 'sans cible : rien à rejoindre');
  assert.strictEqual(migrationKeepWalking({ ...base, distToTarget: 262, extraLegs: 12 }), false, 'budget borné');
});

test('arrivée bois : dans le rayon de la forêt visée = arrived', () => {
  assert.deepStrictEqual(migrationArrivalOk({ reason: 'wood', gone: 145, minDist: 64, distToTarget: 43 }), { ok: true, why: 'arrived' });
  assert.deepStrictEqual(migrationArrivalOk({ reason: 'wood', gone: 293, minDist: 64, distToTarget: 262 }), { ok: true, why: 'moved' });
});

const SANE = { minutesInZone: 1, waterFails: 0, logsNotFound: 0, ironMined: 0, miningMinutes: 0, depletedNear: 0,
  dryCellKnown: true, lastMigrationAt: NOW - 60000, lastMigrationFailed: false, now: NOW, isNight: false };

test('verdict : arrivée bois prouvée sans arbres → seuils d urgence (4 min / 5 min), plus de too_soon de 15 min', () => {
  const s = { ...SANE, lastMigrationReason: 'wood', logsNotFound: LOGS_NOT_FOUND_MAX,
    minutesInZone: MIN_MINUTES_URGENT + 1, lastMigrationAt: NOW - COOLDOWN_URGENT_MS - 1000 };
  assert.ok(MIN_MINUTES_URGENT + 1 < MIN_MINUTES_IN_ZONE);
  assert.deepStrictEqual(zoneVerdict(s), { verdict: 'migrate', reason: 'wood' });
  // même zone, dernière migration pour une autre raison → règle historique (trop tôt)
  assert.strictEqual(zoneVerdict({ ...s, lastMigrationReason: 'exhausted' }).reason, 'too_soon');
  // urgence ≠ immédiateté : l'anti-yo-yo de 4 min tient
  assert.strictEqual(zoneVerdict({ ...s, minutesInZone: 1 }).reason, 'too_soon');
});

test('état de zone : le motif de la dernière migration fait l aller-retour (persisté, survit au respawn)', () => {
  assert.strictEqual(zoneStateInit(NOW).lastMigrationReason, null);
  const after = zoneStateAfterMigration(NOW, null, 'wood');
  assert.strictEqual(after.lastMigrationReason, 'wood');
  assert.strictEqual(zoneStateLoad(JSON.parse(JSON.stringify(after)), NOW + 1000).lastMigrationReason, 'wood');
  assert.strictEqual(zoneStateAfterFailedMigration(after, NOW + 2000, null).lastMigrationReason, 'wood');
  assert.strictEqual(zoneStateLoad({ anchoredAt: NOW, lastMigrationReason: 42 }, NOW).lastMigrationReason, null);
  assert.strictEqual(zoneStateAfterMigration(NOW).lastMigrationReason, null, 'appel historique');
});
