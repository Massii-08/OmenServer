'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { pickRegroupTarget, MIN_FAR, COOLDOWN_MS } = require('./regroup');

// Idée Massii (25/07) : rester en groupe jusqu'à ce que chacun ait son armure fer ; après une mort,
// se re-téléporter aux autres. Avec keepInventory, la mort est gratuite — c'est le RETOUR à pied
// (200-400 blocs sous les mobs) qui tue une 2e fois.

const NOW = 1_000_000;
const mate = (name, x, z, extra = {}) => Object.assign({ name, x, z, role: 'worker', at: NOW }, extra);

const BASE = {
  self: { x: 0, z: 0 },
  selfName: 'NethBot1',
  mates: [mate('NethBot2', 300, 0)],
  armorComplete: false,
  now: NOW,
  lastAt: 0,
};

test('mort loin du groupe → /tpa vers le coéquipier', () => {
  const r = pickRegroupTarget(BASE);
  assert.deepEqual(r, { name: 'NethBot2', dist: 300 });
});

test('choisit le PLUS PROCHE (≠ mapperTp qui vise le plus loin)', () => {
  const r = pickRegroupTarget({ ...BASE, mates: [mate('Loin', 900, 0), mate('Proche', 200, 0)] });
  assert.equal(r.name, 'Proche');
});

test('coéquipier trop proche → on marche, pas de TP', () => {
  const r = pickRegroupTarget({ ...BASE, mates: [mate('NethBot2', MIN_FAR - 1, 0)] });
  assert.equal(r, null);
});

test('armure déjà complète → plus de regroupement (règle Massii)', () => {
  assert.equal(pickRegroupTarget({ ...BASE, armorComplete: true }), null);
});

test('les MAPPEURS ne comptent pas comme groupe (ils sont ailleurs par métier)', () => {
  const r = pickRegroupTarget({ ...BASE, mates: [mate('MapBot1', 300, 0, { role: 'mapper' })] });
  assert.equal(r, null);
});

test('présence PÉRIMÉE (>3 min) = coéquipier mort/déco → ignoré', () => {
  const r = pickRegroupTarget({ ...BASE, mates: [mate('NethBot2', 300, 0, { at: NOW - 200000 })] });
  assert.equal(r, null);
});

test('cooldown : pas deux regroupements coup sur coup', () => {
  assert.equal(pickRegroupTarget({ ...BASE, lastAt: NOW - 1000 }), null);
  assert.ok(pickRegroupTarget({ ...BASE, lastAt: NOW - COOLDOWN_MS - 1 }));
});

test('ne se choisit jamais SOI-MÊME', () => {
  const r = pickRegroupTarget({ ...BASE, mates: [mate('NethBot1', 300, 0)] });
  assert.equal(r, null);
});

test('aucun coéquipier / entrées bancales → null, jamais de crash', () => {
  assert.equal(pickRegroupTarget({ ...BASE, mates: [] }), null);
  assert.equal(pickRegroupTarget({ ...BASE, mates: [{ name: 'X' }, null, { x: 1, z: 1 }] }), null);
  assert.equal(pickRegroupTarget({}), null);
  assert.equal(pickRegroupTarget(), null);
});

test('distance calculée en 2D (x,z) et arrondie', () => {
  const r = pickRegroupTarget({ ...BASE, mates: [mate('NethBot2', 300, 400)] });
  assert.equal(r.dist, 500);
});
