'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { pickMapperTp } = require('./mapperTp');

// TP-au-mappeur (Massii 15/07) : les mappeurs explorent LOIN du spawn ; un bot ressource qui
// (re)part du spawn gagne des minutes en se /tpa à un mappeur au lieu de marcher. Décision PURE :
// avec une cible → le mappeur doit rapprocher d'au moins minGain ; sans cible → le plus loin de moi.

const NOW = 1000000;
function m(name, x, z, { role = 'mapper', at = NOW } = {}) { return { name, x, z, role, at }; }

test('pickMapperTp avec cible : mappeur nettement plus proche de la cible que moi → son nom', () => {
  const r = pickMapperTp({
    self: { x: 0, z: 0 }, goal: { x: 800, z: 0 },
    mappers: [m('MapBot1', 700, 50), m('MapBot2', 300, 0)], now: NOW,
  });
  assert.strictEqual(r && r.name, 'MapBot1');   // le plus proche de la CIBLE, pas de moi
});

test('pickMapperTp avec cible : gain insuffisant (<150) → null (la marche suffit)', () => {
  const r = pickMapperTp({
    self: { x: 0, z: 0 }, goal: { x: 300, z: 0 },
    mappers: [m('MapBot1', 200, 0)], now: NOW,   // gain = 300-100 = 200... mais dist self-goal 300
  });
  assert.strictEqual(r && r.name, 'MapBot1');    // 300 → 100 : gain 200 ≥ 150 → go
  const r2 = pickMapperTp({
    self: { x: 0, z: 0 }, goal: { x: 300, z: 0 },
    mappers: [m('MapBot1', 150, 0)], now: NOW,   // 300 → 150 : gain 150... limite : < minGain+ε ?
  });
  assert.strictEqual(r2 && r2.name, 'MapBot1');  // gain exactement 150 = accepté (≥)
  const r3 = pickMapperTp({
    self: { x: 0, z: 0 }, goal: { x: 200, z: 0 },
    mappers: [m('MapBot1', 100, 0)], now: NOW,   // gain 100 < 150 → null
  });
  assert.strictEqual(r3, null);
});

test('pickMapperTp sans cible : le mappeur le plus LOIN de moi, s\'il est à ≥250 → son nom', () => {
  const r = pickMapperTp({
    self: { x: 0, z: 0 }, goal: null,
    mappers: [m('MapBot1', 300, 0), m('MapBot2', 900, 100)], now: NOW,
  });
  assert.strictEqual(r && r.name, 'MapBot2');
  const r2 = pickMapperTp({ self: { x: 0, z: 0 }, goal: null, mappers: [m('MapBot1', 200, 0)], now: NOW });
  assert.strictEqual(r2, null);                  // 200 < 250 : pas assez loin pour valoir un TP
});

test('pickMapperTp : stale (>3 min), non-mappeurs et moi-même exclus', () => {
  const r = pickMapperTp({
    self: { x: 0, z: 0 }, selfName: 'ResBot1', goal: null,
    mappers: [
      m('MapBot1', 900, 0, { at: NOW - 181000 }),        // périmé
      m('ResBot2', 800, 0, { role: 'worker' }),           // pas un mappeur
      m('ResBot1', 700, 0, { role: 'mapper' }),           // moi (defensive)
    ],
    now: NOW,
  });
  assert.strictEqual(r, null);
});

test('pickMapperTp : liste vide/absente → null', () => {
  assert.strictEqual(pickMapperTp({ self: { x: 0, z: 0 }, goal: null, mappers: [], now: NOW }), null);
  assert.strictEqual(pickMapperTp({ self: { x: 0, z: 0 }, goal: null, now: NOW }), null);
});
