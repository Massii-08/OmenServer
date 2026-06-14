'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { styleToParams } = require('./style');

test('styleToParams : reaction réelle + chat + movementJitter normalisé [0,1] (÷30)', () => {
  const style = {
    player: 'Massitom2008',
    reaction: { meanMs: 345, stdMs: 526, n: 479 },
    chat: { latencyMeanMs: 98250, latencyStdMs: 223127, typoRate: 0.083 },
    derivedParams: { chat: { latencyMeanMs: 98250, latencyStdMs: 223127, typoRate: 0.083 }, errorRate: 0.05, movementJitter: 21.043 },
  };
  const p = styleToParams(style);
  assert.deepStrictEqual(p.reaction, { meanMs: 345, stdMs: 526 });
  assert.strictEqual(p.chat.latencyMeanMs, 98250);
  assert.strictEqual(p.chat.typoRate, 0.083);
  assert.ok(p.lookJitter > 0 && p.lookJitter <= 1, 'lookJitter normalisé [0,1]');
  assert.ok(Math.abs(p.lookJitter - 21.043 / 30) < 1e-6, 'movementJitter ÷30');
  assert.strictEqual(p.movementJitter, p.lookJitter);
  assert.strictEqual(p._player, 'Massitom2008');
});

test('styleToParams : jitter brut élevé clampe à 1', () => {
  assert.strictEqual(styleToParams({ derivedParams: { movementJitter: 99 } }).lookJitter, 1);
});

test('styleToParams : null/invalide → null (rétro-compat : pas de --style)', () => {
  assert.strictEqual(styleToParams(null), null);
  assert.strictEqual(styleToParams('x'), null);
  assert.strictEqual(styleToParams(42), null);
});

test('styleToParams : style minimal (que reaction) → params partiels', () => {
  const p = styleToParams({ reaction: { meanMs: 300, stdMs: 100 } });
  assert.deepStrictEqual(p.reaction, { meanMs: 300, stdMs: 100 });
  assert.strictEqual(p.lookJitter, undefined);
  assert.strictEqual(p.chat, undefined);
});
