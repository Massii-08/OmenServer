'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { shouldSprint, applyPathfinderBounds, PATHFINDER_SEARCH_RADIUS } = require('./movement');

// État de base : le bot avance sur la terre ferme, rassasié, ne mine pas.
const BASE = { moving: true, onGround: true, inWater: false, digging: false, sneaking: false, food: 20, sprinting: false };

test('sprint ON par défaut : avance sur terre ferme + rassasié → true (vrai joueur)', () => {
  assert.equal(shouldSprint(BASE), true);
});

test('à l\'arrêt → pas de sprint', () => {
  assert.equal(shouldSprint({ ...BASE, moving: false }), false);
});

test('en l\'air (chute/saut) → pas de sprint', () => {
  assert.equal(shouldSprint({ ...BASE, onGround: false }), false);
});

test('dans l\'eau → pas de sprint (et on évite l\'eau)', () => {
  assert.equal(shouldSprint({ ...BASE, inWater: true }), false);
});

test('en train de miner → pas de sprint', () => {
  assert.equal(shouldSprint({ ...BASE, digging: true }), false);
});

test('accroupi (pose de bloc / bord) → pas de sprint', () => {
  assert.equal(shouldSprint({ ...BASE, sneaking: true }), false);
});

test('faim ≤ 6 : le serveur refuse le sprint même si on sprintait', () => {
  assert.equal(shouldSprint({ ...BASE, food: 6, sprinting: true }), false);
  assert.equal(shouldSprint({ ...BASE, food: 5, sprinting: true }), false);
});

test('hystérésis faim : sprinte déjà → continue tant que faim > 6 (à 7 OK)', () => {
  assert.equal(shouldSprint({ ...BASE, food: 7, sprinting: true }), true);
});

test('hystérésis faim : ne sprintait PAS → démarre seulement à faim ≥ 7 (pas à 6)', () => {
  assert.equal(shouldSprint({ ...BASE, food: 7, sprinting: false }), true);
  assert.equal(shouldSprint({ ...BASE, food: 6, sprinting: false }), false);
});

test('food inconnu → traité comme rassasié (20)', () => {
  const s = { ...BASE }; delete s.food;
  assert.equal(shouldSprint(s), true);
});

test('état nul/indéfini → false (jamais de crash)', () => {
  assert.equal(shouldSprint(undefined), false);
  assert.equal(shouldSprint(null), false);
  assert.equal(shouldSprint({}), false);
});

// ─── Bornage du pathfinder (OOM live 2026-07-25) ──────────────────────────────
// NethBot2 a mangé 2 Go de heap en 38 s puis FATAL ERROR (heap out of memory), juste après
// `survival:flee`. Cause : mineflayer-pathfinder a `searchRadius = -1` (ILLIMITÉ) par défaut et
// on ne l'avait jamais borné ; `fleeFrom` pose un GoalInvert (heuristique NÉGATIVE) → quand le
// but est insatisfiable (bot acculé), l'A* explore sans fin. Dans astar.js :
//   maxCost = searchRadius < 0 ? -1 : startNode.h + searchRadius
// → c'est un BUDGET DE DÉTOUR relatif à l'estimation directe, pas un rayon absolu : borner ne
// casse donc PAS les longs trajets (mappeurs à 1500 blocs), ça coupe juste l'errance.

test('applyPathfinderBounds : pose un searchRadius fini (jamais -1 = illimité)', () => {
  const pf = { searchRadius: -1 };
  applyPathfinderBounds(pf);
  assert.equal(pf.searchRadius, PATHFINDER_SEARCH_RADIUS);
  assert.ok(pf.searchRadius > 0, 'doit être borné');
});

test('applyPathfinderBounds : budget assez large pour un vrai détour (≥128)', () => {
  assert.ok(PATHFINDER_SEARCH_RADIUS >= 128, 'sinon on casse le contournement de lac/montagne');
});

test('applyPathfinderBounds : best-effort — ne jette pas sur null/undefined', () => {
  assert.doesNotThrow(() => applyPathfinderBounds(null));
  assert.doesNotThrow(() => applyPathfinderBounds(undefined));
});

test('applyPathfinderBounds : retourne true si appliqué, false sinon', () => {
  assert.equal(applyPathfinderBounds({ searchRadius: -1 }), true);
  assert.equal(applyPathfinderBounds(null), false);
});
