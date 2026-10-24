'use strict';
const test = require('node:test');
const assert = require('node:assert');
const H = require('./handoff');

test('isGiftForMe : seul le TENEUR de marmor:<moi> déclenche la réception', () => {
  assert.strictEqual(H.isGiftForMe({ claim: { by: 'NethBot3', at: 1 }, me: 'MapBot1', requester: 'NethBot3' }), true);
  assert.strictEqual(H.isGiftForMe({ claim: { by: 'NethBot2', at: 1 }, me: 'MapBot1', requester: 'NethBot3' }), false);
  assert.strictEqual(H.isGiftForMe({ claim: null, me: 'MapBot1', requester: 'NethBot3' }), false);   // TP de regroupement
  assert.strictEqual(H.isGiftForMe({ claim: { by: 'MapBot1' }, me: 'MapBot1', requester: 'MapBot1' }), false);
});

test('slotsToFree : poche pleine (vécu MapBot1 empty:0) → libérer autant de cases que de pièces', () => {
  assert.strictEqual(H.slotsToFree({ emptySlots: 0, expected: 2 }), 2);
  assert.strictEqual(H.slotsToFree({ emptySlots: 1, expected: 2 }), 1);
  assert.strictEqual(H.slotsToFree({ emptySlots: 14, expected: 2 }), 0);
  assert.strictEqual(H.slotsToFree({ emptySlots: 0, expected: 0 }), 1);   // au moins une case
});

test('pickupTargets : cadeaux à ≤ 4 blocs, le plus proche d\'abord, jamais le reste', () => {
  const self = { x: 0, y: 64, z: 0 };
  const items = [
    { id: 1, name: 'iron_helmet', x: 3, y: 64, z: 0 },
    { id: 2, name: 'iron_leggings', x: 1, y: 64, z: 0 },
    { id: 3, name: 'dirt', x: 1, y: 64, z: 1 },
    { id: 4, name: 'iron_boots', x: 9, y: 64, z: 0 },
    { id: 5, name: null, x: 0, y: 63, z: 2 },
    { id: 6, name: 'shield', x: 0, y: 64, z: 3.5 },
  ];
  assert.deepStrictEqual(H.pickupTargets({ self, items }).map((i) => i.id), [2, 5, 1, 6]);
  assert.deepStrictEqual(H.pickupTargets({ self: null, items }), []);
});

test('tossReady : jamais à plus de 2 blocs', () => {
  assert.strictEqual(H.tossReady(1.4), true);
  assert.strictEqual(H.tossReady(2), true);
  assert.strictEqual(H.tossReady(2.5), false);
  assert.strictEqual(H.tossReady(NaN), false);
});

test('deliveryProof : ramassé par le receveur, ou heartbeat POSTÉRIEUR au jet qui ne liste plus la pièce', () => {
  const pieces = ['iron_leggings', 'iron_helmet'];
  assert.deepStrictEqual(H.deliveryProof({ pieces, collected: 2 }), { proven: true, by: 'collected', back: false });
  assert.strictEqual(H.deliveryProof({ pieces, collected: 1 }).proven, false);
  const tossAt = 1000;
  assert.strictEqual(H.deliveryProof({ pieces, tossAt, receiver: { at: 1500, missing: [] } }).by, 'heartbeat');
  // heartbeat ANTÉRIEUR au jet : il décrit l'état d'avant, ce n'est pas une preuve
  assert.strictEqual(H.deliveryProof({ pieces, tossAt, receiver: { at: 900, missing: [] } }).proven, false);
  // heartbeat frais qui liste encore une pièce : pas reçue
  assert.strictEqual(H.deliveryProof({ pieces, tossAt, receiver: { at: 1500, missing: ['iron_helmet'] } }).proven, false);
  // vieux heartbeat sans champ missing : pas de preuve
  assert.strictEqual(H.deliveryProof({ pieces, tossAt, receiver: { at: 1500 } }).proven, false);
});

test('deliveryProof : une pièce revenue chez le donneur annule toute preuve', () => {
  const pieces = ['iron_leggings', 'iron_helmet'];
  assert.deepStrictEqual(H.deliveryProof({ pieces, pocketBack: 2, collected: 0 }), { proven: false, by: null, back: true });
  assert.deepStrictEqual(H.deliveryProof({ pieces, pocketBack: 1, collected: 1 }), { proven: false, by: null, back: false });
  assert.strictEqual(H.deliveryProof({ pieces: [] }).proven, false);
});

test('handoffNext : delivered sur preuve, wait jusqu\'à 15 s, puis retry une fois, puis give_up', () => {
  const ok = { proven: true, by: 'collected' };
  const no = { proven: false };
  assert.strictEqual(H.handoffNext({ proof: ok, elapsedMs: 300, tries: 1 }), 'delivered');
  assert.strictEqual(H.handoffNext({ proof: no, elapsedMs: 3000, tries: 1 }), 'wait');
  assert.strictEqual(H.handoffNext({ proof: no, elapsedMs: 15000, tries: 1 }), 'retry');
  assert.strictEqual(H.handoffNext({ proof: no, elapsedMs: 15000, tries: 2 }), 'give_up');
  assert.strictEqual(H.handoffNext({ proof: { proven: false, back: true }, elapsedMs: 2500, tries: 1 }), 'retry');
});

test('receiverNext : ramasse ce qui est au sol, attend le donneur, s\'arrête quand il est parti ou au bout de 30 s', () => {
  assert.strictEqual(H.receiverNext({ elapsedMs: 1000, groundLeft: 2 }), 'collect');
  assert.strictEqual(H.receiverNext({ elapsedMs: 1000 }), 'wait');
  assert.strictEqual(H.receiverNext({ elapsedMs: 5000, gotAll: true }), 'done');
  assert.strictEqual(H.receiverNext({ elapsedMs: 5000, gotAll: true, groundLeft: 1 }), 'collect');
  assert.strictEqual(H.receiverNext({ elapsedMs: 9000, donorSeen: true, donorGoneMs: 3500 }), 'donor_left');
  assert.strictEqual(H.receiverNext({ elapsedMs: 9000, donorSeen: true, donorGoneMs: 3500, groundLeft: 1 }), 'collect');
  assert.strictEqual(H.receiverNext({ elapsedMs: 30000, groundLeft: 1 }), 'timeout');
});
