'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseConfine, confineSpreadCommand,
  CONFINE_HOME, shouldEnforceConfine, pickAnchorNow, DEFAULT_CONFINE_RADIUS,
} = require('./confine');

// ─── Existant (pin) ─────────────────────────────────────────────────────────────────────────────
test('parseConfine : "X Z R" → {x,z,radius} ; invalide → null', () => {
  assert.deepStrictEqual(parseConfine('100 -200 64'), { x: 100, z: -200, radius: 64 });
  assert.strictEqual(parseConfine(''), null);
  assert.strictEqual(parseConfine('1 2 0'), null);
});

test('confineSpreadCommand : /spreadplayers autour de l\'ancre (mode admin, inchangé)', () => {
  assert.strictEqual(confineSpreadCommand('Bot', { x: 10, z: -5, radius: 32 }),
    '/spreadplayers 10 -5 0 32 false Bot');
});

// ─── Brique 1 : confine-via-/home (no-give) ─────────────────────────────────────────────────────
// Le confine warpe via /spreadplayers = BLOQUÉ par nogive → mort en sans-give (vécu world_ax2 :
// les bots atteignent iron_deep puis sortent de la poche sèche et se noient). Enforcement légitime :
// un home dédié 'canchor' posé à l'ancre + /home canchor quand le bot dérive trop loin.

test('CONFINE_HOME : nom du home d\'ancre (sanitize-safe, ≠ homes réservés existants)', () => {
  assert.strictEqual(CONFINE_HOME, 'canchor');
});

test('shouldEnforceConfine : loin de l\'ancre + pas occupé + cooldown passé → true', () => {
  const now = 1000000;
  assert.strictEqual(shouldEnforceConfine({
    dist: 200, radius: 140, busy: false, now, lastAt: 0,
  }), true);
});

test('shouldEnforceConfine : marge ×1.25 — dans le rayon élargi → false (pas de yo-yo)', () => {
  const now = 1000000;
  assert.strictEqual(shouldEnforceConfine({ dist: 150, radius: 140, busy: false, now, lastAt: 0 }), false);
  assert.strictEqual(shouldEnforceConfine({ dist: 176, radius: 140, busy: false, now, lastAt: 0 }), true);
});

test('shouldEnforceConfine : occupé (dig/fonte/abri/sauvetage) → false', () => {
  assert.strictEqual(shouldEnforceConfine({ dist: 400, radius: 140, busy: true, now: 1000000, lastAt: 0 }), false);
});

test('shouldEnforceConfine : cooldown 2 min entre deux enforcement → false si trop tôt', () => {
  const now = 1000000;
  assert.strictEqual(shouldEnforceConfine({ dist: 400, radius: 140, busy: false, now, lastAt: now - 60000 }), false);
  assert.strictEqual(shouldEnforceConfine({ dist: 400, radius: 140, busy: false, now, lastAt: now - 121000 }), true);
});

// ─── Brique 2 : auto-ancrage à la première terre sèche ──────────────────────────────────────────
// Chaque semaine = un NOUVEAU monde (seed non choisi) → le bot doit s'établir SEUL une poche
// sèche : la première position stable (au sol, hors eau, en surface) devient l'ancre.

test('pickAnchorNow : au sol + sec + surface → true', () => {
  assert.strictEqual(pickAnchorNow({ onGround: true, inWater: false, y: 72 }), true);
});

test('pickAnchorNow : dans l\'eau / en l\'air / sous terre → false', () => {
  assert.strictEqual(pickAnchorNow({ onGround: true, inWater: true, y: 72 }), false);
  assert.strictEqual(pickAnchorNow({ onGround: false, inWater: false, y: 72 }), false);
  assert.strictEqual(pickAnchorNow({ onGround: true, inWater: false, y: 40 }), false);
  assert.strictEqual(pickAnchorNow({}), false);
});

test('DEFAULT_CONFINE_RADIUS : poche assez grande pour bois+mine (≥120)', () => {
  assert.ok(DEFAULT_CONFINE_RADIUS >= 120 && DEFAULT_CONFINE_RADIUS <= 200);
});

test('pickAnchorNow : woodNear=false → refus (le camp doit être en zone BOISÉE — plank_buffer)', () => {
  assert.strictEqual(pickAnchorNow({ onGround: true, inWater: false, y: 72, woodNear: false }), false);
  assert.strictEqual(pickAnchorNow({ onGround: true, inWater: false, y: 72, woodNear: true }), true);
  // rétro-compat : woodNear absent → pas exigé
  assert.strictEqual(pickAnchorNow({ onGround: true, inWater: false, y: 72 }), true);
});
