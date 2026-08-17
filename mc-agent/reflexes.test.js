'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { installReflexes, DROWN_CRITICAL, tryEat, FOODS, EMERGENCY_FOODS, shouldReleaseSurfacing, HEALTH_THRESHOLD, REGEN_FOOD, NO_REGEN_HP_MARGIN } = require('./reflexes');

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
function botUnderFire({ health = 5, shooter = true, melee = false, food = 20 } = {}) {
  const entities = [];
  if (shooter) entities.push({ type: 'mob', name: 'skeleton', position: { x: 12, y: 64, z: 0 } });
  if (melee) entities.push({ type: 'mob', name: 'zombie', position: { x: 1, y: 64, z: 0 } });
  return {
    health,
    food,
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

// ─── Faim : décrocher plus tôt (Massii : 167 morts/3h dont beaucoup « starved to death while
// fighting » — sous REGEN_FOOD la régén vanilla est coupée, chaque PV perdu est définitif tant
// qu'on n'a pas mangé). Vérifié via le réflexe COMPLET (installReflexes), pas juste shouldFlee en
// isolation — la faim doit être câblée jusqu'au bout de la chaîne réactive.
test('faim : PV entre l\'ancien et le nouveau seuil, affamé, SANS tireur ni contact → fuite', () => {
  const c = runReact(botUnderFire({ health: HEALTH_THRESHOLD + NO_REGEN_HP_MARGIN, shooter: false, melee: false, food: REGEN_FOOD }));
  assert.equal(c.flee, 1, 'au-dessus de l\'ancien seuil mais sous le seuil relevé par la faim → fuite');
  assert.equal(c.cover.length, 0);
});

test('faim : mêmes PV mais RASSASIÉ (food=20 par défaut) → pas de fuite (rétro-compat, seuil historique intact)', () => {
  const c = runReact(botUnderFire({ health: HEALTH_THRESHOLD + NO_REGEN_HP_MARGIN, shooter: false, melee: false }));
  assert.equal(c.flee, 0, 'sans faim, ces PV restent au-dessus du seuil de fuite historique');
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

// ─── shouldReleaseSurfacing : le verrou de remontée ne doit JAMAIS être permanent ───────────────
// Bug live 26/07 (Massii : « neth 3 ne bouge pas, il saute en continu sans rien faire d'autre ») :
// le relâchement n'arrivait que via l'event `breath` ET seulement au-dessus de 15 d'oxygène. Entre
// le seuil d'alerte (5) et 15, aucune branche ne s'exécutait → `surfacing` restait vrai, le saut
// restait armé et le pathfinder restait annulé (setGoal(null)) : le bot sautait sur place à vie.
test('shouldReleaseSurfacing : oxygène franchement revenu → on relâche', () => {
  assert.strictEqual(shouldReleaseSurfacing({ o2: 20, sinceMs: 100 }), true);
  assert.strictEqual(shouldReleaseSurfacing({ o2: 15, sinceMs: 100 }), true);
});

test('shouldReleaseSurfacing : bande morte (6-14) mais verrou RÉCENT → on garde (hystérésis)', () => {
  assert.strictEqual(shouldReleaseSurfacing({ o2: 9, sinceMs: 1000 }), false);
});

test('shouldReleaseSurfacing : verrou trop VIEUX → on relâche quoi qu il arrive', () => {
  // Le filet : si le bot se noie encore, le prochain event `breath` re-arme aussitôt.
  assert.strictEqual(shouldReleaseSurfacing({ o2: 9, sinceMs: 9000 }), true);
  assert.strictEqual(shouldReleaseSurfacing({ o2: 2, sinceMs: 9000 }), true);
});

test('shouldReleaseSurfacing : oxygène inconnu → on relâche (jamais de verrou aveugle)', () => {
  assert.strictEqual(shouldReleaseSurfacing({ o2: null, sinceMs: 100 }), true);
});
