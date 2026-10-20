'use strict';
const test = require('node:test');
const assert = require('node:assert');
const D = require('./dropAhead');

const T = 1_800_000_000_000;

test('noteDropAhead : 1er échec → rien ; 2e au même endroit → turn ; 4e → shift', () => {
  let s = [];
  let r = D.noteDropAhead(s, { x: 10, z: 10 }, T); assert.deepStrictEqual([r.count, r.action], [1, 'none']); s = r.sites;
  r = D.noteDropAhead(s, { x: 12, z: 9 }, T + 10); assert.deepStrictEqual([r.count, r.action], [2, 'turn']); s = r.sites;
  r = D.noteDropAhead(s, { x: 11, z: 11 }, T + 20); assert.deepStrictEqual([r.count, r.action], [3, 'turn']); s = r.sites;
  r = D.noteDropAhead(s, { x: 10, z: 12 }, T + 30); assert.deepStrictEqual([r.count, r.action], [4, 'shift']);
});

test('noteDropAhead : ailleurs (> 8 blocs) ou trop ancien (> 10 min) → compte repart à 1', () => {
  const s = [{ x: 10, z: 10, t: T }];
  assert.strictEqual(D.noteDropAhead(s, { x: 30, z: 10 }, T + 1000).action, 'none');
  const old = D.noteDropAhead(s, { x: 10, z: 10 }, T + D.WINDOW_MS + 1);
  assert.deepStrictEqual([old.count, old.action, old.sites.length], [1, 'none', 1]);
});

test('noteDropAhead : n\'altère pas le tableau reçu ; position invalide → none', () => {
  const s = [{ x: 0, z: 0, t: T }];
  D.noteDropAhead(s, { x: 0, z: 0 }, T + 1);
  assert.strictEqual(s.length, 1);
  assert.strictEqual(D.noteDropAhead(s, null, T + 1).action, 'none');
});

test('turnYaw : +90° normalisé ; 4 tours → retour au cap de départ', () => {
  let y = 0.3;
  for (let i = 0; i < 4; i++) y = D.turnYaw(y);
  assert.ok(Math.abs(y - 0.3) < 1e-9);
  assert.ok(Math.abs(D.turnYaw(Math.PI) - (-Math.PI / 2)) < 1e-9);
});

test('shiftTarget : 30-50 blocs, cap différent à chaque graine, yaw tourné vers la cible', () => {
  const p = { x: 100, z: -50 };
  const a = D.shiftTarget(p, 1), b = D.shiftTarget(p, 2);
  for (const t of [a, b]) {
    const d = Math.hypot(t.x - p.x, t.z - p.z);
    assert.ok(d >= D.SHIFT_MIN - 1 && d <= D.SHIFT_MAX + 1, `dist ${d}`);
    const dx = t.x - p.x, dz = t.z - p.z;
    assert.ok(Math.abs(Math.atan2(-dx, -dz) - t.yaw) < 0.05);
  }
  assert.notDeepStrictEqual([a.x, a.z], [b.x, b.z]);
});
