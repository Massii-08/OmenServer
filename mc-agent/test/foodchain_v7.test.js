'use strict';
// CHAÎNE ALIMENTAIRE v7 — « aller là où la nourriture EST ».
//
// La v6 avait branché tous les mécanismes ; le run world_mn15 (~5 h) montre qu'ils tournaient À VIDE,
// parce qu'ils cherchaient sur place ce qui n'y était pas :
//   • `string_hunt` : 385 tentatives → 0 ficelle, dont `no_spider` ×376 — on cherchait l'araignée à
//     24 blocs, souvent EN PLEIN JOUR, dans une zone qui n'en avait pas.
//   • `fish` : 737 appels → 0 poisson (`no_water` : pas d'eau à 24 blocs des chantiers).
//   • `food_run` : 392 départs quasi tous stériles, re-tentés toutes les 3 min — du churn pur.
//   • et sous terre, `ensureFood` était borgne : son seul plan (chasse) est gated `y >= 45`, donc un
//     bot affamé au fond du puits ne faisait RIEN.
// Ces quatre décisions PURES ferment les quatre trous. Elles vivent dans caution.js, à côté de
// `stringHuntNeeded`/`foodRunNeeded` : c'est la même famille de questions — « ai-je le droit de
// partir, et à partir de quand ? » — étendue d'un cran : « et y a-t-il seulement quelque chose à
// aller chercher ? ».
const test = require('node:test');
const assert = require('node:assert');
const {
  spiderHuntWindow, spiderHuntStreak, SPIDER_NO_SPIDER_MAX, SPIDER_BACKOFF_MS, SPIDER_DAWN_END,
  foodRunCooldownAfter, FOOD_RUN_COOLDOWN_MS, FOOD_RUN_STERILE_COOLDOWN_MS,
  surfaceTripNeeded, FOOD_SURFACE_Y, FOOD_SURFACE_HUNGER,
} = require('../caution');
const { HUNT_RADIUS } = require('../skills/huntSpiders');

const T0 = 1_000_000_000;
const DAY = 6000;      // plein midi : aucune araignée fraîche
const NIGHT = 15000;

// ─── VOLET 2 — la FENÊTRE de la chasse à l'araignée ─────────────────────────────────────────────
// `stringHuntNeeded` répond « ai-je le DROIT » (blindé, armé, déficit de ficelle) ; elle reste
// inchangée. Cette fonction-ci répond « y a-t-il une PROIE » — les 376 `no_spider` sont exactement
// la preuve qu'on partait sans se poser la question.

test('araignee VISIBLE -> on part, quelle que soit l heure', () => {
  const r = spiderHuntWindow({ spiderVisible: true, isNight: false, timeOfDay: DAY, now: T0 });
  assert.strictEqual(r.go, true);
  assert.strictEqual(r.reason, 'visible');
});

test('NUIT -> on part meme sans araignee en vue (c est l heure ou elles apparaissent)', () => {
  const r = spiderHuntWindow({ spiderVisible: false, isNight: true, timeOfDay: NIGHT, now: T0 });
  assert.strictEqual(r.go, true);
  assert.strictEqual(r.reason, 'night');
});

test('PLEIN JOUR + aucune araignee en vue -> on NE PART PAS (les 376 no_spider)', () => {
  const r = spiderHuntWindow({ spiderVisible: false, isNight: false, timeOfDay: DAY, now: T0 });
  assert.strictEqual(r.go, false);
  assert.strictEqual(r.reason, 'no_target');
});

test('AUBE : la fenetre reste ouverte apres la nuit (une araignee ne brule pas au soleil)', () => {
  // Contrairement au zombie/squelette, l araignee SURVIT au lever du jour : celles de la nuit sont
  // encore la au petit matin. C est la fenetre la plus utile — un bot qui a faim a l aube.
  const dawn = { spiderVisible: false, isNight: false, now: T0 };
  assert.strictEqual(spiderHuntWindow(Object.assign({ timeOfDay: 0 }, dawn)).go, true);
  assert.strictEqual(spiderHuntWindow(Object.assign({ timeOfDay: SPIDER_DAWN_END - 1 }, dawn)).reason, 'dawn');
  assert.strictEqual(spiderHuntWindow(Object.assign({ timeOfDay: SPIDER_DAWN_END }, dawn)).go, false);
  assert.strictEqual(spiderHuntWindow(Object.assign({ timeOfDay: 24000 }, dawn)).go, true);   // normalise
});

test('heure INCONNUE + rien en vue -> on ne part pas (une expedition a l aveugle est ce qu on repare)', () => {
  // `bot.time` n est pas livre juste apres une connexion. Ici l enjeu n est pas la securite mais le
  // gaspillage : dans le doute on reste au travail, la faim a d autres filets.
  assert.strictEqual(spiderHuntWindow({ spiderVisible: false, isNight: null, now: T0 }).go, false);
  assert.strictEqual(spiderHuntWindow({ spiderVisible: false, now: T0 }).go, false);
  assert.strictEqual(spiderHuntWindow({}).go, false);
  assert.strictEqual(spiderHuntWindow().go, false);
  // …sauf si on en VOIT une : la vue prime sur l horloge.
  assert.strictEqual(spiderHuntWindow({ spiderVisible: true }).go, true);
});

test('BACK-OFF : 3 no_spider consecutifs -> 15 min de silence, meme la nuit', () => {
  const sig = (extra) => Object.assign({ spiderVisible: false, isNight: true, now: T0 }, extra);
  assert.strictEqual(spiderHuntWindow(sig({ noSpiderStreak: SPIDER_NO_SPIDER_MAX - 1, lastNoSpiderAt: T0 - 1000 })).go, true);
  const barred = spiderHuntWindow(sig({ noSpiderStreak: SPIDER_NO_SPIDER_MAX, lastNoSpiderAt: T0 - 1000 }));
  assert.strictEqual(barred.go, false);
  assert.strictEqual(barred.reason, 'backoff');
  assert.strictEqual(SPIDER_NO_SPIDER_MAX, 3);
  assert.strictEqual(SPIDER_BACKOFF_MS, 900000);
});

test('BACK-OFF : il EXPIRE (la zone se repeuple, on retente)', () => {
  const sig = { spiderVisible: false, isNight: true, now: T0, noSpiderStreak: 9 };
  assert.strictEqual(spiderHuntWindow(Object.assign({ lastNoSpiderAt: T0 - (SPIDER_BACKOFF_MS - 1) }, sig)).go, false);
  assert.strictEqual(spiderHuntWindow(Object.assign({ lastNoSpiderAt: T0 - SPIDER_BACKOFF_MS }, sig)).go, true);
});

test('BACK-OFF : une araignee VISIBLE ne le perce pas (le cooldown vaut aussi contre le churn)', () => {
  // Volontaire : voir UNE araignee juste apres 3 echecs, c est typiquement le mob qui vient de
  // spawner sur le bot — la chasse repartirait pour re-echouer. La faim a d autres filets pendant
  // ces 15 minutes ; on veut surtout que le bot RETOURNE TRAVAILLER.
  const r = spiderHuntWindow({ spiderVisible: true, now: T0, noSpiderStreak: SPIDER_NO_SPIDER_MAX, lastNoSpiderAt: T0 - 1000 });
  assert.strictEqual(r.go, false);
  assert.strictEqual(r.reason, 'backoff');
});

test('BACK-OFF : sans horloge exploitable il ne bloque JAMAIS (retro-compat, jamais un bot gele)', () => {
  const sig = { spiderVisible: false, isNight: true, noSpiderStreak: 9 };
  assert.strictEqual(spiderHuntWindow(Object.assign({}, sig)).go, true);
  assert.strictEqual(spiderHuntWindow(Object.assign({ now: T0 }, sig)).go, true);            // pas de lastNoSpiderAt
  assert.strictEqual(spiderHuntWindow(Object.assign({ lastNoSpiderAt: T0 }, sig)).go, true); // pas de now
  assert.strictEqual(spiderHuntWindow(Object.assign({ now: T0, lastNoSpiderAt: 0 }, sig)).go, true);
});

test('le compteur de no_spider : +1 sur une zone vide, RAZ des qu une araignee existe', () => {
  assert.strictEqual(spiderHuntStreak({ reason: 'no_spider', strings: 0, kills: 0 }, 0), 1);
  assert.strictEqual(spiderHuntStreak({ reason: 'no_spider', strings: 0, kills: 0 }, 2), 3);
  // Du butin = la preuve qu il y en a -> on repart de zero.
  assert.strictEqual(spiderHuntStreak({ reason: 'target', strings: 2, kills: 1 }, 5), 0);
  // Tuee sans ficelle (drop nul) : l araignee EXISTE quand meme -> RAZ.
  assert.strictEqual(spiderHuntStreak({ reason: 'count', strings: 0, kills: 1 }, 5), 0);
});

test('le compteur ignore ce qui ne PROUVE PAS l absence (fuite, timeout, annulation)', () => {
  for (const reason of ['flee', 'kill_timeout', 'timeout', 'cancelled', 'no_pvp', 'error']) {
    assert.strictEqual(spiderHuntStreak({ reason, strings: 0, kills: 0 }, 2), 2, reason);
  }
  assert.strictEqual(spiderHuntStreak(null, 2), 2);
  assert.strictEqual(spiderHuntStreak(undefined, 0), 0);
  assert.strictEqual(spiderHuntStreak({ reason: 'no_spider' }), 1);   // etat initial absent
});

test('le rayon de chasse est passe de 24 a 48 (source unique, cote skill)', () => {
  assert.strictEqual(HUNT_RADIUS, 48);
});

// ─── VOLET 3 — la quete de nourriture STÉRILE se met en sourdine ────────────────────────────────
// 392 departs, quasi tous a vide, relances toutes les 3 min : c est le churn a tuer. Une passe qui
// ne rapporte RIEN dit quelque chose de la ZONE, pas de l instant — inutile d y retourner tout de
// suite. Un gain, lui, prouve que la zone donne encore : on revient au regime nerveux.

test('passe STERILE (stock identique avant/apres) -> le prochain depart attend 15 min', () => {
  assert.strictEqual(foodRunCooldownAfter({ before: 0, after: 0 }), FOOD_RUN_STERILE_COOLDOWN_MS);
  assert.strictEqual(foodRunCooldownAfter({ before: 3, after: 3 }), FOOD_RUN_STERILE_COOLDOWN_MS);
  assert.strictEqual(FOOD_RUN_STERILE_COOLDOWN_MS, 900000);
  assert.ok(FOOD_RUN_STERILE_COOLDOWN_MS > FOOD_RUN_COOLDOWN_MS);
});

test('passe qui RAPPORTE -> retour au regime normal de 3 min', () => {
  assert.strictEqual(foodRunCooldownAfter({ before: 0, after: 1 }), FOOD_RUN_COOLDOWN_MS);
  assert.strictEqual(foodRunCooldownAfter({ before: 2, after: 40 }), FOOD_RUN_COOLDOWN_MS);
});

test('stock qui BAISSE (le bot a mange en route) -> stérile : rien n a ete RAMENE', () => {
  assert.strictEqual(foodRunCooldownAfter({ before: 4, after: 1 }), FOOD_RUN_STERILE_COOLDOWN_MS);
});

test('mesure impossible -> regime normal (on ne met jamais un bot en sourdine sur une donnee absente)', () => {
  assert.strictEqual(foodRunCooldownAfter({}), FOOD_RUN_COOLDOWN_MS);
  assert.strictEqual(foodRunCooldownAfter(), FOOD_RUN_COOLDOWN_MS);
  assert.strictEqual(foodRunCooldownAfter({ before: null, after: 2 }), FOOD_RUN_COOLDOWN_MS);
  assert.strictEqual(foodRunCooldownAfter({ before: 0, after: NaN }), FOOD_RUN_COOLDOWN_MS);
});

// ─── VOLET 4 — sous terre, REMONTER avant de chercher ───────────────────────────────────────────
// Le point borgne documente de la v6 : le seul plan de `ensureFood` (chasse) est gated `y >= 45`
// « la chasse est impossible sous terre » — vrai, mais la conclusion tiree etait « alors on ne fait
// rien ». Un bot affame a y=12 restait donc a y=12 jusqu a mourir. Le home `safe` est en surface :
// c est une remontee, pas une exploration.

test('sous terre + affame + rien a manger -> on remonte', () => {
  assert.strictEqual(surfaceTripNeeded({ y: 12, food: FOOD_SURFACE_HUNGER, foodItems: 0 }), true);
  assert.strictEqual(surfaceTripNeeded({ y: -40, food: 0, foodItems: 0 }), true);
  assert.strictEqual(surfaceTripNeeded({ y: FOOD_SURFACE_Y - 1, food: 3, foodItems: 0 }), true);
});

test('EN SURFACE -> non : la quete normale (chasse/peche) fait deja le travail sur place', () => {
  assert.strictEqual(surfaceTripNeeded({ y: FOOD_SURFACE_Y, food: 0, foodItems: 0 }), false);
  assert.strictEqual(surfaceTripNeeded({ y: 64, food: 0, foodItems: 0 }), false);
  assert.strictEqual(FOOD_SURFACE_Y, 45);   // le meme plancher que le gate existant d ensureFood
});

test('faim CONFORTABLE -> non : on ne coupe pas un minage pour du confort', () => {
  assert.strictEqual(surfaceTripNeeded({ y: 12, food: FOOD_SURFACE_HUNGER + 1, foodItems: 0 }), false);
  assert.strictEqual(surfaceTripNeeded({ y: 12, food: 20, foodItems: 0 }), false);
  assert.strictEqual(FOOD_SURFACE_HUNGER, 10);
});

test('il RESTE a manger -> non : le filet « manger » suffit, meme au fond du puits', () => {
  assert.strictEqual(surfaceTripNeeded({ y: 12, food: 2, foodItems: 1 }), false);
  assert.strictEqual(surfaceTripNeeded({ y: 12, food: 2, foodItems: 64 }), false);
});

test('stock inconnu -> traite comme VIDE (meme arbitrage que foodRunNeeded)', () => {
  assert.strictEqual(surfaceTripNeeded({ y: 12, food: 2 }), true);
  assert.strictEqual(surfaceTripNeeded({ y: 12, food: 2, foodItems: null }), true);
});

test('faim ou altitude INCONNUES -> non, et jamais une exception', () => {
  assert.strictEqual(surfaceTripNeeded({ y: 12, foodItems: 0 }), false);
  assert.strictEqual(surfaceTripNeeded({ y: 12, food: null, foodItems: 0 }), false);
  assert.strictEqual(surfaceTripNeeded({ food: 2, foodItems: 0 }), false);
  assert.strictEqual(surfaceTripNeeded({ y: NaN, food: 2, foodItems: 0 }), false);
  assert.strictEqual(surfaceTripNeeded({}), false);
  assert.strictEqual(surfaceTripNeeded(), false);
});
