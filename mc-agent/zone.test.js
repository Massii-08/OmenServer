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
