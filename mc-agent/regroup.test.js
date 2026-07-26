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

// ─── SQUAD (Massii 2026-07-26 : « une petite squad qui reste ensemble ») ─────────────────────────

const { squadLeader, squadTarget, SQUAD_NEAR } = require('./regroup');

const T = 1000000;
const fresh = (name, x, z, extra = {}) => ({ name, x, z, at: T, ...extra });

test('squadLeader : déterministe — les 3 bots désignent le MÊME chef', () => {
  const mates = [fresh('NethBot2', 0, 0), fresh('NethBot3', 0, 0)];
  assert.strictEqual(squadLeader({ selfName: 'NethBot1', mates, now: T }), 'NethBot1');
  const m2 = [fresh('NethBot1', 0, 0), fresh('NethBot3', 0, 0)];
  assert.strictEqual(squadLeader({ selfName: 'NethBot2', mates: m2, now: T }), 'NethBot1');
  const m3 = [fresh('NethBot1', 0, 0), fresh('NethBot2', 0, 0)];
  assert.strictEqual(squadLeader({ selfName: 'NethBot3', mates: m3, now: T }), 'NethBot1');
});

test('squadLeader : ignore les mappeurs et les présences périmées', () => {
  const mates = [fresh('AaaMapper', 0, 0, { role: 'mapper' }), { name: 'AabMort', x: 0, z: 0, at: 0 }];
  assert.strictEqual(squadLeader({ selfName: 'NethBot1', mates, now: T }), 'NethBot1');
});

test('squadLeader : personne → null', () => {
  assert.strictEqual(squadLeader({ selfName: null, mates: [], now: T }), null);
});

test('squadTarget : le CHEF ne suit personne (sinon la squad fuit sa propre queue)', () => {
  const mates = [fresh('NethBot2', 500, 500), fresh('NethBot3', 500, 500)];
  assert.strictEqual(
    squadTarget({ self: { x: 0, z: 0 }, selfName: 'NethBot1', mates, now: T }), null);
});

test('squadTarget : un suiveur trop loin rejoint le chef', () => {
  const mates = [fresh('NethBot1', 300, 0), fresh('NethBot3', 0, 0)];
  const r = squadTarget({ self: { x: 0, z: 0 }, selfName: 'NethBot2', mates, now: T });
  assert.strictEqual(r.name, 'NethBot1');
  assert.strictEqual(r.dist, 300);
});

test('squadTarget : assez près → on ne bouge pas (le seuil est 64, pas 120)', () => {
  const mates = [fresh('NethBot1', SQUAD_NEAR, 0)];
  assert.strictEqual(
    squadTarget({ self: { x: 0, z: 0 }, selfName: 'NethBot2', mates, now: T }), null);
  const mates2 = [fresh('NethBot1', SQUAD_NEAR + 5, 0)];
  assert.ok(squadTarget({ self: { x: 0, z: 0 }, selfName: 'NethBot2', mates: mates2, now: T }));
});

test('squadTarget : cooldown respecté', () => {
  const mates = [fresh('NethBot1', 300, 0)];
  const args = { self: { x: 0, z: 0 }, selfName: 'NethBot2', mates, now: T };
  assert.strictEqual(squadTarget({ ...args, lastAt: T - 1000 }), null);
  assert.ok(squadTarget({ ...args, lastAt: T - 90000 }));
});

test('squadTarget : armure complète → chacun reprend sa route (règle historique)', () => {
  const mates = [fresh('NethBot1', 300, 0)];
  assert.strictEqual(squadTarget({
    self: { x: 0, z: 0 }, selfName: 'NethBot2', mates, now: T, armorComplete: true,
  }), null);
});

test('squadTarget : chef sans position connue → null (pas de cible inventée)', () => {
  const mates = [{ name: 'NethBot1', at: T }];
  assert.strictEqual(
    squadTarget({ self: { x: 0, z: 0 }, selfName: 'NethBot2', mates, now: T }), null);
});
