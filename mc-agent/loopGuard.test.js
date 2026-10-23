'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createCapReporter, loopCap, createLoopLagWatch, LAG_THRESHOLD_MS } = require('./loopGuard');

test('createCapReporter : émis APRÈS (différé), ≤ 1 / where / 10 s, compte cumulé', () => {
  const out = [];
  const deferred = [];
  let t = 1000;
  const rep = createCapReporter({ emit: (e) => out.push(e), now: () => t, defer: (fn) => deferred.push(fn) });
  assert.strictEqual(rep.report('a', { reason: 'x' }), true);
  assert.strictEqual(out.length, 0, 'rien n\'est écrit pendant la boucle coupée');
  deferred.shift()();
  assert.deepStrictEqual(out[0], { reason: 'x', type: 'sync_loop_capped', where: 'a', count: 1 });
  assert.strictEqual(rep.report('a'), false);          // throttlé
  assert.strictEqual(rep.report('a'), false);
  assert.strictEqual(rep.report('b'), true);           // autre where : indépendant
  t += 10000;
  assert.strictEqual(rep.report('a'), true);
  deferred.splice(0).forEach((fn) => fn());
  assert.strictEqual(out.find((e) => e.where === 'a' && e.count === 3).count, 3, 'les coupes throttlées sont cumulées');
});

test('createCapReporter : un emit qui lève ne casse rien', () => {
  const deferred = [];
  const rep = createCapReporter({ emit: () => { throw new Error('x'); }, defer: (fn) => deferred.push(fn) });
  rep.report('a');
  assert.doesNotThrow(() => deferred[0]());
});

test('createCapReporter : défaut = setImmediate (jamais synchrone)', async () => {
  const out = [];
  const rep = createCapReporter({ emit: (e) => out.push(e) });
  rep.report('z');
  assert.strictEqual(out.length, 0);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(out.length, 1);
});

test('loopCap : faux jusqu\'à max, vrai ensuite, un seul rapport', () => {
  const reports = [];
  const over = loopCap(3, 'w', { report: (w, x) => reports.push([w, x]) });
  assert.deepStrictEqual([over(), over(), over()], [false, false, false]);
  assert.strictEqual(over(), true);
  assert.strictEqual(over(), true);
  assert.strictEqual(reports.length, 1);
  assert.deepStrictEqual(reports[0], ['w', { max: 3 }]);
});

test('createLoopLagWatch : retard = écart à l\'heure attendue ; > 2 s → loop_lag {ms, phase}', () => {
  const lags = [];
  const w = createLoopLagWatch({ intervalMs: 1000, onLag: (e) => lags.push(e), phase: () => 'bm:dig' });
  assert.strictEqual(w.tick(0), 0);                    // 1er tick : référence
  assert.strictEqual(w.tick(1000), 0);
  assert.strictEqual(w.tick(2500), 500);               // 0,5 s de retard : sous le seuil
  assert.strictEqual(lags.length, 0);
  assert.strictEqual(w.tick(2500 + 1000 + LAG_THRESHOLD_MS + 1), LAG_THRESHOLD_MS + 1);
  assert.deepStrictEqual(lags, [{ ms: LAG_THRESHOLD_MS + 1, phase: 'bm:dig' }]);
});

test('createLoopLagWatch : phase qui lève → null, jamais de throw', () => {
  const lags = [];
  const w = createLoopLagWatch({ onLag: (e) => lags.push(e), phase: () => { throw new Error('tdz'); } });
  w.tick(0);
  w.tick(10000);
  assert.deepStrictEqual(lags, [{ ms: 9000, phase: null }]);
});
