'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const H = require('./heapGuard');

test('shouldEmitHeapHigh : sous le seuil → jamais', () => {
  assert.strictEqual(H.shouldEmitHeapHigh(399, null, 1000), false);
  assert.strictEqual(H.shouldEmitHeapHigh(400, null, 1000), false);
});

test('shouldEmitHeapHigh : au-dessus → 1re fois oui, puis throttle 5 s', () => {
  assert.strictEqual(H.shouldEmitHeapHigh(450, null, 1000), true);
  assert.strictEqual(H.shouldEmitHeapHigh(450, 1000, 5999), false);
  assert.strictEqual(H.shouldEmitHeapHigh(450, 1000, 6000), true);
});

test('shouldEmitHeapHigh : entrées invalides → false', () => {
  assert.strictEqual(H.shouldEmitHeapHigh(NaN, null, 1000), false);
  assert.strictEqual(H.shouldEmitHeapHigh(500, null, undefined), false);
});

test('goalLabel : GoalNear avec rayon, null sans but, robuste aux objets bizarres', () => {
  class GoalNear { constructor() { this.x = 1; this.y = 15; this.z = -3; this.rangeSq = 9; } }
  assert.strictEqual(H.goalLabel(new GoalNear()), 'GoalNear(1,15,-3 r3)');
  assert.strictEqual(H.goalLabel(null), null);
  class GoalInvert { }
  assert.strictEqual(H.goalLabel(new GoalInvert()), 'GoalInvert');
});

test('bmMark copie les coordonnées (position mutée en place ensuite) et refuse le non-fini', () => {
  const pos = { x: -7.51, y: 15, z: -55.49 };
  const m = H.bmMark(pos, 1000, 'approach');
  pos.x = 99;
  assert.deepStrictEqual(m, { x: -7.5, y: 15, z: -55.5, at: 1000, phase: 'approach' });
  assert.strictEqual(H.bmMark({ x: NaN, y: 1, z: 2 }, 1000), null);
  assert.strictEqual(H.bmMark(null, 1000), null);
});

test('shouldPersistMark : 1re écriture, puis au plus 1 / 3 s', () => {
  assert.strictEqual(H.shouldPersistMark(null, 1000), true);
  assert.strictEqual(H.shouldPersistMark(1000, 3999), false);
  assert.strictEqual(H.shouldPersistMark(1000, 4000), true);
});

test('isCrashSpot : marque récente à ≤ 4 blocs → vrai (cas réel NethBot3 306→307)', () => {
  const saved = { x: -8, y: 15, z: -57, at: 1792691351000 };
  assert.strictEqual(H.isCrashSpot(saved, { x: -7.5, y: 15, z: -55.5 }, 1792691391209), true);
});

test('isCrashSpot : trop loin, trop vieille, venue du futur, invalide → faux', () => {
  const saved = { x: 0, y: 15, z: 0, at: 100000 };
  assert.strictEqual(H.isCrashSpot(saved, { x: 5, y: 15, z: 0 }, 100001), false);          // 5 > 4
  assert.strictEqual(H.isCrashSpot(saved, { x: 0, y: 15, z: 4 }, 100001), true);           // pile 4
  assert.strictEqual(H.isCrashSpot(saved, { x: 0, y: 15, z: 0 }, 100000 + 180001), false); // > 3 min
  assert.strictEqual(H.isCrashSpot(saved, { x: 0, y: 15, z: 0 }, 99999), false);           // futur
  assert.strictEqual(H.isCrashSpot(null, { x: 0, y: 15, z: 0 }, 100001), false);
  assert.strictEqual(H.isCrashSpot({ x: 0, y: 15, z: 0 }, { x: 0, y: 15, z: 0 }, 100001), false); // sans at
});

test('isCrashSpot : la couche compte (4 blocs en 3D)', () => {
  const saved = { x: 0, y: 15, z: 0, at: 1000 };
  assert.strictEqual(H.isCrashSpot(saved, { x: 0, y: 10, z: 0 }, 1001), false);
});

test('crashShiftTarget : 8..12 blocs, perpendiculaire au cap, même couche, nouveau cap = perpendiculaire', () => {
  const lo = H.crashShiftTarget({ x: 10.4, y: 15.2, z: -3.7 }, { dx: 1, dz: 0 }, () => 0);
  assert.deepStrictEqual(lo, { x: 10, y: 15, z: 4, dist: 8, heading: { dx: 0, dz: 1 } });
  const hi = H.crashShiftTarget({ x: 10.4, y: 15.2, z: -3.7 }, { dx: 1, dz: 0 }, () => 0.9999);
  assert.deepStrictEqual(hi, { x: 10, y: 15, z: -16, dist: 12, heading: { dx: 0, dz: -1 } });
});

test('crashShiftTarget : cap absent ou diagonal → cardinal, jamais de diagonale', () => {
  const a = H.crashShiftTarget({ x: 0, y: 0, z: 0 }, null, () => 0.2);
  assert.strictEqual(Math.abs(a.heading.dx) + Math.abs(a.heading.dz), 1);
  const b = H.crashShiftTarget({ x: 0, y: 0, z: 0 }, { dx: 1, dz: 1 }, () => 0.2);
  assert.strictEqual(Math.abs(b.heading.dx) + Math.abs(b.heading.dz), 1);
  for (let i = 0; i < 50; i++) {
    const r = H.crashShiftTarget({ x: 0, y: 0, z: 0 }, { dx: 0, dz: -1 }, Math.random);
    assert.ok(r.dist >= 8 && r.dist <= 12);
    assert.strictEqual(r.heading.dz, 0);
  }
  assert.strictEqual(H.crashShiftTarget(null, null), null);
});
