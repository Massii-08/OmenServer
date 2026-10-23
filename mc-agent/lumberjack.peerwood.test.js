'use strict';
// ENTRAIDE BOIS SANS BÛCHERON (23/10, live NethBot3 : 0 pièce, ~50 min sur le bois pendant que NethBot1
// et NethBot2 avaient du bois en poche ; personne à 4/4 → pas de bûcheron élu → demande sans destinataire).
const test = require('node:test');
const assert = require('node:assert');
const {
  woodEquiv, peerWoodSupplier, peerDonorSafe, pickPeerWoodGift, woodGiftTossPlan, pickWoodedMate,
  woodWaitDecision, PEER_DONOR_MIN,
} = require('./lumberjack');

const NOW = 1792782843537;
const mate = (o) => Object.assign({ role: 'worker', at: NOW - 10000 }, o);

test('woodEquiv : bûches + planches/4', () => {
  assert.strictEqual(woodEquiv({ oak_log: 10, spruce_planks: 9, stick: 30 }), 12);
  assert.strictEqual(woodEquiv({}), 0);
  assert.strictEqual(woodEquiv(null), 0);
});

test('peerWoodSupplier : un coéquipier frais avec ≥ 24 de bois → destinataire de la demande', () => {
  const mates = [
    mate({ name: 'NethBot1', woodStock: 30 }),
    mate({ name: 'NethBot2', woodStock: 40 }),
    mate({ name: 'MapBot1', role: 'mapper', woodStock: 99 }),
    mate({ name: 'NethBot3', woodStock: 0, woodWant: 16, woodAt: NOW }),
  ];
  assert.strictEqual(peerWoodSupplier({ mates, selfName: 'NethBot3', now: NOW }), 'NethBot2');
  assert.strictEqual(peerWoodSupplier({ mates: [mate({ name: 'NethBot1', woodStock: PEER_DONOR_MIN - 1 })], selfName: 'X', now: NOW }), null);
  assert.strictEqual(peerWoodSupplier({ mates: [mate({ name: 'NethBot1', woodStock: 50, at: NOW - 600000 })], selfName: 'X', now: NOW }), null, 'présence périmée');
  assert.strictEqual(peerWoodSupplier({ mates: [mate({ name: 'NethBot1' })], selfName: 'X', now: NOW }), null, 'ancien heartbeat sans woodStock');
  assert.strictEqual(peerWoodSupplier({ mates: [mate({ name: 'NethBot1', woodStock: 50, woodWant: 16, woodAt: NOW })], selfName: 'X', now: NOW }), null, 'un demandeur ne donne pas');
});

test('le demandeur publie sa demande dès qu un donneur existe (le décideur reçoit le donneur comme fournisseur)', () => {
  const d = woodWaitDecision({ isLumberjack: false, isMapper: false, lumberjack: 'NethBot2', request: null,
    timedOutAt: 0, now: NOW, underground: false, noWoodHere: true });
  assert.strictEqual(d.action, 'request');
});

test('peerDonorSafe : PV/faim corrects, pas d hostile, pas nu la nuit', () => {
  assert.strictEqual(peerDonorSafe({ health: 20, food: 20 }), true);
  assert.strictEqual(peerDonorSafe({ health: 12, food: 20 }), false);
  assert.strictEqual(peerDonorSafe({ health: 20, food: 4 }), false);
  assert.strictEqual(peerDonorSafe({ health: 20, food: 20, hostilesNear: 1 }), false);
  assert.strictEqual(peerDonorSafe({ health: 20, food: 20, isNight: true, worn: 1 }), false);
  assert.strictEqual(peerDonorSafe({ health: 20, food: 20, isNight: true, worn: 3 }), true);
  assert.strictEqual(peerDonorSafe({}), false);
});

const REQ = [mate({ name: 'NethBot3', woodWant: 16, woodAt: NOW - 30000 })];

test('pickPeerWoodGift : 16 bûches à la plus ancienne demande, seulement sans bûcheron', () => {
  assert.deepStrictEqual(pickPeerWoodGift({ mates: REQ, selfName: 'NethBot1', now: NOW, logs: 30 }),
    { to: 'NethBot3', logs: 16, planks: 0, want: 16 });
  assert.strictEqual(pickPeerWoodGift({ mates: REQ, selfName: 'NethBot1', now: NOW, logs: 30, lumberjack: 'NethBot2' }), null, 'le bûcheron sert');
  assert.strictEqual(pickPeerWoodGift({ mates: REQ, selfName: 'NethBot1', now: NOW, logs: 23 }), null, 'sous le seuil de 24');
  assert.strictEqual(pickPeerWoodGift({ mates: REQ, selfName: 'NethBot1', now: NOW, logs: 30, skip: new Set(['NethBot3']) }), null);
  assert.strictEqual(pickPeerWoodGift({ mates: [], selfName: 'NethBot1', now: NOW, logs: 30 }), null, 'personne ne demande');
});

test('pickPeerWoodGift : 64 planches si pas assez de bûches, sinon le mélange', () => {
  assert.deepStrictEqual(pickPeerWoodGift({ mates: REQ, selfName: 'N1', now: NOW, logs: 2, planks: 96 }),
    { to: 'NethBot3', logs: 0, planks: 64, want: 16 });
  const mix = pickPeerWoodGift({ mates: REQ, selfName: 'N1', now: NOW, logs: 10, planks: 56 });
  assert.deepStrictEqual(mix, { to: 'NethBot3', logs: 10, planks: 24, want: 16 });
  assert.strictEqual(mix.logs + mix.planks / 4, 16);
});

test('woodGiftTossPlan : bûches puis planches, toutes essences', () => {
  const items = [{ name: 'oak_log', type: 1, count: 10 }, { name: 'dirt', type: 2, count: 64 },
    { name: 'birch_log', type: 3, count: 10 }, { name: 'oak_planks', type: 4, count: 40 }, { name: 'spruce_planks', type: 5, count: 40 }];
  assert.deepStrictEqual(woodGiftTossPlan(items, { logs: 16, planks: 0 }).map((p) => [p.name, p.count]), [['oak_log', 10], ['birch_log', 6]]);
  assert.deepStrictEqual(woodGiftTossPlan(items, { logs: 0, planks: 64 }).map((p) => [p.name, p.count]), [['oak_planks', 40], ['spruce_planks', 24]]);
});

test('pickWoodedMate : coéquipier le plus proche, en surface, dans une zone boisée connue', () => {
  const spots = [{ x: -256, z: 256 }, { x: 0, z: -640 }];
  const mates = [
    mate({ name: 'NethBot2', x: -596, z: -44, y: 3 }),            // sous terre
    mate({ name: 'NethBot1', x: -19, z: -680, y: 70, role: 'lumberjack' }),
    mate({ name: 'MapBot2', role: 'mapper', x: -250, z: 250, y: 70 }),
  ];
  assert.deepStrictEqual(pickWoodedMate({ self: { x: -249, z: 254 }, selfName: 'NethBot3', mates, now: NOW, spots }),
    { name: 'NethBot1', dist: 962 });
  // déjà à côté : rien à gagner
  assert.strictEqual(pickWoodedMate({ self: { x: -30, z: -660 }, selfName: 'NethBot3', mates, now: NOW, spots }), null);
  // aucun endroit boisé connu près d'un coéquipier
  assert.strictEqual(pickWoodedMate({ self: { x: 500, z: 500 }, selfName: 'NethBot3', mates, now: NOW, spots: [{ x: 900, z: 900 }] }), null);
});
