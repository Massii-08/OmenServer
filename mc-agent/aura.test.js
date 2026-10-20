'use strict';
const test = require('node:test');
const assert = require('node:assert');
const A = require('./aura');

const self = { x: 0, y: 70, z: 0 };
const mob = (name, dx, extra = {}) => Object.assign({ id: dx * 10 + name.length, name, kind: 'Hostile mobs', type: 'hostile', position: { x: dx, y: 70, z: 0 }, isValid: true }, extra);

test('auraTarget : hostile le plus proche à ≤ 3 blocs ; au-delà → rien', () => {
  const t = A.auraTarget([mob('zombie', 2.5), mob('skeleton', 1.5), mob('zombie', 4)], self);
  assert.strictEqual(t.name, 'skeleton');
  assert.strictEqual(A.auraTarget([mob('zombie', 3.5)], self), null);
});

test('auraTarget : jamais creeper, enderman, piglins neutres, golems, joueurs, NO_MELEE ; jamais une entité retirée', () => {
  for (const n of ['creeper', 'enderman', 'zombified_piglin', 'piglin', 'iron_golem', 'snow_golem', 'warden', 'wither_skeleton']) {
    assert.strictEqual(A.auraTarget([mob(n, 2)], self), null, n);
  }
  assert.strictEqual(A.auraTarget([{ name: 'Massii_08', type: 'player', position: { x: 1, y: 70, z: 0 } }], self), null);
  assert.strictEqual(A.auraTarget([{ name: 'cow', kind: 'Passive mobs', type: 'animal', position: { x: 1, y: 70, z: 0 } }], self), null);
  assert.strictEqual(A.auraTarget([mob('zombie', 2, { isValid: false })], self), null);
});

test('auraTarget : hostile invisible (canSee faux) ignoré ; canSee qui lève → ignoré', () => {
  assert.strictEqual(A.auraTarget([mob('zombie', 2)], self, { canSee: () => false }), null);
  assert.strictEqual(A.auraTarget([mob('zombie', 2)], self, { canSee: () => { throw new Error('x'); } }), null);
  assert.ok(A.auraTarget([mob('zombie', 2)], self, { canSee: () => true }));
});

test('auraTarget : self inconnu / liste vide → null', () => {
  assert.strictEqual(A.auraTarget([mob('zombie', 1)], null), null);
  assert.strictEqual(A.auraTarget([], self), null);
  assert.strictEqual(A.auraTarget(null, self), null);
});

test('attackCooldownMs : épée 625, haches plus lentes, poing 250', () => {
  assert.strictEqual(A.attackCooldownMs('iron_sword'), 625);
  assert.strictEqual(A.attackCooldownMs('wooden_axe'), 1250);
  assert.strictEqual(A.attackCooldownMs('stone_axe'), 1250);
  assert.strictEqual(A.attackCooldownMs('iron_axe'), 1112);
  assert.strictEqual(A.attackCooldownMs('diamond_axe'), 1000);
  assert.strictEqual(A.attackCooldownMs(null), 250);
  assert.strictEqual(A.attackCooldownMs('stone_pickaxe'), 834);
});

test('cooldownReady : respecte le délai de l arme tenue', () => {
  assert.strictEqual(A.cooldownReady(1000, 1500, 'iron_sword'), false);
  assert.strictEqual(A.cooldownReady(1000, 1625, 'iron_sword'), true);
  assert.strictEqual(A.cooldownReady(0, 0, 'iron_sword'), true, 'jamais frappé');
});

test('isWeapon : épées et haches', () => {
  assert.ok(A.isWeapon('stone_sword') && A.isWeapon('iron_axe'));
  assert.ok(!A.isWeapon('stone_pickaxe') && !A.isWeapon(null) && !A.isWeapon('pickaxe'));
});

test('auraPlan : pas d arme du tout → rien ; mange / combat pvp / pas de cible → rien', () => {
  const base = { target: mob('zombie', 2), weapon: 'stone_sword', held: 'stone_sword', digging: false, eating: false, pvpTarget: null, lastHitAt: 0, now: 10000 };
  assert.deepStrictEqual(A.auraPlan(base), { act: 'hit' });
  assert.strictEqual(A.auraPlan({ ...base, weapon: null, held: 'stone_pickaxe' }).act, 'none');
  assert.strictEqual(A.auraPlan({ ...base, eating: true }).act, 'none');
  assert.strictEqual(A.auraPlan({ ...base, pvpTarget: { id: 1 } }).act, 'none');
  assert.strictEqual(A.auraPlan({ ...base, target: null }).act, 'none');
});

test('auraPlan : arme en poche, main occupée → équiper (le coup part au tick suivant : changer d objet remet le cooldown à zéro) ; en train de creuser → frapper avec ce qu on tient', () => {
  const base = { target: mob('zombie', 2), weapon: 'stone_sword', held: 'oak_log', digging: false, eating: false, pvpTarget: null, lastHitAt: 0, now: 10000 };
  assert.deepStrictEqual(A.auraPlan(base), { act: 'equip' });
  assert.deepStrictEqual(A.auraPlan({ ...base, held: 'stone_pickaxe', digging: true }), { act: 'hit' });
});

test('auraPlan : cooldown pas prêt (selon l objet qui frappera) → attendre', () => {
  const base = { target: mob('zombie', 2), weapon: 'stone_sword', held: 'stone_sword', digging: false, eating: false, pvpTarget: null, now: 10000 };
  assert.strictEqual(A.auraPlan({ ...base, lastHitAt: 9600 }).act, 'wait');
  assert.strictEqual(A.auraPlan({ ...base, lastHitAt: 9300 }).act, 'hit');
  // creuse avec une pioche : cooldown pioche (834) et pas celui de l épée
  assert.strictEqual(A.auraPlan({ ...base, held: 'stone_pickaxe', digging: true, lastHitAt: 9300 }).act, 'wait');
});
