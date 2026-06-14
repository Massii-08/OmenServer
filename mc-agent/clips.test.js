'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createClipPlayer } = require('./clips');

test('createClipPlayer : rejoue les frames d un clip puis ré-enchaîne', () => {
  const clips = { mine: [
    { ctx: 'mine', player: 'P', frames: [{ in: { atk: 1 }, dyaw: 2.1, dpitch: 1.2 }, { in: { atk: 1, jump: 1 }, dyaw: 0.6, dpitch: 0.6 }] },
  ] };
  const cp = createClipPlayer(clips, () => 0);   // rng=0 → toujours le clip 0
  const f1 = cp.next('mine');
  assert.strictEqual(f1.dyaw, 2.1); assert.strictEqual(f1.dpitch, 1.2); assert.strictEqual(f1.in.atk, 1);
  assert.strictEqual(cp.next('mine').dyaw, 0.6);
  assert.strictEqual(cp.next('mine').dyaw, 2.1, 'clip épuisé → re-pick → frame 0');
});

test('createClipPlayer : changement de contexte → nouveau clip du bon ctx', () => {
  const clips = { mine: [{ player: 'P', frames: [{ in: {}, dyaw: 1, dpitch: 0 }] }],
                  idle: [{ player: 'P', frames: [{ in: {}, dyaw: 9, dpitch: 0 }] }] };
  const cp = createClipPlayer(clips, () => 0);
  assert.strictEqual(cp.next('mine').dyaw, 1);
  assert.strictEqual(cp.next('idle').dyaw, 9);
});

test('createClipPlayer : ctx sans clip → null (fallback nextLook) + has()', () => {
  const cp = createClipPlayer({ mine: [{ frames: [{ dyaw: 1 }] }] }, () => 0);
  assert.strictEqual(cp.next('combat'), null);
  assert.strictEqual(cp.has('combat'), false);
  assert.strictEqual(cp.has('mine'), true);
});

test('createClipPlayer : clips vide → null partout (rétro-compat)', () => {
  const cp = createClipPlayer({}, () => 0);
  assert.strictEqual(cp.next('idle'), null);
});
