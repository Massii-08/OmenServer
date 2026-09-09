'use strict';

/**
 * tests/idle.test.js — le minuteur du bilan automatique (20 min sans scalp).
 */
const test = require('node:test');
const assert = require('node:assert');

const idle = require('../lib/idle.js');

const T0 = Date.parse('2026-09-10T09:00:00Z');
const MIN = 60000;

test('sans scalp fermé, rien ne se déclenche JAMAIS', () => {
  const timer = idle.createIdle({ idle_ms: 20 * MIN });
  assert.strictEqual(timer.due(T0), false);
  assert.strictEqual(timer.due(T0 + (10 * 60 * MIN)), false);
});

test('le bilan part exactement après la durée d’inactivité', () => {
  const timer = idle.createIdle({ idle_ms: 20 * MIN });
  timer.touch(T0);
  assert.strictEqual(timer.due(T0 + (19 * MIN)), false);
  assert.strictEqual(timer.due(T0 + (20 * MIN)), true);
});

test('il ne part QU’UNE FOIS par période d’inactivité', () => {
  const timer = idle.createIdle({ idle_ms: 20 * MIN });
  timer.touch(T0);
  assert.strictEqual(timer.due(T0 + (21 * MIN)), true);
  assert.strictEqual(timer.due(T0 + (22 * MIN)), false);
  assert.strictEqual(timer.due(T0 + (90 * MIN)), false);
});

test('un nouveau scalp fermé réarme le minuteur', () => {
  const timer = idle.createIdle({ idle_ms: 20 * MIN });
  timer.touch(T0);
  assert.strictEqual(timer.due(T0 + (25 * MIN)), true);
  timer.touch(T0 + (30 * MIN));
  assert.strictEqual(timer.due(T0 + (45 * MIN)), false);
  assert.strictEqual(timer.due(T0 + (50 * MIN)), true);
});

test('un 429 du serveur fait taire le minuteur jusqu’à demain', () => {
  const timer = idle.createIdle({ idle_ms: 20 * MIN });
  timer.touch(T0);
  assert.strictEqual(timer.due(T0 + (20 * MIN)), true);
  timer.mute(T0 + (20 * MIN));
  assert.strictEqual(timer.isMuted(T0 + (20 * MIN)), true);

  /* Le scalp suivant ne réveille pas le bilan : le plafond est journalier. */
  timer.touch(T0 + (30 * MIN));
  assert.strictEqual(timer.due(T0 + (60 * MIN)), false);

  /* Le lendemain, tout repart. */
  const tomorrow = T0 + (24 * 60 * MIN);
  assert.strictEqual(timer.isMuted(tomorrow), false);
  timer.touch(tomorrow);
  assert.strictEqual(timer.due(tomorrow + (21 * MIN)), true);
});

test('reset oublie le scalp courant mais PAS le plafond du jour', () => {
  const timer = idle.createIdle({ idle_ms: 20 * MIN });
  timer.touch(T0);
  timer.reset();
  assert.strictEqual(timer.due(T0 + (60 * MIN)), false);
  assert.deepStrictEqual(timer.snapshot().last_ms, null);

  timer.mute(T0);
  timer.reset();
  assert.strictEqual(timer.isMuted(T0), true);
});

test('une durée absente ou absurde retombe sur 20 minutes', () => {
  assert.strictEqual(idle.createIdle().idle_ms, idle.DEFAULT_IDLE_MS);
  assert.strictEqual(idle.createIdle({ idle_ms: 0 }).idle_ms, 20 * MIN);
  assert.strictEqual(idle.createIdle({ idle_ms: -5 }).idle_ms, 20 * MIN);
  assert.strictEqual(idle.createIdle({ idle_ms: 'abc' }).idle_ms, 20 * MIN);
  assert.strictEqual(idle.DEFAULT_IDLE_MS, 20 * MIN);
});

test('un temps illisible ne casse rien et ne déclenche rien', () => {
  const timer = idle.createIdle({ idle_ms: 20 * MIN });
  assert.strictEqual(timer.touch('bientôt'), false);
  assert.strictEqual(timer.due(T0 + (60 * MIN)), false);
  timer.touch(T0);
  assert.strictEqual(timer.due(null), false);
});

test('dayKey rend la journée LOCALE au format AAAA-MM-JJ', () => {
  const moment = new Date(T0);
  const expected = String(moment.getFullYear()) + '-'
    + String(moment.getMonth() + 1).padStart(2, '0') + '-'
    + String(moment.getDate()).padStart(2, '0');
  assert.strictEqual(idle.dayKey(T0), expected);
  assert.match(idle.dayKey(), /^\d{4}-\d{2}-\d{2}$/);
});
