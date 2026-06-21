'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { sampleReactionDelay, sampleDelay } = require('./humanize');

// RNG déterministe (LCG) → tests reproductibles.
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (1103515245 * s + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

test('sampleReactionDelay : lognormale calée sur les vraies captures → médiane ~200ms << moyenne ~400ms', () => {
  // Massitom2008 (06/21) : réaction moyenne 393ms, MÉDIANE 198ms, p90 850ms — queue lourde
  // droitière. Une normale donnerait une médiane ≈ moyenne (393) ; la lognormale doit retomber
  // sur la médiane réelle (~200ms).
  const params = { reaction: { meanMs: 393, stdMs: 629 } };
  const rng = lcg(20260621);
  const xs = [];
  for (let i = 0; i < 40000; i++) xs.push(sampleReactionDelay(params, rng));
  xs.sort((a, b) => a - b);
  const median = xs[Math.floor(xs.length / 2)];
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const p90 = xs[Math.floor(xs.length * 0.90)];
  assert.ok(median >= 120, `plancher anti-aimbot 120ms (got ${median})`);
  assert.ok(median < 320, `médiane ~200ms attendue, pas ~moyenne (got ${median})`);
  assert.ok(median < mean * 0.8, `distribution droitière : médiane << moyenne (med ${median}, mean ${Math.round(mean)})`);
  assert.ok(p90 > 550, `queue lourde : p90 réaliste ~850ms (got ${p90})`);
});

test('sampleReactionDelay : plancher 120ms et plafond mean+3std toujours respectés', () => {
  const params = { reaction: { meanMs: 393, stdMs: 629 } };
  const rng = lcg(7);
  for (let i = 0; i < 5000; i++) {
    const v = sampleReactionDelay(params, rng);
    assert.ok(v >= 120 && v <= 393 + 3 * 629, `borné [120, mean+3std] (got ${v})`);
  }
});

test('sampleReactionDelay : défauts sains (~300ms) sans params', () => {
  const rng = lcg(1);
  const xs = [];
  for (let i = 0; i < 20000; i++) xs.push(sampleReactionDelay(undefined, rng));
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(mean > 200 && mean < 420, `moyenne par défaut ~300ms (got ${Math.round(mean)})`);
});

test('sampleReactionDelay : std=0 → quasi déterministe sur la moyenne', () => {
  const v = sampleReactionDelay({ reaction: { meanMs: 250, stdMs: 0 } }, lcg(3));
  assert.strictEqual(v, 250);
});
