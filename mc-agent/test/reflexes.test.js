'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { tryEat, shouldFlee, installReflexes } = require('../reflexes');

function fakeBot({ food = 20, health = 20, hasFood = true, threat = null } = {}) {
  const calls = { equipped: [], consumed: 0, handlers: {} };
  return {
    calls, food, health,
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: { items() { return hasFood ? [{ name: 'bread' }] : []; } },
    async equip(item, dest) { calls.equipped.push({ item, dest }); },
    async consume() { calls.consumed++; },
    nearestEntity(pred) { return (threat && pred(threat)) ? threat : null; },
    on(evt, cb) { calls.handlers[evt] = cb; },
  };
}

test('tryEat mange si faim basse ET nourriture en inventaire', async () => {
  const bot = fakeBot({ food: 5, hasFood: true });
  assert.strictEqual(await tryEat(bot), true);
  assert.strictEqual(bot.calls.consumed, 1);
});

test('tryEat ne fait rien si rassasié', async () => {
  const bot = fakeBot({ food: 20 });
  assert.strictEqual(await tryEat(bot), false);
  assert.strictEqual(bot.calls.consumed, 0);
});

test('tryEat ne fait rien sans nourriture en inventaire', async () => {
  const bot = fakeBot({ food: 3, hasFood: false });
  assert.strictEqual(await tryEat(bot), false);
});

test('shouldFlee vrai si PV bas', () => {
  assert.strictEqual(shouldFlee(fakeBot({ health: 5 })), true);
});

test('shouldFlee vrai si creeper proche même en pleine vie', () => {
  const creeper = { type: 'mob', name: 'creeper', position: { x: 3, y: 64, z: 0 } };
  assert.strictEqual(shouldFlee(fakeBot({ health: 20, threat: creeper })), true);
});

test('shouldFlee faux si plein PV et aucune menace', () => {
  assert.strictEqual(shouldFlee(fakeBot({ health: 20, threat: null })), false);
});

test('installReflexes branche un handler sur l event health', () => {
  const bot = fakeBot();
  installReflexes(bot, { emit() {}, fleeFrom() {} });
  assert.strictEqual(typeof bot.calls.handlers.health, 'function');
});

// --- Réflexe anti-noyade (vu live HarvT7 : drowned ×3 — pathfinder traverse l'eau, flee sous l'eau
// → air épuisé). Quand l'air baisse : URGENCE remonter (goal coupé + jump), tout relâcher une fois l'air revenu.

function fakeBotO2(extra = {}) {
  const bot = fakeBot(extra);
  bot.calls.controls = [];
  bot.calls.goals = [];
  bot.setControlState = (c, v) => bot.calls.controls.push([c, v]);
  bot.pathfinder = { setGoal: (g) => bot.calls.goals.push(g) };
  return bot;
}

test('réflexe oxygène : air bas → setGoal(null) + jump (remonter) + emit surface', () => {
  const events = [];
  const bot = fakeBotO2();
  installReflexes(bot, { emit: (e) => events.push(e), fleeFrom() {} });
  assert.strictEqual(typeof bot.calls.handlers.breath, 'function', 'handler breath branché');
  bot.oxygenLevel = 4;
  bot.calls.handlers.breath();
  assert.ok(bot.calls.goals.includes(null), 'goal pathfinder coupé (stoppe la traversée)');
  assert.ok(bot.calls.controls.some(([c, v]) => c === 'jump' && v === true), 'jump pour remonter');
  assert.ok(events.some((e) => e.type === 'reflex' && e.action === 'surface'), 'reflex surface émis');
});

test('réflexe oxygène : air revenu → jump relâché (une seule fois, pas de spam)', () => {
  const bot = fakeBotO2();
  installReflexes(bot, { emit() {}, fleeFrom() {} });
  bot.oxygenLevel = 3; bot.calls.handlers.breath();      // urgence
  bot.calls.controls.length = 0;
  bot.oxygenLevel = 20; bot.calls.handlers.breath();     // air revenu
  assert.ok(bot.calls.controls.some(([c, v]) => c === 'jump' && v === false), 'jump relâché');
  bot.calls.controls.length = 0;
  bot.oxygenLevel = 20; bot.calls.handlers.breath();     // déjà relâché → no-op
  assert.strictEqual(bot.calls.controls.length, 0, 'pas de re-relâchement en boucle');
});

test('réflexe oxygène : air confortable → aucun effet', () => {
  const bot = fakeBotO2();
  installReflexes(bot, { emit() {}, fleeFrom() {} });
  bot.oxygenLevel = 18; bot.calls.handlers.breath();
  assert.strictEqual(bot.calls.controls.length, 0);
  assert.strictEqual(bot.calls.goals.length, 0);
});

// --- Phase B : riposte combat + manger pour régénérer -------------------------------------------

test('tryEat (phase B) : blessé + faim sous le seuil de régen → mange même non affamé', async () => {
  const bot = fakeBot({ food: 15, health: 10, hasFood: true }); // 15 > seuil faim (6) mais < régen (18)
  assert.strictEqual(await tryEat(bot), true);
});

test('tryEat (phase B) : blessé mais faim pleine (régen active) → ne mange pas', async () => {
  const bot = fakeBot({ food: 20, health: 10, hasFood: true });
  assert.strictEqual(await tryEat(bot), false);
});

test('riposte : PV en baisse + zombie au contact → attack(zombie) + reflex fight', () => {
  const zombie = { type: 'mob', name: 'zombie', position: { x: 2, y: 64, z: 0, distanceTo: () => 2 } };
  const events = [];
  const attacked = [];
  const bot = fakeBot({ health: 20, threat: zombie });
  installReflexes(bot, { emit: (e) => events.push(e), fleeFrom() {}, attack: (t) => attacked.push(t) });
  bot.calls.handlers.health();                 // baseline (lastHealth = 20)
  bot.health = 16;                             // frappé
  bot.calls.handlers.health();
  assert.strictEqual(attacked.length, 1);
  assert.strictEqual(attacked[0].name, 'zombie');
  assert.ok(events.some((e) => e.type === 'reflex' && e.action === 'fight' && e.mob === 'zombie'));
});

test('riposte : pas de baisse de PV → pas d attaque (le zombie passe au loin)', () => {
  const zombie = { type: 'mob', name: 'zombie', position: { x: 2, y: 64, z: 0, distanceTo: () => 2 } };
  const attacked = [];
  const bot = fakeBot({ health: 20, threat: zombie });
  installReflexes(bot, { emit() {}, fleeFrom() {}, attack: (t) => attacked.push(t) });
  bot.calls.handlers.health();
  bot.calls.handlers.health();                 // PV stables
  assert.strictEqual(attacked.length, 0);
});

test('riposte : creeper proche → FUITE (shouldFlee), jamais d attaque', () => {
  const creeper = { type: 'mob', name: 'creeper', position: { x: 3, y: 64, z: 0, distanceTo: () => 3 } };
  const attacked = [];
  let fled = 0;
  const bot = fakeBot({ health: 20, threat: creeper });
  installReflexes(bot, { emit() {}, fleeFrom: () => fled++, attack: (t) => attacked.push(t) });
  bot.calls.handlers.health();
  bot.health = 16;                             // frappé (explosion proche…)
  bot.calls.handlers.health();
  assert.strictEqual(attacked.length, 0, 'pas de riposte sur un creeper');
  assert.ok(fled >= 1, 'fuite déclenchée');
});

test('riposte : PV bas (≤ seuil) → fuite prioritaire, pas de combat', () => {
  const zombie = { type: 'mob', name: 'zombie', position: { x: 2, y: 64, z: 0, distanceTo: () => 2 } };
  const attacked = [];
  let fled = 0;
  const bot = fakeBot({ health: 20, threat: zombie });
  installReflexes(bot, { emit() {}, fleeFrom: () => fled++, attack: (t) => attacked.push(t) });
  bot.calls.handlers.health();
  bot.health = 5;                              // critique
  bot.calls.handlers.health();
  assert.strictEqual(attacked.length, 0);
  assert.ok(fled >= 1);
});

// --- Phase 3 : watchdog barbotage (onWaterStuck) -------------------------------------------------

test('onWaterStuck : 2 épisodes de surfacing en <90s → rescue déclenché (1 fois, cooldown)', () => {
  let t = 0;
  let rescues = 0;
  const events = [];
  const bot = fakeBotO2();
  installReflexes(bot, { emit: (e) => events.push(e), fleeFrom() {}, now: () => t,
    onWaterStuck: () => rescues++ });
  for (let i = 0; i < 2; i++) {
    bot.oxygenLevel = 3; bot.calls.handlers.breath();   // épisode i
    bot.oxygenLevel = 20; bot.calls.handlers.breath();  // air revenu (fin d'épisode)
    t += 10000;
  }
  assert.strictEqual(rescues, 1, 'rescue dès le 2e épisode (chaque épisode = quasi-noyade)');
  assert.ok(events.some((e) => e.action === 'water_rescue'));
  // épisodes suivants dans le cooldown 60 s → pas de 2e rescue
  bot.oxygenLevel = 3; bot.calls.handlers.breath();
  bot.oxygenLevel = 20; bot.calls.handlers.breath();
  assert.strictEqual(rescues, 1);
});

test('onWaterStuck : épisodes espacés (>90s) → jamais déclenché', () => {
  let t = 0;
  let rescues = 0;
  const bot = fakeBotO2();
  installReflexes(bot, { emit() {}, fleeFrom() {}, now: () => t, onWaterStuck: () => rescues++ });
  for (let i = 0; i < 6; i++) {
    bot.oxygenLevel = 3; bot.calls.handlers.breath();
    bot.oxygenLevel = 20; bot.calls.handlers.breath();
    t += 120000;                                        // 2 min entre épisodes
  }
  assert.strictEqual(rescues, 0);
});
