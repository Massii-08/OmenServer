'use strict';
// JETON D'ABRI (live 22/10, NethBot1 session 152) : `fleeDeathCamp` a fait `taskCtl.cancel()` à
// 952917 ; plus aucun planner n'a re-posé de jeton vivant, et chaque abri de nuit suivant DÉRIVAIT
// de ce jeton mort → `sealed:false why:cancelled depth:0 took_ms:0-2` toutes les 20 s, 10 ré-abris,
// nuit passée à découvert. Un abri ne doit jamais NAÎTRE annulé.
const test = require('node:test');
const assert = require('node:assert');
const { shelterToken, shelterCancelLoopNote, SHELTER_CANCEL_LOOP_N, SHELTER_CANCEL_LOOP_MS } = require('./shelterToken');
const { createTaskController } = require('./tasks');

test('shelterToken : parent VIVANT → suit le parent (mort, ordre) comme avant', () => {
  const ctl = createTaskController();
  const parent = ctl.begin('autonomous');
  const t = shelterToken(parent, () => ctl.generation);
  assert.strictEqual(t.cancelled, false);
  assert.strictEqual(t.inherited, 'live');
  parent.cancelled = true;
  assert.strictEqual(t.cancelled, true);
});

test('shelterToken : parent DÉJÀ ANNULÉ → l abri naît VIVANT (le cas session 152)', () => {
  const ctl = createTaskController();
  ctl.begin('autonomous');
  ctl.cancel();                                   // fleeDeathCamp
  const dead = { cancelled: true };
  const t = shelterToken(dead, () => ctl.generation);
  assert.strictEqual(t.cancelled, false, 'un abri ne doit pas naître annulé');
  assert.strictEqual(t.inherited, 'fresh');
});

test('shelterToken : parent mort → une VRAIE préemption postérieure au démarrage l annule quand même', () => {
  const ctl = createTaskController();
  ctl.cancel();
  const t = shelterToken({ cancelled: true }, () => ctl.generation);
  assert.strictEqual(t.cancelled, false);
  ctl.begin('migration');                         // préemption APRÈS le démarrage de l abri
  assert.strictEqual(t.cancelled, true);
});

test('shelterToken : la borne / le watchdog l annulent par le setter, sans toucher au parent', () => {
  const parent = { cancelled: false };
  const t = shelterToken(parent, () => 0);
  t.cancelled = true;
  assert.strictEqual(t.cancelled, true);
  assert.strictEqual(parent.cancelled, false);
});

test('shelterToken : mode NEUF (après une boucle) → ignore parent et préemptions, seul le setter l annule', () => {
  const ctl = createTaskController();
  const parent = ctl.begin('autonomous');
  const t = shelterToken(parent, () => ctl.generation, { fresh: true });
  assert.strictEqual(t.inherited, 'forced_fresh');
  parent.cancelled = true; ctl.begin('x');
  assert.strictEqual(t.cancelled, false);
  t.cancelled = true;
  assert.strictEqual(t.cancelled, true);
});

test('shelterToken : parent ou génération absents → jamais de crash', () => {
  const t = shelterToken(null, null);
  assert.strictEqual(t.cancelled, false);
  const u = shelterToken(undefined, () => { throw new Error('boom'); });
  assert.strictEqual(u.cancelled, false);
});

test('shelterCancelLoopNote : 3 `cancelled` d affilée en < 2 min → boucle (une fois), puis repart de zéro', () => {
  assert.strictEqual(SHELTER_CANCEL_LOOP_N, 3);
  assert.strictEqual(SHELTER_CANCEL_LOOP_MS, 2 * 60 * 1000);
  let s = null; let r;
  r = shelterCancelLoopNote(s, { reason: 'cancelled', now: 0 }); s = r.state; assert.strictEqual(r.loop, false);
  r = shelterCancelLoopNote(s, { reason: 'cancelled', now: 20000 }); s = r.state; assert.strictEqual(r.loop, false);
  r = shelterCancelLoopNote(s, { reason: 'cancelled', now: 40000 }); s = r.state;
  assert.strictEqual(r.loop, true);
  assert.strictEqual(r.count, 3);
  r = shelterCancelLoopNote(s, { reason: 'cancelled', now: 60000 }); s = r.state;
  assert.strictEqual(r.loop, false, 'la série est remise à zéro après le signalement');
});

test('shelterCancelLoopNote : un abri qui ABOUTIT (ou une autre raison) casse la série', () => {
  let s = null;
  s = shelterCancelLoopNote(s, { reason: 'cancelled', now: 0 }).state;
  s = shelterCancelLoopNote(s, { reason: 'cancelled', now: 1000 }).state;
  s = shelterCancelLoopNote(s, { reason: null, ok: true, now: 2000 }).state;
  const r = shelterCancelLoopNote(s, { reason: 'cancelled', now: 3000 });
  assert.strictEqual(r.loop, false);
  assert.strictEqual(r.count, 1);
});

test('shelterCancelLoopNote : 3 `cancelled` étalés sur > 2 min → pas une boucle', () => {
  let s = null; let r;
  s = shelterCancelLoopNote(s, { reason: 'cancelled', now: 0 }).state;
  s = shelterCancelLoopNote(s, { reason: 'cancelled', now: 70000 }).state;
  r = shelterCancelLoopNote(s, { reason: 'cancelled', now: 140000 });
  assert.strictEqual(r.loop, false);
});
