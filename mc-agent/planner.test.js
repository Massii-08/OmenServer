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
    sleep: async () => {},   // skill factice instantané : la garde anti-boucle-chaude (19/10) dormirait pour de vrai
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
    sleep: async () => {},   // skill factice instantané : la garde anti-boucle-chaude (19/10) dormirait ~1,75 s
  }, null);
  assert.deepStrictEqual(r, { done: true, steps: 6 }); // 2 logs récoltés (6 calls) sans stall intermédiaire
});

// ─── `steps` : combien de skills CE run a-t-il exécutés ? (fix 18/08, boucle à vide) ─────────────
// Run 17-18/08 : `autonomous_chain` mapper_armor→mapper_armor ×47 791 — chaque run se terminait
// sur `done` SANS avoir rien exécuté (chaîne satisfaite d'office). Le caller ne pouvait pas le voir :
// `{done:true}` disait « objectif atteint » qu'on ait travaillé une heure ou zéro seconde.

test('steps : une chaine deja satisfaite rend done avec steps 0 (aucun skill lance)', async () => {
  const h = harness();
  h.bot._inv.A = 1; h.bot._inv.B = 1;
  const r = await runPlanner(h.bot, { chain: h.chain, runSkill: h.runSkill, ctxExtra: h.ctxExtra }, { cancelled: false });
  assert.deepStrictEqual(r, { done: true, steps: 0 });
  assert.deepStrictEqual(h.calls, []);
});

test('steps : compte chaque skill execute, succes comme echec', async () => {
  const h = harness();
  let n = 0;
  const flaky = async (goal) => { n++; if (n === 1) return { ok: false, reason: 'timeout' }; return h.runSkill(goal); };
  const r = await runPlanner(h.bot, { chain: h.chain, runSkill: flaky, ctxExtra: h.ctxExtra }, { cancelled: false });
  assert.strictEqual(r.done, true);
  assert.strictEqual(r.steps, 3, '1 echec + 2 succes = 3 skills executes');
});

test('steps : stalled et cancelled gardent leur forme historique', async () => {
  const h = harness();
  const cancelled = await runPlanner(h.bot, { chain: h.chain, runSkill: h.runSkill, ctxExtra: h.ctxExtra }, { cancelled: true });
  assert.deepStrictEqual(cancelled, { cancelled: true });
  const stuck = async () => ({ ok: false, reason: 'not_found' });
  const stalled = await runPlanner(h.bot, { chain: h.chain, runSkill: stuck, ctxExtra: h.ctxExtra, maxStalls: 2 }, { cancelled: false });
  assert.deepStrictEqual(stalled, { stalled: true, goal: 'a' });
});

// ─── GARDE ANTI-BOUCLE-CHAUDE (19/10) ─────────────────────────────────────────────────────────
// NethBot2, mesuré en live : juste après une téléportation (`wood_trip` → `teleport_detected` →
// `safe_warp warped:true`), `goal planks` émis 111× en 2,2 s (un toutes les ~20 ms), AUCUN
// `goal_failed`, puis `kicked` (flood de paquets) et `disconnected`. Les deux sorties historiques
// étaient aveugles : failStreak (le skill ne répond jamais {ok:false}) et le fingerprint
// (la position change à chaque tour — le bot se recale — donc `stalls` repart à 0).
// La garde mesure la DURÉE du skill : un but relancé sans cesse dont le skill rend la main en
// < 150 ms est une boucle chaude, quoi que dise son résultat et où que se trouve le bot.

// Monde de boucle chaude, à HORLOGE SIMULÉE : `now` et `sleep` sont injectés (aucune attente réelle).
// La position avance à chaque tour (le fingerprint ne stalle donc jamais), `skillMs(tour)` dit
// combien de temps « dure » chaque skill, et le but ne devient satisfait qu'après `satisfyAfter` tours.
function hotHarness({ skillMs = () => 20, result = () => ({ ok: true }), satisfyAfter = Infinity } = {}) {
  let x = 0;
  let t = 0;
  let turns = 0;
  const sleeps = [];
  const bot = { inventory: { items: () => [] }, entity: { position: { get x() { return x; }, y: 64, z: 0 } } };
  const chain = [{ name: 'planks', met: () => turns >= satisfyAfter, skill: 'craftPlanks', args: {} }];
  const opts = {
    chain,
    ctxExtra: () => ({}),
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    runSkill: async () => { turns++; x += 1; t += skillMs(turns); return result(turns); },
  };
  return { bot, opts, sleeps, turns: () => turns };
}

test('boucle chaude : skill instantané + position qui bouge → back-off 250/500/1000/2000/2000 puis stalled hot_loop au 8e tour', async () => {
  const h = hotHarness();
  const r = await runPlanner(h.bot, h.opts, { cancelled: false });
  assert.deepStrictEqual(r, { stalled: true, goal: 'planks', reason: 'hot_loop' });
  assert.strictEqual(h.turns(), 8, '8 tours instantanés consécutifs, pas un de plus');
  // Attente AVANT de relancer : après le 3e tour 250 ms, puis 500, 1000, plafond 2000 (4e→7e tour).
  // Le 8e tour ne dort pas : il rend la main.
  assert.deepStrictEqual(h.sleeps, [250, 500, 1000, 2000, 2000]);
});

test('boucle chaude : le résultat du skill n’y change rien ({ok:true}, {} ou rien du tout)', async () => {
  // « un résultat non-false » : c'est précisément ce que failStreak ne voit pas.
  for (const result of [() => ({ ok: true }), () => ({}), () => undefined, () => null, () => ({ ok: true, got: 0 })]) {
    const h = hotHarness({ result });
    const r = await runPlanner(h.bot, h.opts, { cancelled: false });
    assert.deepStrictEqual(r, { stalled: true, goal: 'planks', reason: 'hot_loop' }, 'résultat ' + JSON.stringify(result()));
    assert.strictEqual(h.turns(), 8);
  }
});

test('boucle chaude : un skill qui lève une exception en rafale sort par failStreak, forme historique', async () => {
  // runSkill qui throw → {ok:false} interne : failStreak (défaut 4) reste la 1re sortie, inchangée.
  const h = hotHarness({ result: () => { throw new Error('boom'); } });
  const r = await runPlanner(h.bot, h.opts, { cancelled: false });
  assert.deepStrictEqual(r, { stalled: true, goal: 'planks' }, 'failStreak garde la priorité et sa forme historique');
});

test('boucle chaude : failStreak garde la priorité et sa forme historique (pas de champ reason)', async () => {
  // 4 échecs instantanés : au 3e tour la garde dormirait (250 ms), mais le 4e tour sort par failStreak.
  const h = hotHarness({ result: () => ({ ok: false, reason: 'not_found' }) });
  const r = await runPlanner(h.bot, h.opts, { cancelled: false });
  assert.deepStrictEqual(r, { stalled: true, goal: 'planks' });
  assert.strictEqual(h.turns(), 4);
});

test('tour LENT (≥ 150 ms) : rien ne se déclenche, même sur un but jamais satisfait pendant 30 tours', async () => {
  const h = hotHarness({ skillMs: () => 150, satisfyAfter: 30 });
  const r = await runPlanner(h.bot, h.opts, { cancelled: false });
  assert.deepStrictEqual(r, { done: true, steps: 30 });
  assert.deepStrictEqual(h.sleeps, [], 'aucune attente imposée à un skill qui travaille vraiment');
});

test('seuil exact : 149 ms est instantané, 150 ms est lent', async () => {
  const fast = hotHarness({ skillMs: () => 149 });
  assert.deepStrictEqual(await runPlanner(fast.bot, fast.opts, { cancelled: false }),
    { stalled: true, goal: 'planks', reason: 'hot_loop' });
  const slow = hotHarness({ skillMs: () => 150, satisfyAfter: 20 });
  assert.deepStrictEqual(await runPlanner(slow.bot, slow.opts, { cancelled: false }), { done: true, steps: 20 });
});

test('un tour lent au milieu remet le compteur à zéro (2 instants, 1 lent, puis 7 instants → pas de stall)', async () => {
  // Sans remise à zéro le compteur serait à 9 au 10e tour et la garde aurait déjà stallé.
  const durations = [20, 20, 400, 20, 20, 20, 20, 20, 20, 20];
  const h = hotHarness({ skillMs: (n) => durations[n - 1], satisfyAfter: 10 });
  const r = await runPlanner(h.bot, h.opts, { cancelled: false });
  assert.deepStrictEqual(r, { done: true, steps: 10 });
  // Après le tour lent (3e) : 4e=1, 5e=2, 6e=3 → 250, 7e → 500, 8e → 1000, 9e → 2000. Le 10e satisfait le but.
  assert.deepStrictEqual(h.sleeps, [250, 500, 1000, 2000]);
});

test('changement de but : le compteur repart à zéro (A,A,B,B,A,A,… ne stalle jamais)', async () => {
  // 10 tours instantanés au total (> 8), mais jamais plus de 2 d'affilée sur le même but.
  const script = ['A', 'A', 'B', 'B', 'A', 'A', 'B', 'B', 'A', 'A'];
  let i = 0;
  let x = 0;
  let t = 0;
  const sleeps = [];
  const bot = { inventory: { items: () => [] }, entity: { position: { get x() { return x; }, y: 64, z: 0 } } };
  const chain = [
    { name: 'A', met: () => script[i] !== 'A', skill: 'a' },
    { name: 'B', met: () => script[i] !== 'B', skill: 'b' },
  ];
  const r = await runPlanner(bot, {
    chain, ctxExtra: () => ({}),
    now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; },
    runSkill: async () => { i++; x++; t += 20; return { ok: true }; },
  }, { cancelled: false });
  assert.deepStrictEqual(r, { done: true, steps: 10 });
  assert.deepStrictEqual(sleeps, []);
});

test('ne dort pas quand le but vient d’être satisfait : l’attente ne vise que le MÊME but relancé', async () => {
  // Le 3e tour instantané satisfait le but : il n'y a rien à « relancer », donc aucune attente.
  const h = hotHarness({ satisfyAfter: 3 });
  const r = await runPlanner(h.bot, h.opts, { cancelled: false });
  assert.deepStrictEqual(r, { done: true, steps: 3 });
  assert.deepStrictEqual(h.sleeps, []);
});

test('annulation pendant le back-off : le planner rend cancelled sans relancer de skill', async () => {
  const h = hotHarness();
  const token = { cancelled: false };
  h.opts.sleep = async (ms) => { h.sleeps.push(ms); token.cancelled = true; };   // annulé pendant l'attente
  const r = await runPlanner(h.bot, h.opts, token);
  assert.deepStrictEqual(r, { cancelled: true });
  assert.strictEqual(h.turns(), 3, 'dort après le 3e tour instantané, puis rend la main sans 4e tour');
  assert.deepStrictEqual(h.sleeps, [250]);
});

test('annulation ARRIVÉE pendant un tour instantané : cancelled prime, pas de back-off', async () => {
  const h = hotHarness();
  const token = { cancelled: false };
  const inner = h.opts.runSkill;
  h.opts.runSkill = async (g, b) => { const r = await inner(g, b); if (h.turns() === 5) token.cancelled = true; return r; };
  const r = await runPlanner(h.bot, h.opts, token);
  assert.deepStrictEqual(r, { cancelled: true });
  assert.strictEqual(h.turns(), 5);
  assert.deepStrictEqual(h.sleeps, [250, 500], 'seuls les tours 3 et 4 ont dormi ; le 5e a été annulé avant la garde');
});

test('garde : constantes et plan d’attente exportés (3 → 250 ms … plafond 2000 ms)', () => {
  const { hotLoopBackoffMs, HOT_LOOP_MS, HOT_LOOP_BACKOFF_FROM, HOT_LOOP_STALL_AT } = require('./planner');
  assert.strictEqual(HOT_LOOP_MS, 150);
  assert.strictEqual(HOT_LOOP_BACKOFF_FROM, 3);
  assert.strictEqual(HOT_LOOP_STALL_AT, 8);
  assert.deepStrictEqual([3, 4, 5, 6, 7, 8, 50].map(hotLoopBackoffMs), [250, 500, 1000, 2000, 2000, 2000, 2000]);
});

test('horloge et sleep PAR DÉFAUT (réels) : une boucle chaude attend vraiment 250 ms avant le 4e tour', async () => {
  // Seul test à attente réelle : il prouve que les défauts (Date.now / setTimeout) sont bien câblés
  // — en production personne n'injecte rien.
  let turns = 0;
  const bot = { inventory: { items: () => [] }, entity: { position: { x: 0, y: 64, z: 0 } } };
  const chain = [{ name: 'planks', met: () => turns >= 4, skill: 'craftPlanks', args: {} }];
  const t0 = Date.now();
  const r = await runPlanner(bot, {
    chain, ctxExtra: () => ({}),
    runSkill: async () => { turns++; bot.entity.position.x += 1; return { ok: true }; },
  }, { cancelled: false });
  const dt = Date.now() - t0;
  assert.deepStrictEqual(r, { done: true, steps: 4 });
  assert.ok(dt >= 240, 'attente réelle attendue ≈ 250 ms, mesuré ' + dt + ' ms');
  assert.ok(dt < 2000, 'mais pas davantage (un seul back-off de 250 ms) : ' + dt + ' ms');
});
