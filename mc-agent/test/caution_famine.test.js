'use strict';
// FAMINE — les deux décisions PURES nées du run world_mn15 (18/08), où la faim est devenue la
// cause de mort DOMINANTE : 5 « starved to death » en 10 minutes sur 4 bots BLINDÉS (armure fer
// complète, épées) — ce n'est donc plus un problème de combat, c'est un problème d'ACQUISITION.
//
// La chaîne de nourriture était rompue en bout de course :
//     faim → chasse (`no_prey` systématique, la zone est vidée depuis des heures)
//          → pêche (`no_rod` ×444 : la canne coûte 3 bâtons + 2 FICELLES, et il n'y a pas de ficelle)
//          → RIEN.
// La ficelle ne se ramasse pas au sol : elle se prend sur l'ARAIGNÉE, qui pullule autour du camp.
// D'où `stringHuntNeeded` (la porte : on ne va chercher la ficelle que blindé et armé) et
// `foodRunNeeded` (le déclencheur : partir chercher à manger AVANT le seuil critique).
const test = require('node:test');
const assert = require('node:assert');
const {
  stringHuntNeeded, STRING_HUNT_MIN_WORN, CAUTION_MIN_WORN,
  foodRunNeeded, FOOD_RUN_HUNGER, FOOD_RUN_COOLDOWN_MS,
} = require('../caution');

// Un bot en état de chasser : blindé (≥2 pièces) et armé.
const READY = { worn: 4, hasWeapon: true };
const arr = (o) => Object.entries(o).map(([name, count]) => ({ name, count }));

// ─── stringHuntNeeded : faut-il aller chercher de la FICELLE sur une araignée ? ─────────────────

test('inventaire vide + blinde + arme -> OUI (ni canne, ni ficelle : la peche est morte sans ca)', () => {
  assert.strictEqual(stringHuntNeeded(Object.assign({ inventory: [] }, READY)), true);
});

test('canne en poche -> NON (la peche marche deja, rien a chasser)', () => {
  const inv = arr({ fishing_rod: 1 });
  assert.strictEqual(stringHuntNeeded(Object.assign({ inventory: inv }, READY)), false);
});

test('3 batons + 2 ficelles -> NON (la canne est fabricable ici et maintenant)', () => {
  const inv = arr({ stick: 3, string: 2 });
  assert.strictEqual(stringHuntNeeded(Object.assign({ inventory: inv }, READY)), false);
});

test('assez de ficelle mais pas de batons -> NON : c est du BOIS qu il manque, pas une araignee', () => {
  // Le piege exact : `no_rod` ne veut pas dire « chasse l araignee ». Deux deficits differents.
  const inv = arr({ string: 5 });
  assert.strictEqual(stringHuntNeeded(Object.assign({ inventory: inv }, READY)), false);
});

test('une seule ficelle (il en faut 2) -> OUI : le deficit de ficelle est ce qui declenche', () => {
  const inv = arr({ stick: 3, string: 1 });
  assert.strictEqual(stringHuntNeeded(Object.assign({ inventory: inv }, READY)), true);
});

test('piles de ficelle fragmentees : elles s ADDITIONNENT (1+1 = 2 -> plus besoin de chasser)', () => {
  const inv = [{ name: 'string', count: 1 }, { name: 'string', count: 1 }, { name: 'stick', count: 3 }];
  assert.strictEqual(stringHuntNeeded(Object.assign({ inventory: inv }, READY)), false);
});

test('NU (0 piece) -> NON : on ne va jamais chatouiller une araignee sans armure', () => {
  assert.strictEqual(stringHuntNeeded({ inventory: [], worn: 0, hasWeapon: true }), false);
});

test('1 seule piece portee -> NON (sous le plancher de prudence)', () => {
  assert.strictEqual(stringHuntNeeded({ inventory: [], worn: 1, hasWeapon: true }), false);
});

test('le plancher est exactement celui de la prudence nocturne (source unique, pas un 2 en dur)', () => {
  assert.strictEqual(STRING_HUNT_MIN_WORN, CAUTION_MIN_WORN);
  assert.strictEqual(stringHuntNeeded({ inventory: [], worn: CAUTION_MIN_WORN, hasWeapon: true }), true);
  assert.strictEqual(stringHuntNeeded({ inventory: [], worn: CAUTION_MIN_WORN - 1, hasWeapon: true }), false);
});

test('blinde mais DESARME -> NON (une araignee au poing, c est 1 degat contre 5)', () => {
  assert.strictEqual(stringHuntNeeded({ inventory: [], worn: 4, hasWeapon: false }), false);
  assert.strictEqual(stringHuntNeeded({ inventory: [], worn: 4 }), false);
});

test('armure INCONNUE (donnee absente / NaN) -> NON : on tranche du cote prudent', () => {
  assert.strictEqual(stringHuntNeeded({ inventory: [], hasWeapon: true }), false);
  assert.strictEqual(stringHuntNeeded({ inventory: [], worn: null, hasWeapon: true }), false);
  assert.strictEqual(stringHuntNeeded({ inventory: [], worn: 'quatre', hasWeapon: true }), false);
});

test('worn accepte un Set ou un tableau de pieces (index.js manipule les DEUX formes)', () => {
  // Piege #61 : un champ lu au mauvais NIVEAU ne plante jamais, il rend la fonctionnalite morte.
  // Number(new Set([...])) = NaN -> lu comme « 0, nu » -> la chasse ne partirait JAMAIS.
  const pieces = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];
  assert.strictEqual(stringHuntNeeded({ inventory: [], worn: new Set(pieces), hasWeapon: true }), true);
  assert.strictEqual(stringHuntNeeded({ inventory: [], worn: pieces, hasWeapon: true }), true);
  assert.strictEqual(stringHuntNeeded({ inventory: [], worn: new Set(['iron_boots']), hasWeapon: true }), false);
});

test('inventaire donne en CARTE {nom: nombre} (forme buildCtxInv) : meme verdict, aucun crash', () => {
  // buildCtxInv(bot) rend {name: count}, bot.inventory.items() rend [{name,count}] : les deux
  // formes circulent dans index.js et `rodPlan` n itere QUE la seconde (un objet nu n est pas
  // iterable -> TypeError). On normalise ici plutot que d attendre le crash en production.
  assert.strictEqual(stringHuntNeeded(Object.assign({ inventory: { dirt: 12 } }, READY)), true);
  assert.strictEqual(stringHuntNeeded(Object.assign({ inventory: { fishing_rod: 1 } }, READY)), false);
  assert.strictEqual(stringHuntNeeded(Object.assign({ inventory: { stick: 3, string: 2 } }, READY)), false);
  assert.strictEqual(stringHuntNeeded(Object.assign({ inventory: { string: 9 } }, READY)), false);
});

test('inventaire absent -> traite comme vide (et ne jette pas)', () => {
  assert.strictEqual(stringHuntNeeded(READY), true);
  assert.strictEqual(stringHuntNeeded(Object.assign({ inventory: null }, READY)), true);
});

test('appel sans argument -> false, jamais une exception', () => {
  assert.strictEqual(stringHuntNeeded(), false);
  assert.strictEqual(stringHuntNeeded({}), false);
});

// ─── foodRunNeeded : quand PARTIR chercher a manger (avant d y etre force) ──────────────────────

const T0 = 1_000_000_000;

test('faim basse ET plus rien a manger -> OUI', () => {
  assert.strictEqual(foodRunNeeded({ food: FOOD_RUN_HUNGER, foodItems: 0, now: T0 }), true);
  assert.strictEqual(foodRunNeeded({ food: 10, foodItems: 0, now: T0 }), true);
  assert.strictEqual(foodRunNeeded({ food: 0, foodItems: 0, now: T0 }), true);
});

test('faim confortable -> NON, meme le ventre vide (on ne part pas en expedition pour rien)', () => {
  assert.strictEqual(foodRunNeeded({ food: FOOD_RUN_HUNGER + 1, foodItems: 0, now: T0 }), false);
  assert.strictEqual(foodRunNeeded({ food: 20, foodItems: 0, now: T0 }), false);
});

test('il RESTE a manger -> NON : c est au filet « manger » d agir, pas a une chasse', () => {
  assert.strictEqual(foodRunNeeded({ food: 6, foodItems: 1, now: T0 }), false);
  assert.strictEqual(foodRunNeeded({ food: 6, foodItems: 64, now: T0 }), false);
});

test('rationnement : deux tentatives ne peuvent pas se suivre (3 min mini)', () => {
  const sig = { food: 8, foodItems: 0 };
  const just = Object.assign({ now: T0, lastRunAt: T0 - 1000 }, sig);
  const soon = Object.assign({ now: T0, lastRunAt: T0 - (FOOD_RUN_COOLDOWN_MS - 1) }, sig);
  const ok = Object.assign({ now: T0, lastRunAt: T0 - FOOD_RUN_COOLDOWN_MS }, sig);
  assert.strictEqual(foodRunNeeded(just), false);
  assert.strictEqual(foodRunNeeded(soon), false);
  assert.strictEqual(foodRunNeeded(ok), true);
});

test('premiere fois (jamais tente) -> OUI, le rationnement ne bloque pas le depart', () => {
  assert.strictEqual(foodRunNeeded({ food: 8, foodItems: 0, now: T0, lastRunAt: 0 }), true);
  assert.strictEqual(foodRunNeeded({ food: 8, foodItems: 0, now: T0 }), true);
  assert.strictEqual(foodRunNeeded({ food: 8, foodItems: 0 }), true);
});

test('faim INCONNUE -> NON (bot.food n est pas livre juste apres une connexion)', () => {
  // `Number(null) === 0` ferait lire « inconnu » comme « affame » et lancerait une chasse a chaque
  // spawn — meme piege que shouldSprint/sprintAllowed, meme idiome de garde.
  assert.strictEqual(foodRunNeeded({ foodItems: 0, now: T0 }), false);
  assert.strictEqual(foodRunNeeded({ food: null, foodItems: 0, now: T0 }), false);
  assert.strictEqual(foodRunNeeded({ food: undefined, foodItems: 0, now: T0 }), false);
  assert.strictEqual(foodRunNeeded({ food: NaN, foodItems: 0, now: T0 }), false);
  assert.strictEqual(foodRunNeeded(), false);
});

test('stock inconnu -> traite comme VIDE (on prefere une chasse de trop a une mort de faim)', () => {
  assert.strictEqual(foodRunNeeded({ food: 8, now: T0 }), true);
  assert.strictEqual(foodRunNeeded({ food: 8, foodItems: null, now: T0 }), true);
});

test('le declencheur est PRECOCE : bien au-dessus du filet d urgence (faim <= 8) et du critique (6)', () => {
  // C est tout l objet du reglage : a 8 il est deja trop tard pour partir chasser/pecher — la
  // regeneration est coupee (< 18) et le bot meurt en route.
  assert.ok(FOOD_RUN_HUNGER > 8, 'doit partir AVANT le filet d urgence, pas au meme moment');
  assert.strictEqual(FOOD_RUN_HUNGER, 14);
  assert.strictEqual(FOOD_RUN_COOLDOWN_MS, 180000);
});
