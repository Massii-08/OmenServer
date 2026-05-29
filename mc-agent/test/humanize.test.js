'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { sampleDelay, applyTypos, humanizeReply } = require('../humanize');

// rng déterministe : séquence rejouable
function seqRng(values) { let i = 0; return () => values[i++ % values.length]; }

test('sampleDelay reste borné (>= 80ms) même avec rng extrême', () => {
  const params = { chat: { latencyMeanMs: 1000, latencyStdMs: 400 } };
  const d = sampleDelay(params, seqRng([0.999999, 0.5])); // pousse z très négatif
  assert.ok(d >= 80, `delay ${d} < 80`);
  assert.ok(Number.isInteger(d));
});

test('applyTypos rate=0 ne touche pas le texte', () => {
  assert.strictEqual(applyTypos('bonjour les amis', 0, Math.random), 'bonjour les amis');
});

test('applyTypos rate=1 modifie le texte', () => {
  const out = applyTypos('bonjour', 1, seqRng([0.0, 0.9]));
  assert.notStrictEqual(out, 'bonjour');
});

test('humanizeReply retourne {text, delayMs}', () => {
  const profile = { params: { chat: { latencyMeanMs: 500, latencyStdMs: 100, typoRate: 0 } } };
  const r = humanizeReply(profile, 'salut', seqRng([0.5, 0.5]));
  assert.strictEqual(r.text, 'salut');
  assert.ok(typeof r.delayMs === 'number' && r.delayMs >= 80);
});

test('humanizeReply tolère un profil null (defaults)', () => {
  const r = humanizeReply(null, 'x', seqRng([0.5, 0.5]));
  assert.ok(r.delayMs >= 80 && r.text === 'x');
});
