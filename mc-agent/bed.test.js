'use strict';
const test = require('node:test');
const assert = require('node:assert');
const B = require('./bed');

test('woolBest / bedRecipeName : 3 laines de LA MÊME couleur, pas 3 mélangées', () => {
  assert.deepStrictEqual(B.woolBest({ white_wool: 2, black_wool: 1 }), { color: 'white', count: 2 });
  assert.strictEqual(B.bedRecipeName({ white_wool: 2, black_wool: 1 }), null, '2+1 couleurs ≠ un lit');
  assert.strictEqual(B.bedRecipeName({ white_wool: 1, gray_wool: 4 }), 'gray_bed');
  assert.strictEqual(B.woolMissing({ white_wool: 2 }), 1);
  assert.strictEqual(B.woolMissing({}), 3);
  assert.strictEqual(B.woolMissing({ pink_wool: 9 }), 0);
});

test('bedItemIn : n\'importe quelle couleur de lit en poche', () => {
  assert.strictEqual(B.bedItemIn({ red_bed: 1 }), 'red_bed');
  assert.strictEqual(B.bedItemIn({ red_bed: 0, oak_log: 3 }), null);
  assert.strictEqual(B.bedItemIn(null), null);
});

test('bedGoalMet : satisfait si posé ou en attente de nouvel essai', () => {
  assert.strictEqual(B.bedGoalMet({ inv: { white_bed: 1 }, bedPlaced: true }), true);
  assert.strictEqual(B.bedGoalMet({ inv: { white_bed: 1 }, bedRetryLater: true }), true);
});

test('bedGoalMet : lit en poche → à poser ; laine + bois → à crafter ; laine sans bois → sauté', () => {
  assert.strictEqual(B.bedGoalMet({ inv: { white_bed: 1 } }), false);
  assert.strictEqual(B.bedGoalMet({ inv: { white_wool: 3 }, planksOk: true }), false);
  assert.strictEqual(B.bedGoalMet({ inv: { white_wool: 3 }, planksOk: false }), true, 'jamais bloquant');
});

test('bedGoalMet : pas de laine → mouton connu = à faire, aucun mouton = SAUTÉ (non bloquant)', () => {
  assert.strictEqual(B.bedGoalMet({ inv: { oak_log: 5 }, sheepNear: true, planksOk: true }), false);
  assert.strictEqual(B.bedGoalMet({ inv: { oak_log: 5 }, sheepNear: false, planksOk: true }), true);
  assert.strictEqual(B.bedGoalMet({ inv: {} }), true, 'contexte sans info (vieux tests) : sauté');
});

test('sheepKnown : vu maintenant, ou vu < 10 min à ≤ 96 blocs', () => {
  const now = 1e9;
  assert.strictEqual(B.sheepKnown({ seenNow: true }), true);
  const pos = { x: 0, z: 0 };
  assert.strictEqual(B.sheepKnown({ last: { x: 50, z: 0, at: now - 60000 }, pos, now }), true);
  assert.strictEqual(B.sheepKnown({ last: { x: 200, z: 0, at: now - 60000 }, pos, now }), false, 'trop loin');
  assert.strictEqual(B.sheepKnown({ last: { x: 10, z: 0, at: now - 11 * 60000 }, pos, now }), false, 'trop vieux');
  assert.strictEqual(B.sheepKnown({ last: { x: 10, z: 0, at: now + 5000 }, pos, now }), false, 'futur');
  assert.strictEqual(B.sheepKnown({}), false);
});

test('mémo : bedMemoWith FUSIONNE (dette de mort, zone conservées) et efface le retry', () => {
  const memo = { base: { x: 1, y: 2, z: 3 }, zone: { a: 1 }, bedRetryAt: 5 };
  const m = B.bedMemoWith(memo, { x: 10.7, y: 64.2, z: -3.1 }, 42);
  assert.deepStrictEqual(m.bed, { x: 10, y: 64, z: -4, at: 42 });
  assert.deepStrictEqual(m.base, memo.base);
  assert.deepStrictEqual(m.zone, memo.zone);
  assert.strictEqual(m.bedRetryAt, undefined);
  assert.strictEqual(memo.bed, undefined, 'pas de mutation de l\'entrée');
  assert.deepStrictEqual(B.bedOf(m), m.bed);
  const c = B.bedMemoCleared(m);
  assert.strictEqual(B.bedOf(c), null);
  assert.deepStrictEqual(c.zone, memo.zone);
});

test('bedRetryActive : vrai pendant le délai, faux après ; une date absurde ne gèle rien', () => {
  const now = 1e9;
  const m = B.bedRetryMemo({ base: {} }, now);
  assert.deepStrictEqual(m.base, {});
  assert.strictEqual(B.bedRetryActive(m, now + 1000), true);
  assert.strictEqual(B.bedRetryActive(m, now + B.BED_RETRY_MS + 1), false);
  assert.strictEqual(B.bedRetryActive({ bedRetryAt: now + 1e12 }, now), false, 'mémo d\'un autre monde');
  assert.strictEqual(B.bedRetryActive(null, now), false);
});

// Monde jouet : sol plein à y=63, air au-dessus, sauf ce que `over` redéfinit.
function world(over = {}) {
  return (x, y, z) => {
    const k = `${x},${y},${z}`;
    if (k in over) return over[k];
    if (y <= 63) return { name: 'grass_block', boundingBox: 'block' };
    return { name: 'air', boundingBox: 'empty' };
  };
}

test('bedSpotPlan : 4 directions en terrain plat, pied à 1 bloc, tête à 2, clic sur le sol du pied', () => {
  const plan = B.bedSpotPlan(world(), { x: 0.4, y: 64, z: 0.6 });
  assert.strictEqual(plan.length, 4);
  const e = plan.find((p) => p.dir[0] === 1);
  assert.deepStrictEqual(e.foot, { x: 1, y: 64, z: 0 });
  assert.deepStrictEqual(e.head, { x: 2, y: 64, z: 0 });
  assert.deepStrictEqual(e.ref, { x: 1, y: 63, z: 0 });
});

test('bedSpotPlan : écarte un mur, un trou sous la tête, de l\'eau, un lit déjà là', () => {
  const plan = B.bedSpotPlan(world({
    '1,64,0': { name: 'stone', boundingBox: 'block' },          // mur à l'est
    '-2,63,0': { name: 'air', boundingBox: 'empty' },           // trou sous la tête ouest
    '0,64,1': { name: 'water', boundingBox: 'empty' },          // eau au sud
    '0,64,-2': { name: 'white_bed', boundingBox: 'empty' },     // déjà un lit au nord
  }), { x: 0, y: 64, z: 0 });
  assert.deepStrictEqual(plan, []);
});

test('bedSpotPlan : entrées invalides → aucune place', () => {
  assert.deepStrictEqual(B.bedSpotPlan(null, { x: 0, y: 0, z: 0 }), []);
  assert.deepStrictEqual(B.bedSpotPlan(world(), null), []);
  assert.deepStrictEqual(B.bedSpotPlan(() => null, { x: 0, y: 64, z: 0 }), [], 'chunk non chargé');
});

test('parseBedMessage : textes vanilla en_US, jamais un message de joueur', () => {
  assert.strictEqual(B.parseBedMessage('Respawn point set'), 'spawn_set');
  assert.strictEqual(B.parseBedMessage('You have no home bed or charged respawn anchor, or it was obstructed'), 'spawn_missing');
  assert.strictEqual(B.parseBedMessage('You may not rest now; there are monsters nearby'), 'monsters');
  assert.strictEqual(B.parseBedMessage('You can sleep only at night or during thunderstorms'), 'day');
  assert.strictEqual(B.parseBedMessage('You may not rest now; the bed is too far away'), 'too_far');
  assert.strictEqual(B.parseBedMessage('This bed is occupied'), 'occupied');
  assert.strictEqual(B.parseBedMessage('This bed is obstructed'), 'obstructed');
  assert.strictEqual(B.parseBedMessage('<Bob> Respawn point set lol'), null, 'un joueur qui tape la phrase');
  assert.strictEqual(B.parseBedMessage('Teleporting...'), null);
  assert.strictEqual(B.parseBedMessage(''), null);
  assert.strictEqual(B.parseBedMessage(null), null);
});

test('sleepErrorReason : erreurs mineflayer de bot.sleep', () => {
  assert.strictEqual(B.sleepErrorReason(new Error('it\'s not night and it\'s not a thunderstorm')), 'day');
  assert.strictEqual(B.sleepErrorReason(new Error('there are monsters nearby')), 'monsters');
  assert.strictEqual(B.sleepErrorReason(new Error('wrong block : not a bed block')), 'not_bed');
  assert.strictEqual(B.sleepErrorReason(new Error('boom')), 'error');
});

test('sleepDecision : nuit CONNUE + lit à ≤ 16 blocs', () => {
  const bed = { x: 10, y: 64, z: 0 };
  assert.strictEqual(B.sleepDecision({ bed, pos: { x: 5, y: 64, z: 0 }, night: true }).sleep, true);
  assert.deepStrictEqual(B.sleepDecision({ bed, pos: { x: 40, y: 64, z: 0 }, night: true }).why, 'too_far');
  assert.strictEqual(B.sleepDecision({ bed, pos: { x: 5, y: 64, z: 0 }, night: false }).why, 'not_night');
  assert.strictEqual(B.sleepDecision({ bed, pos: { x: 5, y: 64, z: 0 }, night: null }).why, 'not_night', 'heure inconnue');
  assert.strictEqual(B.sleepDecision({ bed: null, pos: { x: 5, y: 64, z: 0 }, night: true }).why, 'no_bed');
  assert.strictEqual(B.sleepDecision({ bed, pos: { x: 10, y: 40, z: 0 }, night: true }).sleep, false, '24 blocs plus bas (mine)');
});
