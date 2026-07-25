'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { coverPlan, shouldTakeCover, MELEE_OK } = require('./cover');

// Preuve live (world_ax4, 25/07) : « NethBot2 was shot by Skeleton » ×8 en 4 minutes, plus
// NethBot3 et MapBot2. Les squelettes sont le tueur n°1 des bots nus en sans-give.

// ─── coverPlan : où poser le mur ──────────────────────────────────────────────

test('coverPlan : tireur à l\'EST → mur sur la case est, 2 de haut (pieds + tête)', () => {
  const p = coverPlan({ x: 10, y: 64, z: 10 }, { x: 22, y: 64, z: 10 });
  assert.deepEqual(p, [{ x: 11, y: 64, z: 10 }, { x: 11, y: 65, z: 10 }]);
});

test('coverPlan : tireur à l\'OUEST → mur côté ouest', () => {
  const p = coverPlan({ x: 10, y: 64, z: 10 }, { x: -3, y: 64, z: 10 });
  assert.deepEqual(p, [{ x: 9, y: 64, z: 10 }, { x: 9, y: 65, z: 10 }]);
});

test('coverPlan : l\'axe DOMINANT gagne (mur perpendiculaire au tir)', () => {
  // dz (+20) domine dx (+3) → le mur se pose au sud, pas à l'est.
  const p = coverPlan({ x: 10, y: 64, z: 10 }, { x: 13, y: 64, z: 30 });
  assert.deepEqual(p, [{ x: 10, y: 64, z: 11 }, { x: 10, y: 65, z: 11 }]);
});

test('coverPlan : positions flottantes → cases entières sous le bot', () => {
  const p = coverPlan({ x: 10.7, y: 64.0, z: 10.2 }, { x: 25.5, y: 64, z: 10.1 });
  assert.deepEqual(p, [{ x: 11, y: 64, z: 10 }, { x: 11, y: 65, z: 10 }]);
});

test('coverPlan : même colonne (aucune direction) → null, jamais de crash', () => {
  assert.equal(coverPlan({ x: 10, y: 64, z: 10 }, { x: 10, y: 70, z: 10 }), null);
  assert.equal(coverPlan(null, { x: 1, y: 1, z: 1 }), null);
  assert.equal(coverPlan({ x: 1, y: 1, z: 1 }, null), null);
});

// ─── shouldTakeCover : quand se terrer plutôt que charger ─────────────────────

const NU = { distance: 12, health: 20, armorPoints: 0, weaponDamage: 0, hasShield: false, hasBlock: true };

test('bot NU canardé à 12 blocs → couvert (le cas qui tuait NethBot2 8×)', () => {
  assert.equal(shouldTakeCover(NU), true);
});

test('au CONTACT (≤5 blocs) → on tape, on ne se terre pas', () => {
  assert.equal(shouldTakeCover({ ...NU, distance: MELEE_OK }), false);
  assert.equal(shouldTakeCover({ ...NU, distance: 3 }), false);
});

test('avec BOUCLIER → la charge est couverte, pas de mur', () => {
  assert.equal(shouldTakeCover({ ...NU, hasShield: true }), false);
});

test('équipé (armure fer + épée) et en forme → charge', () => {
  assert.equal(shouldTakeCover({ ...NU, armorPoints: 15, weaponDamage: 6, health: 20 }), false);
});

test('équipé mais BLESSÉ → couvert quand même (on ne traverse pas à 8 PV)', () => {
  assert.equal(shouldTakeCover({ ...NU, armorPoints: 15, weaponDamage: 6, health: 8 }), true);
});

test('armuré mais DÉSARMÉ → couvert (charger sans arme = encaisser pour rien)', () => {
  assert.equal(shouldTakeCover({ ...NU, armorPoints: 15, weaponDamage: 0 }), true);
});

test('aucun bloc en poche → false (rien à poser, la décision ne sert à rien)', () => {
  assert.equal(shouldTakeCover({ ...NU, hasBlock: false }), false);
});

test('entrée vide/indéfinie → false, jamais de crash', () => {
  assert.equal(shouldTakeCover(undefined), false);
  assert.equal(shouldTakeCover({}), false);
});
