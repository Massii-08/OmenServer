'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { roofPlan, shouldShelter } = require('./shelter');

test('roofPlan : bloc posable en poche → source inventory', () => {
  assert.strictEqual(roofPlan([{ name: 'dirt', count: 3 }], { hasPickaxe: false }).source, 'inventory');
});

test('roofPlan : rien en poche mais terrain minable → source mine', () => {
  assert.strictEqual(roofPlan([], { hasPickaxe: false, groundMineable: true }).source, 'mine');
});

test('roofPlan : rien en poche, pierre + pas de pioche → source none', () => {
  assert.strictEqual(roofPlan([{ name: 'stone_sword', count: 1 }], { hasPickaxe: false, groundMineable: false }).source, 'none');
});

test('shouldShelter : obscurité (light<=7) déclenche même y bas, sans dépendre de la nuit', () => {
  assert.strictEqual(shouldShelter({ night: false, lightLevel: 3, naked: true }).shelter, true);
});

test('shouldShelter : nuit + nu déclenche', () => {
  assert.strictEqual(shouldShelter({ night: true, lightLevel: null, naked: true }).shelter, true);
});

test('shouldShelter : jour + clair + équipé → non', () => {
  assert.strictEqual(shouldShelter({ night: false, lightLevel: 15, naked: false, lowHp: false, hostilesNear: false }).shelter, false);
});

test('shouldShelter : hostiles proches + nu (grotte) → déclenche même si light inconnu', () => {
  assert.strictEqual(shouldShelter({ night: false, lightLevel: null, naked: true, hostilesNear: true }).shelter, true);
});
