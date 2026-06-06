'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { cellKey, coveredCells, nextFrontierCell } = require('./frontier');

function memWithBiomes(cells) {
  return { worlds: { overworld: { biomes: cells.map(([x, z]) => ({ name: 'plains', x, z })) } } };
}

test('coveredCells : union biomes (déjà quantifiés) + localSeen', () => {
  const m = memWithBiomes([[0, 0], [128, 0]]);
  const seen = new Set(['256,0']);
  const c = coveredCells(m, 'overworld', seen);
  assert.ok(c.has('0,0') && c.has('128,0') && c.has('256,0'));
  assert.strictEqual(c.size, 3);
});

test('nextFrontierCell : cellule du bot non couverte → ring 0 (scanner ICI d\'abord)', () => {
  const m = memWithBiomes([]);
  const r = nextFrontierCell(m, 'overworld', new Set(), { x: 70, z: 70 });
  assert.strictEqual(r.ring, 0);
  assert.strictEqual(r.key, '0,0');
  assert.deepStrictEqual(r.center, { x: 64, z: 64 });
});

test('nextFrontierCell : remplit le TROU le plus proche, pas une ligne lointaine', () => {
  // bot en (64,64) ; tout couvert sauf la cellule (128,0) (trou adjacent) et (1280,0) (loin)
  const covered = [];
  for (let x = -256; x <= 512; x += 128) for (let z = -256; z <= 512; z += 128) {
    if (!(x === 128 && z === 0)) covered.push([x, z]);
  }
  const m = memWithBiomes(covered);
  const r = nextFrontierCell(m, 'overworld', new Set(), { x: 64, z: 64 });
  assert.strictEqual(r.key, '128,0');
  assert.strictEqual(r.ring, 1);
});

test('nextFrontierCell : skip (cellules en échec/eau) exclues', () => {
  const m = memWithBiomes([[0, 0]]);
  const skip = new Set(['128,0', '-128,0', '0,128', '0,-128', '128,128', '-128,-128', '128,-128', '-128,128']);
  const r = nextFrontierCell(m, 'overworld', new Set(), { x: 64, z: 64 }, { skip });
  assert.ok(r.ring >= 2, `ring ${r.ring} devrait sauter l'anneau 1 entièrement skippé`);
});

test('nextFrontierCell : tout couvert dans maxRing → null (fallback marche aléatoire)', () => {
  const covered = [];
  for (let x = -512; x <= 512; x += 128) for (let z = -512; z <= 512; z += 128) covered.push([x, z]);
  const m = memWithBiomes(covered);
  const r = nextFrontierCell(m, 'overworld', new Set(), { x: 0, z: 0 }, { maxRing: 3 });
  assert.strictEqual(r, null);
});

test('nextFrontierCell : à anneau égal, la cellule la PLUS PROCHE du bot gagne', () => {
  const m = memWithBiomes([[0, 0]]);
  // bot à l'EST de sa cellule → la cellule est (128,0) plus proche que (-128,0)
  const r = nextFrontierCell(m, 'overworld', new Set(), { x: 120, z: 64 });
  assert.strictEqual(r.key, '128,0');
});

test('cellKey : floor division (négatifs corrects)', () => {
  assert.strictEqual(cellKey(-1, -1), '-128,-128');
  assert.strictEqual(cellKey(127, 127), '0,0');
});
