'use strict';
const assert = require('assert');
const { pickWornOutToReport } = require('./wornOut');

// 1) Première usure d'une pièce → signalée une fois.
{
  const r = pickWornOutToReport(['iron_helmet'], new Set());
  assert.deepStrictEqual(r.toEmit, ['iron_helmet']);
  assert.ok(r.reported.has('iron_helmet'));
}

// 2) Même pièce encore usée à l'appel suivant → PLUS de ré-émission (dédup ; c'est le bug
//    NethBot1 : _wornArmor() appelé ~18×/tick réémettait la même pièce, 32 % des events).
{
  const r1 = pickWornOutToReport(['iron_helmet'], new Set());
  const r2 = pickWornOutToReport(['iron_helmet'], r1.reported);
  assert.deepStrictEqual(r2.toEmit, []);
  assert.ok(r2.reported.has('iron_helmet'));
}

// 3) Pièce remplacée (plus dans la liste usée) → sort du registre ; une future usure ré-émet.
{
  const r1 = pickWornOutToReport(['iron_helmet'], new Set());
  const r2 = pickWornOutToReport([], r1.reported);          // remplacée par une pièce neuve
  assert.deepStrictEqual(r2.toEmit, []);
  assert.ok(!r2.reported.has('iron_helmet'));
  const r3 = pickWornOutToReport(['iron_helmet'], r2.reported); // la neuve s'use à son tour
  assert.deepStrictEqual(r3.toEmit, ['iron_helmet']);
}

// 4) Une NOUVELLE pièce s'use pendant qu'une autre est déjà signalée → seule la nouvelle émet.
{
  const r1 = pickWornOutToReport(['iron_helmet'], new Set());
  const r2 = pickWornOutToReport(['iron_helmet', 'iron_boots'], r1.reported);
  assert.deepStrictEqual(r2.toEmit, ['iron_boots']);
  assert.ok(r2.reported.has('iron_helmet') && r2.reported.has('iron_boots'));
}

// 5) Rien d'usé → rien à émettre, registre vide.
{
  const r = pickWornOutToReport([], new Set());
  assert.deepStrictEqual(r.toEmit, []);
  assert.strictEqual(r.reported.size, 0);
}

console.log('wornOut.test.js OK');
