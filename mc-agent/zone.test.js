'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  zoneVerdict, verdictTelemetry, pickMigrationTarget, migrationLeg, legIsGood, minDistFor, zoneFailureKind,
  zoneStateInit, zoneStateLoad, zoneStateAfterMigration,
  MIN_MINUTES_IN_ZONE, MIGRATION_COOLDOWN_MS, WATER_FAILS_MAX, LOGS_NOT_FOUND_MAX,
  EXHAUSTED_MINING_MIN, EXHAUSTED_IRON_MIN, DEPLETED_NEAR_MAX, MIGRATE_MIN_DIST, MIGRATE_MAX_DIST,
  MIGRATE_FAR_MIN_DIST, MIGRATE_WOOD_MIN_DIST, MIGRATE_MIN_PROGRESS, MIN_MINUTES_URGENT, COOLDOWN_URGENT_MS,
  LEG_DIST, LOADED_RADIUS, legHeading, LEG_STUCK_MIN,
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

test('eau : la distance normale suffit (le problème est local)', () => {
  assert.strictEqual(minDistFor('water'), MIGRATE_MIN_DIST);
  assert.strictEqual(minDistFor(undefined), MIGRATE_MIN_DIST);
});

// ⚠️ BOIS = plancher INVERSÉ (mesuré live world_mn11 : 13 migrations 'wood' sur 16 échouaient
// underground:true). Avec le plancher normal de 200, le bot sautait par-dessus une flower_forest à
// 18 blocs pour viser une forêt à 238-374 blocs — injoignable depuis le fond de la mine. Pour
// restocker du bois on veut la forêt LA PLUS PROCHE ; le plancher ne sert plus qu'à garantir un
// déplacement RÉEL (≥ MIGRATE_MIN_PROGRESS).
test('bois : plancher COURT (= MIGRATE_MIN_PROGRESS) => la forêt la plus proche', () => {
  assert.strictEqual(minDistFor('wood'), MIGRATE_WOOD_MIN_DIST);
  assert.strictEqual(MIGRATE_WOOD_MIN_DIST, MIGRATE_MIN_PROGRESS);
  assert.ok(MIGRATE_WOOD_MIN_DIST < MIGRATE_MIN_DIST, 'le plancher bois doit être BIEN plus court que 200');
});

test('bois : une forêt proche (110b) est acceptée là où le plancher 200 la refusait', () => {
  // Reproduction du cas world_mn11 : le bot en (110,1), une flower_forest à 18b (rejetée, elle
  // n'est pas un vrai déplacement) et une à 110b — retenue avec le plancher bois, refusée à 200.
  const from = { x: 110, z: 1 };
  const tooClose = { name: 'flower_forest', x: 128, z: 0 };   // ~18 blocs → sous MIGRATE_MIN_PROGRESS
  const nearForest = { name: 'flower_forest', x: 0, z: 0 };   // ~110 blocs
  const farForest = { name: 'forest', x: 384, z: 256 };       // ~374 blocs
  const biomes = [tooClose, nearForest, farForest];
  const wood = pickMigrationTarget({ from, biomes, minDist: minDistFor('wood') });
  assert.ok(wood, 'une cible bois doit être trouvée');
  assert.deepStrictEqual({ x: wood.x, z: wood.z }, { x: 0, z: 0 }, 'doit viser la forêt PROCHE, pas la lointaine');
  // Avec l'ancien plancher (200), la proche était refusée → on retombait sur la lointaine.
  const old = pickMigrationTarget({ from, biomes, minDist: MIGRATE_MIN_DIST });
  assert.deepStrictEqual({ x: old.x, z: old.z }, { x: 384, z: 256 }, 'plancher 200 = forêt lointaine (le bug)');
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
  // preuve MODEREE (au seuil, pas 3x) : c'est bien l'hysteresis normale qu'on teste ici
  const r = zoneVerdict(healthy({ minutesInZone: MIN_MINUTES_IN_ZONE - 1, waterFails: WATER_FAILS_MAX }));
  assert.strictEqual(r.verdict, 'stay');
  assert.strictEqual(r.reason, 'too_soon');
});

test('zone noyee et on a passe le seuil de temps => on migre', () => {
  const r = zoneVerdict(healthy({ minutesInZone: MIN_MINUTES_IN_ZONE, waterFails: WATER_FAILS_MAX }));
  assert.strictEqual(r.verdict, 'migrate');
});

test('deux migrations rapprochees interdites (cooldown)', () => {
  // preuve MODEREE : le cooldown LONG ne s'applique qu'hors regime d'urgence
  const r = zoneVerdict(healthy({ waterFails: WATER_FAILS_MAX, lastMigrationAt: NOW - (MIGRATION_COOLDOWN_MS - 1) }));
  assert.strictEqual(r.verdict, 'stay');
  assert.strictEqual(r.reason, 'cooldown');
});

test('cooldown ecoule => la migration redevient possible', () => {
  const r = zoneVerdict(healthy({ waterFails: WATER_FAILS_MAX, lastMigrationAt: NOW - MIGRATION_COOLDOWN_MS }));
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

test('cible bois : une foret iron-epuisee reste valable (les arbres, eux, restent)', () => {
  // world_mn12 (28/07) : TOUTES les forets accessibles etaient marquees iron-`depleted` (les
  // ouvriers y avaient mine le fer) -> la migration bois les ecartait et ne gardait qu'une foret
  // a 371 blocs (beyond_loaded -> NoPath -> moved:0) -> le bois n'arrivait JAMAIS -> deadlock pioche
  // -> mapper_armor mort toute la nuit. L'epuisement traque le MINERAI, pas les arbres.
  const near = { name: 'forest', x: 250, z: 0 };   // iron-depletee MAIS proche/atteignable
  const far = { name: 'forest', x: 900, z: 0 };     // non depletee MAIS trop loin (chunks non charges)
  const depleted = [{ x: 250, z: 0 }];
  const t = pickMigrationTarget({ from: FROM, biomes: [near, far], depleted, minDist: MIGRATE_MIN_DIST, reason: 'wood' });
  assert.strictEqual(t.x, 250, 'une migration bois doit garder la foret proche meme iron-epuisee');
});

test('cible epuisement : une cellule epuisee reste ecartee (comportement ore inchange)', () => {
  const near = { name: 'forest', x: 250, z: 0 };
  const far = { name: 'forest', x: 900, z: 0 };
  const depleted = [{ x: 250, z: 0 }];
  const t = pickMigrationTarget({ from: FROM, biomes: [near, far], depleted, minDist: MIGRATE_MIN_DIST, reason: 'depleted' });
  assert.strictEqual(t.x, 900, 'une migration d epuisement doit toujours ecarter la cellule epuisee');
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

// La longueur d'une jambe doit tenir DANS LES CHUNKS CHARGES (view-distance 6 = 96 blocs),
// sinon le pathfinder est aveugle et rend NoPath : c'est ce qui faisait echouer toutes les
// migrations bois (`hop_failed moved:8`) tant que la jambe valait 128.
test('jambe : un point sur le cap, DANS le rayon de chunks charges', () => {
  const a = migrationLeg({ from: FROM, heading: 0, legs: 0 });
  assert.strictEqual(Math.round(Math.hypot(a.x - FROM.x, a.z - FROM.z)), LEG_DIST);
  assert.ok(LEG_DIST < LOADED_RADIUS, 'une jambe doit rester dans les chunks charges');
});

test('jambe : les jambes s enchainent depuis la position courante', () => {
  const l1 = migrationLeg({ from: FROM, heading: 0, legs: 0 });
  const l2 = migrationLeg({ from: l1, heading: 0, legs: 1 });
  assert.ok(Math.hypot(l2.x - FROM.x, l2.z - FROM.z) > Math.hypot(l1.x - FROM.x, l1.z - FROM.z));
});

test('jambe : au-dela du cap total, on s arrete (pas de nomadisme infini)', () => {
  assert.strictEqual(migrationLeg({ from: FROM, heading: 0, legs: 99 }), null);
});

// ─── Contournement d'obstacle : le cap DÉVIE quand une jambe n'a pas progressé ───────────────────
// Cause racine mesuree world_mn12 (28/07) : la jambe de migration vise `GoalNearXZ` + `canDig=false`
// ; sur terrain vallonne/obstrue le pathfinder rend NoPath INSTANTANE, le bot ne bouge pas, et la
// jambe suivante — calculee au MEME cap depuis la MEME position — re-vise le MEME point inatteignable
// => degenere MAX_LEGS fois sur place (`moved:1/9`, migration `underground:false` en boucle). En
// deviant le cap a chaque blocage, on tente de contourner l'obstacle au lieu de le re-percuter.
test('legHeading : cap inchange tant que ca progresse (stuck=0)', () => {
  assert.strictEqual(legHeading(0.5, 0), 0.5);
});
test('legHeading : le cap DÉVIE quand la jambe precedente a echoue', () => {
  const base = 0;
  assert.notStrictEqual(legHeading(base, 1), base);   // 1er blocage : on ne re-vise PAS le meme point
});
test('legHeading : la deviation OSCILLE de part et d autre du cap de base', () => {
  const base = 0;
  const d1 = legHeading(base, 1) - base;
  const d2 = legHeading(base, 2) - base;
  assert.ok(d1 > 0 && d2 < 0, 'deviations de signes opposes pour balayer les deux cotes');
});
test('legHeading : la deviation GRANDIT quand on reste bloque', () => {
  const base = 0;
  assert.ok(Math.abs(legHeading(base, 3) - base) > Math.abs(legHeading(base, 1) - base));
});
test('legHeading : la deviation est bornee (ne repart jamais franchement en arriere)', () => {
  const base = 0;
  for (let s = 1; s < 30; s++) {
    assert.ok(Math.abs(legHeading(base, s) - base) <= Math.PI, 'deviation <= 180deg');
  }
});
test('LEG_STUCK_MIN : un seuil de progres franc, sous une vraie jambe', () => {
  assert.ok(LEG_STUCK_MIN > 0 && LEG_STUCK_MIN < LEG_DIST);
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

// ⚠️ world_mn12 28/07 : la chaine mapper_armor bouclait gift_planks not_found A VIE en wood-desert.
// L escape noWood (66a5e45) sur gift_planks depend de _zoneLogsNotFound >= 8, mais ce compteur
// n est alimente QUE par les buts de _WOOD_GOALS. gift_planks/gift_fuel (gatherLog du gift chain)
// n y etaient PAS -> leurs echecs n incrementaient jamais le compteur -> noWood restait false a vie
// sur un worker en mapper_armor (qui ne lance jamais le `logs`/`plank_buffer` de la chaine principale)
// -> gift_planks deadlock -> mappeurs JAMAIS armes. Meme classe que #52/#61 : un escape cable sur
// un signal que la branche concernee ne produit jamais.
test('les buts bois de la chaine gift comptent aussi (mapper_armor wood-desert)', () => {
  assert.strictEqual(zoneFailureKind('gift_planks', 'not_found'), 'wood');
  assert.strictEqual(zoneFailureKind('gift_fuel', 'not_found'), 'wood');
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

// ─── PREUVE ECRASANTE : ne pas faire mariner un bot dans une zone PROUVEE morte ─────────────────
// Regression signalee par Massii : « avant on reussissait en 45 min a avoir quasi fini toute
// l armure », et la l armure stagne a 3 depuis des heures. Mesure a l appui :
//     logsNotFound: 24 (seuil 8) - depletedNear: 10 (seuil 3) - ironMined: 0  =>  verdict STAY
// L hysteresis (15 min) et le cooldown (20 min) sont la pour empecher le NOMADISME sur une
// preuve FAIBLE. Face a une preuve ecrasante ils deviennent absurdes : le bot reste 20 min dans
// une zone ou il ne peut RIEN faire. Un joueur part tout de suite. Les garde-fous restent, mais
// avec des seuils d urgence.

test('preuve ecrasante : on part sans attendre les 15 min', () => {
  const r = zoneVerdict(healthy({
    minutesInZone: MIN_MINUTES_URGENT,
    logsNotFound: LOGS_NOT_FOUND_MAX * 3,
  }));
  assert.strictEqual(r.verdict, 'migrate');
  assert.strictEqual(r.reason, 'wood');
});

test('preuve ecrasante : le cooldown long ne cloue plus le bot 20 min', () => {
  const r = zoneVerdict(healthy({
    minutesInZone: MIN_MINUTES_URGENT,
    depletedNear: DEPLETED_NEAR_MAX * 3,
    ironMined: 0,                                  // `depleted` exige aussi un rendement au plancher
    lastMigrationAt: NOW - COOLDOWN_URGENT_MS,
  }));
  assert.strictEqual(r.verdict, 'migrate');
});

// Les garde-fous ne DISPARAISSENT pas : sinon la flotte devient nomade et ne produit plus rien.
test('preuve ecrasante mais on vient TOUT JUSTE d arriver => on reste quand meme', () => {
  const r = zoneVerdict(healthy({
    minutesInZone: MIN_MINUTES_URGENT - 1,
    logsNotFound: LOGS_NOT_FOUND_MAX * 5,
  }));
  assert.strictEqual(r.verdict, 'stay');
  assert.strictEqual(r.reason, 'too_soon');
});

test('preuve ecrasante mais migration il y a 30 s => on reste (anti yo-yo)', () => {
  const r = zoneVerdict(healthy({
    minutesInZone: MIN_MINUTES_URGENT,
    logsNotFound: LOGS_NOT_FOUND_MAX * 5,
    lastMigrationAt: NOW - 30000,
  }));
  assert.strictEqual(r.verdict, 'stay');
  assert.strictEqual(r.reason, 'cooldown');
});

// Une preuve seulement MODEREE garde les seuils prudents d origine.
test('preuve moderee : les seuils prudents restent en vigueur', () => {
  const r = zoneVerdict(healthy({ minutesInZone: MIN_MINUTES_URGENT, logsNotFound: LOGS_NOT_FOUND_MAX }));
  assert.strictEqual(r.verdict, 'stay');
  assert.strictEqual(r.reason, 'too_soon');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// FENÊTRE GLISSANTE DES COMPTEURS D'ÉVÉNEMENTS (run world_mn14, 28/07)
// ════════════════════════════════════════════════════════════════════════════════════════════════
// Les compteurs d'événements étaient des CUMULS DE ZONE : un bot au passé productif ne migrait
// JAMAIS, même d'une zone morte. Verdicts RÉELS extraits des session-*.jsonl :
//   stay/ok       minutesInZone 221 waterFails 25 logsNotFound 5 ironMined 150 miningMinutes 2 depletedNear 23
//   stay/cooldown minutesInZone 282 waterFails 14 logsNotFound 8 ironMined  67 miningMinutes 3 depletedNear 29
// 150 fers EN CUMUL, 0 récemment (miningMinutes 2 !), 23 cellules épuisées autour — et le bot vote
// « rester » parce que `ironMined=150` passe la garde anti-migration « le filon produit ».
// Cascade : pas de migration → pas de bois frais → pas de combustible → armures jamais finies.

const {
  windowAdd, windowSum, windowPrune, windowLoad, ZONE_WINDOW_MS, ZONE_BUCKET_MS,
} = require('./zone');

const T0 = 100 * 3600 * 1000;   // horloge de référence des tests de fenêtre (injectée partout)

// ─── Le helper de fenêtre ───────────────────────────────────────────────────────────────────────

test('fenetre : la somme ne compte que ce qui est DANS la fenetre', () => {
  let w = windowAdd([], 5, T0);
  w = windowAdd(w, 3, T0 + 5 * 60000);
  assert.strictEqual(windowSum(w, T0 + 5 * 60000), 8);
});

test('fenetre : un evenement plus vieux que la fenetre SORT du compte', () => {
  const w = windowAdd([], 150, T0);
  assert.strictEqual(windowSum(w, T0), 150);
  assert.strictEqual(windowSum(w, T0 + ZONE_WINDOW_MS), 0, 'pile au bord => dehors');
  assert.strictEqual(windowSum(w, T0 + 3 * 3600 * 1000), 0, '3 h plus tard => plus rien');
});

test('fenetre : juste avant le bord, l evenement compte encore', () => {
  const w = windowAdd([], 7, T0);
  assert.strictEqual(windowSum(w, T0 + ZONE_WINDOW_MS - 1), 7);
});

test('fenetre : les ajouts d une meme minute sont fusionnes (memo borne)', () => {
  let w = [];
  for (let i = 0; i < 40; i++) w = windowAdd(w, 1, T0 + i * 1000);   // 40 s d'affilee
  assert.strictEqual(w.length, 1, 'un seul seau par minute');
  assert.strictEqual(windowSum(w, T0 + 40000), 40);
});

test('fenetre : le nombre d entrees reste borne meme sous un deluge d evenements', () => {
  let w = [];
  for (let i = 0; i < 3600; i++) w = windowAdd(w, 1, T0 + i * 1000);   // 1/s pendant 1 h
  assert.ok(w.length <= ZONE_WINDOW_MS / ZONE_BUCKET_MS + 1, `bornee, vu ${w.length}`);
  // Granularite assumee : le seau qui chevauche le bord de la fenetre sort ENTIER (ici le seau
  // t-20min, soit 60 evenements) => 19 minutes pleines. A l'echelle d'un verdict qui juge une zone
  // sur 20 min, une minute de resolution n'a aucune importance ; la borne memoire, si.
  assert.strictEqual(windowSum(w, T0 + 3600 * 1000), 1140, '19 seaux pleins de 60');
});

test('fenetre : windowAdd ne MUTE PAS son entree (module pur)', () => {
  const before = windowAdd([], 4, T0);
  const snapshot = JSON.parse(JSON.stringify(before));
  windowAdd(before, 9, T0 + 1000);
  assert.deepStrictEqual(before, snapshot);
});

test('fenetre : un ajout nul ou negatif ne fait jamais RECULER le compteur', () => {
  let w = windowAdd([], 5, T0);
  w = windowAdd(w, 0, T0 + 1000);
  w = windowAdd(w, -3, T0 + 2000);
  assert.strictEqual(windowSum(w, T0 + 2000), 5);
});

test('fenetre : windowLoad assainit un memo corrompu (jamais de crash au respawn)', () => {
  assert.deepStrictEqual(windowLoad(null), []);
  assert.deepStrictEqual(windowLoad('nope'), []);
  assert.deepStrictEqual(windowLoad([null, 3, { t: 'x', n: 1 }, { t: 1, n: NaN }, { t: 2, n: -1 }]), []);
  assert.deepStrictEqual(windowLoad([{ t: 20, n: 1 }, { t: 10, n: 2 }]), [{ t: 10, n: 2 }, { t: 20, n: 1 }],
    'trie par horodatage');
});

test('fenetre : une entree DATEE DU FUTUR est jetee (changement d heure, memo herite)', () => {
  const w = [{ t: T0 + 3600000, n: 99 }];
  assert.strictEqual(windowSum(w, T0), 0);
  assert.deepStrictEqual(windowPrune(w, T0), []);
});

// ─── L'état persisté porte la fenêtre (le bot meurt toutes les 3 min : #63b) ─────────────────────

test('etat de zone : les fenetres naissent vides', () => {
  const s = zoneStateInit(T0);
  assert.deepStrictEqual(s.waterFailsWin, []);
  assert.deepStrictEqual(s.logsNotFoundWin, []);
  assert.deepStrictEqual(s.ironMinedWin, []);
});

test('etat de zone : la fenetre SURVIT au respawn, mais elaguee de ce qui a expire', () => {
  const saved = {
    anchoredAt: T0,
    ironMinedWin: [{ t: T0, n: 150 }, { t: T0 + 3 * 3600000, n: 4 }],
  };
  const s = zoneStateLoad(saved, T0 + 3 * 3600000 + 60000);
  assert.deepStrictEqual(s.ironMinedWin, [{ t: T0 + 3 * 3600000, n: 4 }],
    'le fer d il y a 3 h ne doit pas ressusciter au respawn');
});

test('etat de zone : un memo SANS fenetre (ancien format) se charge sans casser', () => {
  const s = zoneStateLoad({ anchoredAt: T0, waterFails: 4, ironMined: 7 }, T0 + 1000);
  assert.deepStrictEqual(s.ironMinedWin, []);
  assert.strictEqual(s.ironMined, 7, 'le cumul de session reste, lui');
});

test('etat de zone : une migration vide les fenetres', () => {
  const s = zoneStateAfterMigration(T0);
  assert.deepStrictEqual(s.ironMinedWin, []);
  assert.deepStrictEqual(s.waterFailsWin, []);
});

// ─── LES DEUX VERDICTS RÉELS DOIVENT BASCULER ───────────────────────────────────────────────────

/** Verdict réel n°1 (world_mn14) : stay/ok — 221 min sur place, 150 fers EN CUMUL, 0 récemment. */
function realA(over = {}) {
  return Object.assign({
    minutesInZone: 221, waterFails: 25, logsNotFound: 5, ironMined: 150,
    miningMinutes: 2, depletedNear: 23, dryCellKnown: true, lastMigrationAt: 0, now: NOW,
  }, over);
}

/** Verdict réel n°2 (world_mn14) : stay/cooldown — 282 min, 67 fers en cumul, 29 cellules epuisees. */
function realB(over = {}) {
  return Object.assign({
    minutesInZone: 282, waterFails: 14, logsNotFound: 8, ironMined: 67,
    miningMinutes: 3, depletedNear: 29, dryCellKnown: true, lastMigrationAt: 0, now: NOW,
  }, over);
}

test('LE BUG : verdict reel n1 avec le CUMUL de session => le bot reste dans une zone morte', () => {
  const r = zoneVerdict(realA());
  assert.strictEqual(r.verdict, 'stay');
  assert.strictEqual(r.reason, 'ok', '150 fers cumules passent la garde « le filon produit »');
});

test('LE FIX : verdict reel n1 avec le fer FENETRE => migrate:depleted', () => {
  const r = zoneVerdict(realA({ ironMined: 0 }));
  assert.strictEqual(r.verdict, 'migrate');
  assert.strictEqual(r.reason, 'depleted');
});

test('LE FIX : verdict reel n2 (hors cooldown) avec les compteurs FENETRES => migrate:depleted', () => {
  // Le cumul ne se contente pas de clouer le bot : quand il finit par lacher (cooldown ecoule), il
  // migre pour le MAUVAIS MOTIF — `wood`, dont le plancher est 64 blocs (piege #63d) — alors que la
  // zone est EPUISEE et exige 600 blocs. Un saut de 64 blocs, c'est le meme sous-sol deja fouille.
  const cumul = zoneVerdict(realB());
  assert.strictEqual(cumul.reason, 'wood', 'cumul logsNotFound=8 => motif errone');
  assert.strictEqual(minDistFor(cumul.reason), MIGRATE_WOOD_MIN_DIST, '... donc 64 blocs seulement');

  const r = zoneVerdict(realB({ ironMined: 0, logsNotFound: 0, waterFails: 0 }));
  assert.strictEqual(r.verdict, 'migrate');
  assert.strictEqual(r.reason, 'depleted');
  assert.strictEqual(minDistFor(r.reason), MIGRATE_FAR_MIN_DIST, 'zone videe => on s eloigne pour de bon');
});

test('CHAINE COMPLETE : 150 fers mines il y a 3 h => la fenetre les oublie => migrate:depleted', () => {
  // Exactement ce que fait index.js : on ACCUMULE dans la fenetre, on SOMME au moment du verdict.
  const mined3hAgo = windowAdd([], 150, NOW - 3 * 3600 * 1000);
  const r = zoneVerdict(realA({ ironMined: windowSum(mined3hAgo, NOW) }));
  assert.strictEqual(r.verdict, 'migrate');
  assert.strictEqual(r.reason, 'depleted');
});

test('ANTI-CHURN (regression world_mn10) : du fer mine RECEMMENT protege toujours la zone', () => {
  // La garde qui a corrige mn10 doit rester vivante : un bot qui sort 40 fers dans la fenetre
  // n est PAS « en rond », il ne doit pas partir sur le seul signal depletedNear.
  const fresh = windowAdd([], 40, NOW - 60000);
  const r = zoneVerdict(realA({ ironMined: windowSum(fresh, NOW) }));
  assert.strictEqual(r.verdict, 'stay');
  assert.strictEqual(r.reason, 'ok');
});

test('l EAU aussi se fenetre : 25 echecs il y a 3 h ne noient plus la zone d aujourd hui', () => {
  const old = windowAdd([], 25, NOW - 3 * 3600 * 1000);
  const r = zoneVerdict(realA({
    waterFails: windowSum(old, NOW), dryCellKnown: false, depletedNear: 0, ironMined: 0,
    miningMinutes: 0,
  }));
  assert.strictEqual(r.verdict, 'stay', 'plus aucun echec eau recent');
});

test('le BOIS aussi se fenetre : des echecs recents suffisent, les vieux non', () => {
  const old = windowAdd([], LOGS_NOT_FOUND_MAX, NOW - 3 * 3600 * 1000);
  const recent = windowAdd(old, LOGS_NOT_FOUND_MAX, NOW - 60000);
  const base = { depletedNear: 0, ironMined: 40, miningMinutes: 0, dryCellKnown: true, waterFails: 0 };
  assert.strictEqual(zoneVerdict(realA(Object.assign({}, base, { logsNotFound: windowSum(old, NOW) }))).verdict, 'stay');
  const r = zoneVerdict(realA(Object.assign({}, base, { logsNotFound: windowSum(recent, NOW) })));
  assert.strictEqual(r.verdict, 'migrate');
  assert.strictEqual(r.reason, 'wood');
});

// ─── Le trou `exhausted` (documenté, cf. rapport) ────────────────────────────────────────────────
// `exhausted` mesure un EFFORT cumule (miningMinutes) contre un RENDEMENT desormais fenetre.
// L effort reste un CUMUL DE ZONE a dessein : ce n est pas un flux d evenements mais un chronometre,
// et le fenetrer a 20 min exigerait de miner 100 % du temps => la regle serait morte pour de bon.
// Fenetrer le seul rendement suffit a la REANIMER : un bot au passe productif la declenche enfin.

test('exhausted : un passe productif ne protege plus une zone qui ne rend PLUS rien', () => {
  const r = zoneVerdict(healthy({
    miningMinutes: EXHAUSTED_MINING_MIN, ironMined: 0, depletedNear: 0,
  }));
  assert.strictEqual(r.verdict, 'migrate');
  assert.strictEqual(r.reason, 'exhausted');
});

test('exhausted : du fer dans la fenetre garde le bot sur place', () => {
  const r = zoneVerdict(healthy({
    miningMinutes: EXHAUSTED_MINING_MIN, ironMined: EXHAUSTED_IRON_MIN, depletedNear: 0,
  }));
  assert.strictEqual(r.verdict, 'stay');
});

test('fenetre : une horloge qui RECULE oublie, elle n empile pas (jamais de seau en double)', () => {
  // NTP, veille/reprise : `now` peut repasser en arriere. L'elagage jetant ce qui est date du
  // FUTUR, un saut en arriere fait PERDRE les seaux recents — le compteur repart du passe. C'est
  // le sens sur : moins de preuve => le bot RESTE, il ne migre jamais sur du bruit d'horloge.
  let w = windowAdd([], 2, T0 + 5 * 60000);
  w = windowAdd(w, 3, T0);                       // en arriere : le seau « futur » est jete
  assert.deepStrictEqual(w, [{ t: T0, n: 3 }]);
  w = windowAdd(w, 4, T0 + 5 * 60000);           // l'horloge repart en avant
  assert.strictEqual(w.length, 2, 'deux seaux distincts');
  assert.deepStrictEqual(w.map((e) => e.t), [T0, T0 + 5 * 60000], 'et la liste reste triee');
  assert.strictEqual(windowSum(w, T0 + 5 * 60000), 7);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// MIGRATION QUI ABOUTIT (360 sessions des 17-18/08 : 917 `zone_migration_start` → 72 `zone_migrated`)
// ════════════════════════════════════════════════════════════════════════════════════════════════
// Trois causes pures, testées ici (la préemption du planner, elle, vit dans index.js) :
//   (a) une migration « loin » (depleted/exhausted, plancher 600) cassait la marche dès 64 blocs
//       sur le premier bosquet venu → les 43 `depleted` « réussies » ont dist 50-250 : même secteur ;
//   (b) un ÉCHEC coûtait 20 min de cooldown, et la cible déterministe suivante était LA MÊME ;
//   (c) migrer de NUIT = un bot souvent nu qui marche 600-1200 blocs en hard → mort → échec.

const {
  migrationEarlyExitOk, zoneStateAfterFailedMigration, pruneFailedTargets,
  FAILED_TARGET_TTL_MS, FAILED_TARGET_RADIUS, FAILED_TARGETS_CAP,
} = require('./zone');

// ─── (a) Sortie anticipée sur « bon terrain » ────────────────────────────────────────────────────

test('sortie anticipee : BOIS => 64 blocs suffisent (la foret la plus proche)', () => {
  assert.strictEqual(migrationEarlyExitOk({ reason: 'wood', gone: MIGRATE_MIN_PROGRESS, minDist: minDistFor('wood') }), true);
  assert.strictEqual(migrationEarlyExitOk({ reason: 'wood', gone: MIGRATE_MIN_PROGRESS - 1, minDist: minDistFor('wood') }), false);
});

test('sortie anticipee : EAU (raison non-far) => meme plancher que le bois', () => {
  assert.strictEqual(migrationEarlyExitOk({ reason: 'water', gone: MIGRATE_MIN_PROGRESS, minDist: minDistFor('water') }), true);
  assert.strictEqual(migrationEarlyExitOk({ reason: 'water', gone: 10, minDist: minDistFor('water') }), false);
});

test('LE BUG : zone videe => 64-250 blocs ne suffisent PLUS (meme secteur deja fouille)', () => {
  for (const reason of ['depleted', 'exhausted']) {
    const minDist = minDistFor(reason);
    for (const gone of [64, 128, 250]) {
      assert.strictEqual(migrationEarlyExitOk({ reason, gone, minDist, distToTarget: 500 }), false,
        `${reason} : s arreter a ${gone} blocs = demenager dans la piece d a cote`);
    }
  }
});

test('zone videe : on accepte le bon terrain a partir de 3/4 du plancher', () => {
  const minDist = minDistFor('depleted');
  assert.strictEqual(migrationEarlyExitOk({ reason: 'depleted', gone: 0.75 * minDist, minDist, distToTarget: 300 }), true);
  assert.strictEqual(migrationEarlyExitOk({ reason: 'depleted', gone: 0.75 * minDist - 1, minDist, distToTarget: 300 }), false);
});

test('zone videe : ARRIVE a la cible (<=48) => on s arrete, quelle que soit la distance faite', () => {
  assert.strictEqual(migrationEarlyExitOk({ reason: 'exhausted', gone: 10, minDist: 600, distToTarget: 48 }), true);
  assert.strictEqual(migrationEarlyExitOk({ reason: 'exhausted', gone: 10, minDist: 600, distToTarget: 49 }), false);
});

test('zone videe sans minDist fourni => plancher far par defaut (pas 0)', () => {
  assert.strictEqual(migrationEarlyExitOk({ reason: 'depleted', gone: 100 }), false);
  assert.strictEqual(migrationEarlyExitOk({ reason: 'depleted', gone: 0.75 * MIGRATE_FAR_MIN_DIST }), true);
});

test('marche a l aveugle (pas de cible : distToTarget infini) => seule la distance faite compte', () => {
  assert.strictEqual(migrationEarlyExitOk({ reason: 'depleted', gone: 300, minDist: 600, distToTarget: Infinity }), false);
  assert.strictEqual(migrationEarlyExitOk({ reason: 'depleted', gone: 460, minDist: 600, distToTarget: Infinity }), true);
  assert.strictEqual(migrationEarlyExitOk({ reason: 'wood', gone: 70, minDist: 64, distToTarget: Infinity }), true);
});

test('sortie anticipee : entrees absurdes => on continue de marcher (jamais de sortie sur du bruit)', () => {
  assert.strictEqual(migrationEarlyExitOk({ reason: 'wood', gone: NaN }), false);
  assert.strictEqual(migrationEarlyExitOk({ reason: 'depleted', gone: undefined, distToTarget: NaN }), false);
  assert.strictEqual(migrationEarlyExitOk(), false);
});

// ─── (b) Un échec ne doit plus coûter 20 min ────────────────────────────────────────────────────

test('apres un ECHEC de migration, le cooldown est court (5 min), pas 20', () => {
  const r = zoneVerdict(healthy({
    waterFails: WATER_FAILS_MAX, lastMigrationAt: NOW - COOLDOWN_URGENT_MS, lastMigrationFailed: true,
  }));
  assert.strictEqual(r.verdict, 'migrate');
  assert.strictEqual(r.reason, 'water');
});

test('apres un echec, le cooldown court existe quand meme (anti boucle chaude)', () => {
  const r = zoneVerdict(healthy({
    waterFails: WATER_FAILS_MAX, lastMigrationAt: NOW - (COOLDOWN_URGENT_MS - 1), lastMigrationFailed: true,
  }));
  assert.strictEqual(r.verdict, 'stay');
  assert.strictEqual(r.reason, 'cooldown');
});

test('apres une migration REUSSIE, le cooldown long reste de 20 min', () => {
  const r = zoneVerdict(healthy({
    waterFails: WATER_FAILS_MAX, lastMigrationAt: NOW - COOLDOWN_URGENT_MS, lastMigrationFailed: false,
  }));
  assert.strictEqual(r.verdict, 'stay');
  assert.strictEqual(r.reason, 'cooldown');
});

test('un opts.cooldownMs explicite prime sur le cooldown court d echec', () => {
  const r = zoneVerdict(healthy({
    waterFails: WATER_FAILS_MAX, lastMigrationAt: NOW - COOLDOWN_URGENT_MS, lastMigrationFailed: true,
  }), { cooldownMs: MIGRATION_COOLDOWN_MS });
  assert.strictEqual(r.reason, 'cooldown');
});

test('lastMigrationFailed non booleen (memo bizarre) => traite comme une reussite (prudent)', () => {
  const r = zoneVerdict(healthy({
    waterFails: WATER_FAILS_MAX, lastMigrationAt: NOW - COOLDOWN_URGENT_MS, lastMigrationFailed: 'yes',
  }));
  assert.strictEqual(r.reason, 'cooldown');
});

// ─── (c) Pas de trek de nuit ─────────────────────────────────────────────────────────────────────

test('NUIT : une zone noyee ne declenche PAS de migration (bot nu, 600-1200 blocs en hard)', () => {
  const r = zoneVerdict(healthy({ waterFails: WATER_FAILS_MAX, isNight: true }));
  assert.strictEqual(r.verdict, 'stay');
  assert.strictEqual(r.reason, 'night');
});

test('NUIT : evaluee APRES too_soon et cooldown (on garde la raison la plus ancienne)', () => {
  const soon = zoneVerdict(healthy({ minutesInZone: 1, waterFails: WATER_FAILS_MAX, isNight: true }));
  assert.strictEqual(soon.reason, 'too_soon');
  const cool = zoneVerdict(healthy({ waterFails: WATER_FAILS_MAX, isNight: true, lastMigrationAt: NOW - 1000 }));
  assert.strictEqual(cool.reason, 'cooldown');
});

test('NUIT : meme une preuve ecrasante attend le jour', () => {
  const r = zoneVerdict(healthy({ minutesInZone: MIN_MINUTES_URGENT, logsNotFound: LOGS_NOT_FOUND_MAX * 5, isNight: true }));
  assert.strictEqual(r.verdict, 'stay');
  assert.strictEqual(r.reason, 'night');
});

test('JOUR (isNight false) ou heure inconnue (null/absent) => pas de gate', () => {
  assert.strictEqual(zoneVerdict(healthy({ waterFails: WATER_FAILS_MAX, isNight: false })).verdict, 'migrate');
  assert.strictEqual(zoneVerdict(healthy({ waterFails: WATER_FAILS_MAX, isNight: null })).verdict, 'migrate');
  assert.strictEqual(zoneVerdict(healthy({ waterFails: WATER_FAILS_MAX })).verdict, 'migrate');
});

// ─── (b bis) La cible ratée est écartée 45 min ──────────────────────────────────────────────────
// `pickMigrationTarget` est DÉTERMINISTE : sans mémoire d'échec, le re-essai visait exactement la
// même cellule — re-échec garanti au même endroit.

const T_AVOID = 50 * 3600 * 1000;
const NEAR_FOREST = { name: 'forest', x: 0, z: 400 };
const FAR_FOREST = { name: 'forest', x: 0, z: 900 };

test('cible ratee recemment => ecartee, on prend la suivante', () => {
  const avoid = [{ x: 0, z: 400, at: T_AVOID - 10 * 60000 }];
  const t = pickMigrationTarget({ from: FROM, biomes: [NEAR_FOREST, FAR_FOREST], avoid, now: T_AVOID });
  assert.deepStrictEqual({ x: t.x, z: t.z }, { x: 0, z: 900 });
});

test('cible ratee : l exclusion couvre un rayon (une cellule voisine de la cible ratee aussi)', () => {
  const avoid = [{ x: 0, z: 400 + FAILED_TARGET_RADIUS, at: T_AVOID }];
  const t = pickMigrationTarget({ from: FROM, biomes: [NEAR_FOREST, FAR_FOREST], avoid, now: T_AVOID });
  assert.strictEqual(t.z, 900, 'a FAILED_TARGET_RADIUS pile : encore ecartee');
  const avoidFar = [{ x: 0, z: 400 + FAILED_TARGET_RADIUS + 1, at: T_AVOID }];
  const t2 = pickMigrationTarget({ from: FROM, biomes: [NEAR_FOREST, FAR_FOREST], avoid: avoidFar, now: T_AVOID });
  assert.strictEqual(t2.z, 400, 'au-dela du rayon : la cible proche redevient valable');
});

test('cible ratee il y a plus de 45 min => redevient valable (la carte a pu changer)', () => {
  const avoid = [{ x: 0, z: 400, at: T_AVOID - FAILED_TARGET_TTL_MS }];
  const t = pickMigrationTarget({ from: FROM, biomes: [NEAR_FOREST, FAR_FOREST], avoid, now: T_AVOID });
  assert.strictEqual(t.z, 400);
  assert.strictEqual(FAILED_TARGET_TTL_MS, 45 * 60 * 1000);
});

test('toutes les cibles ratees => null (le caller bascule sur la marche a l aveugle)', () => {
  const avoid = [{ x: 0, z: 400, at: T_AVOID }, { x: 0, z: 900, at: T_AVOID }];
  assert.strictEqual(pickMigrationTarget({ from: FROM, biomes: [NEAR_FOREST, FAR_FOREST], avoid, now: T_AVOID }), null);
});

test('cible ratee : horloge par defaut = Date.now()', () => {
  const avoid = [{ x: 0, z: 400, at: Date.now() }];
  const t = pickMigrationTarget({ from: FROM, biomes: [NEAR_FOREST, FAR_FOREST], avoid });
  assert.strictEqual(t.z, 900);
});

test('cible ratee : entrees invalides ou datees du FUTUR ignorees (jamais d exclusion a vie)', () => {
  const avoid = [null, 3, { x: 'a', z: 400, at: T_AVOID }, { x: 0, z: 400 }, { x: 0, z: 400, at: T_AVOID + 3600000 }];
  const t = pickMigrationTarget({ from: FROM, biomes: [NEAR_FOREST, FAR_FOREST], avoid, now: T_AVOID });
  assert.strictEqual(t.z, 400);
});

test('cible ratee : le choix reste deterministe (ordre des cellules sans effet)', () => {
  const avoid = [{ x: 0, z: 400, at: T_AVOID }];
  const biomes = [NEAR_FOREST, FAR_FOREST, { name: 'plains', x: 300, z: 0 }];
  const a = pickMigrationTarget({ from: FROM, biomes, avoid, now: T_AVOID });
  const b = pickMigrationTarget({ from: FROM, biomes: biomes.slice().reverse(), avoid, now: T_AVOID });
  assert.deepStrictEqual(a, b);
});

// ─── L'état d'échec est PERSISTÉ (le bot meurt toutes les 3 min : pièges #52, #63b, #66a) ─────────

test('etat de zone : un etat frais n a ni echec ni cible ratee', () => {
  const s = zoneStateInit(T_AVOID);
  assert.strictEqual(s.lastMigrationFailed, false);
  assert.deepStrictEqual(s.failedTargets, []);
});

test('etat de zone : un memo d avant le fix (sans ces champs) se charge avec les defauts', () => {
  const s = zoneStateLoad({ anchoredAt: T_AVOID - 1000, waterFails: 3, lastMigrationAt: 7 }, T_AVOID);
  assert.strictEqual(s.lastMigrationFailed, false);
  assert.deepStrictEqual(s.failedTargets, []);
  assert.strictEqual(s.waterFails, 3, 'le reste du memo est repris tel quel');
});

test('etat de zone : l echec et les cibles ratees SURVIVENT au respawn', () => {
  const saved = {
    anchoredAt: T_AVOID - 3600000, lastMigrationFailed: true,
    failedTargets: [{ x: 10, z: 20, at: T_AVOID - 60000 }],
  };
  const s = zoneStateLoad(saved, T_AVOID);
  assert.strictEqual(s.lastMigrationFailed, true);
  assert.deepStrictEqual(s.failedTargets, [{ x: 10, z: 20, at: T_AVOID - 60000 }]);
});

test('etat de zone : au chargement, les cibles expirees, futures ou corrompues sont elaguees', () => {
  const saved = {
    anchoredAt: T_AVOID - 3600000, lastMigrationFailed: 'oui',
    failedTargets: [
      { x: 1, z: 1, at: T_AVOID - FAILED_TARGET_TTL_MS },      // expiree (pile au bord)
      { x: 2, z: 2, at: T_AVOID - FAILED_TARGET_TTL_MS + 1 },  // encore valable
      { x: 3, z: 3, at: T_AVOID + 60000 },                    // datee du futur
      { x: 'x', z: 4, at: T_AVOID }, null, 'nope',
    ],
  };
  const s = zoneStateLoad(saved, T_AVOID);
  assert.deepStrictEqual(s.failedTargets, [{ x: 2, z: 2, at: T_AVOID - FAILED_TARGET_TTL_MS + 1 }]);
  assert.strictEqual(s.lastMigrationFailed, false, 'un drapeau non booleen ne compte pas comme un echec');
});

test('etat de zone : la liste des cibles ratees est bornee aux plus RECENTES', () => {
  const failedTargets = [];
  for (let i = 0; i < 12; i++) failedTargets.push({ x: i, z: i, at: T_AVOID - (12 - i) * 60000 });
  const s = zoneStateLoad({ anchoredAt: T_AVOID - 3600000, failedTargets: failedTargets.slice().reverse() }, T_AVOID);
  assert.strictEqual(FAILED_TARGETS_CAP, 8);
  assert.strictEqual(s.failedTargets.length, FAILED_TARGETS_CAP);
  assert.deepStrictEqual(s.failedTargets.map((e) => e.x), [4, 5, 6, 7, 8, 9, 10, 11], 'les 8 plus recentes, triees');
});

test('pruneFailedTargets : ne mute pas son entree (module pur)', () => {
  const list = [{ x: 1, z: 1, at: T_AVOID }, { x: 2, z: 2, at: 0 }];
  const snap = JSON.parse(JSON.stringify(list));
  pruneFailedTargets(list, T_AVOID);
  assert.deepStrictEqual(list, snap);
  assert.deepStrictEqual(pruneFailedTargets('nope', T_AVOID), []);
});

function _richState() {
  return Object.assign(zoneStateInit(T_AVOID - 3600000), {
    waterFails: 9, logsNotFound: 4, ironMined: 30, miningMs: 600000, lastMigrationAt: 0,
    waterFailsWin: [{ t: T_AVOID - 60000, n: 5 }],
    ironMinedWin: [{ t: T_AVOID - 120000, n: 2 }],
  });
}

test('echec de migration : l horloge et les compteurs de zone NE repartent PAS de zero', () => {
  const before = _richState();
  const s = zoneStateAfterFailedMigration(before, T_AVOID, { x: 0, z: 900 });
  assert.strictEqual(s.anchoredAt, before.anchoredAt, 'la zone n a pas change : l hysteresis continue');
  assert.strictEqual(s.waterFails, 9);
  assert.strictEqual(s.logsNotFound, 4);
  assert.strictEqual(s.ironMined, 30);
  assert.strictEqual(s.miningMs, 600000);
  assert.deepStrictEqual(s.waterFailsWin, before.waterFailsWin);
  assert.deepStrictEqual(s.ironMinedWin, before.ironMinedWin);
});

test('echec de migration : cooldown arme maintenant, drapeau d echec, cible memorisee', () => {
  const s = zoneStateAfterFailedMigration(_richState(), T_AVOID, { x: 12.4, z: 899.6, source: 'mapped' });
  assert.strictEqual(s.lastMigrationAt, T_AVOID);
  assert.strictEqual(s.lastMigrationFailed, true);
  assert.deepStrictEqual(s.failedTargets, [{ x: 12, z: 900, at: T_AVOID }]);
});

test('echec de migration a l aveugle (cible null) : echec note, aucune cible memorisee', () => {
  const s = zoneStateAfterFailedMigration(_richState(), T_AVOID, null);
  assert.strictEqual(s.lastMigrationFailed, true);
  assert.strictEqual(s.lastMigrationAt, T_AVOID);
  assert.deepStrictEqual(s.failedTargets, []);
});

test('echec de migration : les cibles ratees s accumulent, bornees, et les expirees tombent', () => {
  let s = Object.assign(_richState(), { failedTargets: [{ x: -1, z: -1, at: T_AVOID - FAILED_TARGET_TTL_MS - 1 }] });
  for (let i = 0; i < 10; i++) s = zoneStateAfterFailedMigration(s, T_AVOID + i, { x: i * 200, z: 0 });
  assert.strictEqual(s.failedTargets.length, FAILED_TARGETS_CAP);
  assert.ok(!s.failedTargets.some((e) => e.x === -1), 'la cible expiree est elaguee');
  assert.strictEqual(s.failedTargets[s.failedTargets.length - 1].x, 1800, 'la plus recente est gardee');
});

test('echec de migration : ne mute pas l etat d entree (module pur)', () => {
  const before = _richState();
  const snap = JSON.parse(JSON.stringify(before));
  zoneStateAfterFailedMigration(before, T_AVOID, { x: 0, z: 900 });
  assert.deepStrictEqual(before, snap);
});

test('echec de migration sur un etat absent => etat frais marque en echec (jamais de crash)', () => {
  const s = zoneStateAfterFailedMigration(null, T_AVOID, { x: 5, z: 5 });
  assert.strictEqual(s.lastMigrationFailed, true);
  assert.strictEqual(s.lastMigrationAt, T_AVOID);
  assert.deepStrictEqual(s.failedTargets, [{ x: 5, z: 5, at: T_AVOID }]);
});

test('migration REUSSIE : le drapeau d echec tombe, mais les cibles ratees restent 45 min', () => {
  const failed = zoneStateAfterFailedMigration(_richState(), T_AVOID, { x: 0, z: 900 });
  const s = zoneStateAfterMigration(T_AVOID + 60000, failed);
  assert.strictEqual(s.lastMigrationFailed, false);
  assert.strictEqual(s.lastMigrationAt, T_AVOID + 60000);
  assert.strictEqual(s.anchoredAt, T_AVOID + 60000, 'nouvelle zone : l horloge repart');
  assert.deepStrictEqual(s.failedTargets, [{ x: 0, z: 900, at: T_AVOID }]);
  // Sans etat precedent (appel historique), aucune cible ratee — retro-compat.
  assert.deepStrictEqual(zoneStateAfterMigration(T_AVOID).failedTargets, []);
});

test('ALLER-RETOUR memo (piege #61) : ce que l echec ecrit, le respawn le relit a l identique', () => {
  const failed = zoneStateAfterFailedMigration(_richState(), T_AVOID, { x: 0, z: 900 });
  const reloaded = zoneStateLoad(JSON.parse(JSON.stringify(failed)), T_AVOID + 1000);
  assert.strictEqual(reloaded.lastMigrationFailed, true);
  assert.deepStrictEqual(reloaded.failedTargets, failed.failedTargets);
  assert.strictEqual(reloaded.lastMigrationAt, T_AVOID);
});

test('CHAINE COMPLETE : echec → 5 min plus tard on re-tente, VERS UNE AUTRE cible', () => {
  // La reproduction du bug en deux temps : avant, le re-essai attendait 20 min puis visait la MEME
  // cellule (pickMigrationTarget est deterministe) → re-echec garanti au meme endroit.
  const first = pickMigrationTarget({ from: FROM, biomes: [NEAR_FOREST, FAR_FOREST], now: T_AVOID });
  assert.strictEqual(first.z, 400);
  const st = zoneStateAfterFailedMigration(_richState(), T_AVOID, first);
  const later = T_AVOID + COOLDOWN_URGENT_MS;
  const v = zoneVerdict(healthy({
    waterFails: WATER_FAILS_MAX, lastMigrationAt: st.lastMigrationAt,
    lastMigrationFailed: st.lastMigrationFailed, now: later,
  }));
  assert.strictEqual(v.verdict, 'migrate', '5 min apres l echec, on re-tente');
  const second = pickMigrationTarget({ from: FROM, biomes: [NEAR_FOREST, FAR_FOREST], avoid: st.failedTargets, now: later });
  assert.strictEqual(second.z, 900, '... et pas vers la cellule qui vient d echouer');
});

// ─── (d) L'ARRIVÉE d'une migration « loin » se juge comme son départ (fix 18/08, suite) ─────────
// La sortie anticipée corrigée, restait le VERDICT d'arrivée : jugé à 64 blocs pour tous les
// motifs. Une migration `depleted` dont les jambes s'épuisaient à 100-250 blocs (obstacles, NoPath)
// ré-ancrait sa base dans le même secteur vidé et repartait pour 20 min de cooldown — l'échec
// mesuré (« déménager dans la pièce d'à côté ») revenait par cette porte-là.

const { migrationArrivalOk, ARRIVAL_DEPLETED_RADIUS } = require('./zone');

const ARR = { x: 1000, z: 0 };

test('arrivee BOIS/EAU : la regle historique (64 blocs) est inchangee', () => {
  assert.deepStrictEqual(migrationArrivalOk({ reason: 'wood', gone: 64, minDist: 64 }), { ok: true, why: 'moved' });
  assert.deepStrictEqual(migrationArrivalOk({ reason: 'water', gone: 63, minDist: 200 }), { ok: false, why: 'too_short' });
});

test('arrivee ZONE VIDEE : 3/4 du plancher parcourus => succes', () => {
  const r = migrationArrivalOk({ reason: 'depleted', gone: 450, minDist: 600, distToTarget: 400, arrival: ARR, depleted: [ARR] });
  assert.deepStrictEqual(r, { ok: true, why: 'far_enough' });
});

test('arrivee ZONE VIDEE : arrive a la cible (<=48) => succes meme si la cible est proche', () => {
  const r = migrationArrivalOk({ reason: 'exhausted', gone: 100, minDist: 600, distToTarget: 30, arrival: ARR, depleted: [ARR] });
  assert.deepStrictEqual(r, { ok: true, why: 'arrived' });
});

test('arrivee ZONE VIDEE : 150 blocs en TERRAIN FRAIS (aucune cellule epuisee autour) => succes', () => {
  const far = { x: ARR.x + ARRIVAL_DEPLETED_RADIUS + 1, z: 0 };
  const r = migrationArrivalOk({ reason: 'depleted', gone: 150, minDist: 600, distToTarget: 450, arrival: ARR, depleted: [far] });
  assert.deepStrictEqual(r, { ok: true, why: 'fresh_ground' });
});

test('LE BUG : arrivee ZONE VIDEE a 150 blocs ENCORE dans le secteur epuise => ECHEC', () => {
  const near = { x: ARR.x + ARRIVAL_DEPLETED_RADIUS, z: 0 };   // pile au bord : encore « autour »
  const r = migrationArrivalOk({ reason: 'depleted', gone: 150, minDist: 600, distToTarget: 450, arrival: ARR, depleted: [near] });
  assert.deepStrictEqual(r, { ok: false, why: 'still_depleted' });
});

test('arrivee ZONE VIDEE : moins de 64 blocs => echec, terrain frais ou pas', () => {
  const r = migrationArrivalOk({ reason: 'exhausted', gone: 40, minDist: 600, distToTarget: 560, arrival: ARR, depleted: [] });
  assert.deepStrictEqual(r, { ok: false, why: 'too_short' });
});

test('arrivee ZONE VIDEE sans carte (aucune cellule connue) => le terrain est presume frais', () => {
  const r = migrationArrivalOk({ reason: 'exhausted', gone: 100, minDist: 600, arrival: ARR });
  assert.deepStrictEqual(r, { ok: true, why: 'fresh_ground' });
});

test('arrivee : position illisible => echec (on n ancre jamais une base a l aveugle)', () => {
  assert.deepStrictEqual(migrationArrivalOk({ reason: 'wood', gone: NaN }), { ok: false, why: 'no_position' });
  assert.deepStrictEqual(migrationArrivalOk({ reason: 'depleted', gone: 200, minDist: 600, arrival: null, depleted: [] }),
    { ok: false, why: 'no_position' });
});

test('arrivee : cellules epuisees corrompues ignorees (jamais de crash)', () => {
  const r = migrationArrivalOk({ reason: 'depleted', gone: 100, minDist: 600, arrival: ARR, depleted: [null, { x: 'a', z: 0 }, 5] });
  assert.deepStrictEqual(r, { ok: true, why: 'fresh_ground' });
});

// ─── JAMBE DE MIGRATION BLOQUÉE DANS UN ABRI / UN TUNNEL : REPLI EN CREUSANT (mesure 19/10) ─────
// À l'aube, la migration part pendant que le bot est encore DANS son abri de nuit (creusé, emmuré,
// couvert) ou au fond de son tunnel (y=50, `/home safe` refusé). La jambe marche en `canDig:false` :
// enfermé + interdiction de creuser = NoPath instantané, les 24 jambes « s'exécutent » en 1-2 s et
// la migration échoue `moved:1..2 arrival:too_short` (3/3 bots ce matin-là).
const { legDigRetry } = require('./zone');

test('legDigRetry : jambe sans creuser qui n a pas avancé → on la retente EN CREUSANT', () => {
  assert.strictEqual(legDigRetry({ moved: 0 }), true);
  assert.strictEqual(legDigRetry({ moved: 2 }), true);
  assert.strictEqual(legDigRetry({ moved: LEG_STUCK_MIN - 0.5 }), true);
});

test('legDigRetry : la jambe a avancé → aucun repli (la marche de surface reste la règle)', () => {
  assert.strictEqual(legDigRetry({ moved: LEG_STUCK_MIN }), false);
  assert.strictEqual(legDigRetry({ moved: 60 }), false);
});

test('legDigRetry : préemptés (mort, ordre, évasion) → on ne relance RIEN', () => {
  assert.strictEqual(legDigRetry({ moved: 0, cancelled: true }), false);
});

test('legDigRetry : position illisible → pas de repli (on ne creuse pas à l aveugle)', () => {
  assert.strictEqual(legDigRetry({ moved: NaN }), false);
  assert.strictEqual(legDigRetry({ moved: -1 }), false);
  assert.strictEqual(legDigRetry({}), false);
  assert.strictEqual(legDigRetry(), false);
});
