'use strict';
// DUEL CONTRE UN ZOMBIE (23/10) — mesure sur 11 h de sessions mineurs (rencontres SANS squelette ni
// creeper) : une rencontre commencée en FUYANT meurt 22/40 (55 %), commencée en COMBATTANT 11/50
// (22 %) ; un combat jamais lâché 1/26 (4 %), un combat lâché pour fuir 10/24 (42 %). À 6-12 PV au
// départ : fuir 10/18 (56 %), combattre 4/9 (44 %). D'où : seul contre un zombie, armé, on se bat
// jusqu'à 6 PV — et le disjoncteur ne coupe plus sur la chute de PV.
const test = require('node:test');
const assert = require('node:assert');
const fb = require('./fightBreaker');

test('isZombieDuel : un seul hostile de la famille zombie, aucun creeper, arme ≥ épée de pierre', () => {
  assert.strictEqual(fb.isZombieDuel({ names: ['zombie'], attackDamage: 5 }), true);
  for (const n of ['husk', 'drowned', 'zombie_villager']) assert.strictEqual(fb.isZombieDuel({ names: [n], attackDamage: 6 }), true, n);
  assert.strictEqual(fb.isZombieDuel({ names: ['zombie'], attackDamage: 4 }), false);          // épée de bois
  assert.strictEqual(fb.isZombieDuel({ names: ['zombie'], attackDamage: 0 }), false);          // poings
  assert.strictEqual(fb.isZombieDuel({ names: ['zombie', 'zombie'], attackDamage: 7 }), false); // groupe
  assert.strictEqual(fb.isZombieDuel({ names: ['zombie', 'creeper'], attackDamage: 7 }), false);
  assert.strictEqual(fb.isZombieDuel({ names: ['zombie', 'skeleton'], attackDamage: 7 }), false);
  assert.strictEqual(fb.isZombieDuel({ names: ['skeleton'], attackDamage: 7 }), false);
  assert.strictEqual(fb.isZombieDuel({ names: ['spider'], attackDamage: 7 }), false);
  assert.strictEqual(fb.isZombieDuel({}), false);
});

test('engageAllowedByHp : en duel zombie on engage jusqu\'à 6 PV (au lieu de 12)', () => {
  assert.strictEqual(fb.engageAllowedByHp({ health: 7, hostiles: 1, duel: true }), true);
  assert.strictEqual(fb.engageAllowedByHp({ health: 6, hostiles: 1, duel: true }), true);
  assert.strictEqual(fb.engageAllowedByHp({ health: 5.9, hostiles: 1, duel: true }), false);
  assert.strictEqual(fb.engageAllowedByHp({ health: 7, hostiles: 1 }), false);   // hors duel : inchangé
});

test('shouldAbortFight : en duel, plancher 6 PV et plus de coupure sur la chute', () => {
  assert.strictEqual(fb.shouldAbortFight({ inFight: true, health: 9, drop: 0, duel: true }), null);
  assert.strictEqual(fb.shouldAbortFight({ inFight: true, health: 12, drop: 9, duel: true }), null);
  assert.strictEqual(fb.shouldAbortFight({ inFight: true, health: 5.5, drop: 0, duel: true }), 'floor');
  assert.strictEqual(fb.shouldAbortFight({ inFight: true, health: 9, drop: 0 }), 'floor');   // hors duel : inchangé
});

test('breaker : un duel ne disjoncte pas à 8 PV ; le même combat hors duel disjoncte', () => {
  const b = fb.createFightBreaker();
  b.sample(20, 0); b.sample(14, 1000); b.sample(8, 2000);
  assert.strictEqual(b.check({ inFight: true, health: 8, t: 2000, duel: true }).abort, false);
  assert.deepStrictEqual(b.check({ inFight: true, health: 5, t: 2500, duel: true }).reason, 'floor');
  const c = fb.createFightBreaker();
  c.sample(20, 0); c.sample(8, 2000);
  assert.strictEqual(c.check({ inFight: true, health: 8, t: 2000 }).abort, true);
});

test('breaker.canEngage : en duel, 8 PV → permis ; hors duel → low_hp', () => {
  const b = fb.createFightBreaker();
  assert.strictEqual(b.canEngage({ t: 0, health: 8, hostiles: 1, nearestDist: 2, duel: true }).ok, true);
  assert.strictEqual(b.canEngage({ t: 0, health: 8, hostiles: 1, nearestDist: 2 }).reason, 'low_hp');
});
