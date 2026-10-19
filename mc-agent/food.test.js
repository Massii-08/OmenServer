'use strict';
// NOURRITURE — compter en POINTS DE FAIM et borner le temps (décisions PURES, aucun serveur).
// Voir food.js pour le constat live (monde neuf, 13 min) : seule la viande CUITE comptait comme
// réserve, et une « sortie nourriture » pouvait durer ~6 minutes.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const F = require('./food');
const { FOODS, EMERGENCY_FOODS } = require('./reflexes');

// ─── 1. foodPoints : la table et le compte ──────────────────────────────────────────────────────

test('foodPoints : inventaire vide / absent / illisible → 0, jamais d exception', () => {
  assert.strictEqual(F.foodPoints({}), 0);
  assert.strictEqual(F.foodPoints([]), 0);
  assert.strictEqual(F.foodPoints(null), 0);
  assert.strictEqual(F.foodPoints(undefined), 0);
  assert.strictEqual(F.foodPoints('cooked_beef'), 0);
  assert.strictEqual(F.foodPoints(42), 0);
});

test('foodPoints : le CUIT vaut ses points vanilla (2 steaks = 16)', () => {
  assert.strictEqual(F.foodPoints({ cooked_beef: 2 }), 16);
  assert.strictEqual(F.foodPoints({ cooked_porkchop: 1, cooked_chicken: 1, bread: 1 }), 8 + 6 + 5);
});

test('foodPoints : le CRU compte (4 bœufs crus = 12 = le seuil du kit) — c était LE trou', () => {
  assert.strictEqual(F.foodPoints({ beef: 4 }), 12);
  assert.strictEqual(F.foodPoints({ beef: 4 }) >= F.STOCK_POINTS, true);
  assert.strictEqual(F.foodPoints({ porkchop: 1, mutton: 1, chicken: 1, rabbit: 1, cod: 1, salmon: 1, tropical_fish: 1, potato: 1 }),
    3 + 2 + 2 + 3 + 2 + 2 + 1 + 1);
});

test('foodPoints : la chair putréfiée vaut 2 (4 vanilla, décotée pour l effet Faim) — 10 chairs = 20', () => {
  assert.strictEqual(F.foodPoints({ rotten_flesh: 1 }), 2);
  assert.strictEqual(F.foodPoints({ rotten_flesh: 10 }), 20);
  // 10 chairs putréfiées : plus aucune raison de repartir chasser (seuil d ensureFood = 20)
  assert.strictEqual(F.foodPoints({ rotten_flesh: 10 }) >= F.ENSURE_SKIP_POINTS, true);
});

test('foodPoints : tout ce qui n est pas comestible est ignoré (et les noms hérités d Object ne donnent pas NaN)', () => {
  assert.strictEqual(F.foodPoints({ cobblestone: 64, iron_pickaxe: 1, spider_eye: 3 }), 0);
  assert.strictEqual(F.foodPoints({ constructor: 5, toString: 2, __proto__: 1, hasOwnProperty: 9 }), 0);
  assert.strictEqual(F.foodPoints({ cooked_beef: 1, constructor: 5 }), 8);
});

test('foodPoints : compte invalide (négatif, NaN, texte) → ignoré, jamais de NaN ni de points négatifs', () => {
  assert.strictEqual(F.foodPoints({ cooked_beef: -3 }), 0);
  assert.strictEqual(F.foodPoints({ cooked_beef: NaN }), 0);
  assert.strictEqual(F.foodPoints({ cooked_beef: 'beaucoup' }), 0);
  assert.strictEqual(F.foodPoints({ cooked_beef: null }), 0);
  assert.strictEqual(F.foodPoints({ cooked_beef: 2, bread: -1 }), 16);
});

test('foodPoints : accepte AUSSI la liste [{name,count}] (piège #61 : deux formes d inventaire dans le code)', () => {
  const list = [{ name: 'cooked_beef', count: 2 }, { name: 'rotten_flesh', count: 3 }, { name: 'dirt', count: 64 }, null, { count: 5 }];
  assert.strictEqual(F.foodPoints(list), 16 + 6);
  const map = { cooked_beef: 2, rotten_flesh: 3, dirt: 64 };
  assert.strictEqual(F.foodPoints(list), F.foodPoints(map));
});

test('FOOD_POINTS : valeurs vanilla de la consigne', () => {
  const T = F.FOOD_POINTS;
  const attendu = {
    cooked_beef: 8, cooked_porkchop: 8, cooked_mutton: 6, cooked_chicken: 6, cooked_salmon: 6,
    cooked_cod: 5, cooked_rabbit: 5, bread: 5, baked_potato: 5, mushroom_stew: 6, rabbit_stew: 10,
    beetroot_soup: 6, pumpkin_pie: 8, golden_carrot: 6, apple: 4, carrot: 3, melon_slice: 2,
    sweet_berries: 2, glow_berries: 2, cookie: 2, beetroot: 1, dried_kelp: 1, honey_bottle: 6,
    beef: 3, porkchop: 3, mutton: 2, chicken: 2, rabbit: 3, cod: 2, salmon: 2, tropical_fish: 1, potato: 1,
    rotten_flesh: 2,
  };
  assert.deepStrictEqual({ ...T }, attendu);
  assert.strictEqual(Object.isFrozen(T), true, 'une table de référence ne se modifie pas en vol');
});

test('FOOD_POINTS : le cuit vaut toujours plus que son cru (sinon cuire serait une perte)', () => {
  const T = F.FOOD_POINTS;
  for (const raw of ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon']) {
    assert.ok(T['cooked_' + raw] > T[raw], raw);
  }
  assert.ok(T.baked_potato > T.potato);
});

test('FOOD_POINTS ⇄ reflexes.js : le bot MANGE tout ce qu on compte, et on compte tout ce qu il mange', () => {
  // Deux définitions de « comestible » finissent toujours par diverger — c est exactement comme ça
  // qu on comptait « 0 nourriture » avec 10 chairs putréfiées en poche. Ce test les cloue ensemble.
  const mangeable = new Set([...FOODS, ...EMERGENCY_FOODS]);
  for (const name of Object.keys(F.FOOD_POINTS)) {
    assert.ok(mangeable.has(name), `${name} est compté mais le réflexe de faim ne le mange pas`);
  }
  // suspicious_stew : mangé en détresse mais volontairement compté 0 (effets aléatoires, potentiellement
  // Poison/Wither) — on ne bâtit pas une réserve dessus.
  for (const name of mangeable) {
    if (name === 'suspicious_stew') continue;
    assert.ok(F.FOOD_POINTS[name] > 0, `${name} est mangé par le réflexe mais ne compte pour rien`);
  }
  assert.strictEqual(F.FOOD_POINTS.suspicious_stew, undefined);
});

test('seuils : kit 12, ensureFood 20, remontée 6, portée de vue 32', () => {
  assert.strictEqual(F.STOCK_POINTS, 12);
  assert.strictEqual(F.ENSURE_SKIP_POINTS, 20);
  assert.strictEqual(F.SURFACE_TRIP_POINTS, 6);
  assert.strictEqual(F.HUNT_SIGHT_RADIUS, 32);
  assert.ok(F.STOCK_POINTS < F.ENSURE_SKIP_POINTS, 'le kit se contente de moins que ce que ensureFood vise');
});

// ─── 2. Le temps : budget partagé, jeton borné ──────────────────────────────────────────────────

function fakeClock(t0 = 1000) {
  const c = { t: t0, now: () => c.t, advance: (ms) => { c.t += ms; } };
  return c;
}

test('createBudget : le temps restant baisse avec l horloge, jamais négatif', () => {
  const c = fakeClock();
  const b = F.createBudget(60000, c.now);
  assert.strictEqual(b.left(), 60000);
  assert.strictEqual(b.total, 60000);
  c.advance(8000);
  assert.strictEqual(b.left(), 52000);
  assert.strictEqual(b.elapsed(), 8000);
  assert.strictEqual(b.expired(), false);
  c.advance(999999);
  assert.strictEqual(b.left(), 0);
  assert.strictEqual(b.expired(), true);
});

test('createBudget.take(cap) : le plafond d une phase, rogné par ce qui reste du TOTAL', () => {
  const c = fakeClock();
  const b = F.createBudget(60000, c.now);
  assert.strictEqual(b.take(8000), 8000);
  assert.strictEqual(b.take(999999), 60000);
  c.advance(50000);
  assert.strictEqual(b.take(45000), 10000, 'la chasse ne peut pas dépasser ce qui reste du budget');
  c.advance(20000);
  assert.strictEqual(b.take(45000), 0);
  assert.strictEqual(b.take(NaN), 0);
  assert.strictEqual(b.take(-5), 0);
});

test('createBudget : total invalide → budget nul (échoue vers le COURT, jamais vers l infini)', () => {
  assert.strictEqual(F.createBudget(NaN).left(), 0);
  assert.strictEqual(F.createBudget(undefined).left(), 0);
  assert.strictEqual(F.createBudget(-1).left(), 0);
});

test('boundedToken : suit le jeton parent, peut être coupé localement, et s arrête sur un prédicat', () => {
  const parent = { cancelled: false };
  const a = F.boundedToken(parent);
  assert.strictEqual(a.token.cancelled, false);
  parent.cancelled = true;
  assert.strictEqual(a.token.cancelled, true, 'tâche annulée → la sous-routine s arrête aussi');

  const b = F.boundedToken({ cancelled: false });
  b.cancel();
  assert.strictEqual(b.token.cancelled, true);

  let enough = false;
  const c = F.boundedToken({ cancelled: false }, () => enough);
  assert.strictEqual(c.token.cancelled, false);
  enough = true;
  assert.strictEqual(c.token.cancelled, true, 'objectif atteint → on lâche prise tout de suite');
});

test('boundedToken : parent absent, prédicat qui jette → pas annulé (une donnée illisible ne coupe rien)', () => {
  assert.strictEqual(F.boundedToken(null).token.cancelled, false);
  assert.strictEqual(F.boundedToken(undefined, () => { throw new Error('boom'); }).token.cancelled, false);
  const t = F.boundedToken({ cancelled: false });
  t.token.cancelled = true;                       // le setter existe (un consommateur peut vouloir l armer)
  assert.strictEqual(t.token.cancelled, true);
});

test('boundedToken : le jeton parent est relu À CHAQUE LECTURE (un getter, pas une copie)', () => {
  const parent = { cancelled: false };
  const { token } = F.boundedToken(parent);
  const lectures = [token.cancelled, (parent.cancelled = true, token.cancelled)];
  assert.deepStrictEqual(lectures, [false, true]);
});

// ─── 3. Cuire : seulement si ça tient dans le budget ────────────────────────────────────────────

test('cookPlan : pas de four EN POCHE → on garde le cru (il se mange)', () => {
  const p = F.cookPlan({ raw: 6, furnace: false, leftMs: 50000 });
  assert.strictEqual(p.cook, 0);
  assert.strictEqual(p.reason, 'no_furnace');
});

test('cookPlan : moins de 2 crus → rien (poser puis reprendre un four pour UNE pièce ne vaut pas le temps)', () => {
  assert.strictEqual(F.cookPlan({ raw: 1, furnace: true, leftMs: 50000 }).cook, 0);
  assert.strictEqual(F.cookPlan({ raw: 1, furnace: true, leftMs: 50000 }).reason, 'few_raw');
  assert.strictEqual(F.cookPlan({ raw: 0, furnace: true, leftMs: 50000 }).cook, 0);
  assert.strictEqual(F.cookPlan({ raw: 2, furnace: true, leftMs: 50000 }).cook, 2);
});

test('cookPlan : le nombre de pièces tient dans le temps (10 s par pièce + 8 s de pose/reprise du four)', () => {
  // 45 s restantes : (45 − 8) / 10 = 3 pièces.
  const p = F.cookPlan({ raw: 8, furnace: true, leftMs: 45000 });
  assert.strictEqual(p.cook, 3);
  assert.strictEqual(p.reason, 'ok');
  assert.ok(p.maxMs >= 3 * F.SMELT_ITEM_MS, 'le plafond du four couvre ses pièces');
  assert.ok(p.maxMs <= 3 * F.SMELT_ITEM_MS + 5000, 'mais pas bien davantage');
  // beaucoup de temps : on cuit tout ce qu on a
  assert.strictEqual(F.cookPlan({ raw: 4, furnace: true, leftMs: 60000 }).cook, 4);
});

test('cookPlan : pas assez de temps pour 2 pièces → on n y va pas du tout', () => {
  const p = F.cookPlan({ raw: 8, furnace: true, leftMs: 25000 });   // (25 − 8) / 10 = 1 pièce
  assert.strictEqual(p.cook, 0);
  assert.strictEqual(p.reason, 'no_time');
  assert.strictEqual(F.cookPlan({ raw: 8, furnace: true, leftMs: 0 }).cook, 0);
});

test('cookPlan : entrées absentes ou invalides → 0, jamais d exception', () => {
  assert.strictEqual(F.cookPlan().cook, 0);
  assert.strictEqual(F.cookPlan({}).cook, 0);
  assert.strictEqual(F.cookPlan({ raw: NaN, furnace: true, leftMs: NaN }).cook, 0);
  assert.strictEqual(F.cookPlan({ raw: 5, furnace: true, leftMs: undefined }).cook, 0);
});

// ─── 4. Pêcher : canne EN POCHE, sinon rien ─────────────────────────────────────────────────────

test('fishPlan : sans canne en poche → on ne pêche pas (et on ne fabrique ni ne chasse la ficelle)', () => {
  const p = F.fishPlan({ rod: false, leftMs: 50000 });
  assert.strictEqual(p.fish, false);
  assert.strictEqual(p.reason, 'no_rod');
});

test('fishPlan : canne + temps → pêche, 40 s au plus, rognées par le budget restant', () => {
  assert.deepStrictEqual(
    { ...F.fishPlan({ rod: true, leftMs: 55000 }) },
    { fish: true, ms: 40000, reason: 'ok' });
  assert.strictEqual(F.fishPlan({ rod: true, leftMs: 20000 }).ms, 20000);
  assert.strictEqual(F.FISH_MS, 40000);
  assert.strictEqual(F.FISH_RADIUS, 16);
});

test('fishPlan : trop peu de temps (< 12 s) → une ligne n aurait même pas le temps de mordre', () => {
  const p = F.fishPlan({ rod: true, leftMs: 11000 });
  assert.strictEqual(p.fish, false);
  assert.strictEqual(p.reason, 'no_time');
  assert.strictEqual(F.fishPlan({ rod: true, leftMs: 12000 }).fish, true);
  assert.strictEqual(F.fishPlan().fish, false);
});

// ─── 5. Ramasser après un combat : « faut-il ramasser MAINTENANT ? » ────────────────────────────

const ZOMBIE = { name: 'zombie', kind: 'Hostile mobs', type: 'hostile' };
const calme = (extra) => Object.assign({
  target: ZOMBIE, hostilesNear: false, migrating: false, busy: false, goalActive: false, dropDist: 2.5,
}, extra);

test('shouldLootAfterCombat : zombie tué, aucun hostile, rien d autre en cours, un objet à 2,5 blocs → on ramasse', () => {
  const r = F.shouldLootAfterCombat(calme());
  assert.strictEqual(r.go, true);
  assert.strictEqual(r.reason, 'ok');
});

test('shouldLootAfterCombat : un hostile à ≤ 8 blocs → non (le combat n est pas fini)', () => {
  const r = F.shouldLootAfterCombat(calme({ hostilesNear: true }));
  assert.strictEqual(r.go, false);
  assert.strictEqual(r.reason, 'hostiles');
});

test('shouldLootAfterCombat : PENDANT une migration → jamais (elle est exclusive)', () => {
  const r = F.shouldLootAfterCombat(calme({ migrating: true, dropDist: 1 }));
  assert.strictEqual(r.go, false);
  assert.strictEqual(r.reason, 'migrating');
});

test('shouldLootAfterCombat : bot occupé (panique, armure, noyade, ramassage déjà en cours…) → non', () => {
  const r = F.shouldLootAfterCombat(calme({ busy: true, dropDist: 1 }));
  assert.strictEqual(r.go, false);
  assert.strictEqual(r.reason, 'busy');
});

test('shouldLootAfterCombat : un AUTRE but pathfinder est actif → seulement si l objet est à ≤ 4 blocs', () => {
  const loin = F.shouldLootAfterCombat(calme({ goalActive: true, dropDist: 4.01 }));
  assert.strictEqual(loin.go, false);
  assert.strictEqual(loin.reason, 'trip_in_progress');
  assert.strictEqual(F.shouldLootAfterCombat(calme({ goalActive: true, dropDist: 4 })).go, true);
  assert.strictEqual(F.shouldLootAfterCombat(calme({ goalActive: true, dropDist: 0.5 })).go, true);
  // sans but actif la distance (≤ rayon de balayage) ne compte pas
  assert.strictEqual(F.shouldLootAfterCombat(calme({ goalActive: false, dropDist: 5.9 })).go, true);
});

test('shouldLootAfterCombat : rien au sol → non (et null ≠ 0 : « pas d objet » n est pas « objet à 0 bloc »)', () => {
  assert.strictEqual(F.shouldLootAfterCombat(calme({ dropDist: null })).reason, 'no_drop');
  assert.strictEqual(F.shouldLootAfterCombat(calme({ dropDist: undefined })).reason, 'no_drop');
  assert.strictEqual(F.shouldLootAfterCombat(calme({ dropDist: NaN })).reason, 'no_drop');
  assert.strictEqual(F.shouldLootAfterCombat(calme({ dropDist: 0 })).go, true, 'un objet SOUS nos pieds, lui, compte');
});

test('shouldLootAfterCombat : seul un hostile tué ouvre la porte (le gibier chassé a SON ramassage)', () => {
  // huntPassive va lui-même sur le lieu de mort : lui faire concurrence = deux goto qui se volent le
  // pathfinder (GoalChanged), le bug de classe n°1 du 19/10.
  assert.strictEqual(F.shouldLootAfterCombat(calme({ target: { name: 'cow', kind: 'Passive mobs', type: 'animal' } })).reason, 'not_hostile');
  assert.strictEqual(F.shouldLootAfterCombat(calme({ target: null })).reason, 'not_hostile');
  assert.strictEqual(F.shouldLootAfterCombat(calme({ target: undefined })).reason, 'not_hostile');
  assert.strictEqual(F.shouldLootAfterCombat(calme({ target: {} })).reason, 'not_hostile');
  assert.strictEqual(F.shouldLootAfterCombat(calme({ target: { name: 'player', type: 'player' } })).reason, 'not_hostile');
});

test('shouldLootAfterCombat : zombie, araignée, squelette, noyé… tous « hostile » (kind OU type)', () => {
  for (const t of [
    { name: 'spider', kind: 'Hostile mobs' },
    { name: 'skeleton', type: 'hostile' },
    { name: 'drowned', kind: 'Hostile mobs', type: 'hostile' },
    { name: 'husk', kind: 'Hostile mobs' },
  ]) {
    assert.strictEqual(F.shouldLootAfterCombat(calme({ target: t })).go, true, t.name);
  }
});

test('shouldLootAfterCombat : l enderman reste NEUTRE même classé « Hostile mobs » (on ne va pas fouiller son combat)', () => {
  assert.strictEqual(F.shouldLootAfterCombat(calme({ target: { name: 'enderman', kind: 'Hostile mobs' } })).reason, 'not_hostile');
});

test('shouldLootAfterCombat : état absent → non, sans exception', () => {
  assert.strictEqual(F.shouldLootAfterCombat().go, false);
  assert.strictEqual(F.shouldLootAfterCombat(null).go, false);
  assert.strictEqual(F.shouldLootAfterCombat({}).go, false);
});

test('shouldLootAfterCombat : constantes de la consigne (rayon 6, 4 objets, 5 s, hostiles à 8, objet « proche » à 4)', () => {
  assert.strictEqual(F.COMBAT_LOOT_RADIUS, 6);
  assert.strictEqual(F.COMBAT_LOOT_ITEMS, 4);
  assert.strictEqual(F.COMBAT_LOOT_MS, 5000);
  assert.strictEqual(F.COMBAT_LOOT_HOSTILE_RADIUS, 8);
  assert.strictEqual(F.COMBAT_LOOT_NEAR, 4);
  assert.strictEqual(F.COMBAT_LOOT_SETTLE_MS, 400);
});

// ─── 6. Les durées de la consigne ───────────────────────────────────────────────────────────────

test('durées : sortie nourriture 60 s (timer 70 s), butin 8 s rayon 10, chasse 45 s', () => {
  assert.strictEqual(F.FOOD_RUN_BUDGET_MS, 60000);
  assert.strictEqual(F.FOOD_RUN_TIMEOUT_MS, 70000);
  assert.strictEqual(F.LOOT_SWEEP_MS, 8000);
  assert.strictEqual(F.LOOT_SWEEP_RADIUS, 10);
  assert.strictEqual(F.HUNT_WAVE_MS, 45000);
  assert.ok(F.FOOD_RUN_TIMEOUT_MS > F.FOOD_RUN_BUDGET_MS, 'le garde-fou du timer laisse de la marge au budget');
});

// ─── 7. Câblage dans les fichiers qui consomment le module ──────────────────────────────────────

test('goals.js : n a plus de compteur « cuit seulement » — une seule mesure, foodPoints', () => {
  const src = fs.readFileSync(path.join(__dirname, 'goals.js'), 'utf8');
  assert.strictEqual(/cookedCount|COOKED_FOODS/.test(src), false, 'l ancienne mesure ne doit pas survivre (c était le bug)');
  assert.match(src, /require\('\.\/food'\)/);
});
