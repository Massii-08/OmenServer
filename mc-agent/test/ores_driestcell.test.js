'use strict';
// driestCell : verrou de régression sur le RAYON (run water-wall cycle 2). Le dry_steer appelait
// driestCell avec range 600 → cellule sèche élue à 350 blocs → marche infaisable (3× dry_steer_failed
// short, morts en route, death_loop — vécu live NethBot2). Le rayon borne les ORES comptés autour de
// base : une cellule au-delà ne doit JAMAIS être élue, même parfaitement sèche.
const { test } = require('node:test');
const assert = require('node:assert');
const { driestCell } = require('../ores');

// 20 ores de fer par cellule : près (cx=0 → centre ~48) un peu humide, loin (x≈640) parfaitement sec.
function mkOres() {
  const ores = [];
  for (let i = 0; i < 20; i++) {
    ores.push({ material: 'iron_ore', x: 10 + i, z: 10, wet: i < 4 });          // près : 20% wet
    ores.push({ material: 'iron_ore', x: 640 + i, z: 10, wet: false });          // loin : 0% wet
  }
  return ores;
}

test('driestCell: la cellule sèche HORS rayon est exclue → élit la cellule proche', () => {
  const c = driestCell(mkOres(), { base: { x: 0, z: 0 }, range: 224, cellSize: 128, minOres: 12, material: 'iron' });
  assert.ok(c, 'une cellule doit être élue');
  assert.ok(c.x < 224, `cellule élue trop loin (x=${c.x})`);
  assert.ok(Math.abs(c.wetFraction - 0.2) < 1e-9);
});

test('driestCell: avec un grand rayon, la cellule lointaine plus sèche gagne (comportement de base)', () => {
  const c = driestCell(mkOres(), { base: { x: 0, z: 0 }, range: 800, cellSize: 128, minOres: 12, material: 'iron' });
  assert.ok(c.x > 500, `attendu la cellule lointaine sèche (x=${c.x})`);
  assert.strictEqual(c.wetFraction, 0);
});
