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

// SOUS TERRE = jamais d'abri (Massii 16/07 : « du moment que les bots ressource sont sous terre
// pour miner, pas besoin de se cacher pour la nuit »). Piège vécu : sous terre il fait TOUJOURS
// sombre (lightLevel ≤7) et le mineur en chaîne armure est NU par définition → shouldShelter
// 'dark' le faisait s'enterrer 10-13 min en boucle DANS sa mine, où l'aube ne change rien.
test('shouldShelter : underground → jamais d\'abri, quel que soit le danger', () => {
  assert.deepStrictEqual(shouldShelter({ underground: true, night: true, naked: true }),
    { shelter: false, reason: 'underground' });
  assert.deepStrictEqual(shouldShelter({ underground: true, lightLevel: 0, lowHp: true }),
    { shelter: false, reason: 'underground' });
  assert.deepStrictEqual(shouldShelter({ underground: true, hostilesNear: true, naked: true }),
    { shelter: false, reason: 'underground' });
  assert.deepStrictEqual(shouldShelter({ underground: true, night: true, proactive: true }),
    { shelter: false, reason: 'underground' });
});

test('shouldShelter : en surface (underground false/absent) → comportements historiques inchangés', () => {
  assert.strictEqual(shouldShelter({ night: true, naked: true }).shelter, true);
  assert.strictEqual(shouldShelter({ underground: false, night: true, naked: true }).shelter, true);
  assert.strictEqual(shouldShelter({ lightLevel: 3, lowHp: true }).shelter, true);
  assert.strictEqual(shouldShelter({ night: false, naked: true }).shelter, false);
});
