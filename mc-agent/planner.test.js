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
