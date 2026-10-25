'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('./respawnEscape');

const NOW = 1_800_000_000_000;
const CAMP = { x: 5, z: -605 };

test('verdict : 2 morts en ≤ 5 min à ≤ 24 blocs du point de réapparition → camp (le cas NethBot1 23/10)', () => {
  const v = R.respawnCampVerdict({
    spawn: { x: 5, z: -605 }, now: NOW,
    deathPos: [{ x: 5, z: -607, at: NOW - 280000 }, { x: 3, z: -604, at: NOW - 10000 }],
  });
  assert.deepStrictEqual(v, { x: 5, z: -605, deaths: 2, why: 'deaths_near' });
});

test('verdict : morts trop anciennes (> 5 min), trop loin, ou une seule → pas de camp', () => {
  assert.strictEqual(R.respawnCampVerdict({ spawn: CAMP, now: NOW, deathPos: [{ x: 5, z: -605, at: NOW - 6 * 60000 }, { x: 5, z: -605, at: NOW - 1000 }] }), null);
  assert.strictEqual(R.respawnCampVerdict({ spawn: CAMP, now: NOW, deathPos: [{ x: 60, z: -605, at: NOW - 1000 }, { x: 5, z: -605, at: NOW - 2000 }] }), null);
  assert.strictEqual(R.respawnCampVerdict({ spawn: CAMP, now: NOW, deathPos: [{ x: 5, z: -605, at: NOW - 1000 }] }), null);
  assert.strictEqual(R.respawnCampVerdict({ spawn: null, now: NOW, deathPos: [] }), null);
  // une mort datée du FUTUR (mémo hérité) ne compte pas
  assert.strictEqual(R.respawnCampVerdict({ spawn: CAMP, now: NOW, deathPos: [{ x: 5, z: -605, at: NOW + 60000 }, { x: 5, z: -605, at: NOW - 1000 }] }), null);
});

test('verdict : les vies brèves de respawnCamp (≥ 2 vies < 60 s ici) suffisent', () => {
  const v = R.respawnCampVerdict({ spawn: { x: 6, z: -603 }, now: NOW, deathPos: [], shortLives: { x: 5, z: -605, deaths: 3 } });
  assert.deepStrictEqual(v, { x: 5, z: -605, deaths: 3, why: 'short_lives' });
  // un verdict de vies brèves AILLEURS (vieux camp) ne fait pas de ce spawn un camp
  assert.strictEqual(R.respawnCampVerdict({ spawn: { x: 200, z: 0 }, now: NOW, deathPos: [], shortLives: { x: 5, z: -605, deaths: 3 } }), null);
});

const mate = (name, o = {}) => Object.assign({ name, role: 'worker', x: -363, z: -26, y: 15, at: NOW - 20000, worn: 3, ironZone: 10 }, o);

test('coéquipier : vivant, mineur, ARMÉ, loin du camp → choisi', () => {
  const m = R.pickRescueMate({ camp: CAMP, self: CAMP, selfName: 'NethBot1', now: NOW, mates: [mate('NethBot3')] });
  assert.strictEqual(m.name, 'NethBot3');
  assert.strictEqual(m.worn, 3);
  assert.ok(m.dist > 600);
});

test('coéquipier : nu, cartographe, bûcheron, soi-même, heartbeat périmé, ou DANS le camp → refusé', () => {
  const mates = [
    mate('Naked', { worn: 0 }), mate('OnePiece', { worn: 1 }), mate('NoField', { worn: undefined }),
    mate('MapBot1', { role: 'mapper' }), mate('Lj', { role: 'lumberjack' }), mate('NethBot1'),
    mate('Stale', { at: NOW - 10 * 60000 }), mate('InCamp', { x: 20, z: -600 }),
  ];
  assert.strictEqual(R.pickRescueMate({ camp: CAMP, selfName: 'NethBot1', now: NOW, mates }), null);
  assert.strictEqual(R.pickRescueMate({ camp: CAMP, now: NOW, mates: null }), null);
  assert.strictEqual(R.pickRescueMate({ camp: null, now: NOW, mates: [mate('A')] }), null);
});

test('coéquipier : le mieux armé, puis le mineur au travail, puis le plus proche, puis le nom', () => {
  const pick = (mates) => R.pickRescueMate({ camp: CAMP, self: CAMP, selfName: 'X', now: NOW, mates }).name;
  assert.strictEqual(pick([mate('A', { worn: 2 }), mate('B', { worn: 4 })]), 'B');
  assert.strictEqual(pick([mate('A', { y: 70, ironZone: 0 }), mate('B')]), 'B');
  assert.strictEqual(pick([mate('A', { x: 400, z: 400 }), mate('B', { x: 5, z: -500 })]), 'B');
  assert.strictEqual(pick([mate('B'), mate('A')]), 'A');
});

const ready = (o = {}) => R.reanchorReady(Object.assign({
  pending: { x: 5, z: -605, at: NOW - 60000 }, pos: { x: -60, y: 64, z: -605 }, now: NOW,
  onGround: true, inWater: false, groundOk: true, hostileDist: null, camped: false,
  blockLight: 0, skyLight: 15, night: false,
}, o));

test('ré-ancrage : sorti à ≥ 48 blocs, au sol plein, au calme, éclairé → oui', () => {
  const r = ready();
  assert.strictEqual(r.ok, true);
  assert.ok(r.dist >= 48);
});

test('ré-ancrage : chaque condition manquante bloque, avec sa raison', () => {
  assert.strictEqual(ready({ pending: null }).reason, 'no_pending');
  assert.strictEqual(ready({ pos: { x: -30, y: 64, z: -605 } }).reason, 'too_close');
  assert.strictEqual(ready({ busy: true }).reason, 'busy');
  assert.strictEqual(ready({ onGround: false }).reason, 'not_standing');
  assert.strictEqual(ready({ inWater: true }).reason, 'not_standing');
  assert.strictEqual(ready({ groundOk: false }).reason, 'no_ground', 'vide sous les pieds (voidGuard)');
  assert.strictEqual(ready({ groundOk: null }).reason, 'no_ground', 'chunk illisible : on attend');
  assert.strictEqual(ready({ hostileDist: 9 }).reason, 'hostile_near');
  assert.strictEqual(ready({ hostileDist: 20 }).ok, true);
  assert.strictEqual(ready({ camped: true }).reason, 'camped');
  assert.strictEqual(ready({ pending: { x: 5, z: -605, at: NOW - 31 * 60000 } }).reason, 'expired');
});

test('ré-ancrage : lumière — torche (bloc ≥ 8) OU ciel ouvert de jour ; galerie noire ou ciel de nuit refusés', () => {
  assert.strictEqual(ready({ blockLight: 12, skyLight: 0 }).ok, true, 'galerie éclairée');
  assert.strictEqual(ready({ blockLight: 0, skyLight: 0 }).reason, 'dark', 'galerie noire = les mobs y naissent');
  assert.strictEqual(ready({ blockLight: 0, skyLight: 15, night: true }).reason, 'dark', 'à découvert de nuit');
  assert.strictEqual(ready({ blockLight: 10, skyLight: 15, night: true }).ok, true);
  assert.strictEqual(ready({ blockLight: null, skyLight: null }).ok, true, 'illisible : on ne bloque pas');
});

test('pickRescueMate : le bûcheron n est accepté qu en mode relâché (allowLumberjack)', () => {
  const { pickRescueMate } = require('./respawnEscape');
  const now = 1e6;
  const mates = [{ name: 'B3', role: 'lumberjack', x: 0, z: 200, at: now, worn: 0 }];
  assert.strictEqual(pickRescueMate({ camp: { x: 0, z: 0 }, now, mates, minWorn: 0 }), null);
  assert.strictEqual(pickRescueMate({ camp: { x: 0, z: 0 }, now, mates, minWorn: 0, allowLumberjack: true }).name, 'B3');
});
