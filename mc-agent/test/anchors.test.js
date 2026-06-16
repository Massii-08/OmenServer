'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { recordAnchor, pickDryAnchor } = require('../anchors');

test('recordAnchor: ajoute, arrondit, et garde une liste neuve', () => {
  const a = recordAnchor([], { x: 10.7, y: -58.1, z: -3.4 });
  assert.deepStrictEqual(a, [{ x: 11, y: -58, z: -3 }]);
  const b = recordAnchor(a, { x: 200, y: -58, z: 200 });
  assert.strictEqual(b.length, 2);
  assert.strictEqual(a.length, 1, 'la liste source ne doit pas muter');
});

test('recordAnchor: rejette les positions invalides', () => {
  assert.deepStrictEqual(recordAnchor([], null), []);
  assert.deepStrictEqual(recordAnchor([{ x: 1, y: 2, z: 3 }], { x: NaN, y: 0, z: 0 }), [{ x: 1, y: 2, z: 3 }]);
});

test('recordAnchor: fusionne une ancre quasi-colocalisée (pas 50 ancres au même tunnel)', () => {
  let l = recordAnchor([], { x: 100, y: -58, z: 100 });
  l = recordAnchor(l, { x: 104, y: -57, z: 98 }); // < minSep(16) → remplace, pas un ajout
  assert.strictEqual(l.length, 1);
  assert.deepStrictEqual(l[0], { x: 104, y: -57, z: 98 }, 'la position est rafraîchie');
});

test('recordAnchor: FIFO borné à max (garde les plus récentes)', () => {
  let l = [];
  for (let i = 0; i < 6; i++) l = recordAnchor(l, { x: i * 100, y: -58, z: 0 }, { max: 3 });
  assert.strictEqual(l.length, 3);
  assert.deepStrictEqual(l.map((a) => a.x), [300, 400, 500]);
});

test('pickDryAnchor: choisit la plus LOIN du point de noyade', () => {
  const list = [
    { x: 10, y: -58, z: 0 },   // dist 10
    { x: 300, y: -58, z: 0 },  // dist 300 ← la plus loin
    { x: 100, y: -58, z: 0 },  // dist 100
  ];
  const got = pickDryAnchor(list, { x: 0, y: -58, z: 0 }, 20);
  assert.deepStrictEqual(got, { x: 300, y: -58, z: 0 });
});

test('pickDryAnchor: ignore les ancres trop proches du point de noyade (anti re-noyade)', () => {
  const list = [{ x: 5, y: -58, z: 0 }, { x: 8, y: -58, z: 5 }]; // toutes < minDist(20)
  assert.strictEqual(pickDryAnchor(list, { x: 0, y: -58, z: 0 }, 20), null);
});

test('pickDryAnchor: liste vide / args invalides → null', () => {
  assert.strictEqual(pickDryAnchor([], { x: 0, y: 0, z: 0 }), null);
  assert.strictEqual(pickDryAnchor([{ x: 100, y: 0, z: 0 }], null), null);
});
