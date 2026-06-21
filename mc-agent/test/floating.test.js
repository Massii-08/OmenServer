'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { isFloatingStuck } = require('../unstuck');

const prev = { x: 0, z: 0, t: 0 };
const cur = { x: 0, z: 0, t: 2000 }; // immobile, 2s plus tard

test('isFloatingStuck: immobile en l\'air sans sol → flottant', () => {
  assert.strictEqual(isFloatingStuck(prev, cur, { onGround: false, inWater: false, vy: 0 }), true);
});

test('isFloatingStuck: au sol → pas flottant', () => {
  assert.strictEqual(isFloatingStuck(prev, cur, { onGround: true, inWater: false, vy: 0 }), false);
});

test('isFloatingStuck: dans l\'eau → géré ailleurs (escapeWater), pas flottant', () => {
  assert.strictEqual(isFloatingStuck(prev, cur, { onGround: false, inWater: true, vy: 0 }), false);
});

test('isFloatingStuck: en chute (vy<0) → pas flottant', () => {
  assert.strictEqual(isFloatingStuck(prev, cur, { onGround: false, inWater: false, vy: -0.5 }), false);
});

test('isFloatingStuck: FAUX POSITIF terre — onGround flaky mais SOL SOLIDE dessous → pas flottant', () => {
  // Cas vécu live (plains, world_dry_a) : bot immobile sur terrain solide, onGround=false par flakiness
  // mineflayer → ancienne détection croyait au flottement → recoverFloating échoue en boucle (rien à
  // récupérer, le bot EST au sol) → 0 minage. groundBelow=true supprime le faux positif.
  assert.strictEqual(isFloatingStuck(prev, cur, { onGround: false, inWater: false, vy: 0, groundBelow: true }), false);
});

test('isFloatingStuck: VRAI flottant — pas de sol dessous → flottant (recovery légitime)', () => {
  assert.strictEqual(isFloatingStuck(prev, cur, { onGround: false, inWater: false, vy: 0, groundBelow: false }), true);
});
