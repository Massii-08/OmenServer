'use strict';
// DERNIER CARRÉ CONTRE UN ZOMBIE AU CONTACT (25/10, run keepInventory OFF, 22 morts en 2 h) :
// 7 `fight_aborted` (plancher atteint → fuite) contre UN seul hostile, 6 finissent en mort dans les
// 20 s, dont 4 en ≤ 4 s (12:09:22 → 2 s, 12:09:37 → 3 s, 12:27:49 → 2 s, 13:07:50 → 4 s) — chaque
// fois « slain by Zombie ». Le bot nu à 4-10 PV qui tourne le dos à un zombie collé prend le coup
// suivant dans le dos. Seul contre UN zombie déjà à portée de coup, on finit le combat : aucune
// coupure (plancher ou chute), aucune fuite réflexe sur PV bas, l'engagement reste permis.
const test = require('node:test');
const assert = require('node:assert');
const fb = require('./fightBreaker');
const { shouldFlee } = require('./reflexes');
const { combatDecision, survivalTick } = require('./survival');

test('isLoneZombieContact : un seul hostile, famille zombie, à portée de coup, avec une arme', () => {
  const w = { attackDamage: 5 };
  assert.strictEqual(fb.isLoneZombieContact({ names: ['zombie'], nearestDist: 1.5, ...w }), true);
  for (const n of ['husk', 'drowned', 'zombie_villager']) assert.strictEqual(fb.isLoneZombieContact({ names: [n], nearestDist: 2, ...w }), true, n);
  assert.strictEqual(fb.isLoneZombieContact({ names: ['zombie'], nearestDist: fb.LAST_STAND_REACH, ...w }), true);
  assert.strictEqual(fb.isLoneZombieContact({ names: ['zombie'], nearestDist: 1.5, attackDamage: 4 }), true);   // épée de bois
  assert.strictEqual(fb.isLoneZombieContact({ names: ['zombie'], nearestDist: 1.5, attackDamage: 0 }), false);  // poings : la fuite reste
  assert.strictEqual(fb.isLoneZombieContact({ names: ['zombie'], nearestDist: 1.5 }), false);                   // arme inconnue
  assert.strictEqual(fb.isLoneZombieContact({ names: ['zombie'], nearestDist: 5, ...w }), false);          // pas collé : la fuite marche
  assert.strictEqual(fb.isLoneZombieContact({ names: ['zombie', 'zombie'], nearestDist: 1, ...w }), false); // groupe
  assert.strictEqual(fb.isLoneZombieContact({ names: ['zombie', 'creeper'], nearestDist: 1, ...w }), false);
  assert.strictEqual(fb.isLoneZombieContact({ names: ['zombie', 'skeleton'], nearestDist: 1, ...w }), false);
  assert.strictEqual(fb.isLoneZombieContact({ names: ['spider'], nearestDist: 1, ...w }), false);
  assert.strictEqual(fb.isLoneZombieContact({ names: ['zombie'], ...w }), false);                           // distance inconnue
  assert.strictEqual(fb.isLoneZombieContact({}), false);
});

test('shouldAbortFight : en dernier carré, ni plancher ni chute — même en duel sous 6 PV', () => {
  assert.strictEqual(fb.shouldAbortFight({ inFight: true, health: 4, drop: 9, lastStand: true }), null);
  assert.strictEqual(fb.shouldAbortFight({ inFight: true, health: 2, drop: 0, duel: true, lastStand: true }), null);
  // sans dernier carré : inchangé
  assert.strictEqual(fb.shouldAbortFight({ inFight: true, health: 4, drop: 0 }), 'floor');
  assert.strictEqual(fb.shouldAbortFight({ inFight: true, health: 5.5, drop: 0, duel: true }), 'floor');
});

test('breaker.check : le plancher atteint en dernier carré ne disjoncte pas (raison tracée last_stand)', () => {
  const b = fb.createFightBreaker();
  b.sample(20, 0); b.sample(11, 1000); b.sample(6.5, 2000);
  const r = b.check({ inFight: true, health: 6.5, t: 2000, lastStand: true });
  assert.strictEqual(r.abort, false);
  assert.strictEqual(r.reason, 'last_stand');
  const r2 = fb.createFightBreaker().check({ inFight: true, health: 6.5, t: 2000 });
  assert.strictEqual(r2.abort, true);
  // rien à couper : pas de raison inventée
  assert.strictEqual(fb.createFightBreaker().check({ inFight: true, health: 18, t: 0, lastStand: true }).reason, null);
});

test('breaker.canEngage : en dernier carré l\'engagement reste permis à bas PV, même juste après un abandon', () => {
  const b = fb.createFightBreaker();
  b.noteAbort({ t: 1000, pos: { x: 0, y: 64, z: 0 }, fleeOk: true, health: 7 });
  const g = b.canEngage({ t: 1500, pos: { x: 3, y: 64, z: 0 }, health: 4, hostiles: 1, nearestDist: 1.5, lastStand: true });
  assert.strictEqual(g.ok, true);
  assert.strictEqual(g.reason, 'last_stand');
  // sans dernier carré : refus (délai de ré-engagement)
  const b2 = fb.createFightBreaker();
  b2.noteAbort({ t: 1000, pos: { x: 0, y: 64, z: 0 }, fleeOk: true, health: 7 });
  assert.strictEqual(b2.canEngage({ t: 1500, pos: { x: 3, y: 64, z: 0 }, health: 4, hostiles: 1, nearestDist: 6 }).ok, false);
});

test('reflexes.shouldFlee : PV bas en dernier carré → pas de fuite ; le creeper reste fui', () => {
  const bot = { health: 3, food: 12, entity: { position: { x: 0, y: 64, z: 0 } }, nearestEntity: () => null };
  assert.strictEqual(shouldFlee(bot), true);
  assert.strictEqual(shouldFlee(bot, { duel: true }), true);
  assert.strictEqual(shouldFlee(bot, { lastStand: true }), false);
});

test('survival.combatDecision : zombie seul au contact → fight à tout PV ; creeper / lave / mappeur priment', () => {
  const base = { hostileCount: 1, armored: false, food: 12, nearestDist: 1.5, lastStand: true };
  assert.strictEqual(combatDecision({ ...base, health: 4 }), 'fight');
  assert.strictEqual(combatDecision({ ...base, health: 9 }), 'fight');
  assert.strictEqual(combatDecision({ ...base, health: 4, hasCreeper: true }), 'flee');
  assert.strictEqual(combatDecision({ ...base, health: 4, lavaNear: true }), 'flee');
  // sans dernier carré : la fuite d'origine
  assert.strictEqual(combatDecision({ ...base, health: 4, lastStand: false }), 'flee');
});

function fakeBot(health, mobs, items) {
  const P = (x) => ({ x, y: -6, z: 0, distanceTo(o) { return Math.hypot(o.x - this.x, o.y - this.y, o.z - this.z); } });
  const ents = {};
  mobs.forEach(([name, d], i) => { ents[i] = { name, kind: 'Hostile mobs', position: P(d) }; });
  const calls = { attack: 0, flee: 0, canEngage: [] };
  return {
    calls, entity: { position: P(0) }, entities: ents, health, food: 12,
    time: { timeOfDay: 6000 }, inventory: { slots: [], items: () => items },
    pvp: { attack: () => { calls.attack++; } }, equip: async () => {}, blockAt: () => null,
    pathfinder: { isMoving: () => false },
  };
}

test('survivalTick : zombie collé, épée de pierre, 4 PV → fight, canEngage reçoit lastStand (avant : fuite)', async () => {
  const bot = fakeBot(4, [['zombie', 2]], [{ name: 'stone_sword' }]);
  const r = await survivalTick(bot, { fleeFrom: () => { bot.calls.flee++; return true; }, lavaNear: () => false, now: () => 5e9,
    canEngage: (a) => { bot.calls.canEngage.push(a); return { ok: true }; } });
  assert.strictEqual(r, 'fight');
  assert.strictEqual(bot.calls.flee, 0);
  assert.strictEqual(bot.calls.canEngage[0].lastStand, true);
});

test('survivalTick : zombie à 6 blocs, épée, 4 PV → fuite (pas collé, règle d\'origine)', async () => {
  const bot = fakeBot(4, [['zombie', 6]], [{ name: 'stone_sword' }]);
  const r = await survivalTick(bot, { fleeFrom: () => true, lavaNear: () => false, now: () => 6e9 });
  assert.strictEqual(r, 'flee');
});

test('engageAllowedByHp : en armure complète, groupe engagé dès 10 PV', () => {
  const { engageAllowedByHp } = require('./fightBreaker');
  assert.strictEqual(engageAllowedByHp({ health: 15, hostiles: 3 }), false);
  assert.strictEqual(engageAllowedByHp({ health: 15, hostiles: 3, armored: true }), true);
  assert.strictEqual(engageAllowedByHp({ health: 8, hostiles: 3, armored: true }), false);
});
