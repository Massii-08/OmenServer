'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { runPlanner } = require('./planner');

// Faux monde : un inventaire mutable + hasTable ; runSkill applique l'effet du but.
function harness() {
  const inv = {};
  let hasTable = false;
  const bot = {
    _inv: inv,
    inventory: { items: () => Object.entries(inv).map(([name, count]) => ({ name, count })) },
  };
  const chain = [
    { name: 'a', met: (c) => (c.inv.A || 0) >= 1, skill: 'mkA' },
    { name: 'b', met: (c) => (c.inv.B || 0) >= 1, skill: 'mkB' },
  ];
  // ctxExtra fournit hasTable au planner
  const ctxExtra = () => ({ hasTable });
  const calls = [];
  const runSkill = async (goal) => {
    calls.push(goal.name);
    if (goal.skill === 'mkA') inv.A = 1;
    if (goal.skill === 'mkB') inv.B = 1;
    return { ok: true };
  };
  return { bot, chain, ctxExtra, runSkill, calls };
}

test('runPlanner exécute les buts jusqu’à l’objectif atteint', async () => {
  const h = harness();
  const token = { cancelled: false };
  const res = await runPlanner(h.bot, { chain: h.chain, runSkill: h.runSkill, ctxExtra: h.ctxExtra }, token);
  assert.deepStrictEqual(h.calls, ['a', 'b']);
  assert.strictEqual(res.done, true);
});

test('runPlanner s’arrête immédiatement si token.cancelled', async () => {
  const h = harness();
  const token = { cancelled: true };
  const res = await runPlanner(h.bot, { chain: h.chain, runSkill: h.runSkill, ctxExtra: h.ctxExtra }, token);
  assert.deepStrictEqual(h.calls, []);
  assert.strictEqual(res.cancelled, true);
});

test('runPlanner abandonne après maxStalls sans progrès (fallback)', async () => {
  const h = harness();
  const token = { cancelled: false };
  const stuckSkill = async () => ({ ok: false, reason: 'not_found' }); // n'applique jamais l'effet
  const res = await runPlanner(h.bot, { chain: h.chain, runSkill: stuckSkill, ctxExtra: h.ctxExtra, maxStalls: 3 }, token);
  assert.strictEqual(res.stalled, true);
  assert.strictEqual(res.goal, 'a');
});

test('phase3 : but exploratoire qui ÉCHOUE en bougeant → stall quand même (failStreak)', async () => {
  // vécu V3Res2/4 : gatherLog en anneaux change la position à chaque tentative → le fingerprint
  // position remettait stalls à 0 → boucle infinie. 4 {ok:false} consécutifs = stalled.
  let x = 0;
  const bot = { inventory: { items: () => [] }, entity: { position: { get x() { return x; }, y: 64, z: 0 } } };
  const chain = [{ name: 'logs', met: () => false, skill: 'gatherLog', args: {} }];
  const r = await runPlanner(bot, {
    chain,
    runSkill: async () => { x += 50; return { ok: false, reason: 'timeout' }; }, // bouge ET échoue
    ctxExtra: () => ({}),
  }, null);
  assert.deepStrictEqual(r, { stalled: true, goal: 'logs' });
});

test('phase3 : succès intermittents remettent le failStreak à zéro', async () => {
  let x = 0;
  let calls = 0;
  const items = [];
  const bot = { inventory: { items: () => items.slice() }, entity: { position: { get x() { return x; }, y: 64, z: 0 } } };
  const chain = [{ name: 'logs', met: (c) => (c.inv.oak_log || 0) >= 2, skill: 'gatherLog', args: {} }];
  const r = await runPlanner(bot, {
    chain,
    runSkill: async () => {
      calls++; x += 50;
      if (calls % 3 === 0) { items.push({ name: 'oak_log', count: 1 }); return { ok: true }; } // progrès périodique
      return { ok: false, reason: 'timeout' };
    },
    ctxExtra: () => ({}),
  }, null);
  assert.deepStrictEqual(r, { done: true }); // 2 logs récoltés (6 calls) sans stall intermédiaire
});
