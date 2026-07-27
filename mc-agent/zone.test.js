'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  zoneVerdict, pickMigrationTarget, migrationLeg, legIsGood, minDistFor,
  MIN_MINUTES_IN_ZONE, MIGRATION_COOLDOWN_MS, WATER_FAILS_MAX, LOGS_NOT_FOUND_MAX,
  EXHAUSTED_MINING_MIN, EXHAUSTED_IRON_MIN, DEPLETED_NEAR_MAX, MIGRATE_MIN_DIST, MIGRATE_MAX_DIST,
  MIGRATE_FAR_MIN_DIST,
} = require('./zone');

// ─── « Si une zone a été vidée de ses minerais, il s'éloigne de BEAUCOUP » (Massii, 27/07) ───────
// Une zone épuisée ne se répare pas en marchant 200 blocs : les cellules voisines sont le MÊME
// terrain, déjà fouillé par la même flotte. La distance minimale est donc bien plus grande quand
// le motif est l'épuisement que quand c'est une nappe d'eau (locale, elle).

test('zone vidée => la distance minimale de migration est BIEN plus grande', () => {
  assert.ok(MIGRATE_FAR_MIN_DIST > MIGRATE_MIN_DIST);
  assert.strictEqual(minDistFor('exhausted'), MIGRATE_FAR_MIN_DIST);
  assert.strictEqual(minDistFor('depleted'), MIGRATE_FAR_MIN_DIST);
});

test('eau ou bois : la distance normale suffit (le problème est local)', () => {
  assert.strictEqual(minDistFor('water'), MIGRATE_MIN_DIST);
  assert.strictEqual(minDistFor('wood'), MIGRATE_MIN_DIST);
  assert.strictEqual(minDistFor(undefined), MIGRATE_MIN_DIST);
});

test('zone vidée : une cellule proche est REFUSÉE, une lointaine acceptée', () => {
  const near = { name: 'forest', x: MIGRATE_MIN_DIST + 10, z: 0 };
  const far = { name: 'forest', x: MIGRATE_FAR_MIN_DIST + 10, z: 0 };
  const opts = { from: { x: 0, z: 0 }, minDist: minDistFor('exhausted') };
  assert.strictEqual(pickMigrationTarget({ ...opts, biomes: [near] }), null);
  assert.ok(pickMigrationTarget({ ...opts, biomes: [far] }));
});

const NOW = 10 * 3600 * 1000;

/** Zone saine, ancienne, hors cooldown : le socle sur lequel on n'ajoute qu'un symptôme. */
function healthy(over = {}) {
  return Object.assign({
    minutesInZone: 60,
    waterFails: 0,
    logsNotFound: 0,
    ironMined: 40,
    miningMinutes: 30,
    depletedNear: 0,
    dryCellKnown: false,
    lastMigrationAt: 0,
    now: NOW,
  }, over);
}

// ─── Hystérésis : sans elle la flotte devient nomade et ne produit plus rien ─────────────────────

test('zone saine => on reste', () => {
  assert.strictEqual(zoneVerdict(healthy()).verdict, 'stay');
});

test('zone noyee mais on vient d arriver => on reste (hysteresis)', () => {
  const r = zoneVerdict(healthy({ minutesInZone: MIN_MINUTES_IN_ZONE - 1, waterFails: 99 }));
  assert.strictEqual(r.verdict, 'stay');
  assert.strictEqual(r.reason, 'too_soon');
});

test('zone noyee et on a passe le seuil de temps => on migre', () => {
  const r = zoneVerdict(healthy({ minutesInZone: MIN_MINUTES_IN_ZONE, waterFails: WATER_FAILS_MAX }));
  assert.strictEqual(r.verdict, 'migrate');
});

test('deux migrations rapprochees interdites (cooldown)', () => {
  const r = zoneVerdict(healthy({ waterFails: 99, lastMigrationAt: NOW - (MIGRATION_COOLDOWN_MS - 1) }));
  assert.strictEqual(r.verdict, 'stay');
  assert.strictEqual(r.reason, 'cooldown');
});

test('cooldown ecoule => la migration redevient possible', () => {
  const r = zoneVerdict(healthy({ waterFails: 99, lastMigrationAt: NOW - MIGRATION_COOLDOWN_MS }));
  assert.strictEqual(r.verdict, 'migrate');
});

// ─── Eau ────────────────────────────────────────────────────────────────────────────────────────
// Massii : « 5-6 veines seches dans une zone noyee ne justifient pas d y rester ».

test('assez d echecs eau et AUCUNE cellule seche mappee => migrate:water', () => {
  const r = zoneVerdict(healthy({ waterFails: WATER_FAILS_MAX, dryCellKnown: false }));
  assert.strictEqual(r.verdict, 'migrate');
  assert.strictEqual(r.reason, 'water');
});

// Une cellule seche connue A PORTEE est une meilleure reponse qu un trek de 1500 blocs.
test('echecs eau MAIS une cellule seche mappee est a portee => on reste (on ira la-bas)', () => {
  const r = zoneVerdict(healthy({ waterFails: 99, dryCellKnown: true }));
  assert.strictEqual(r.verdict, 'stay');
});

test('un seul echec eau ne declenche rien', () => {
  assert.strictEqual(zoneVerdict(healthy({ waterFails: 1 })).verdict, 'stay');
});

// ─── Zone epuisee ───────────────────────────────────────────────────────────────────────────────
// Massii : « ce n est pas parce qu il reste 5-6 veines de fer qu il faut rester dans une zone
// deja exploitee ».

test('longtemps a miner pour presque rien => migrate:exhausted', () => {
  const r = zoneVerdict(healthy({ miningMinutes: EXHAUSTED_MINING_MIN, ironMined: EXHAUSTED_IRON_MIN - 1 }));
  assert.strictEqual(r.verdict, 'migrate');
  assert.strictEqual(r.reason, 'exhausted');
});

test('longtemps a miner AVEC un bon rendement => on reste', () => {
  const r = zoneVerdict(healthy({ miningMinutes: 60, ironMined: 50 }));
  assert.strictEqual(r.verdict, 'stay');
});

test('mauvais rendement mais pas encore assez mine => on reste (echantillon trop court)', () => {
  const r = zoneVerdict(healthy({ miningMinutes: EXHAUSTED_MINING_MIN - 1, ironMined: 0 }));
  assert.strictEqual(r.verdict, 'stay');
});

test('assez de cellules epuisees autour => migrate:depleted', () => {
  const r = zoneVerdict(healthy({ depletedNear: DEPLETED_NEAR_MAX }));
  assert.strictEqual(r.verdict, 'migrate');
  assert.strictEqual(r.reason, 'depleted');
});

// ─── Bois ───────────────────────────────────────────────────────────────────────────────────────
// Le frein n 1 mesure sur world_ax4 : 93 % d echecs sur `logs`, zone rasee autour de l ancre.

test('la zone est rasee (logs introuvables en boucle) => migrate:wood', () => {
  const r = zoneVerdict(healthy({ logsNotFound: LOGS_NOT_FOUND_MAX }));
  assert.strictEqual(r.verdict, 'migrate');
  assert.strictEqual(r.reason, 'wood');
});

test('quelques echecs de bois ne suffisent pas', () => {
  assert.strictEqual(zoneVerdict(healthy({ logsNotFound: LOGS_NOT_FOUND_MAX - 1 })).verdict, 'stay');
});

test('entrees manquantes ou absurdes => on reste (jamais de migration sur du bruit)', () => {
  assert.strictEqual(zoneVerdict({}).verdict, 'stay');
  assert.strictEqual(zoneVerdict(null).verdict, 'stay');
  assert.strictEqual(zoneVerdict(healthy({ minutesInZone: NaN, waterFails: 99 })).verdict, 'stay');
});

// ─── Choix de la cible : DETERMINISTE (toute l escouade doit calculer la meme) ───────────────────

const FROM = { x: 0, z: 0 };
const CELLS = [
  { name: 'ocean', x: 300, z: 0 },
  { name: 'forest', x: 0, z: 400 },
  { name: 'plains', x: 250, z: 0 },
  { name: 'birch_forest', x: 0, z: 900 },
  { name: 'river', x: 260, z: 10 },
];

test('cible : une cellule BOISEE non-ocean dans la fourchette', () => {
  const t = pickMigrationTarget({ from: FROM, biomes: CELLS });
  assert.ok(t, 'une cible doit etre trouvee');
  assert.strictEqual(t.biome, 'forest');
  assert.strictEqual(t.source, 'mapped');
});

test('cible : le meme calcul rend la MEME cible (escouade groupee)', () => {
  const a = pickMigrationTarget({ from: FROM, biomes: CELLS });
  const b = pickMigrationTarget({ from: FROM, biomes: CELLS.slice().reverse() });
  assert.deepStrictEqual(a, b, 'l ordre des cellules ne doit pas changer le resultat');
});

test('cible : jamais l ocean ni la riviere (ce sont des ouvriers, pas des cartographes)', () => {
  const t = pickMigrationTarget({ from: FROM, biomes: [{ name: 'ocean', x: 400, z: 0 }, { name: 'river', x: 300, z: 0 }] });
  assert.strictEqual(t, null);
});

test('cible : trop pres = zone deja exploitee, trop loin = trek suicidaire', () => {
  const tooClose = pickMigrationTarget({ from: FROM, biomes: [{ name: 'forest', x: MIGRATE_MIN_DIST - 1, z: 0 }] });
  assert.strictEqual(tooClose, null);
  const tooFar = pickMigrationTarget({ from: FROM, biomes: [{ name: 'forest', x: MIGRATE_MAX_DIST + 1, z: 0 }] });
  assert.strictEqual(tooFar, null);
});

test('cible : une cellule epuisee est ecartee', () => {
  const t = pickMigrationTarget({
    from: FROM,
    biomes: [{ name: 'forest', x: 0, z: 400 }],
    depleted: [{ x: 0, z: 400 }],
  });
  assert.strictEqual(t, null);
});

test('cible : le bois prime sur la simple proximite', () => {
  const t = pickMigrationTarget({
    from: FROM,
    biomes: [{ name: 'plains', x: 210, z: 0 }, { name: 'forest', x: 0, z: 500 }],
  });
  assert.strictEqual(t.biome, 'forest');
});

test('cible : a defaut de bois, une terre non-ocean fait l affaire', () => {
  const t = pickMigrationTarget({ from: FROM, biomes: [{ name: 'plains', x: 250, z: 0 }] });
  assert.strictEqual(t.biome, 'plains');
});

test('cible : carte vide => null (le caller bascule sur la marche a l aveugle)', () => {
  assert.strictEqual(pickMigrationTarget({ from: FROM, biomes: [] }), null);
  assert.strictEqual(pickMigrationTarget({ from: FROM }), null);
});

// ─── Marche a l aveugle (memoire fraiche, aucune carte) ─────────────────────────────────────────

test('jambe : un point a ~128 blocs sur le cap, deterministe par bot', () => {
  const a = migrationLeg({ from: FROM, heading: 0, legs: 0 });
  assert.strictEqual(Math.round(Math.hypot(a.x - FROM.x, a.z - FROM.z)), 128);
});

test('jambe : les jambes s enchainent depuis la position courante', () => {
  const l1 = migrationLeg({ from: FROM, heading: 0, legs: 0 });
  const l2 = migrationLeg({ from: l1, heading: 0, legs: 1 });
  assert.ok(Math.hypot(l2.x - FROM.x, l2.z - FROM.z) > Math.hypot(l1.x - FROM.x, l1.z - FROM.z));
});

test('jambe : au-dela du cap total, on s arrete (pas de nomadisme infini)', () => {
  assert.strictEqual(migrationLeg({ from: FROM, heading: 0, legs: 99 }), null);
});

test('terrain : bon si des arbres sont visibles, hors eau, biome terrestre', () => {
  assert.strictEqual(legIsGood({ treesNear: 3, inWater: false, biome: 'forest' }), true);
});

test('terrain : refuse les pieds dans l eau', () => {
  assert.strictEqual(legIsGood({ treesNear: 5, inWater: true, biome: 'forest' }), false);
});

test('terrain : refuse ocean et riviere', () => {
  assert.strictEqual(legIsGood({ treesNear: 5, inWater: false, biome: 'ocean' }), false);
  assert.strictEqual(legIsGood({ treesNear: 5, inWater: false, biome: 'frozen_river' }), false);
});

test('terrain : refuse une zone sans un seul arbre (c est le goulot n 1)', () => {
  assert.strictEqual(legIsGood({ treesNear: 0, inWater: false, biome: 'desert' }), false);
});
