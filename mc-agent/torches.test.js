'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { shouldPlaceTorch, TORCH_INTERVAL_MS, TORCH_MIN_MOVE } = require('./torches');

// Calé sur la capture réelle (Massitom2008 × alexdon1837, 33 min) : 131 et 97 torches posées,
// torche en main ~10 % du temps. Les humains éclairent tout ce qu'ils traversent ; le bot ne
// posait de torche que dans le tunnel de branch-mine, et vivait le reste du temps dans le noir —
// or block-light 0 est la condition EXACTE d'apparition des mobs.

const NOW = 1_000_000;
const BASE = {
  y: 16, lightLevel: 0, torches: 8, now: NOW,
  lastAt: NOW - TORCH_INTERVAL_MS - 1,
  pos: { x: 100, z: 0 }, lastPos: { x: 0, z: 0 },
};

test('sous terre, dans le noir, torche en poche, on a avancé → on pose', () => {
  assert.strictEqual(shouldPlaceTorch(BASE), true);
});

test('aucune torche en poche → non (rien à poser)', () => {
  assert.strictEqual(shouldPlaceTorch({ ...BASE, torches: 0 }), false);
});

test('en SURFACE → non : la lumière du ciel fait le travail', () => {
  assert.strictEqual(shouldPlaceTorch({ ...BASE, y: 70 }), false);
});

test('zone DÉJÀ éclairée → non, on ne gaspille pas', () => {
  assert.strictEqual(shouldPlaceTorch({ ...BASE, lightLevel: 12 }), false);
  assert.strictEqual(shouldPlaceTorch({ ...BASE, lightLevel: 7 }), true, '7 = encore sombre');
});

test('lumière inconnue (null) → on pose quand même : sous terre, le noir est la règle', () => {
  assert.strictEqual(shouldPlaceTorch({ ...BASE, lightLevel: null }), true);
});

test('trop tôt depuis la dernière → non (cadence ~3-5/min comme les humains)', () => {
  assert.strictEqual(shouldPlaceTorch({ ...BASE, lastAt: NOW - 1000 }), false);
});

test('pas assez avancé → non (anti-empilement au même endroit)', () => {
  assert.strictEqual(
    shouldPlaceTorch({ ...BASE, pos: { x: TORCH_MIN_MOVE - 1, z: 0 }, lastPos: { x: 0, z: 0 } }),
    false);
});

test('première torche de la session (aucun historique) → on pose', () => {
  assert.strictEqual(shouldPlaceTorch({ ...BASE, lastAt: undefined, lastPos: null }), true);
});

test('seuils surchargeables + entrées vides → jamais de crash', () => {
  assert.strictEqual(shouldPlaceTorch({ ...BASE, y: 70, opts: { surfaceY: 100 } }), true);
  assert.strictEqual(shouldPlaceTorch({}), false);
  assert.strictEqual(shouldPlaceTorch(), false);
});
