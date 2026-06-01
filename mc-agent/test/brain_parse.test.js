'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseDecision, RateLimiter } = require('../brain');

test('parseDecision lit du JSON simple', () => {
  const d = parseDecision('{"reply":"salut","action":"follow","args":{"player":"Massii"}}');
  assert.deepStrictEqual(d, { reply: 'salut', action: 'follow', args: { player: 'Massii' }, command: null });
});

test('parseDecision tolère les fences ```json', () => {
  const d = parseDecision('```json\n{"reply":"ok","action":null,"args":{}}\n```');
  assert.strictEqual(d.reply, 'ok');
  assert.strictEqual(d.action, null);
});

test('parseDecision applique des défauts pour les champs manquants', () => {
  const d = parseDecision('{"reply":"hello"}');
  assert.strictEqual(d.action, null);
  assert.deepStrictEqual(d.args, {});
});

test('RateLimiter autorise jusqu\'à maxCalls puis bloque, et libère après la fenêtre', () => {
  let now = 1000;
  const rl = new RateLimiter(2, 1000, () => now);
  assert.strictEqual(rl.tryAcquire(), true);
  assert.strictEqual(rl.tryAcquire(), true);
  assert.strictEqual(rl.tryAcquire(), false); // 3e dans la fenêtre → bloqué
  now += 1001;
  assert.strictEqual(rl.tryAcquire(), true);  // fenêtre écoulée → ok
});
