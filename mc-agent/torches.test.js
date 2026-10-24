'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { shouldPlaceTorch, TORCH_INTERVAL_MS, TORCH_MIN_MOVE } = require('./torches');

// Calé sur la capture réelle (Massitom2008 × alexdon1837, 33 min) : 131 et 97 torches posées,
// torche en main ~10 % du temps. Les humains éclairent tout ce qu'ils traversent ; le bot ne
// posait de torche que dans le tunnel de branch-mine, et vivait le reste du temps dans le noir —
// or block-light 0 est la condition EXACTE d'apparition des mobs.

const NOW = 1_000_000;
const BASE = {
  y: 16, lightLevel: 0, torches: 8, now: NOW,
  lastAt: NOW - TORCH_INTERVAL_MS - 1,
  pos: { x: 100, z: 0 }, lastPos: { x: 0, z: 0 },
};

test('sous terre, dans le noir, torche en poche, on a avancé → on pose', () => {
  assert.strictEqual(shouldPlaceTorch(BASE), true);
});

test('aucune torche en poche → non (rien à poser)', () => {
  assert.strictEqual(shouldPlaceTorch({ ...BASE, torches: 0 }), false);
});

test('en SURFACE → non : la lumière du ciel fait le travail', () => {
  assert.strictEqual(shouldPlaceTorch({ ...BASE, y: 70 }), false);
});

test('zone DÉJÀ éclairée → non, on ne gaspille pas', () => {
  assert.strictEqual(shouldPlaceTorch({ ...BASE, lightLevel: 12 }), false);
  // Rationnement 24/10 : seul le NOIR (≤ 3) appelle une torche ; 4-7 = pénombre déjà éclairée au loin.
  assert.strictEqual(shouldPlaceTorch({ ...BASE, lightLevel: 7 }), false, '7 = déjà éclairé');
  assert.strictEqual(shouldPlaceTorch({ ...BASE, lightLevel: 3 }), true, '3 = noir');
});

test('lumière inconnue (null) → on pose quand même : sous terre, le noir est la règle', () => {
  assert.strictEqual(shouldPlaceTorch({ ...BASE, lightLevel: null }), true);
});

test('trop tôt depuis la dernière → non (cadence ~3-5/min comme les humains)', () => {
  assert.strictEqual(shouldPlaceTorch({ ...BASE, lastAt: NOW - 1000 }), false);
});

test('pas assez avancé → non (anti-empilement au même endroit)', () => {
  assert.strictEqual(
    shouldPlaceTorch({ ...BASE, pos: { x: TORCH_MIN_MOVE - 1, z: 0 }, lastPos: { x: 0, z: 0 } }),
    false);
});

test('première torche de la session (aucun historique) → on pose', () => {
  assert.strictEqual(shouldPlaceTorch({ ...BASE, lastAt: undefined, lastPos: null }), true);
});

test('seuils surchargeables + entrées vides → jamais de crash', () => {
  assert.strictEqual(shouldPlaceTorch({ ...BASE, y: 70, opts: { surfaceY: 100 } }), true);
  assert.strictEqual(shouldPlaceTorch({}), false);
  assert.strictEqual(shouldPlaceTorch(), false);
});

// ── Rationnement « joueur » (Massii 24/10 : « il y a besoin de moins de torches ») ────────────────
const { galleryTorchWanted, createTorchRegistry, nearestTorchDist, TORCH_SPACING, STAIR_DARK_MS } = require('./torches');

test('une torche à ≤ 11 blocs (3D) → non : l\'endroit est déjà éclairé', () => {
  assert.strictEqual(shouldPlaceTorch({ ...BASE, nearestTorch: 4 }), false);
  assert.strictEqual(shouldPlaceTorch({ ...BASE, nearestTorch: TORCH_SPACING }), false);
  assert.strictEqual(shouldPlaceTorch({ ...BASE, nearestTorch: TORCH_SPACING + 0.5 }), true);
  assert.strictEqual(shouldPlaceTorch({ ...BASE, nearestTorch: null }), true, 'aucune torche connue');
});

test('descente en ESCALIER : pas de torche, sauf noir total qui dure ≥ 45 s', () => {
  assert.strictEqual(shouldPlaceTorch({ ...BASE, stair: true }), false);
  assert.strictEqual(shouldPlaceTorch({ ...BASE, stair: true, darkForMs: 10000 }), false);
  assert.strictEqual(shouldPlaceTorch({ ...BASE, stair: true, darkForMs: STAIR_DARK_MS }), true);
});

test('galerie : torche si noir ET pas de torche voisine — une tous les ~12 blocs le long d\'un couloir', () => {
  const reg = createTorchRegistry();
  let placed = 0;
  for (let x = 0; x <= 48; x++) {
    const pos = { x, y: -55, z: 0 };
    if (galleryTorchWanted({ lightLevel: 0, nearestTorch: reg.nearest(pos) })) { reg.note(pos); placed++; }
  }
  assert.strictEqual(placed, 5, '0, 12, 24, 36, 48');
  // Galerie PARALLÈLE à 3 blocs (lacets) : les torches de la 1re suffisent presque partout.
  let placed2 = 0;
  for (let x = 0; x <= 48; x++) {
    const pos = { x, y: -55, z: 3 };
    if (galleryTorchWanted({ lightLevel: 0, nearestTorch: reg.nearest(pos) })) { reg.note(pos); placed2++; }
  }
  assert.strictEqual(placed2, 0);
  assert.strictEqual(galleryTorchWanted({ lightLevel: 5, nearestTorch: null }), false, 'lumière connue > 3');
});

test('nearestTorchDist : registre + scan des blocs (findBlocks autour du point), jamais de throw', () => {
  const reg = createTorchRegistry();
  reg.note({ x: 20, y: 0, z: 0 });
  const bot = {
    registry: { blocksByName: { torch: { id: 1 }, wall_torch: { id: 2 } } },
    findBlocks: (o) => { assert.ok(o.point && o.maxDistance === TORCH_SPACING + 1); return [{ x: 3, y: 0, z: 4 }]; },
  };
  assert.strictEqual(nearestTorchDist(bot, { x: 0, y: 0, z: 0 }, { registry: reg }), 5);
  assert.strictEqual(nearestTorchDist(null, { x: 0, y: 0, z: 0 }, { registry: reg }), 20);
  assert.strictEqual(nearestTorchDist({ findBlocks: () => { throw new Error('x'); }, registry: bot.registry }, { x: 0, y: 0, z: 0 }, { registry: reg }), 20);
  assert.strictEqual(nearestTorchDist(bot, null), null);
});
