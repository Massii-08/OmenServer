'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { note, isBanned } = require('./deathzones');

// Ban-zone des CAMPS DE MORT (piste n°2 rapport water-wall) : Bot2/3 épinglés au même spot
// (mobs armés accumulés en hard, imminent_bookmark_death ×25 à (-563,73,-489)). Après 2 alertes
// espacées dans la même zone 64 → bannie (TTL) → fuite active au lieu de rester.

test('note : 1re alerte → zone créée, pas bannie', () => {
  const r = note([], -563, -489, 1000000);
  assert.strictEqual(r.newlyBanned, false);
  assert.strictEqual(r.zones.length, 1);
  assert.strictEqual(isBanned(r.zones, -563, -489, 1000000), false);
});

test('note : 2e alerte ESPACÉE (≥20 s) dans le rayon 64 → zone bannie', () => {
  let r = note([], -563, -489, 1000000);
  r = note(r.zones, -560, -480, 1000000 + 25000);   // même camp, 25 s après
  assert.strictEqual(r.newlyBanned, true);
  assert.strictEqual(isBanned(r.zones, -563, -489, 1000000 + 26000), true);
  assert.strictEqual(isBanned(r.zones, -563, -489, 1000000 + 26000, { radius: 64 }), true);
});

test('note : rafale (<20 s d\'écart) ne compte qu\'une alerte (anti-spam du watchdog 1 s)', () => {
  let r = note([], 0, 0, 1000000);
  r = note(r.zones, 1, 1, 1000000 + 3000);          // 3 s après = même rafale
  assert.strictEqual(r.newlyBanned, false);
  r = note(r.zones, 0, 0, 1000000 + 8000);
  assert.strictEqual(r.newlyBanned, false);
});

test('note : alertes dans DEUX zones éloignées → zones séparées, aucune bannie', () => {
  let r = note([], 0, 0, 1000000);
  r = note(r.zones, 500, 500, 1000000 + 30000);
  assert.strictEqual(r.zones.length, 2);
  assert.strictEqual(r.newlyBanned, false);
});

test('isBanned : hors rayon → false ; TTL expiré → false (le camp se dissipe au jour)', () => {
  let r = note([], 0, 0, 1000000);
  r = note(r.zones, 0, 0, 1000000 + 30000);
  assert.strictEqual(r.newlyBanned, true);
  assert.strictEqual(isBanned(r.zones, 200, 0, 1000000 + 40000), false);              // loin
  assert.strictEqual(isBanned(r.zones, 0, 0, 1000000 + 30000 + 900001), false);       // TTL 15 min passé
});

test('note : une zone déjà bannie re-signalée → newlyBanned false (fuite déjà déclenchée)', () => {
  let r = note([], 0, 0, 1000000);
  r = note(r.zones, 0, 0, 1000000 + 30000);
  assert.strictEqual(r.newlyBanned, true);
  r = note(r.zones, 2, 2, 1000000 + 60000);
  assert.strictEqual(r.newlyBanned, false);
});
