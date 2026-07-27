'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  zoneVerdict, verdictTelemetry, pickMigrationTarget, migrationLeg, legIsGood, minDistFor, zoneFailureKind,
  zoneStateInit, zoneStateLoad, zoneStateAfterMigration,
  MIN_MINUTES_IN_ZONE, MIGRATION_COOLDOWN_MS, WATER_FAILS_MAX, LOGS_NOT_FOUND_MAX,
  EXHAUSTED_MINING_MIN, EXHAUSTED_IRON_MIN, DEPLETED_NEAR_MAX, MIGRATE_MIN_DIST, MIGRATE_MAX_DIST,
  MIGRATE_FAR_MIN_DIST,
} = require('./zone');

// ─── Télémétrie du verdict de zone : dedup au changement de raison, toujours sur 'migrate' ───────
// Sans cette trace, un verdict 'stay' n'émet rien → impossible de diagnostiquer pourquoi une flotte
// noyée ne migre jamais (le verdict de migration n'a pas tiré une seule fois de toute une journée).

test('telemetrie : trace au premier verdict (raison nouvelle vs null)', () => {
  const t = verdictTelemetry({ verdict: 'stay', reason: 'too_soon' }, null);
  assert.deepStrictEqual(t, { log: true, reason: 'too_soon' });
});

test('telemetrie : dedup — meme raison consecutive ne se re-trace pas', () => {
  const t = verdictTelemetry({ verdict: 'stay', reason: 'too_soon' }, 'too_soon');
  assert.deepStrictEqual(t, { log: false, reason: 'too_soon' });
});

test('telemetrie : changement de raison => on trace', () => {
  const t = verdictTelemetry({ verdict: 'stay', reason: 'ok' }, 'too_soon');
  assert.deepStrictEqual(t, { log: true, reason: 'ok' });
});

test('telemetrie : un verdict migrate se trace TOUJOURS, meme raison inchangee', () => {
  const t = verdictTelemetry({ verdict: 'migrate', reason: 'water' }, 'water');
  assert.deepStrictEqual(t, { log: true, reason: 'water' });
});

test('telemetrie : verdict absent/invalide => ne trace pas, garde la raison precedente', () => {
  assert.deepStrictEqual(verdictTelemetry(null, 'ok'), { log: false, reason: 'ok' });
  assert.deepStrictEqual(verdictTelemetry(undefined, null), { log: false, reason: null });
});

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

test('cellules epuisees autour ET filon qui ne paie plus => migrate:depleted', () => {
  // Dépletion spatiale + rendement sous le plancher `exhausted` : on tourne vraiment en rond.
  const r = zoneVerdict(healthy({ depletedNear: DEPLETED_NEAR_MAX, ironMined: EXHAUSTED_IRON_MIN - 1 }));
  assert.strictEqual(r.verdict, 'migrate');
  assert.strictEqual(r.reason, 'depleted');
});

test('cellules epuisees autour MAIS le filon COURANT paie encore => on reste', () => {
  // RÉGRESSION world_mn10 (27/07) : des bots à 36-103 fers/~20 min migraient sur le SEUL signal
  // depletedNear≥3, perdant base+mine+bois pour une zone fraîche souvent SANS ARBRES (churn
  // bois↔profondeur, frein n°1, done 1→0). Un bot qui sort du fer n'est PAS « en rond ».
  const r = zoneVerdict(healthy({ depletedNear: DEPLETED_NEAR_MAX, ironMined: 40 }));
  assert.strictEqual(r.verdict, 'stay');
  assert.strictEqual(r.reason, 'ok');
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

// ─── Quel echec accuse la ZONE ? (mesure live 27/07, `world_mn9`) ───────────────────────────────
// La cascade observee : zone rasee -> plus de bois -> plus de batons -> PLUS DE PIOCHE -> le bot
// passe devant les veines de fer sans pouvoir les miner et casse la pierre a mains nues.
// Le signal decisif n'etait PAS `logs not_found` (le bot n'essaie meme plus de couper du bois) :
// c'etait `pick_recovery_failed: no_sticks`. Compter le manque de MATIERE BOIS, quel que soit le
// but qui l'a rencontre, sinon la zone rasee ne se declare jamais rasee.

test('manque de bois : compte, quel que soit le but qui le rencontre', () => {
  assert.strictEqual(zoneFailureKind('logs', 'not_found'), 'wood');
  assert.strictEqual(zoneFailureKind('help_pick', 'pick_recovery:no_sticks'), 'wood');
  assert.strictEqual(zoneFailureKind('t1_sword', 'no_wood'), 'wood');
  assert.strictEqual(zoneFailureKind('crafting_table', 'no_planks'), 'wood');
});

test('nappe d eau : compte comme eau', () => {
  assert.strictEqual(zoneFailureKind('descend_y16', 'water_ahead'), 'water');
  assert.strictEqual(zoneFailureKind('iron_deep', 'drowning'), 'water');
});

test('un echec sans rapport avec la zone ne compte pas', () => {
  assert.strictEqual(zoneFailureKind('iron_deep', 'no_pickaxe'), null);
  assert.strictEqual(zoneFailureKind('food_stock', 'no_prey'), null);
  assert.strictEqual(zoneFailureKind('descend_y16', 'dig_failed'), null);
  assert.strictEqual(zoneFailureKind('x', undefined), null);
  assert.strictEqual(zoneFailureKind(), null);
});

// `not_found` seul est ambigu : il n accuse la zone que sur un but de BOIS.
test('not_found n accuse la zone que sur un but de bois', () => {
  assert.strictEqual(zoneFailureKind('planks', 'not_found'), 'wood');
  assert.strictEqual(zoneFailureKind('cobble_furnace', 'not_found'), null);
});

// ─── L ETAT DE ZONE DOIT SURVIVRE AU PROCESS (cause racine, 27/07 soir) ─────────────────────────
// La migration n a JAMAIS tire de la journee alors que la flotte etait visiblement noyee
// (descend_y16 water_ahead 77-82 %, ~20 sauvetages eau par session). Raison : l horloge de zone
// et les compteurs vivaient dans le PROCESS, or le self-healing relance un bot toutes les quelques
// minutes -> chaque respawn les remettait a zero -> l hysteresis de 15 min n etait JAMAIS atteinte.
// Meme classe que les pieges #52 et #63 : une memoire d echec par process ne sert a rien quand les
// sessions redemarrent sans cesse. L etat doit vivre dans le memo de base, comme la dette de mort.

test('etat de zone : un etat frais demarre l horloge maintenant', () => {
  const s = zoneStateInit(1000);
  assert.strictEqual(s.anchoredAt, 1000);
  assert.strictEqual(s.waterFails, 0);
  assert.strictEqual(s.logsNotFound, 0);
  assert.strictEqual(s.lastMigrationAt, 0);
});

test('etat de zone : un etat persiste est REPRIS tel quel (l horloge continue)', () => {
  const saved = { anchoredAt: 500, waterFails: 4, logsNotFound: 2, ironMined: 7, miningMs: 60000, lastMigrationAt: 300 };
  const s = zoneStateLoad(saved, 999999);
  assert.strictEqual(s.anchoredAt, 500, 'l horloge ne doit PAS repartir de zero au respawn');
  assert.strictEqual(s.waterFails, 4);
  assert.strictEqual(s.logsNotFound, 2);
});

test('etat de zone : un etat corrompu ou absent retombe sur un etat frais', () => {
  assert.strictEqual(zoneStateLoad(null, 1000).anchoredAt, 1000);
  assert.strictEqual(zoneStateLoad({}, 1000).anchoredAt, 1000);
  assert.strictEqual(zoneStateLoad({ anchoredAt: 'x' }, 1000).anchoredAt, 1000);
});

// Une horloge venue du futur (changement d heure, memo d un autre monde) ne doit pas geler la zone.
test('etat de zone : une horloge dans le futur est reinitialisee', () => {
  assert.strictEqual(zoneStateLoad({ anchoredAt: 5000 }, 1000).anchoredAt, 1000);
});

test('etat de zone : apres migration, tout repart de zero SAUF le cooldown', () => {
  const s = zoneStateAfterMigration(7000);
  assert.strictEqual(s.anchoredAt, 7000);
  assert.strictEqual(s.waterFails, 0);
  assert.strictEqual(s.lastMigrationAt, 7000, 'le cooldown doit courir depuis la migration');
});
