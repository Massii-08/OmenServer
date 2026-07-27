'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { assessDrop, safeToDrop } = require('./fallCheck');

// monde vertical simulé : map y → nom de bloc (colonne x=0,z=0)
function columnAt(col) {
  return (q) => {
    const name = col[q.y] || 'air';
    return { name, boundingBox: (name === 'air' || name === 'water' || name === 'lava' || name === 'cave_air') ? 'empty' : 'block' };
  };
}

test('assessDrop : sol dur à 4 d\'air → {depth:4, solid}', () => {
  const at = columnAt({ 5: 'stone' });               // air en 9..6, stone à 5
  const a = assessDrop(null, { x: 0, y: 9, z: 0 }, { blockAt: at });
  assert.deepStrictEqual(a, { depth: 4, surface: 'solid' });
});

test('assessDrop : eau en bas → water ; lave → lava ; rien → void', () => {
  assert.strictEqual(assessDrop(null, { x: 0, y: 9, z: 0 }, { blockAt: columnAt({ 6: 'water' }) }).surface, 'water');
  assert.strictEqual(assessDrop(null, { x: 0, y: 9, z: 0 }, { blockAt: columnAt({ 6: 'lava' }) }).surface, 'lava');
  assert.strictEqual(assessDrop(null, { x: 0, y: 9, z: 0 }, { blockAt: columnAt({}) }).surface, 'void');
});

test('safeToDrop : petite chute (5 blocs, ~3 HP) à pleine vie → OUI (joueur réel)', () => {
  // depth 4 → chute ~5 blocs → dégâts ~2 HP ≤ 10 (moitié de 20)
  assert.strictEqual(safeToDrop({ depth: 4, surface: 'solid' }, 20), true);
});

test('safeToDrop : chute ~13 blocs (~10 HP) à 20 PV → limite OUI ; à 12 PV → NON', () => {
  const a = { depth: 12, surface: 'solid' };          // chute 13 → 10 HP
  assert.strictEqual(safeToDrop(a, 20), true);        // 10 ≤ 10
  assert.strictEqual(safeToDrop(a, 12), false);       // 10 > 6
});

test('safeToDrop : eau = toujours oui, même blessé ; lave/vide/unknown = jamais', () => {
  assert.strictEqual(safeToDrop({ depth: 20, surface: 'water' }, 4), true);
  assert.strictEqual(safeToDrop({ depth: 2, surface: 'lava' }, 20), false);
  assert.strictEqual(safeToDrop({ depth: 24, surface: 'void' }, 20), false);
  assert.strictEqual(safeToDrop({ depth: 3, surface: 'unknown' }, 20), false);
});

test('safeToDrop (Massii) : PV < 75% → refus même pour une petite chute (sauf eau)', () => {
  assert.strictEqual(safeToDrop({ depth: 4, surface: 'solid' }, 14), false); // 14 < 15
  assert.strictEqual(safeToDrop({ depth: 4, surface: 'solid' }, 15), true);
  assert.strictEqual(safeToDrop({ depth: 10, surface: 'water' }, 6), true);  // eau = toujours ok
});

// ─── Une chute de 2 blocs ne fait AUCUN degat (Massii, live 27/07) ──────────────────────────────
// « Les bots doivent apprendre que s ils tombent de 2 blocs de hauteur c est pas grave, parce que
// des fois ils n avancent pas parce que c est 2 blocs de hauteur. » Le refus venait du garde
// `hp < 15` qui bloquait TOUTE chute volontaire — y compris celles a zero degat. En Minecraft les
// degats de chute commencent au-dela de 3 blocs : sauter 2 blocs est gratuit, meme a 1 PV.
test('safeToDrop : une chute SANS degat est toujours acceptee, meme blesse', () => {
  assert.strictEqual(safeToDrop({ depth: 1, surface: 'solid' }, 3), true);
  assert.strictEqual(safeToDrop({ depth: 2, surface: 'solid' }, 3), true);
  assert.strictEqual(safeToDrop({ depth: 2, surface: 'solid' }, 20), true);
});

test('safeToDrop : des qu il y a du degat, le garde PV reprend', () => {
  assert.strictEqual(safeToDrop({ depth: 3, surface: 'solid' }, 14), false);  // 1 degat, blesse
  assert.strictEqual(safeToDrop({ depth: 3, surface: 'solid' }, 20), true);
});

test('safeToDrop : lave/vide restent refuses meme a faible profondeur', () => {
  assert.strictEqual(safeToDrop({ depth: 1, surface: 'lava' }, 20), false);
  assert.strictEqual(safeToDrop({ depth: 2, surface: 'void' }, 20), false);
});
