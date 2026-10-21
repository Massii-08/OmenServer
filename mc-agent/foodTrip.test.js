'use strict';
// NOURRITURE — L'EXPÉDITION VERS LE GIBIER : tests (19/10).
//
// Mesure live qui a motivé l'ajout : les sorties nourriture sont rapides (33 à 352 ms) mais TOUS les
// bots restent à 0 point — `hunt_cook_done reason:no_prey:no_passive` à chaque fois, faute d'animal à
// ≤ 32 blocs du spawn (forêt dense) alors que des PLAINES sont à ~140 blocs.
//
// Trois étages, testés séparément :
//   1. les décisions PURES (foodTrip.js) — où aller, faut-il partir, quelle jambe, quelles cellules écarter ;
//   2. l'ORCHESTRATION (foodRun.runHuntCook) avec des dépendances fausses et une horloge fausse : QUOI
//      tourne, DANS QUEL ORDRE, SOUS QUEL PLAFOND — un plafond non appliqué ment, une garde lue au mauvais
//      endroit ne plante jamais, elle rend la fonctionnalité morte (piège #61) ;
//   3. le CÂBLAGE d'index.js, exécuté dans un bac à sable (pas seulement lu).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const T = require('./foodTrip');
const F = require('./food');
const { runHuntCook } = require('./foodRun');
const { LEG_DIST, LEG_STUCK_MIN } = require('./zone');

const NOW = 1_000_000_000;
const MIN = 60 * 1000;
// Une cellule de biome telle que la produit le backend (`add_biome` : coin SO quantifié sur 128).
const cell = (name, x, z) => ({ name, id: null, x, z, at: null });

// ─── 1. pickGrazingCell ─────────────────────────────────────────────────────────────────────────
// Géométrie : cellules de 128², le point visé est le plus proche de `from` DANS la cellule, rentré de
// 32 blocs (INSET) — pour une cellule (cx,cz) : x ∈ [cx+32, cx+95], z ∈ [cz+32, cz+95].

test('pickGrazingCell : la PLAINE la plus proche gagne', () => {
  const biomes = [cell('plains', 256, 0), cell('plains', 128, 0), cell('plains', 640, 0)];
  const r = T.pickGrazingCell({ from: { x: 64, z: 64 }, biomes, now: NOW });
  assert.ok(r, 'une plaine à portée doit être trouvée');
  assert.strictEqual(r.biome, 'plains');
  assert.strictEqual(r.x, 160, 'cellule 128..255 : on entre de 32 blocs par le bord ouest');
  assert.strictEqual(r.z, 64, 'même latitude que le bot : on ne s écarte pas');
  assert.strictEqual(r.dist, 96);
});

test('pickGrazingCell : la liste blanche — les 11 biomes de la consigne sont tous acceptés', () => {
  const wanted = ['plains', 'sunflower_plains', 'meadow', 'savanna', 'savanna_plateau',
    'flower_forest', 'forest', 'birch_forest', 'taiga', 'snowy_plains', 'cherry_grove'];
  assert.deepStrictEqual([...T.GRAZING_BIOMES].sort(), [...wanted].sort());
  for (const name of wanted) {
    const r = T.pickGrazingCell({ from: { x: 64, z: 64 }, biomes: [cell(name, 128, 0)], now: NOW });
    assert.ok(r, `${name} est un biome à gibier`);
    assert.strictEqual(r.biome, name);
  }
});

test('pickGrazingCell : JAMAIS océan, rivière, plage, désert, badlands, champignons, forêt sombre, marais', () => {
  const never = ['ocean', 'deep_ocean', 'cold_ocean', 'frozen_ocean', 'warm_ocean', 'river', 'frozen_river', 'beach',
    'snowy_beach', 'desert', 'badlands', 'eroded_badlands', 'wooded_badlands', 'mushroom_fields',
    'dark_forest', 'swamp', 'mangrove_swamp', 'dripstone_caves', 'lush_caves', 'the_void'];
  for (const name of never) {
    const r = T.pickGrazingCell({ from: { x: 64, z: 64 }, biomes: [cell(name, 128, 0)], now: NOW });
    assert.strictEqual(r, null, `${name} ne doit JAMAIS être élue`);
  }
  // …et des cellules exclues PLUS PROCHES ne masquent pas une plaine plus loin
  const r = T.pickGrazingCell({
    from: { x: 64, z: 64 },
    biomes: [cell('dark_forest', 128, 0), cell('river', 128, 128), cell('plains', 256, 0)],
    maxDist: 400, now: NOW,
  });
  assert.ok(r && r.biome === 'plains' && r.x === 288, 'la plaine à 224 blocs, pas la forêt sombre à 96');
});

test('pickGrazingCell : l exemple de la consigne — forêt dense au spawn, PLAINES à ~140 blocs', () => {
  // le bot est dans une cellule « forest » (rien à ≤ 32 blocs), forêt sombre et marais voisins, plaine en diagonale
  const biomes = [cell('forest', 0, 0), cell('dark_forest', 128, 0), cell('swamp', 0, 128), cell('plains', 128, 128)];
  const r = T.pickGrazingCell({ from: { x: 64, z: 64 }, biomes, now: NOW });
  assert.ok(r, 'la plaine à ~140 blocs doit être trouvée avec les défauts (maxDist 160)');
  assert.strictEqual(r.biome, 'plains');
  assert.ok(r.dist > 130 && r.dist < 142, `dist=${r.dist}`);
});

test('pickGrazingCell : maxDist (160 par défaut) borne la MARCHE (distance du point visé)', () => {
  assert.strictEqual(T.FOOD_TRIP_MAX_DIST, 160);
  const plains = [cell('plains', 128, 0)];                      // point visé (160,64) depuis (0,64)
  const at = (x) => T.pickGrazingCell({ from: { x, z: 64 }, biomes: plains, now: NOW });
  assert.ok(at(0), 'pile 160 blocs : accepté');
  assert.strictEqual(at(-1), null, '161 blocs : refusé');
  // la plaine d en face (point visé à 288) n est pas atteignable sans élargir
  const far = [cell('plains', 256, 0)];
  assert.strictEqual(T.pickGrazingCell({ from: { x: 0, z: 64 }, biomes: far, now: NOW }), null);
  assert.ok(T.pickGrazingCell({ from: { x: 0, z: 64 }, biomes: far, maxDist: 300, now: NOW }), 'joignable si l appelant élargit');
});

test('pickGrazingCell : maxDist illisible (NaN, texte, Infinity) → le DÉFAUT, jamais « sans borne »', () => {
  const from = { x: 0, z: 64 };
  const far = [cell('plains', 4096, 0)];
  for (const bad of [NaN, 'loin', undefined, null, Infinity]) {
    const r = T.pickGrazingCell({ from, biomes: far, maxDist: bad, now: NOW });
    assert.strictEqual(r, null, `maxDist=${String(bad)} ne doit pas laisser passer une cellule à 4 km`);
  }
});

test('pickGrazingCell : minDist — la cellule sous nos pieds est ignorée (on vient de constater qu il n y a rien)', () => {
  assert.strictEqual(T.FOOD_TRIP_MIN_DIST, 48);
  const from = { x: 64, z: 64 };
  const here = cell('plains', 0, 0);                           // point visé = notre position : distance 0
  const next = cell('plains', 128, 0);                         // point visé (160,64) : distance 96
  const r = T.pickGrazingCell({ from, biomes: [here, next], now: NOW });
  assert.ok(r && r.x === 160, 'la cellule voisine, pas celle où l on se tient');
  assert.strictEqual(T.pickGrazingCell({ from, biomes: [here], now: NOW }), null, 'seule cellule connue = celle de dessous : on ne tourne pas en rond');
  assert.ok(T.pickGrazingCell({ from, biomes: [here], minDist: 0, now: NOW }), 'minDist 0 permet la cellule courante');
  // une cellule voisine collée à nous (point visé à 33 blocs) est elle aussi déjà « vue »
  assert.strictEqual(T.pickGrazingCell({ from: { x: 127, z: 64 }, biomes: [cell('plains', 128, 0)], now: NOW }), null);
});

test('pickGrazingCell : avoid — une cellule ratée il y a < 20 min est ignorée, la suivante est élue', () => {
  const biomes = [cell('plains', 128, 0), cell('meadow', 0, 128)];
  const from = { x: 70, z: 64 };
  const first = T.pickGrazingCell({ from, biomes, now: NOW });
  assert.ok(first && first.biome === 'plains', 'la plaine (90 blocs) devance la prairie (96)');
  const avoid = [{ x: first.x, z: first.z, at: NOW - 5 * MIN }];
  const second = T.pickGrazingCell({ from, biomes, avoid, now: NOW });
  assert.ok(second, 'une autre cellule existe');
  assert.strictEqual(second.biome, 'meadow');
  // les deux écartées → plus rien
  const both = avoid.concat([{ x: second.x, z: second.z, at: NOW - 1 * MIN }]);
  assert.strictEqual(T.pickGrazingCell({ from, biomes, avoid: both, now: NOW }), null);
});

test('pickGrazingCell : avoid — au bout de 20 min la cellule redevient éligible', () => {
  const biomes = [cell('plains', 128, 0)];
  const from = { x: 0, z: 64 };
  const target = T.pickGrazingCell({ from, biomes, now: NOW });
  assert.ok(target);
  assert.strictEqual(T.FOOD_TRIP_AVOID_MS, 20 * MIN);
  const recent = [{ x: target.x, z: target.z, at: NOW - (20 * MIN - 1) }];
  assert.strictEqual(T.pickGrazingCell({ from, biomes, avoid: recent, now: NOW }), null, '19 min 59 s : encore écartée');
  const old = [{ x: target.x, z: target.z, at: NOW - 20 * MIN }];
  assert.ok(T.pickGrazingCell({ from, biomes, avoid: old, now: NOW }), '20 min pile : éligible');
});

test('pickGrazingCell : avoid — compare des CELLULES (un point quelconque suffit) et ignore les entrées illisibles', () => {
  const biomes = [cell('plains', 128, 0)];
  const from = { x: 0, z: 64 };
  // un point DANS la cellule (128..255 × 0..127), pas le point visé
  assert.strictEqual(T.pickGrazingCell({ from, biomes, avoid: [{ x: 140, z: 5, at: NOW - MIN }], now: NOW }), null);
  // entrées sans date / datées du FUTUR / illisibles : jamais d exception, jamais d exclusion à vie
  const junk = [null, 'x', {}, { x: 192, z: 64 }, { x: 192, z: 64, at: NOW + 5 * MIN }, { x: NaN, z: 0, at: NOW }];
  assert.ok(T.pickGrazingCell({ from, biomes, avoid: junk, now: NOW }));
  // une cellule VOISINE ratée n écarte pas celle-ci
  assert.ok(T.pickGrazingCell({ from, biomes, avoid: [{ x: 64, z: 64, at: NOW - MIN }], now: NOW }));
});

test('pickGrazingCell : DÉTERMINISTE — égalité parfaite départagée par le coin, jamais par l ordre du tableau', () => {
  // depuis (0,0) : (128,0) → point (160,32) ; (0,128) → point (32,160) : même distance
  const a = [cell('plains', 128, 0), cell('plains', 0, 128)];
  const b = [cell('plains', 0, 128), cell('plains', 128, 0)];
  const ra = T.pickGrazingCell({ from: { x: 0, z: 0 }, biomes: a, maxDist: 300, minDist: 0, now: NOW });
  const rb = T.pickGrazingCell({ from: { x: 0, z: 0 }, biomes: b, maxDist: 300, minDist: 0, now: NOW });
  assert.deepStrictEqual([ra.x, ra.z, ra.biome], [rb.x, rb.z, rb.biome]);
  assert.deepStrictEqual([ra.x, ra.z], [32, 160], 'coin lexicographique le plus petit (0,128)');
});

test('pickGrazingCell : le point visé est TOUJOURS dans la cellule, rentré de 32 blocs (même non quantifiée / négative)', () => {
  assert.strictEqual(T.FOOD_TRIP_INSET, 32);
  const r = T.pickGrazingCell({ from: { x: 0, z: 64 }, biomes: [cell('plains', 130, 5)], now: NOW });
  assert.ok(r);
  assert.ok(r.x >= 128 + 32 && r.x <= 255 - 32 && r.z >= 0 + 32 && r.z <= 127 - 32, `(${r.x},${r.z}) hors de la boîte rentrée`);
  // négatifs : floor, pas troncature vers zéro (cellule -128..-1 → x ≤ -1-32)
  const neg = T.pickGrazingCell({ from: { x: 0, z: 64 }, biomes: [cell('plains', -128, 0)], minDist: 0, now: NOW });
  assert.ok(neg && neg.x === -33, `cellule -128..-1 : bord est -1, rentré de 32 → -33 (vu ${neg && neg.x})`);
  // le bot est DÉJÀ aligné avec la boîte rentrée d une cellule voisine : pas de détour latéral
  const inside = T.pickGrazingCell({ from: { x: 100, z: 200 }, biomes: [cell('plains', 128, 128)], now: NOW });
  assert.ok(inside && inside.z === 200, 'même latitude : aucun écart gratuit');
});

test('pickGrazingCell : espace de noms `minecraft:` toléré ; nom absent / null → ignoré', () => {
  const r = T.pickGrazingCell({ from: { x: 64, z: 64 }, biomes: [cell('minecraft:plains', 128, 0)], now: NOW });
  assert.ok(r && r.biome === 'plains');
  const none = T.pickGrazingCell({
    from: { x: 64, z: 64 },
    biomes: [{ name: null, id: 7, x: 128, z: 0 }, { id: 7, x: 128, z: 0 }, { name: '', x: 128, z: 0 }],
    now: NOW,
  });
  assert.strictEqual(none, null, 'un biome custom sans nom n est PAS déclaré à gibier');
});

test('pickGrazingCell : entrées invalides → null, jamais d exception', () => {
  const ok = [cell('plains', 128, 0)];
  assert.strictEqual(T.pickGrazingCell(), null);
  assert.strictEqual(T.pickGrazingCell({}), null);
  assert.strictEqual(T.pickGrazingCell({ from: null, biomes: ok }), null);
  assert.strictEqual(T.pickGrazingCell({ from: { x: NaN, z: 0 }, biomes: ok }), null);
  assert.strictEqual(T.pickGrazingCell({ from: { x: 0, z: 0 }, biomes: null }), null);
  assert.strictEqual(T.pickGrazingCell({ from: { x: 0, z: 0 }, biomes: [] }), null);
  assert.strictEqual(T.pickGrazingCell({ from: { x: 0, z: 0 }, biomes: [null, 7, 'x', { name: 'plains' }, { name: 'plains', x: 'a', z: 0 }] }), null);
});

// ─── 2. shouldFoodTrip ──────────────────────────────────────────────────────────────────────────

const READY = Object.freeze({
  points: 0, passiveInView: false, isDay: true, y: 70,
  migrating: false, ordered: false, busy: false, tripBusy: false, canGive: false,
});
const with_ = (over) => Object.assign({}, READY, over);

test('shouldFoodTrip : faim + jour + surface + aucun passif → on part', () => {
  assert.deepStrictEqual(T.shouldFoodTrip(READY), { go: true, reason: 'ok' });
});

test('shouldFoodTrip : les quatre conditions de la consigne, une par une', () => {
  assert.deepStrictEqual(T.shouldFoodTrip(with_({ points: 6 })), { go: false, reason: 'not_hungry' });
  assert.deepStrictEqual(T.shouldFoodTrip(with_({ points: 5 })), { go: true, reason: 'ok' });
  assert.deepStrictEqual(T.shouldFoodTrip(with_({ isDay: false })), { go: false, reason: 'night' });
  assert.deepStrictEqual(T.shouldFoodTrip(with_({ y: 30 })), { go: false, reason: 'underground' });
  assert.deepStrictEqual(T.shouldFoodTrip(with_({ passiveInView: true })), { go: false, reason: 'passive_in_view' });
});

test('shouldFoodTrip : seuils pile — 6 points = pas de vraie faim, y 58 = surface, y 57 = sous terre', () => {
  assert.strictEqual(T.FOOD_TRIP_POINTS, 6);
  assert.strictEqual(T.FOOD_TRIP_MIN_Y, 58);
  assert.strictEqual(T.shouldFoodTrip(with_({ points: 5.99 })).go, true);
  assert.strictEqual(T.shouldFoodTrip(with_({ points: 6 })).go, false);
  assert.strictEqual(T.shouldFoodTrip(with_({ y: 58 })).go, true);
  assert.strictEqual(T.shouldFoodTrip(with_({ y: 57.9 })).go, false);
  // distinct du plancher de chasse d ensureFood (45) : la consigne demande 58 pour l expédition
  assert.strictEqual(T.shouldFoodTrip(with_({ y: 50 })).go, false);
});

test('shouldFoodTrip : heure inconnue (null / absente) → on ne part PAS (marcher 75 s au crépuscule sans le savoir)', () => {
  assert.deepStrictEqual(T.shouldFoodTrip(with_({ isDay: null })), { go: false, reason: 'time_unknown' });
  const noDay = Object.assign({}, READY); delete noDay.isDay;
  assert.deepStrictEqual(T.shouldFoodTrip(noDay), { go: false, reason: 'time_unknown' });
  assert.strictEqual(T.shouldFoodTrip(with_({ isDay: 'oui' })).go, false, 'seul le booléen true vaut « jour »');
});

test('shouldFoodTrip : jamais par-dessus une migration, un ordre direct, la survie ou une expédition déjà en vol', () => {
  assert.deepStrictEqual(T.shouldFoodTrip(with_({ migrating: true })), { go: false, reason: 'migrating' });
  assert.deepStrictEqual(T.shouldFoodTrip(with_({ ordered: true })), { go: false, reason: 'ordered' });
  assert.deepStrictEqual(T.shouldFoodTrip(with_({ busy: true })), { go: false, reason: 'busy' });
  assert.deepStrictEqual(T.shouldFoodTrip(with_({ tripBusy: true })), { go: false, reason: 'trip_busy' });
});

test('shouldFoodTrip : un bot qui PEUT se /give à manger n y va pas (le /give est instantané, la marche non)', () => {
  assert.deepStrictEqual(T.shouldFoodTrip(with_({ canGive: true })), { go: false, reason: 'can_give' });
  assert.deepStrictEqual(T.shouldFoodTrip(with_({ canGive: false })), { go: true, reason: 'ok' });
  const noField = Object.assign({}, READY); delete noField.canGive;
  assert.strictEqual(T.shouldFoodTrip(noField).go, true, 'champ absent = pas de /give (sans-give est le cas nominal)');
});

test('shouldFoodTrip : pas assez de budget pour chasser ensuite → on ne part pas', () => {
  assert.strictEqual(T.FOOD_TRIP_MIN_LEFT_MS, 20000);
  assert.deepStrictEqual(T.shouldFoodTrip(with_({ leftMs: 19999 })), { go: false, reason: 'no_time' });
  assert.deepStrictEqual(T.shouldFoodTrip(with_({ leftMs: 20000 })), { go: true, reason: 'ok' });
  assert.deepStrictEqual(T.shouldFoodTrip(with_({ leftMs: 0 })), { go: false, reason: 'no_time' });
  assert.deepStrictEqual(T.shouldFoodTrip(with_({ leftMs: NaN })), { go: false, reason: 'no_time' });
  assert.strictEqual(T.shouldFoodTrip(READY).go, true, 'leftMs absent = aucune contrainte de temps');
});

test('shouldFoodTrip : « pas de donnée » ne se lit jamais « zéro » (null ≠ 0 points, null ≠ altitude 0)', () => {
  assert.deepStrictEqual(T.shouldFoodTrip(with_({ points: null })), { go: false, reason: 'no_state' });
  assert.deepStrictEqual(T.shouldFoodTrip(with_({ points: undefined })), { go: false, reason: 'no_state' });
  assert.deepStrictEqual(T.shouldFoodTrip(with_({ points: NaN })), { go: false, reason: 'no_state' });
  assert.deepStrictEqual(T.shouldFoodTrip(with_({ y: null })), { go: false, reason: 'no_state' });
  assert.deepStrictEqual(T.shouldFoodTrip(with_({ y: NaN })), { go: false, reason: 'no_state' });
  assert.deepStrictEqual(T.shouldFoodTrip(), { go: false, reason: 'no_state' });
  assert.deepStrictEqual(T.shouldFoodTrip(null), { go: false, reason: 'no_state' });
  assert.deepStrictEqual(T.shouldFoodTrip('oui'), { go: false, reason: 'no_state' });
});

// ─── 3. foodTripLeg ─────────────────────────────────────────────────────────────────────────────

test('foodTripLeg : un but lointain se vise par jambes de 64 blocs (le pathfinder est aveugle au-delà du chargé)', () => {
  assert.strictEqual(LEG_DIST, 64);
  const leg = T.foodTripLeg({ from: { x: 0, z: 0 }, to: { x: 140, z: 0 } });
  assert.deepStrictEqual(leg, { x: 64, z: 0, last: false });
  const second = T.foodTripLeg({ from: { x: 64, z: 0 }, to: { x: 140, z: 0 } });
  assert.deepStrictEqual(second, { x: 128, z: 0, last: false });
  const third = T.foodTripLeg({ from: { x: 128, z: 0 }, to: { x: 140, z: 0 } });
  assert.strictEqual(third, null, '12 blocs du but : arrivé');
});

test('foodTripLeg : la DERNIÈRE jambe vise le but lui-même, sans le dépasser', () => {
  const leg = T.foodTripLeg({ from: { x: 0, z: 0 }, to: { x: 50, z: 30 } });         // 58 blocs
  assert.deepStrictEqual(leg, { x: 50, z: 30, last: true });
  const diag = T.foodTripLeg({ from: { x: 0, z: 0 }, to: { x: 100, z: 100 } });      // 141 blocs
  assert.strictEqual(diag.last, false);
  assert.ok(Math.abs(Math.hypot(diag.x, diag.z) - 64) <= 1, 'jambe de ~64 blocs');
  assert.ok(Math.abs(diag.x - diag.z) <= 1, 'droit vers le but');
});

test('foodTripLeg : arrivé (≤ 24 blocs) → null ; entrées illisibles → null', () => {
  assert.strictEqual(T.FOOD_TRIP_ARRIVED, 24);
  assert.strictEqual(T.foodTripLeg({ from: { x: 0, z: 0 }, to: { x: 24, z: 0 } }), null);
  assert.notStrictEqual(T.foodTripLeg({ from: { x: 0, z: 0 }, to: { x: 25, z: 0 } }), null);
  assert.strictEqual(T.foodTripLeg(), null);
  assert.strictEqual(T.foodTripLeg({ from: { x: 0, z: 0 } }), null);
  assert.strictEqual(T.foodTripLeg({ from: { x: NaN, z: 0 }, to: { x: 100, z: 0 } }), null);
});

test('foodTripLeg : une jambe qui n a pas avancé DÉVIE le cap (±40°, croissant) au lieu de re-viser le même point', () => {
  const from = { x: 0, z: 0 }, to = { x: 200, z: 0 };
  const straight = T.foodTripLeg({ from, to, stuck: 0 });
  const dev1 = T.foodTripLeg({ from, to, stuck: 1 });
  const dev2 = T.foodTripLeg({ from, to, stuck: 2 });
  assert.notDeepStrictEqual([dev1.x, dev1.z], [straight.x, straight.z]);
  assert.ok(dev1.z > 0 && dev2.z < 0, 'on oscille de part et d autre du cap');
  const ang = (l) => Math.abs(Math.atan2(l.z, l.x)) * 180 / Math.PI;
  assert.ok(Math.abs(ang(dev1) - 40) < 2, `1er palier ≈ 40°, vu ${ang(dev1)}`);
  assert.ok(dev1.last === false && dev2.last === false);
  // même proche du but, une jambe bloquée ne vise plus « droit dessus » : elle contourne — sans dépasser
  // la distance au but (50 blocs, pas une jambe pleine de 64)
  const near = T.foodTripLeg({ from, to: { x: 50, z: 0 }, stuck: 1 });
  assert.strictEqual(near.last, false);
  assert.ok(Math.abs(Math.hypot(near.x, near.z) - 50) <= 1, `jambe de contournement ≈ 50 blocs, vu ${Math.hypot(near.x, near.z)}`);
});

// ─── 4. cellules essayées sans succès ───────────────────────────────────────────────────────────

test('triedCellsPrune : valides seulement, ni expirées ni futures, 8 plus récentes, triées', () => {
  assert.strictEqual(T.FOOD_TRIP_AVOID_CAP, 8);
  const list = [
    { x: 1, z: 1, at: NOW - 25 * MIN },          // expirée
    { x: 2, z: 2, at: NOW + 1 },                 // du futur
    { x: 3, z: 3, at: NOW - 2 * MIN },
    { x: 4, z: 4 },                              // sans date
    null, 'x', { x: NaN, z: 0, at: NOW },
    { x: 5, z: 5, at: NOW - 10 * MIN },
  ];
  const out = T.triedCellsPrune(list, NOW);
  assert.deepStrictEqual(out.map((e) => e.x), [5, 3], 'triées par ancienneté, invalides retirées');
  const many = Array.from({ length: 12 }, (_, i) => ({ x: i * 128, z: 0, at: NOW - (12 - i) * 1000 }));
  assert.strictEqual(T.triedCellsPrune(many, NOW).length, 8);
  assert.strictEqual(T.triedCellsPrune(many, NOW)[7].x, 11 * 128, 'on garde les plus RÉCENTES');
  assert.deepStrictEqual(T.triedCellsPrune(null, NOW), []);
  assert.deepStrictEqual(T.triedCellsPrune('x', NOW), []);
});

test('triedCellsPrune : ne mute jamais l entrée', () => {
  const list = [{ x: 1, z: 1, at: NOW - MIN }, { x: 2, z: 2, at: NOW - 30 * MIN }];
  const copy = JSON.stringify(list);
  T.triedCellsPrune(list, NOW);
  assert.strictEqual(JSON.stringify(list), copy);
});

test('triedCellsAdd : ajoute, dédoublonne par CELLULE (la même cellule rafraîchit sa date), élague', () => {
  let l = T.triedCellsAdd([], { x: 192, z: 64 }, NOW);
  assert.deepStrictEqual(l, [{ x: 192, z: 64, at: NOW }]);
  l = T.triedCellsAdd(l, { x: 200, z: 70 }, NOW + MIN);            // même cellule 128..255 × 0..127
  assert.strictEqual(l.length, 1);
  assert.strictEqual(l[0].at, NOW + MIN);
  l = T.triedCellsAdd(l, { x: 320, z: 64 }, NOW + 2 * MIN);        // autre cellule
  assert.strictEqual(l.length, 2);
  // les expirées partent à l ajout
  l = T.triedCellsAdd(l, { x: -64, z: 64 }, NOW + 30 * MIN);
  assert.deepStrictEqual(l.map((e) => e.x), [-64]);
  // cellule illisible : la liste, élaguée, sans exception
  assert.deepStrictEqual(T.triedCellsAdd(l, null, NOW + 30 * MIN), l);
  assert.deepStrictEqual(T.triedCellsAdd(l, { x: NaN, z: 0 }, NOW + 30 * MIN), l);
});

test('triedCellsLoad : relit le mémo de base ; ancien format sans le champ → liste vide', () => {
  assert.strictEqual(T.FOOD_TRIP_MEMO_KEY, 'foodTrips');
  assert.deepStrictEqual(T.triedCellsLoad(null, NOW), []);
  assert.deepStrictEqual(T.triedCellsLoad({}, NOW), []);
  assert.deepStrictEqual(T.triedCellsLoad({ base: { x: 1, y: 2, z: 3 } }, NOW), []);
  const memo = { base: { x: 1 }, foodTrips: [{ x: 192, z: 64, at: NOW - MIN }, { x: 9, z: 9, at: NOW - 40 * MIN }] };
  assert.deepStrictEqual(T.triedCellsLoad(memo, NOW), [{ x: 192, z: 64, at: NOW - MIN }]);
});

test('constantes de la consigne : 75 s de marche, 160 blocs, rayon 16', () => {
  assert.strictEqual(T.FOOD_TRIP_MS, 75000);
  assert.strictEqual(T.FOOD_TRIP_MAX_DIST, 160);
  assert.strictEqual(T.FOOD_TRIP_NEAR, 16);
  assert.ok(T.FOOD_TRIP_LEG_MS * T.FOOD_TRIP_MAX_LEGS > T.FOOD_TRIP_MS, 'le plafond de la marche est le temps, pas le nombre de jambes');
  assert.ok(LEG_STUCK_MIN > 0 && T.FOOD_TRIP_STUCK_MAX >= 2);
});

// ─── 5. runHuntCook : l'EXPÉDITION (orchestration, dépendances fausses, horloge fausse) ─────────

function fakeClock(t0 = 1000) {
  const c = { t: t0, now: () => c.t, advance: (ms) => { c.t += ms; } };
  return c;
}

// Un monde : pas de gibier en vue, le sac vide, jour, surface. Le gibier n'apparaît qu'APRÈS la marche.
function tripWorld(over = {}) {
  const clock = fakeClock();
  const w = {
    clock,
    inv: {},
    parent: { cancelled: false },
    passive: false,               // gibier en vue MAINTENANT
    passiveAfterWalk: true,       // …et une fois arrivé ?
    state: { isDay: true, y: 70, migrating: false, ordered: false, busy: false, tripBusy: false },
    cell: { x: 160, z: 160, biome: 'plains', dist: 135.8 },
    cellThrows: false,
    walkTakes: 40000,
    walkResult: null,
    walkThrows: false,
    huntTakes: 20000,
    huntGives: { beef: 3 },
    lockFails: false,
    lockHeld: false,
    locks: 0, unlocks: 0,
    heldDuring: {},
    tried: [],
    calls: [],
    events: [],
    ...over,
  };
  const give = (add) => { if (add) for (const k of Object.keys(add)) w.inv[k] = (w.inv[k] || 0) + add[k]; };
  w.deps = {
    now: clock.now,
    token: w.parent,
    inventory: () => w.inv,
    passiveInView: () => w.passive,
    hunt: async (o) => {
      w.calls.push(['hunt', { count: o.count, ms: o.ms, token: o.token }]);
      w.heldDuring.hunt = w.lockHeld;
      clock.advance(Math.min(w.huntTakes, o.ms)); give(w.huntGives);
      return { ok: true, kills: 2 };
    },
    rawStacks: () => [],
    hasFurnace: () => false,
    cook: async () => 0,
    hasRod: () => false,
    fish: async () => ({ ok: false, caught: 0, reason: 'no_water' }),
    emit: (e) => { w.events.push(e); },
    // ── l'expédition ──
    tripState: () => Object.assign({}, w.state),
    grazingCell: () => { w.calls.push(['cell']); if (w.cellThrows) throw new Error('carte illisible'); return w.cell; },
    tripLock: () => { w.calls.push(['lock']); if (w.lockFails) return false; w.locks++; w.lockHeld = true; return true; },
    tripUnlock: () => { w.calls.push(['unlock']); w.unlocks++; w.lockHeld = false; },
    tripWalk: async (o) => {
      w.calls.push(['walk', { cell: o.cell, ms: o.ms, token: o.token, cancel: o.cancel }]);
      w.heldDuring.walk = w.lockHeld;
      if (w.walkThrows) throw new Error('pathfinder KO');
      clock.advance(Math.min(w.walkTakes, o.ms));
      w.passive = w.passiveAfterWalk;
      return w.walkResult || { ok: true, arrived: true, legs: 3 };
    },
    tripTried: (c) => { w.calls.push(['tried']); w.tried.push(c); },
  };
  return w;
}
const callNames = (w) => w.calls.map((c) => c[0]);
const evTypes = (w) => w.events.map((e) => e.type);

test('expédition : faim + jour + surface + aucun gibier → on marche vers la cellule PUIS on chasse sur place', async () => {
  const w = tripWorld();
  const r = await runHuntCook(w.deps, 6);
  assert.deepStrictEqual(callNames(w), ['cell', 'lock', 'walk', 'hunt', 'unlock'], 'cellule → verrou → marche → chasse → verrou relâché');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.got, 9);
  assert.deepStrictEqual(w.calls.find((c) => c[0] === 'walk')[1].cell, w.cell, 'on marche vers LA cellule élue');
  assert.deepStrictEqual(w.tried, [], 'chasse réussie : la cellule n est pas écartée');
});

test('expédition : events food_trip (départ) puis food_trip_done (fin), avant le bilan hunt_cook_done', async () => {
  const w = tripWorld();
  await runHuntCook(w.deps, 6);
  assert.deepStrictEqual(evTypes(w), ['food_trip', 'food_trip_done', 'hunt_cook_done']);
  const start = w.events[0];
  assert.deepStrictEqual([start.toX, start.toZ, start.biome, start.dist], [160, 160, 'plains', 136]);
  const done = w.events[1];
  assert.strictEqual(done.got, 9, '3 bœufs crus = 9 points');
  assert.strictEqual(done.took_ms, 40000 + 20000, 'marche + chasse sur place');
  assert.strictEqual(done.kills, 2);
  assert.strictEqual(done.arrived, true);
  assert.strictEqual(w.events[2].trip, 'went', 'le bilan dit pourquoi on est parti');
});

test('expédition : le verrou est tenu pendant TOUTE l expédition (marche ET chasse), relâché après', async () => {
  const w = tripWorld();
  await runHuntCook(w.deps, 6);
  assert.strictEqual(w.heldDuring.walk, true);
  assert.strictEqual(w.heldDuring.hunt, true, 'sinon le confine / le squad ramène le bot au milieu de la chasse');
  assert.strictEqual(w.lockHeld, false);
  assert.deepStrictEqual([w.locks, w.unlocks], [1, 1]);
});

test('expédition : le verrou couvre AUSSI la cuisson et la pêche (le bot est loin de l ancre : un /home en plein four l abandonnerait)', async () => {
  const w = tripWorld({ huntGives: { beef: 3 } });             // 9 points de cru : < 18, on cuit
  w.deps.hasFurnace = () => true;
  w.deps.rawStacks = () => (w.inv.beef > 0 ? [{ name: 'beef', out: 'cooked_beef', count: w.inv.beef }] : []);
  w.deps.cook = async (o) => {
    w.heldDuring.cook = w.lockHeld;
    w.clock.advance(o.maxMs);
    w.inv.beef -= o.count; w.inv.cooked_beef = (w.inv.cooked_beef || 0) + o.count;
    return o.count;
  };
  const r = await runHuntCook(w.deps, 6);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(w.heldDuring.cook, true, 'le four se pose / se reprend sous le verrou');
  assert.deepStrictEqual(callNames(w).slice(-2), ['hunt', 'unlock'], 'relâché à la fin de la sortie, pas avant la cuisson');
  const done = w.events.find((e) => e.type === 'food_trip_done');
  assert.ok(done.got >= 18, `le gain de l expédition compte la viande CUITE (got=${done.got})`);
  assert.deepStrictEqual(evTypes(w), ['food_trip', 'food_trip_done', 'hunt_cook_done']);
  // pêche : même contrat
  const w2 = tripWorld({ huntGives: { beef: 1 } });
  w2.deps.hasRod = () => true;
  w2.deps.fish = async (o) => { w2.heldDuring.fish = w2.lockHeld; w2.clock.advance(1000); w2.inv.cod = 2; return { ok: true, caught: 2, reason: 'timeout' }; };
  await runHuntCook(w2.deps, 6);
  assert.strictEqual(w2.heldDuring.fish, true, 'la ligne se lance sous le verrou');
  assert.strictEqual(w2.lockHeld, false);
});

test('expédition : une exception dans la CUISSON relâche aussi le verrou (finally couvre toute la sortie)', async () => {
  const w = tripWorld({ huntGives: { beef: 3 } });
  w.deps.hasFurnace = () => true;
  w.deps.rawStacks = () => [{ name: 'beef', out: 'cooked_beef', count: 3 }];
  let n = 0;
  w.deps.inventory = () => { if (w.calls.some((c) => c[0] === 'hunt') && ++n > 2) throw new Error('inventaire illisible'); return w.inv; };
  await assert.rejects(runHuntCook(w.deps, 6), /inventaire illisible/);
  assert.strictEqual(w.lockHeld, false);
  assert.strictEqual(w.unlocks, 1);
});

test('expédition : la marche est plafonnée à 75 s et reçoit un jeton DÉRIVÉ + de quoi le couper', async () => {
  const w = tripWorld();
  await runHuntCook(w.deps, 6);
  const walk = w.calls.find((c) => c[0] === 'walk')[1];
  assert.strictEqual(walk.ms, 75000);
  assert.strictEqual(typeof walk.cancel, 'function');
  assert.strictEqual(walk.token.cancelled, true, 'jeton coupé une fois l expédition finie : rien ne court en fond');
});

test('expédition : le jeton de marche suit la tâche, s arrête dès qu un gibier apparaît et quand le but est atteint', async () => {
  // gibier en vue => le jeton se coupe (la marche s arrête à la fin de sa jambe : on chasse)
  const w = tripWorld();
  let tok = null;
  const walk = w.deps.tripWalk;
  w.deps.tripWalk = async (o) => {
    tok = o.token;
    const before = tok.cancelled;
    w.passive = true;                                        // une vache apparaît en route
    const after = tok.cancelled;
    w.passive = false;
    w.sawBefore = before; w.sawAfter = after;
    return walk(o);
  };
  await runHuntCook(w.deps, 6);
  assert.strictEqual(w.sawBefore, false, 'au départ rien en vue : le jeton est libre');
  assert.strictEqual(w.sawAfter, true, 'dès qu un gibier est en vue la marche doit s arrêter');
  // tâche annulée PENDANT la marche => jeton coupé tout de suite (lu avant la fin de l expédition, qui le coupe de toute façon)
  const w2 = tripWorld();
  const walk2 = w2.deps.tripWalk;
  w2.deps.tripWalk = async (o) => {
    w2.tokBefore = o.token.cancelled;
    w2.parent.cancelled = true;
    w2.tokAfter = o.token.cancelled;
    return walk2(o);
  };
  await runHuntCook(w2.deps, 6);
  assert.strictEqual(w2.tokBefore, false);
  assert.strictEqual(w2.tokAfter, true, 'le jeton suit la tâche : annulée = la marche s arrête à la prochaine lecture');
  // le but atteint (un butin ramassé en route) coupe aussi la marche
  const w3 = tripWorld();
  const walk3 = w3.deps.tripWalk;
  w3.deps.tripWalk = async (o) => {
    w3.tokBefore = o.token.cancelled;
    w3.inv.cooked_beef = 3;                                  // 24 points ≥ 18
    w3.tokAfter = o.token.cancelled;
    return walk3(o);
  };
  await runHuntCook(w3.deps, 6);
  assert.strictEqual(w3.tokBefore, false);
  assert.strictEqual(w3.tokAfter, true);
});

test('expédition : la marche n est PAS facturée au budget de chasse (elle a son propre plafond)', async () => {
  const w = tripWorld({ walkTakes: 75000 });
  await runHuntCook(w.deps, 6);
  const hunt = w.calls.find((c) => c[0] === 'hunt');
  assert.ok(hunt, 'après 75 s de marche la chasse tourne quand même');
  assert.strictEqual(hunt[1].ms, 45000, 'une vague complète : le budget de 60 s est intact');
  // budget PARTAGÉ fourni par l appelant (ensureFood : il reste 30 s) : la chasse d après ne dépasse pas ce reste
  const w2 = tripWorld({ walkTakes: 75000 });
  const budget = F.createBudget(30000, w2.clock.now);
  await runHuntCook(w2.deps, 6, { budget });
  assert.strictEqual(w2.calls.find((c) => c[0] === 'hunt')[1].ms, 30000);
});

test('expédition : la sortie complète ne dépasse JAMAIS marche (75 s) + budget (60 s)', async () => {
  const w = tripWorld({ walkTakes: 999999, huntTakes: 999999, huntGives: { beef: 1 } });
  const t0 = w.clock.now();
  await runHuntCook(w.deps, 6);
  const total = w.clock.now() - t0;
  assert.ok(total <= 75000 + 60000, `total=${total}`);
  assert.ok(total >= 75000, 'la marche a bien eu lieu');
});

test('expédition : rien chassé à l arrivée → la cellule est ÉCARTÉE, verdict no_prey:no_passive, aucune chasse', async () => {
  const w = tripWorld({ passiveAfterWalk: false });
  const r = await runHuntCook(w.deps, 6);
  assert.deepStrictEqual(callNames(w), ['cell', 'lock', 'walk', 'unlock', 'tried']);
  assert.deepStrictEqual(w.tried, [w.cell], 'mémorisée comme essayée : le prochain passage en choisit une autre');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_prey:no_passive');
  const done = w.events.find((e) => e.type === 'food_trip_done');
  assert.strictEqual(done.got, 0);
  assert.strictEqual(done.kills, 0);
  assert.strictEqual(done.took_ms, 40000);
});

test('expédition : du gibier mais aucune proie tuée (elles ont fui) → la cellule est aussi écartée', async () => {
  const w = tripWorld({ huntGives: null });
  w.deps.hunt = async (o) => { w.calls.push(['hunt', { ms: o.ms }]); w.clock.advance(5000); return { ok: false, kills: 0 }; };
  const r = await runHuntCook(w.deps, 6);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(w.tried, [w.cell]);
});

test('expédition : UNE seule par appel, même avec plusieurs vagues demandées', async () => {
  const w = tripWorld({ huntGives: { beef: 1 } });
  await runHuntCook(w.deps, 6, { waves: 3 });
  assert.strictEqual(w.calls.filter((c) => c[0] === 'walk').length, 1);
  assert.strictEqual(w.events.filter((e) => e.type === 'food_trip').length, 1);
});

test('expédition : chaque porte de la décision — jamais de marche, jamais de verrou, raison tracée dans le bilan', async () => {
  const cases = [
    ['night', { state: { isDay: false, y: 70 } }],
    ['time_unknown', { state: { isDay: null, y: 70 } }],
    ['underground', { state: { isDay: true, y: 40 } }],
    ['migrating', { state: { isDay: true, y: 70, migrating: true } }],
    ['ordered', { state: { isDay: true, y: 70, ordered: true } }],
    ['busy', { state: { isDay: true, y: 70, busy: true } }],
    ['trip_busy', { state: { isDay: true, y: 70, tripBusy: true } }],
    ['can_give', { state: { isDay: true, y: 70, canGive: true } }],
    ['not_hungry', { state: { isDay: true, y: 70 }, inv: { beef: 2 } }],        // 6 points : pas de vraie faim
  ];
  for (const [reason, over] of cases) {
    const w = tripWorld(over);
    const r = await runHuntCook(w.deps, 6);
    assert.deepStrictEqual(callNames(w), [], `${reason} : ni cellule, ni verrou, ni marche, ni chasse`);
    assert.strictEqual(r.ok, false, reason);
    assert.strictEqual(r.reason, 'no_prey:no_passive', `${reason} : même verdict qu avant l expédition`);
    assert.strictEqual(w.events.some((e) => e.type === 'food_trip'), false, reason);
    assert.strictEqual(w.events.find((e) => e.type === 'hunt_cook_done').trip, reason, `${reason} : le silence est un bug`);
  }
});

test('expédition : un gibier EN VUE → la chasse habituelle, l expédition n est même pas évaluée', async () => {
  const w = tripWorld({ passive: true });
  await runHuntCook(w.deps, 6);
  assert.deepStrictEqual(callNames(w), ['hunt']);
  assert.strictEqual(w.events.find((e) => e.type === 'hunt_cook_done').trip, undefined);
});

test('expédition : aucune cellule connue → pas de marche (carte vide / illisible), raison no_cell', async () => {
  for (const mod of [{ cell: null }, { cellThrows: true }]) {
    const w = tripWorld(mod);
    const r = await runHuntCook(w.deps, 6);
    assert.deepStrictEqual(callNames(w).filter((n) => n === 'walk' || n === 'lock'), []);
    assert.strictEqual(r.reason, 'no_prey:no_passive');
    assert.strictEqual(w.events.find((e) => e.type === 'hunt_cook_done').trip, 'no_cell');
  }
});

test('expédition : verrou déjà pris (une autre expédition) → pas de marche, raison trip_busy', async () => {
  const w = tripWorld({ lockFails: true });
  const r = await runHuntCook(w.deps, 6);
  assert.deepStrictEqual(callNames(w), ['cell', 'lock']);
  assert.strictEqual(r.reason, 'no_prey:no_passive');
  assert.strictEqual(w.events.find((e) => e.type === 'hunt_cook_done').trip, 'trip_busy');
  assert.strictEqual(w.unlocks, 0, 'on ne relâche pas un verrou qu on n a pas pris');
});

test('expédition : moins de 20 s de budget → pas de marche (la chasse d après n aurait pas le temps)', async () => {
  const w = tripWorld();
  const budget = F.createBudget(15000, w.clock.now);
  await runHuntCook(w.deps, 6, { budget });
  assert.strictEqual(callNames(w).includes('walk'), false);
  assert.strictEqual(w.events.find((e) => e.type === 'hunt_cook_done').trip, 'no_time');
});

test('expédition : tâche annulée PENDANT la marche → on s arrête, événement de fin, verrou relâché, cellule NON écartée', async () => {
  const w = tripWorld();
  const walk = w.deps.tripWalk;
  w.deps.tripWalk = async (o) => { const r = await walk(o); w.parent.cancelled = true; return r; };
  const r = await runHuntCook(w.deps, 6);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'cancelled');
  assert.strictEqual(callNames(w).includes('hunt'), false, 'plus de chasse par-dessus une tâche annulée');
  assert.strictEqual(w.lockHeld, false);
  assert.deepStrictEqual(w.tried, [], 'interrompue n est pas échouée : la cellule reste éligible');
  const done = w.events.find((e) => e.type === 'food_trip_done');
  assert.ok(done, 'chaque food_trip a sa fin');
  assert.strictEqual(done.aborted, true);
  assert.deepStrictEqual(evTypes(w), ['food_trip', 'food_trip_done', 'hunt_cook_done']);
});

test('expédition : la marche JETTE → pas d exception, verrou relâché, la cellule est écartée (rien n a été chassé)', async () => {
  const w = tripWorld({ walkThrows: true, passiveAfterWalk: false });
  const r = await runHuntCook(w.deps, 6);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(w.lockHeld, false);
  assert.deepStrictEqual(w.tried, [w.cell]);
  assert.ok(w.events.some((e) => e.type === 'food_trip_done'));
});

test('expédition : le verrou est relâché même si une exception inattendue traverse la chasse', async () => {
  const w = tripWorld();
  w.deps.hunt = async () => { throw new Error('pvp KO'); };
  const r = await runHuntCook(w.deps, 6);                      // les dépendances qui jettent sont avalées…
  assert.strictEqual(r.ok, false);
  assert.strictEqual(w.lockHeld, false, '…et le verrou ne reste jamais pris');
  // un tripUnlock qui jette ne casse rien non plus
  const w2 = tripWorld();
  w2.deps.tripUnlock = () => { throw new Error('verrou KO'); };
  await assert.doesNotReject(runHuntCook(w2.deps, 6));
});

test('expédition : une exception INATTENDUE qui traverse la chasse relâche quand même le verrou (finally)', async () => {
  const w = tripWorld();
  const walk = w.deps.tripWalk;
  w.deps.tripWalk = async (o) => { const r = await walk(o); w.walked = true; return r; };
  w.deps.inventory = () => { if (w.walked) throw new Error('inventaire illisible'); return w.inv; };
  await assert.rejects(runHuntCook(w.deps, 6), /inventaire illisible/, 'comme avant : cette exception-là n est pas avalée');
  assert.strictEqual(w.lockHeld, false, 'le verrou ne reste JAMAIS pris : le confine et le squad ne ramèneraient plus jamais le bot');
  assert.strictEqual(w.unlocks, 1);
  assert.deepStrictEqual(w.tried, [], 'et la cellule n est pas accusée');
  const done = w.events.find((e) => e.type === 'food_trip_done');
  assert.ok(done && done.aborted === true, 'la fin est annoncée, marquée interrompue');
});

test('expédition : décision illisible (tripState jette) → on ne part pas, comme avant', async () => {
  const w = tripWorld();
  w.deps.tripState = () => { throw new Error('monde illisible'); };
  const r = await runHuntCook(w.deps, 6);
  assert.deepStrictEqual(callNames(w), []);
  assert.strictEqual(r.reason, 'no_prey:no_passive');
});

test('expédition : SANS les dépendances de l expédition → comportement historique exact (aucun event, aucune marche)', async () => {
  for (const drop of [['tripWalk'], ['grazingCell'], ['tripState'], ['tripWalk', 'grazingCell', 'tripState', 'tripLock', 'tripUnlock', 'tripTried']]) {
    const w = tripWorld();
    for (const k of drop) delete w.deps[k];
    const r = await runHuntCook(w.deps, 6);
    assert.strictEqual(r.reason, 'no_prey:no_passive', drop.join(','));
    assert.strictEqual(w.events.some((e) => e.type === 'food_trip'), false);
    assert.strictEqual(w.events.find((e) => e.type === 'hunt_cook_done').trip, undefined);
  }
});

test('expédition : verrou / mémoire optionnels — la marche fonctionne sans', async () => {
  const w = tripWorld();
  delete w.deps.tripLock; delete w.deps.tripUnlock; delete w.deps.tripTried;
  const r = await runHuntCook(w.deps, 6);
  assert.strictEqual(r.ok, true);
  const w2 = tripWorld({ passiveAfterWalk: false });
  delete w2.deps.tripLock; delete w2.deps.tripUnlock; delete w2.deps.tripTried;
  await assert.doesNotReject(runHuntCook(w2.deps, 6));
});

test('expédition : déjà assez de points en poche → rien du tout (ni évaluation, ni event)', async () => {
  const w = tripWorld({ inv: { cooked_beef: 3 } });
  const r = await runHuntCook(w.deps, 6);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(callNames(w), []);
  assert.deepStrictEqual(w.events, []);
});

test('expédition : le bilan hunt_cook_done compte aussi la marche (took_ms)', async () => {
  const w = tripWorld();
  await runHuntCook(w.deps, 6);
  const ev = w.events.find((e) => e.type === 'hunt_cook_done');
  assert.ok(ev.took_ms >= 60000, `took_ms=${ev.took_ms}`);
  assert.strictEqual(ev.kills, 2);
});

// ─── 6. Câblage d'index.js : EXÉCUTÉ dans un bac à sable (pas seulement lu) ─────────────────────
// index.js ne s'importe pas (il crée le bot au chargement). On extrait du source RÉEL les fonctions de
// câblage et on les exécute avec de faux `bot`, `withTimeout`, `pfGoals`… : si la production référence un
// nom qui n existe pas, le bac à sable lève une ReferenceError — la classe de bug des pièges #56 et #61
// (« tests verts, process mort au premier tick »). Les trois étages précédents ne le voient pas.
const { EventEmitter } = require('node:events');
const { isNight } = require('./skills/shelter');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function slice(from, to) {
  const a = SRC.indexOf(from);
  assert.ok(a >= 0, `repère introuvable : ${from}`);
  assert.strictEqual(SRC.indexOf(from, a + 1), -1, `repère non unique : ${from}`);
  const b = SRC.indexOf(to, a + from.length);
  assert.ok(b > a, `fin introuvable : ${to}`);
  return SRC.slice(a, b);
}
const TRIP_SRC = slice('// ── EXPÉDITION VERS LE GIBIER', '// PÊCHE — plan B nourriture');
const FLAG_NAMES = ['_migrating', '_imminentBusy', 'panicInFlight', '_armorBusy', '_baseBusy', '_escaping', '_deathDebtBusy', '_foodTripBusy'];

function tripGlue(over = {}) {
  const w = {
    clock: { t: 5_000_000 },
    bot: Object.assign(new EventEmitter(), {
      entity: { position: { x: 0, y: 70, z: 0 } },
      time: { timeOfDay: 6000 },
      pvp: { target: null },
      pathfinder: {},
    }),
    owner: 'autonomous',
    inWater: false,
    taskToken: { cancelled: false },
    cells: [],
    memo: null,
    saved: [],
    gotos: [], tweaks: [], stops: 0, legTimeouts: [], timeoutCbs: [], sleeps: [],
    watchers: [], cleared: [],
    legTakes: 15000,
    gotoImpl: null,
    gotoThrows: false,
    runCaptured: null, runArgs: null,
    ...over,
  };
  w.bot.pathfinder.goto = (goal) => {
    if (w.gotoThrows) throw new Error('pathfinder KO');
    w.gotos.push({ x: goal.x, z: goal.z, range: goal.range });
    w.clock.t += w.legTakes;
    w.lastLegTakes = w.legTakes;
    if (w.gotoImpl) w.gotoImpl(goal, w);
    else { w.bot.entity.position.x = goal.x; w.bot.entity.position.z = goal.z; }   // arrive pile au point visé
    return Promise.resolve();
  };
  w.bot.inventory = { items: () => [] };
  class Movements {}
  const env = {
    bot: w.bot,
    Date: { now: () => w.clock.t },
    setInterval: (fn, ms) => { w.watchers.push({ fn, ms }); return w.watchers.length; },
    clearInterval: (id) => { w.cleared.push(id); },
    isInWater: () => { if (w.waterThrows) throw new Error('monde illisible'); return w.inWater; },
    isNight,
    taskCtl: { get active() { return w.owner; } },
    loadWorldCells: () => ({ biomes: w.cells, depleted: [], ores: [] }),
    loadBaseState: () => w.memo,
    saveBaseState: (st) => { w.memo = st; w.saved.push(st); return true; },
    pickGrazingCell: T.pickGrazingCell,
    triedCellsLoad: T.triedCellsLoad,
    triedCellsAdd: T.triedCellsAdd,
    FOOD_TRIP_MEMO_KEY: T.FOOD_TRIP_MEMO_KEY,
    foodTripLeg: T.foodTripLeg,
    FOOD_TRIP_NEAR: T.FOOD_TRIP_NEAR,
    FOOD_TRIP_ARRIVED: T.FOOD_TRIP_ARRIVED,
    FOOD_TRIP_LEG_MS: T.FOOD_TRIP_LEG_MS,
    FOOD_TRIP_LEG_MIN_MS: T.FOOD_TRIP_LEG_MIN_MS,
    FOOD_TRIP_MAX_LEGS: T.FOOD_TRIP_MAX_LEGS,
    FOOD_TRIP_STUCK_MAX: T.FOOD_TRIP_STUCK_MAX,
    LEG_STUCK_MIN,
    Movements,
    pfGoals: { GoalNearXZ: class { constructor(x, z, range) { this.x = x; this.z = z; this.range = range; } } },
    withTempMovements: async (b, Ctor, tweaks, fn) => { w.tweaks.push({ b, Ctor, tweaks }); return fn(); },
    // Comme le vrai : un goto plus long que le plafond est COUPÉ au plafond (le fake de goto a déjà avancé
    // l horloge de toute sa durée ; on rend l excédent), et le callback d expiration est conservé.
    withTimeout: (p, ms, onTimeout) => {
      w.legTimeouts.push(ms);
      w.timeoutCbs.push(onTimeout);
      if (Number.isFinite(w.lastLegTakes) && w.lastLegTakes > ms) { w.clock.t -= (w.lastLegTakes - ms); w.lastLegTakes = 0; }
      return Promise.resolve(p);
    },
    stopMotion: () => { w.stops++; },
    // huntCookGoal
    taskToken: w.taskToken,
    runHuntCook: async (d, t, o) => { w.runCaptured = d; w.runArgs = [t, o]; return { ok: true }; },
    buildCtxInv: () => ({}),
    nearestPassive: () => null,
    HUNT_SIGHT_RADIUS: F.HUNT_SIGHT_RADIUS,
    huntPassive: async () => ({ ok: true, kills: 0 }),
    RAW2COOKED: {},
    _invTotal: () => 0,
    fuelUnits: () => 0,
    fuelNames: () => [],
    smeltWithFurnace: async () => ({ ok: false }),
    fishGoal: async () => ({ ok: false }),
    FISH_TARGET: F.FISH_TARGET,
    FISH_RADIUS: F.FISH_RADIUS,
    emit: () => {},
    NO_GIVE: w.noGive !== false,
    FOOD_TRIP_YIELD_MAX_MS: T.FOOD_TRIP_YIELD_MAX_MS,
    sleep: async (ms) => { w.sleeps.push(ms); w.clock.t += ms; if (w.onSleep) w.onSleep(w); },
  };
  const names = Object.keys(env);
  const decl = FLAG_NAMES.map((n) => `let ${n} = false;`).join('\n');
  const setter = `const __flags = { set(n, v) { switch (n) { ${FLAG_NAMES.map((n) => `case '${n}': ${n} = v; break;`).join(' ')} } }, get(n) { switch (n) { ${FLAG_NAMES.map((n) => `case '${n}': return ${n};`).join(' ')} } } };`;
  const factory = new Function(...names, `${decl}\n${setter}\n${TRIP_SRC}\nreturn { foodTripState, foodTripCell, foodTripLock, foodTripUnlock, foodTripMark, foodTripWalk, foodTripYield, huntCookGoal, __flags };`);
  Object.assign(w, factory(...names.map((n) => env[n])));
  return w;
}
const flagged = (w, names, v = true) => { for (const n of [].concat(names)) w.__flags.set(n, v); };

test('index.js : _foodTripBusy est déclarée AU NIVEAU MODULE (colonne 0), avant tout consommateur', () => {
  const decl = SRC.search(/^let _foodTripBusy\b/m);
  assert.ok(decl >= 0, '`let _foodTripBusy` doit être à la colonne 0, jamais dans onSpawn (piège #56)');
  // aucune lecture AVANT la déclaration (zone morte temporelle d un `let` de module) : les consommateurs
  // — timers, fonctions — viennent tous après elle dans le fichier
  const before = SRC.slice(0, decl).split('\n').filter((l) => /_foodTripBusy/.test(l) && !/^\s*\/\//.test(l));
  assert.deepStrictEqual(before, [], 'aucune lecture de _foodTripBusy avant sa déclaration');
  assert.strictEqual((SRC.match(/^let _foodTripBusy\b/gm) || []).length, 1, 'déclarée une seule fois');
});

test('index.js : le confine ET le squad comptent l expédition comme « occupé » (sinon /home ou /tpa la coupent en route)', () => {
  const lines = SRC.split('\n').filter((l) => /const busy = !!bot\.targetDigBlock/.test(l));
  assert.strictEqual(lines.length, 2, 'les deux gardes busy historiques (confine + squad)');
  // (le squad ajoute `|| _craftDepth > 0` depuis le 20/10 : un /tpa pendant un craft abandonnait la table)
  for (const l of lines) assert.match(l, /_migrating \|\| _escaping \|\| _foodTripBusy \|\| _exploreBusy( \|\| _craftDepth > 0)?;/, l);
});

// ⚠️ Mesure live (run « zéro → fer » 21/10, 20:44-23:44) : NethBot1 (bûcheron élu) n'a obtenu AUCUNE
// pièce d'armure en 180 min, alors que NethBot2 a fini les 4 en 110 min avec autant de morts (19
// chacun). Cause : `bot._mcaExploreBounds` (posé au confine, cf. #54/#72) autorise explore() à viser
// jusqu'à 2× le rayon confine (280 blocs ici), mais l'enforcement confine (ligne busy ci-dessus) yanke
// le bot dès 1,25× le rayon (175 blocs) — SANS tenir compte d'une exploration de surface en vol. Un
// `lj_stock` (gatherLog) qui doit voyager au-delà de 175 blocs pour trouver du bois se faisait donc
// systématiquement couper en route par `/home`, reset la marche, et recommençait — cf. `confine_enforce
// dist:212` suivi de `teleport_detected` dans session-109. Même risque pour tout `gather(explore:true)`
// (minerai/autre ressource), pas seulement le bois. `_exploreBusy` couvre ce trou, même famille que
// `_foodTripBusy` (l'expédition vers le gibier a le même problème et le même remède).
test('index.js : _exploreBusy est déclarée AU NIVEAU MODULE (colonne 0), avant tout consommateur', () => {
  const decl = SRC.search(/^let _exploreBusy\b/m);
  assert.ok(decl >= 0, '`let _exploreBusy` doit être à la colonne 0, jamais dans onSpawn (piège #56)');
  const before = SRC.slice(0, decl).split('\n').filter((l) => /_exploreBusy/.test(l) && !/^\s*\/\//.test(l));
  assert.deepStrictEqual(before, [], 'aucune lecture de _exploreBusy avant sa déclaration');
  assert.strictEqual((SRC.match(/^let _exploreBusy\b/gm) || []).length, 1, 'déclarée une seule fois');
});

test('index.js : gatherWoodSafely (lj_stock/logs) tient _exploreBusy pendant tout son trajet', () => {
  const a = SRC.indexOf('async function gatherWoodSafely(gargs) {');
  assert.ok(a >= 0, 'gatherWoodSafely introuvable');
  const b = SRC.indexOf('\nasync function ', a + 10);
  const body = SRC.slice(a, b > a ? b : a + 2000);
  assert.match(body, /_exploreBusy = true;/, 'le trajet pose le verrou avant de chercher du bois');
  assert.match(body, /finally \{ _exploreBusy = false; \}/, 'le verrou est rendu même si le trajet échoue/throw');
  // le `true` doit précéder la boucle de recherche (sinon un retour anticipé le laisse armé pour rien,
  // ou pire, la boucle tourne un tour sans lui)
  assert.ok(body.indexOf('_exploreBusy = true;') < body.indexOf('for (let guard'), 'posé AVANT la boucle de trajet');
});

test('index.js : le skill `gather` générique (minerai/autre, chaîne autonome) tient aussi _exploreBusy', () => {
  assert.match(SRC, /if \(goal\.args\.name === 'stone'\) return gatherStone\(goal\);\n\s+_exploreBusy = true;\n\s+try \{ return await gather\(bot, \{ \.\.\.goal\.args, explore: true \}, taskToken\); \}\n\s+finally \{ _exploreBusy = false; \}/);
});

test('index.js : les garde-fous des appelants laissent la place à l expédition (+ FOOD_TRIP_MS) — sinon ils la couperaient', () => {
  assert.match(SRC, /withTimeout\(huntCookGoal\(4\), HUNT_COOK_TIMEOUT_MS \+ FOOD_TRIP_MS/);
  assert.match(SRC, /withTimeout\(huntCookGoal\(6\), HUNT_COOK_TIMEOUT_MS \+ FOOD_TRIP_MS/);
  assert.match(SRC, /withTimeout\(ensureFood\(\), FOOD_RUN_TIMEOUT_MS \+ FOOD_TRIP_MS/);
  assert.match(SRC, /huntCook: 90000 \+ FOOD_TRIP_MS/);
  // …et les constantes de base n ont pas bougé (la consigne : budget 60 s, timer 70 s)
  assert.strictEqual(F.FOOD_RUN_TIMEOUT_MS, 70000);
  assert.strictEqual(F.HUNT_COOK_TIMEOUT_MS, 70000);
  // le pire cas réel tient dans chaque garde-fou : ensureFood = butin 8 s + marche 75 s + reste du budget (52 s) ;
  // huntCookGoal seul = marche 75 s + budget 60 s ; le skill du planner ajoute 20 s de marge de plus
  const worstEnsure = F.LOOT_SWEEP_MS + T.FOOD_TRIP_MS + (F.FOOD_RUN_BUDGET_MS - F.LOOT_SWEEP_MS);
  const worstHunt = T.FOOD_TRIP_MS + F.HUNT_COOK_BUDGET_MS;
  assert.ok(worstEnsure <= F.FOOD_RUN_TIMEOUT_MS + T.FOOD_TRIP_MS, `${worstEnsure} ms de pire cas contre le garde-fou du timer`);
  assert.ok(worstHunt <= F.HUNT_COOK_TIMEOUT_MS + T.FOOD_TRIP_MS, `${worstHunt} ms de pire cas contre le garde-fou de la chasse`);
  assert.ok(worstHunt <= 90000 + T.FOOD_TRIP_MS, 'et contre celui du skill huntCook du planner');
});

test('index.js : foodTrip.js est requis et tous les noms importés existent', () => {
  assert.match(SRC, /require\('\.\/foodTrip'\)/);
  for (const name of ['pickGrazingCell', 'foodTripLeg', 'triedCellsLoad', 'triedCellsAdd', 'FOOD_TRIP_MEMO_KEY', 'FOOD_TRIP_MS',
    'FOOD_TRIP_YIELD_MAX_MS', 'FOOD_TRIP_NEAR', 'FOOD_TRIP_ARRIVED', 'FOOD_TRIP_LEG_MS', 'FOOD_TRIP_LEG_MIN_MS', 'FOOD_TRIP_MAX_LEGS', 'FOOD_TRIP_STUCK_MAX']) {
    assert.ok(name in T, `${name} doit être exporté par foodTrip.js`);
    assert.match(SRC, new RegExp(`\\b${name}\\b`), `${name} importé mais jamais utilisé ?`);
  }
});

// ── foodTripState : l'état que lit la décision ──

test('foodTripState : jour / nuit / heure inconnue (null, jamais « jour » par défaut)', () => {
  const w = tripGlue();
  w.bot.time.timeOfDay = 6000;
  assert.strictEqual(w.foodTripState().isDay, true);
  w.bot.time.timeOfDay = 14000;
  assert.strictEqual(w.foodTripState().isDay, false);
  w.bot.time.timeOfDay = 23500;                                    // aube : plus la nuit
  assert.strictEqual(w.foodTripState().isDay, true);
  w.bot.time.timeOfDay = undefined;
  assert.strictEqual(w.foodTripState().isDay, null);
  w.bot.time = undefined;
  assert.strictEqual(w.foodTripState().isDay, null);
});

test('foodTripState : sans-give → canGive faux ; serveur de test où le bot peut se /give à manger → canGive vrai', () => {
  assert.strictEqual(tripGlue().foodTripState().canGive, false, 'run sans-give (le cas nominal) : l expédition est permise');
  assert.strictEqual(tripGlue({ noGive: false }).foodTripState().canGive, true);
  const decide = (w) => T.shouldFoodTrip(Object.assign({ points: 0, passiveInView: false }, w.foodTripState()));
  assert.strictEqual(decide(tripGlue()).go, true);
  assert.deepStrictEqual(decide(tripGlue({ noGive: false })), { go: false, reason: 'can_give' });
});

test('foodTripState : altitude du bot (NaN si la position est illisible, jamais 0)', () => {
  const w = tripGlue();
  w.bot.entity.position.y = 63.5;
  assert.strictEqual(w.foodTripState().y, 63.5);
  w.bot.entity = undefined;
  assert.ok(Number.isNaN(w.foodTripState().y));
  // …et la décision lit cela comme « pas de donnée », jamais comme « altitude 0 = sous terre » ni « surface »
  const verdict = T.shouldFoodTrip(Object.assign({ points: 0, passiveInView: false }, w.foodTripState()));
  assert.deepStrictEqual(verdict, { go: false, reason: 'no_state' });
});

test('foodTripState : ORDRE direct (follow, guard, take…) ou migration → ordered ; planner, mappeur et repos laissent faire', () => {
  const w = tripGlue();
  for (const owner of ['follow', 'guard', 'take', 'goto', 'come', 'mineDown', 'loiter', 'pvp', 'migration']) {
    w.owner = owner;
    assert.strictEqual(w.foodTripState().ordered, true, owner);
  }
  for (const owner of ['autonomous', null, undefined]) {
    w.owner = owner;
    assert.strictEqual(w.foodTripState().ordered, false, String(owner));
  }
});

test('foodTripState : migration, survie, armure, base, évasion, dette de mort, noyade, combat → migrating / busy', () => {
  const w = tripGlue();
  assert.strictEqual(w.foodTripState().migrating, false);
  assert.strictEqual(w.foodTripState().busy, false);
  flagged(w, '_migrating');
  assert.strictEqual(w.foodTripState().migrating, true);
  flagged(w, '_migrating', false);
  for (const flag of ['_imminentBusy', 'panicInFlight', '_armorBusy', '_baseBusy', '_escaping', '_deathDebtBusy']) {
    flagged(w, flag);
    assert.strictEqual(w.foodTripState().busy, true, flag);
    flagged(w, flag, false);
  }
  w.inWater = true;
  assert.strictEqual(w.foodTripState().busy, true, 'dans l eau');
  w.inWater = false;
  w.bot.pvp.target = { name: 'zombie' };
  assert.strictEqual(w.foodTripState().busy, true, 'un combat est en cours');
  w.bot.pvp.target = null;
  assert.strictEqual(w.foodTripState().busy, false);
});

test('foodTripState : lecture de l eau qui jette → pas occupé (best-effort), expédition déjà en vol → tripBusy', () => {
  const w = tripGlue({ waterThrows: true });
  assert.doesNotThrow(() => w.foodTripState());
  assert.strictEqual(w.foodTripState().busy, false);
  assert.strictEqual(w.foodTripState().tripBusy, false);
  flagged(w, '_foodTripBusy');
  assert.strictEqual(w.foodTripState().tripBusy, true);
});

test('foodTripState + décision : le scénario de la consigne passe, et chaque porte ferme', () => {
  const w = tripGlue();
  const decide = () => T.shouldFoodTrip(Object.assign({ points: 0, passiveInView: false }, w.foodTripState()));
  assert.deepStrictEqual(decide(), { go: true, reason: 'ok' });
  w.bot.time.timeOfDay = 15000;
  assert.strictEqual(decide().reason, 'night');
  w.bot.time.timeOfDay = 6000;
  w.bot.entity.position.y = 20;
  assert.strictEqual(decide().reason, 'underground');
  w.bot.entity.position.y = 70;
  w.owner = 'follow';
  assert.strictEqual(decide().reason, 'ordered');
  w.owner = 'autonomous';
  flagged(w, '_migrating');
  assert.strictEqual(decide().reason, 'migrating');
});

// ── foodTripCell / verrou / mémoire ──

test('foodTripCell : la plaine la plus proche de la carte du groupe, depuis la position du bot', () => {
  const w = tripGlue({ cells: [cell('forest', 0, 0), cell('dark_forest', 128, 0), cell('plains', 128, 128)] });
  w.bot.entity.position.x = 64; w.bot.entity.position.z = 64;
  const r = w.foodTripCell();
  assert.ok(r);
  assert.strictEqual(r.biome, 'plains');
  assert.deepStrictEqual([r.x, r.z], [160, 160]);
});

test('foodTripCell : écarte les cellules ratées du MÉMO DE BASE (< 20 min) ; rien de connu → null', () => {
  const w = tripGlue({ cells: [cell('plains', 128, 128), cell('meadow', -128, 128)] });
  w.bot.entity.position.x = 64; w.bot.entity.position.z = 64;
  const first = w.foodTripCell();
  assert.strictEqual(first.biome, 'plains');
  w.memo = { base: { x: 0, y: 64, z: 0 }, foodTrips: [{ x: first.x, z: first.z, at: w.clock.t - 5 * MIN }] };
  const second = w.foodTripCell();
  assert.ok(second && second.biome === 'meadow', 'la cellule ratée est écartée, la suivante est élue');
  w.memo.foodTrips.push({ x: second.x, z: second.z, at: w.clock.t - MIN });
  assert.strictEqual(w.foodTripCell(), null);
  const w2 = tripGlue({ cells: [] });
  assert.strictEqual(w2.foodTripCell(), null, 'carte vide');
  const w3 = tripGlue({ cells: [cell('plains', 128, 0)] });
  w3.bot.entity = undefined;
  assert.strictEqual(w3.foodTripCell(), null, 'position illisible');
});

test('foodTripLock / foodTripUnlock : un seul verrou, rendu par l unlock', () => {
  const w = tripGlue();
  assert.strictEqual(w.foodTripLock(), true);
  assert.strictEqual(w.__flags.get('_foodTripBusy'), true);
  assert.strictEqual(w.foodTripLock(), false, 'une deuxième expédition est refusée');
  w.foodTripUnlock();
  assert.strictEqual(w.__flags.get('_foodTripBusy'), false);
  assert.strictEqual(w.foodTripLock(), true);
});

test('foodTripMark : écrit la cellule ratée dans le mémo de base, en PRÉSERVANT le reste (base, zone, dette de mort)', () => {
  const memo0 = { base: { x: 1, y: 2, z: 3 }, zone: { anchoredAt: 5 }, deathDebt: { x: 9 }, deaths: [1, 2] };
  const w = tripGlue({ memo: memo0 });
  w.foodTripMark({ x: 192, z: 64, biome: 'plains', dist: 90 });
  assert.strictEqual('foodTrips' in memo0, false, 'le mémo d origine n est pas muté : on fusionne dans un objet neuf');
  assert.strictEqual(w.saved.length, 1);
  const st = w.saved[0];
  assert.deepStrictEqual(st.base, { x: 1, y: 2, z: 3 });
  assert.deepStrictEqual(st.zone, { anchoredAt: 5 });
  assert.deepStrictEqual(st.deathDebt, { x: 9 });
  assert.deepStrictEqual(st.deaths, [1, 2]);
  assert.deepStrictEqual(st.foodTrips, [{ x: 192, z: 64, at: w.clock.t }]);
  // la même cellule rafraîchit sa date (pas de doublon), une autre s ajoute
  w.clock.t += MIN;
  w.foodTripMark({ x: 200, z: 70 });
  w.foodTripMark({ x: 320, z: 64 });
  assert.strictEqual(w.memo.foodTrips.length, 2);
  assert.deepStrictEqual(w.memo.base, { x: 1, y: 2, z: 3 }, 'et le reste du mémo survit aux écritures suivantes');
});

test('foodTripMark : pas de mémo du tout (premier lancement) → un mémo neuf, sans exception', () => {
  const w = tripGlue({ memo: null });
  w.foodTripMark({ x: 192, z: 64 });
  assert.deepStrictEqual(w.memo.foodTrips, [{ x: 192, z: 64, at: w.clock.t }]);
});

test('foodTripMark → foodTripCell : la cellule ratée n est pas re-visée (aller-retour complet, piège #61)', () => {
  const w = tripGlue({ cells: [cell('plains', 128, 128), cell('meadow', -128, 128)] });
  w.bot.entity.position.x = 64; w.bot.entity.position.z = 64;
  const first = w.foodTripCell();
  w.foodTripMark(first);
  const second = w.foodTripCell();
  assert.ok(second && second.biome !== first.biome, 'la suivante, pas la même');
  w.clock.t += 20 * MIN;
  assert.strictEqual(w.foodTripCell().biome, first.biome, '20 min plus tard elle est de nouveau éligible');
});

// ── foodTripWalk ──

const mkToken = () => { const t = { cancelled: false }; return t; };

test('foodTripWalk : jambes de 64 blocs vers la cellule, GoalNearXZ de rayon 16, sans creuser', async () => {
  const w = tripGlue();
  const r = await w.foodTripWalk({ cell: { x: 140, z: 0 }, ms: 75000, token: mkToken() });
  assert.deepStrictEqual(w.gotos, [{ x: 64, z: 0, range: 16 }, { x: 128, z: 0, range: 16 }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.arrived, true);
  assert.strictEqual(r.legs, 2);
  assert.strictEqual(w.tweaks.length, 1);
  assert.deepStrictEqual(w.tweaks[0].tweaks, { canDig: false }, 'surface seulement : ni grotte ni colline percée');
});

test('foodTripWalk : GoalNearXZ (altitude libre), jamais un GoalNear 3D à l altitude courante', () => {
  const body = slice('async function foodTripWalk(', '// Stock de nourriture : chasse');
  assert.match(body, /new pfGoals\.GoalNearXZ\(leg\.x, leg\.z, FOOD_TRIP_NEAR\)/);
  assert.strictEqual(/pfGoals\.GoalNear\(/.test(body), false, 'un GoalNear 3D vers un point lointain = NoPath instantané en terrain vallonné');
});

test('foodTripWalk : bornée à `ms` — chaque jambe est rognée par ce qui reste, et la boucle s arrête', async () => {
  // chaque jambe dure 30 s et n avance que de 20 blocs : sans plafond il en ferait 8
  const w = tripGlue({
    legTakes: 30000,
    gotoImpl: (goal, ww) => { ww.bot.entity.position.x += 20; },
  });
  const t0 = w.clock.t;
  const r = await w.foodTripWalk({ cell: { x: 400, z: 0 }, ms: 75000, token: mkToken() });
  assert.deepStrictEqual(w.legTimeouts, [30000, 30000, 15000], 'la 3e jambe est rognée à ce qu il reste des 75 s');
  assert.strictEqual(w.clock.t - t0, 75000, 'la marche dure EXACTEMENT son plafond, pas une seconde de plus');
  assert.strictEqual(r.legs, 3);
  assert.strictEqual(r.arrived, false);
  // et plus de jambe quand il reste < 3 s : 10 s, jambes de 4 s → 10 s puis 6 s, il reste 2 s → stop
  const w2 = tripGlue({ legTakes: 4000, gotoImpl: (g, ww) => { ww.bot.entity.position.x += 20; } });
  const r2 = await w2.foodTripWalk({ cell: { x: 400, z: 0 }, ms: 10000, token: mkToken() });
  assert.deepStrictEqual(w2.legTimeouts, [10000, 6000]);
  assert.strictEqual(r2.legs, 2, 'il reste 2 s : aucune troisième jambe');
});

test('foodTripWalk : à l expiration d une jambe le MOUVEMENT est coupé (withTimeout seul n annule rien)', async () => {
  const w = tripGlue();
  await w.foodTripWalk({ cell: { x: 140, z: 0 }, ms: 75000, token: mkToken() });
  assert.ok(w.timeoutCbs.length >= 1);
  const before = w.stops;
  w.timeoutCbs[0]();
  assert.strictEqual(w.stops, before + 1, 'stopMotion appelé : le goto abandonné ne continue pas de marcher');
});

test('foodTripWalk : jetons — annulé avant de partir → pas un pas ; annulé après la 1re jambe → on s arrête là', async () => {
  const w = tripGlue();
  const dead = { cancelled: true };
  const r0 = await w.foodTripWalk({ cell: { x: 140, z: 0 }, ms: 75000, token: dead });
  assert.deepStrictEqual(w.gotos, []);
  assert.strictEqual(r0.legs, 0);
  const w2 = tripGlue();
  const tok = mkToken();
  w2.gotoImpl = (goal, ww) => { ww.bot.entity.position.x = goal.x; ww.bot.entity.position.z = goal.z; tok.cancelled = true; };   // un gibier apparaît
  const r = await w2.foodTripWalk({ cell: { x: 400, z: 0 }, ms: 75000, token: tok });
  assert.strictEqual(w2.gotos.length, 1);
  assert.strictEqual(r.legs, 1);
});

test('foodTripWalk : une jambe qui n avance pas DÉVIE le cap ; 2 de suite → on renonce (jamais 8 jambes sur place)', async () => {
  const w = tripGlue({ gotoImpl: () => { /* NoPath : le bot reste sur place */ } });
  const r = await w.foodTripWalk({ cell: { x: 200, z: 0 }, ms: 75000, token: mkToken() });
  assert.strictEqual(r.legs, 2, 'FOOD_TRIP_STUCK_MAX jambes puis abandon');
  assert.strictEqual(w.gotos[0].z, 0, 'la 1re jambe vise droit sur la cellule');
  assert.notStrictEqual(w.gotos[1].z, 0, 'la 2e dévie (±40°) au lieu de re-viser le même point inatteignable');
  assert.strictEqual(r.arrived, false);
  assert.strictEqual(r.moved, 0);
});

test('foodTripWalk : une jambe qui avance (≥ 16 blocs) remet le compteur de blocage à zéro', async () => {
  let n = 0;
  const w = tripGlue({ gotoImpl: (goal, ww) => { n++; if (n % 2 === 0) ww.bot.entity.position.x += 30; } });   // 1 jambe sur 2 avance
  const r = await w.foodTripWalk({ cell: { x: 600, z: 0 }, ms: 400000, token: mkToken() });
  assert.ok(r.legs > 2, `une marche qui progresse une jambe sur deux ne doit pas être abandonnée (legs=${r.legs})`);
  assert.ok(r.legs <= T.FOOD_TRIP_MAX_LEGS);
});

test('foodTripWalk : le guetteur à 2 Hz coupe le mouvement dès que le jeton est coupé — et est TOUJOURS arrêté', async () => {
  const w = tripGlue();
  const tok = mkToken();
  await w.foodTripWalk({ cell: { x: 140, z: 0 }, ms: 75000, token: tok });
  assert.strictEqual(w.watchers.length, 1);
  assert.strictEqual(w.watchers[0].ms, 500);
  assert.deepStrictEqual(w.cleared, [1], 'clearInterval appelé');
  const before = w.stops;
  w.watchers[0].fn();
  assert.strictEqual(w.stops, before, 'jeton libre : on ne coupe rien');
  tok.cancelled = true;
  w.watchers[0].fn();
  assert.strictEqual(w.stops, before + 1, 'gibier en vue : on coupe la jambe en cours, on ne laisse pas le troupeau derrière nous');
});

test('foodTripWalk : le guetteur est arrêté même si le pathfinder jette', async () => {
  const w = tripGlue({ gotoThrows: true });
  await assert.rejects(w.foodTripWalk({ cell: { x: 140, z: 0 }, ms: 75000, token: mkToken() }), /pathfinder KO/);
  assert.deepStrictEqual(w.cleared, [1]);
});

test('foodTripWalk : bot sans position → rien, sans exception', async () => {
  const w = tripGlue();
  w.bot.entity = undefined;
  const r = await w.foodTripWalk({ cell: { x: 140, z: 0 }, ms: 75000, token: mkToken() });
  assert.strictEqual(r.legs, 0);
  assert.strictEqual(r.arrived, false);
});

test('foodTripWalk : déjà sur place (≤ 24 blocs) → arrivé sans jambe', async () => {
  const w = tripGlue();
  const r = await w.foodTripWalk({ cell: { x: 10, z: 10 }, ms: 75000, token: mkToken() });
  assert.strictEqual(r.legs, 0);
  assert.strictEqual(r.arrived, true);
});

// ── foodTripYield : le planner cède le pathfinder pendant l'expédition ──

test('constante : le planner cède au plus la marche (75 s) + tout le budget de la sortie (60 s : chasse, cuisson, pêche)', () => {
  assert.strictEqual(T.FOOD_TRIP_YIELD_MAX_MS, 75000 + 60000);
  assert.ok(T.FOOD_TRIP_YIELD_MAX_MS >= T.FOOD_TRIP_MS + F.HUNT_COOK_BUDGET_MS, 'le pire cas réel d une expédition tient dans la cession');
});

test('foodTripYield : aucune expédition → retour immédiat, aucun sommeil (le planner ne ralentit jamais hors expédition)', async () => {
  const w = tripGlue();
  await w.foodTripYield();
  assert.deepStrictEqual(w.sleeps, []);
});

test('foodTripYield : expédition en cours → le planner attend qu elle finisse, par pas de 500 ms', async () => {
  const w = tripGlue();
  flagged(w, '_foodTripBusy');
  let n = 0;
  w.onSleep = () => { if (++n === 4) flagged(w, '_foodTripBusy', false); };      // l expédition finit après 4 pas
  await w.foodTripYield();
  assert.deepStrictEqual(w.sleeps, [500, 500, 500, 500]);
});

test('foodTripYield : BORNÉ — une expédition qui ne finit jamais ne gèle pas le planner au-delà de FOOD_TRIP_YIELD_MAX_MS', async () => {
  const w = tripGlue();
  flagged(w, '_foodTripBusy');
  const t0 = w.clock.t;
  await w.foodTripYield();
  const waited = w.clock.t - t0;
  assert.ok(waited >= T.FOOD_TRIP_YIELD_MAX_MS && waited < T.FOOD_TRIP_YIELD_MAX_MS + 1000, `attente=${waited}`);
});

test('foodTripYield : tâche annulée pendant l attente (mort, migration) → on rend la main aussitôt', async () => {
  const w = tripGlue();
  flagged(w, '_foodTripBusy');
  w.onSleep = (ww) => { if (ww.sleeps.length === 2) ww.taskToken.cancelled = true; };
  await w.foodTripYield();
  assert.deepStrictEqual(w.sleeps, [500, 500], 'rendu la main dès que le jeton est coupé');
});

test('index.js : runSkillWithTelemetry cède AVANT de lancer un but (après la garde migration, avant settleSurvivalKit)', () => {
  const body = slice('async function runSkillWithTelemetry(g) {', 'const _t0 = Date.now();');
  const iMig = body.indexOf('if (migrationOwnsBot())');
  const iYield = body.indexOf('await foodTripYield();');
  const iSettle = body.indexOf('await settleSurvivalKit();');
  assert.ok(iMig >= 0 && iYield > iMig && iSettle > iYield, 'ordre : garde migration → cession → survie');
});

// ── huntCookGoal : les six dépendances de l'expédition sont branchées sur les bonnes fonctions ──

test('huntCookGoal (câblage) : les dépendances de l expédition sont branchées et rendent ce que runHuntCook attend', async () => {
  const w = tripGlue({ cells: [cell('plains', 128, 128)] });
  w.bot.entity.position.x = 64; w.bot.entity.position.z = 64;
  await w.huntCookGoal(6, { goalPoints: 20 });
  const d = w.runCaptured;
  for (const k of ['tripState', 'grazingCell', 'tripLock', 'tripUnlock', 'tripWalk', 'tripTried']) {
    assert.strictEqual(typeof d[k], 'function', `${k} doit être câblée`);
  }
  assert.deepStrictEqual(w.runArgs, [6, { goalPoints: 20 }], 'les arguments historiques sont relayés tels quels');
  assert.strictEqual(d.tripState().isDay, true);
  assert.strictEqual(d.grazingCell().biome, 'plains');
  assert.strictEqual(d.tripLock(), true);
  assert.strictEqual(d.tripLock(), false);
  d.tripUnlock();
  assert.strictEqual(w.__flags.get('_foodTripBusy'), false);
  d.tripTried({ x: 160, z: 160 });
  assert.strictEqual(w.memo.foodTrips.length, 1);
  const walked = await d.tripWalk({ cell: { x: 160, z: 160 }, ms: 75000, token: mkToken() });
  assert.strictEqual(walked.ok, true);
});

test('bout en bout : runHuntCook RÉEL + câblage RÉEL d index.js — la bête du pré à 136 blocs est atteinte et chassée', async () => {
  const w = tripGlue({ cells: [cell('forest', 0, 0), cell('dark_forest', 128, 0), cell('plains', 128, 128)] });
  w.bot.entity.position.x = 64; w.bot.entity.position.z = 64;
  const events = [];
  let cow = false;
  const inv = {};
  // le vrai orchestrateur, nourri des dépendances que produit le VRAI huntCookGoal d index.js (le bac à
  // sable les capture) — seuls le monde (inventaire, gibier, chasse, horloge) et la sortie sont simulés
  const real = runHuntCook;
  await w.huntCookGoal(6);
  const deps = Object.assign({}, w.runCaptured, {
    now: () => w.clock.t,
    token: { cancelled: false },
    inventory: () => inv,
    passiveInView: () => cow,
    hunt: async (o) => { w.clock.t += 20000; inv.beef = 3; return { ok: true, kills: 2 }; },
    rawStacks: () => [], hasFurnace: () => false, hasRod: () => false, cook: async () => 0, fish: async () => ({}),
    emit: (e) => events.push(e),
  });
  // la marche réelle déplace le bot ; le gibier apparaît quand il est à ≤ 32 blocs de la cellule
  const walk = deps.tripWalk;
  deps.tripWalk = async (o) => { const r = await walk(o); cow = Math.hypot(w.bot.entity.position.x - 160, w.bot.entity.position.z - 160) <= 32; return r; };
  const r = await real(deps, 6);
  assert.strictEqual(r.ok, true, JSON.stringify(events));
  assert.deepStrictEqual(events.map((e) => e.type), ['food_trip', 'food_trip_done', 'hunt_cook_done']);
  assert.strictEqual(events[0].biome, 'plains');
  assert.ok(events[0].dist > 130 && events[0].dist < 142);
  assert.strictEqual(w.__flags.get('_foodTripBusy'), false, 'verrou rendu');
  const arrivedAt = Math.hypot(w.bot.entity.position.x - 160, w.bot.entity.position.z - 160);
  assert.ok(arrivedAt <= T.FOOD_TRIP_ARRIVED, `le bot est arrivé sur la cellule (à ${Math.round(arrivedAt)} blocs)`);
  assert.strictEqual(w.saved.length, 0, 'chasse réussie : rien n est écarté');
});

test('bout en bout : gibier introuvable à l arrivée → la cellule est écartée dans le MÉMO, verrou rendu, et la suivante sera élue', async () => {
  // la prairie voisine n est hors de portée (224 blocs) que DEPUIS le départ ; depuis la plaine elle est à 134
  const w = tripGlue({ cells: [cell('plains', 128, 128), cell('meadow', 256, 128)] });
  w.bot.entity.position.x = 64; w.bot.entity.position.z = 64;
  const events = [];
  const inv = {};
  await w.huntCookGoal(6);
  const deps = Object.assign({}, w.runCaptured, {
    now: () => w.clock.t, token: { cancelled: false }, inventory: () => inv, passiveInView: () => false,
    hunt: async () => ({ ok: true, kills: 0 }), rawStacks: () => [], hasFurnace: () => false, hasRod: () => false,
    cook: async () => 0, fish: async () => ({}), emit: (e) => events.push(e),
  });
  const r = await runHuntCook(deps, 6);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_prey:no_passive');
  assert.deepStrictEqual(events.map((e) => e.type), ['food_trip', 'food_trip_done', 'hunt_cook_done']);
  assert.strictEqual(w.__flags.get('_foodTripBusy'), false);
  assert.strictEqual(w.memo.foodTrips.length, 1, 'la cellule ratée est dans le mémo de base');
  const next = w.foodTripCell();
  assert.ok(next && next.biome === 'meadow', 'au prochain passage on tente une AUTRE cellule');
});
