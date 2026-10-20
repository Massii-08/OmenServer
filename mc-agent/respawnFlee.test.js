'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('./respawnFlee');

const self = { x: 0, y: 70, z: 0 };

test('rien à ≤ 8 blocs → null (on peut creuser)', () => {
  assert.strictEqual(R.respawnFleePlan({ self, threats: [] }), null);
  assert.strictEqual(R.respawnFleePlan({ self, threats: [{ x: 9, y: 70, z: 0 }] }), null);
});

test('zombie à 2 blocs à l est → destination à l ouest, ≥ 24 blocs de la menace', () => {
  const p = R.respawnFleePlan({ self, threats: [{ x: 2, y: 70, z: 0 }] });
  assert.ok(p);
  assert.ok(p.dest.x < 0, JSON.stringify(p));
  assert.ok(Math.hypot(p.dest.x - 2, p.dest.z) >= 24 - 0.5);
  assert.strictEqual(p.dist, 2);
  assert.strictEqual(p.hostiles, 1);
});

test('plusieurs menaces : à l opposé du BARYCENTRE (menaces au nord-est → fuite au sud-ouest)', () => {
  const p = R.respawnFleePlan({ self, threats: [{ x: 3, y: 70, z: -3 }, { x: 5, y: 70, z: -1 }, { x: 14, y: 70, z: -14 }] });
  assert.ok(p.dest.x < 0 && p.dest.z > 0, JSON.stringify(p));
  assert.strictEqual(p.hostiles, 2, 'la menace à ~20 blocs ne compte pas (scan 16)');
});

test('encerclé (barycentre sur le bot) : à l opposé du plus proche, jamais NaN', () => {
  const p = R.respawnFleePlan({ self, threats: [{ x: 2, y: 70, z: 0 }, { x: -3, y: 70, z: 0 }] });
  // barycentre = (-0.5, 0) → len 0.5 → fallback non déclenché (≥ 0.5) : fuite vers +x
  assert.ok(Number.isFinite(p.dest.x) && Number.isFinite(p.dest.z));
  const q = R.respawnFleePlan({ self, threats: [{ x: 2, y: 70, z: 0 }, { x: -2, y: 70, z: 0 }] });
  assert.ok(Number.isFinite(q.dest.x) && Number.isFinite(q.dest.z));
  assert.ok(Math.hypot(q.dest.x, q.dest.z) >= 23);
});

test('entrées invalides → null, pas de throw', () => {
  assert.strictEqual(R.respawnFleePlan(null), null);
  assert.strictEqual(R.respawnFleePlan({ threats: [{ x: 1, z: 1 }] }), null);
  assert.strictEqual(R.respawnFleePlan({ self, threats: [null, { x: NaN, z: 1 }] }), null);
});

test('fleeStuck : < 1 bloc en 1,5 s = coincé', () => {
  assert.strictEqual(R.fleeStuck({ x: 0, z: 0, t: 0 }, { x: 0.5, z: 0 }, 1000), false, 'trop tôt');
  assert.strictEqual(R.fleeStuck({ x: 0, z: 0, t: 0 }, { x: 0.5, z: 0 }, 1500), true);
  assert.strictEqual(R.fleeStuck({ x: 0, z: 0, t: 0 }, { x: 3, z: 0 }, 1500), false);
  assert.strictEqual(R.fleeStuck(null, { x: 0, z: 0 }, 9999), false);
});
