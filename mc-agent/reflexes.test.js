'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { installReflexes, DROWN_CRITICAL } = require('./reflexes');

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
