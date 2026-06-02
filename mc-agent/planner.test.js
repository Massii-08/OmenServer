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

// Régression : un but "movement-based" (descend_y54) progresse par la POSITION, pas par
// l'inventaire. Le détecteur de stall ne doit PAS le tuer en faux positif. Le but déclare
// `progress(ctx)` ; le planner doit l'utiliser pour mesurer le progrès.
// Reproduit le stall live observé : bot qui descend jusqu'à Y-54 mais planner stallé sur descend_y54.
test('runPlanner ne stalle pas sur un but qui progresse via goal.progress (position)', async () => {
  let y = 64;                                   // surface → cible -54
  const bot = { inventory: { items: () => [] } }; // inventaire toujours vide pendant la descente
  const chain = [
    { name: 'descend', skill: 'descend',
      met: (c) => (c.y !== undefined && c.y <= -52),
      progress: (c) => (c.y !== undefined ? Math.round(c.y) : null) },
  ];
  const ctxExtra = () => ({ y });
  const calls = [];
  const runSkill = async (goal) => { calls.push(goal.name); y -= 20; return { ok: true }; }; // descend de 20/run
  const token = { cancelled: false };
  // maxStalls=4 : SANS le fix, le planner stalle au 4e run (y=-16, pas encore <=-52) car
  // l'inventaire ne change jamais → faux stall. AVEC le fix : y change → stalls reset → atteint -56.
  const res = await runPlanner(bot, { chain, runSkill, ctxExtra, maxStalls: 4 }, token);
  assert.strictEqual(res.done, true, 'doit atteindre la profondeur cible sans faux stall');
  assert.ok(calls.length >= 6, `attendu >=6 descentes (64→-56), eu ${calls.length}`);
});
