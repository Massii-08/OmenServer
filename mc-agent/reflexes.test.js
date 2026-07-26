'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { installReflexes, DROWN_CRITICAL, tryEat, FOODS, EMERGENCY_FOODS } = require('./reflexes');

// Bot mock minimal pour piloter le réflexe `breathe` (anti-noyade). On appelle breathe() directement
// (installReflexes le retourne) avec un oxygenLevel scripté.
function makeBot(oxygenLevel) {
  return {
    oxygenLevel,
    on: () => {},                                   // install : bot.on('health'|'breath', …) no-op
    pathfinder: { setGoal: () => {} },
    setControlState: () => {},
  };
}

test('breathe : oxygène CRITIQUE (≤ DROWN_CRITICAL) → onWaterStuck IMMÉDIAT (bug #4 anti-noyade)', () => {
  let stuckCalls = 0;
  const bot = makeBot(DROWN_CRITICAL);              // quasi-noyade
  const { breathe } = installReflexes(bot, { emit: () => {}, onWaterStuck: () => { stuckCalls++; }, now: () => 100000 });
  breathe();
  assert.ok(stuckCalls >= 1, 'oxygène critique → rescue immédiat (bypass le gate 2-épisodes/20s)');
});

test('breathe : oxygène bas mais PAS critique (4) → pas de rescue immédiat (gate normal, 1 seul épisode)', () => {
  let stuckCalls = 0;
  const bot = makeBot(4);                            // bas (≤5 surface) mais > DROWN_CRITICAL
  const { breathe } = installReflexes(bot, { emit: () => {}, onWaterStuck: () => { stuckCalls++; }, now: () => 100000 });
  breathe();
  assert.equal(stuckCalls, 0, 'pas critique + 1 épisode → pas de rescue (l\'urgence ne se déclenche qu\'à l\'O2 critique)');
});

test('breathe : oxygène plein → aucun réflexe', () => {
  let stuckCalls = 0;
  const bot = makeBot(20);
  const { breathe } = installReflexes(bot, { emit: () => {}, onWaterStuck: () => { stuckCalls++; }, now: () => 100000 });
  breathe();
  assert.equal(stuckCalls, 0);
});

const { meleeAssailant } = require('./reflexes');

test('meleeAssailant : rayon configurable (mappeur 3) — zombie à 4 blocs hors riposte, à 2 riposté', () => {
  const mk = (d) => ({
    entity: { position: { x: 0, y: 64, z: 0 } },
    nearestEntity: (fn) => {
      const e = { type: 'mob', name: 'zombie', position: { x: d, y: 64, z: 0, distanceTo: (p) => Math.abs(d - p.x) } };
      return fn(e) ? e : null;
    },
  });
  assert.strictEqual(meleeAssailant(mk(4), 3), null);
  assert.ok(meleeAssailant(mk(2), 3));
  assert.ok(meleeAssailant(mk(4)));           // défaut 5 : comportement historique intact
});

// ─── COUVERT plutôt que FUITE face à un tireur (analyse live world_ax4, 25/07) ──
// Autopsie des morts : CHAQUE mort est précédée d'un `reflex: flee`. Ils fuient... et meurent
// quand même. Normal : fuir un squelette à découvert, c'est courir 20 blocs dans sa ligne de tir
// (portée d'arc 16). Le squelette pèse 52 des 103 morts du run. À PV bas, sans assaillant au
// contact, se mettre à couvert domine strictement la fuite — un tireur qui ne voit plus sa cible
// cesse de tirer.
function botUnderFire({ health = 5, shooter = true, melee = false } = {}) {
  const entities = [];
  if (shooter) entities.push({ type: 'mob', name: 'skeleton', position: { x: 12, y: 64, z: 0 } });
  if (melee) entities.push({ type: 'mob', name: 'zombie', position: { x: 1, y: 64, z: 0 } });
  return {
    health,
    food: 20,
    entity: { position: { x: 0, y: 64, z: 0 } },
    entities: Object.fromEntries(entities.map((e, i) => [i, e])),
    on: () => {},
    pathfinder: { setGoal: () => {} },
    setControlState: () => {},
    inventory: { items: () => [{ name: 'cobblestone', count: 20 }] },
    nearestEntity: (pred) => entities.find(pred) || null,
  };
}

function runReact(bot, extra = {}) {
  const calls = { flee: 0, cover: [] };
  const { react } = installReflexes(bot, Object.assign({
    emit: () => {},
    fleeFrom: () => { calls.flee += 1; },
    onCover: (foe) => { calls.cover.push(foe && foe.name); },
    now: () => 100000,
  }, extra));
  react();
  return calls;
}

test('PV bas + tireur SANS assaillant au contact → COUVERT, pas de fuite', () => {
  const c = runReact(botUnderFire({ health: 5 }));
  assert.deepEqual(c.cover, ['skeleton'], 'doit se mettre à couvert du squelette');
  assert.equal(c.flee, 0, 'courir à découvert est précisément ce qui les tuait');
});

test('PV bas + assaillant au CONTACT → fuite (le couvert ne protège pas d\'un zombie collé)', () => {
  const c = runReact(botUnderFire({ health: 5, melee: true }));
  assert.equal(c.flee, 1);
  assert.equal(c.cover.length, 0);
});

test('PV bas SANS tireur → fuite classique (comportement inchangé)', () => {
  const c = runReact(botUnderFire({ health: 5, shooter: false }));
  assert.equal(c.flee, 1);
  assert.equal(c.cover.length, 0);
});

test('sans onCover injecté → fuite (rétro-compat totale des appelants existants)', () => {
  const bot = botUnderFire({ health: 5 });
  const calls = { flee: 0 };
  const { react } = installReflexes(bot, { emit: () => {}, fleeFrom: () => { calls.flee += 1; }, now: () => 100000 });
  react();
  assert.equal(calls.flee, 1);
});

test('PV corrects → ni fuite ni couvert (on ne se terre pas pour rien)', () => {
  const c = runReact(botUnderFire({ health: 20 }));
  assert.equal(c.flee, 0);
  assert.equal(c.cover.length, 0);
});

// ─── Nourriture de détresse (Massii 2026-07-26 : 7 morts de faim en 20 min) ─────────────────────

test('tryEat : mange la viande CRUE plutôt que de mourir de faim', async () => {
  const eaten = [];
  const bot = {
    food: 4, health: 20,
    inventory: { items: () => [{ name: 'beef' }] },
    equip: async (it) => eaten.push(it.name),
    consume: async () => {},
  };
  assert.strictEqual(await tryEat(bot), true);
  assert.deepStrictEqual(eaten, ['beef']);
});

test('tryEat : mange la CHAIR PUTRÉFIÉE en dernier recours (butin des zombies)', async () => {
  const eaten = [];
  const bot = {
    food: 4, health: 20,
    inventory: { items: () => [{ name: 'rotten_flesh' }] },
    equip: async (it) => eaten.push(it.name),
    consume: async () => {},
  };
  assert.strictEqual(await tryEat(bot), true);
  assert.deepStrictEqual(eaten, ['rotten_flesh']);
});

test('tryEat : le CUIT passe toujours avant la détresse', async () => {
  const eaten = [];
  const bot = {
    food: 4, health: 20,
    inventory: { items: () => [{ name: 'rotten_flesh' }, { name: 'cooked_beef' }] },
    equip: async (it) => eaten.push(it.name),
    consume: async () => {},
  };
  await tryEat(bot);
  assert.deepStrictEqual(eaten, ['cooked_beef']);
});

test('tryEat : jamais de nourriture TOXIQUE, même affamé', async () => {
  const eaten = [];
  const bot = {
    food: 1, health: 20,
    inventory: { items: () => [{ name: 'spider_eye' }, { name: 'poisonous_potato' }, { name: 'pufferfish' }] },
    equip: async (it) => eaten.push(it.name),
    consume: async () => {},
  };
  assert.strictEqual(await tryEat(bot), false);
  assert.deepStrictEqual(eaten, []);
});

test('EMERGENCY_FOODS et FOODS sont disjoints (pas de doublon de priorité)', () => {
  for (const f of EMERGENCY_FOODS) assert.ok(!FOODS.has(f), `${f} est dans les deux listes`);
});
