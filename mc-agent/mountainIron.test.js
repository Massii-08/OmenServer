'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('./mountainIron');

const iron = (x, y, z, material = 'iron_ore') => ({ material, x, y, z });

test('mountainOres : seul le fer STRICTEMENT au-dessus de 64 (anti-xray max-block-height 64)', () => {
  const out = M.mountainOres([iron(0, 64, 0), iron(1, 65, 0), iron(2, 90, 0), { material: 'coal_ore', x: 3, y: 90, z: 0 }]);
  assert.deepStrictEqual(out.map((o) => o.y), [65, 90]);
});

test('mountainOres : dédoublonne et écarte le fer mouillé', () => {
  const out = M.mountainOres([iron(1, 70, 1), iron(1.4, 70.2, 1.7), iron(5, 70, 5)], (p) => p.x === 5);
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual([out[0].x, out[0].y, out[0].z], [1, 70, 1]);
});

test('mountainClusters : minerais à ≤ 2 blocs = une grappe, chaînage transitif', () => {
  const cl = M.mountainClusters([iron(0, 70, 0), iron(2, 70, 0), iron(4, 71, 0), iron(20, 70, 0)]);
  assert.deepStrictEqual(cl.map((c) => c.length).sort(), [1, 3]);
});

test('mountainKey : indépendante de l ordre', () => {
  const a = [iron(3, 72, 3), iron(2, 70, 2)];
  assert.strictEqual(M.mountainKey(a), M.mountainKey(a.slice().reverse()));
  assert.strictEqual(M.mountainKey(a), 'mtn:2,70,2');
});

test('pickMountainIron : la grappe la plus rentable, cible = minerai le plus proche', () => {
  const from = { x: 0, y: 70, z: 0 };
  const ores = [iron(10, 70, 0), iron(30, 72, 0), iron(31, 72, 0), iron(32, 72, 0), iron(33, 73, 0)];
  const c = M.pickMountainIron(ores, from, { now: 1000 });
  // grappe isolée à 10 (coût 10) vs grappe de 4 à 30 (30 + 1 − 9 = 22) → la proche
  assert.strictEqual(c.x, 10);
  assert.strictEqual(c.count, 1);
  const far = M.pickMountainIron([iron(30, 70, 0), iron(31, 70, 0), iron(32, 70, 0), iron(33, 70, 0), iron(25, 70, 20)], from, { now: 1 });
  assert.strictEqual(far.count, 4);                 // 30 − 9 = 21 < 32
  assert.strictEqual(far.x, 30);
  assert.strictEqual(far.ores[0].x, 30);
  assert.ok(!('dist' in far.ores[0]));
});

test('pickMountainIron : distance max, grappe ratée < 30 min et claimée écartées', () => {
  const from = { x: 0, y: 70, z: 0 };
  assert.strictEqual(M.pickMountainIron([iron(80, 70, 0)], from, { now: 1 }), null);
  const ores = [iron(10, 70, 0), iron(20, 70, 0)];
  const k10 = 'mtn:10,70,0';
  const fails = M.mountainFailAdd([], k10, 'unreachable', 1000);
  assert.strictEqual(M.pickMountainIron(ores, from, { now: 2000, fails }).x, 20);
  assert.strictEqual(M.pickMountainIron(ores, from, { now: 1000 + M.MOUNTAIN_FAIL_TTL_MS + 1, fails }).x, 10);
  assert.strictEqual(M.pickMountainIron(ores, from, { now: 2000, isClaimed: (k) => k === k10 }).x, 20);
  assert.strictEqual(M.pickMountainIron([], from, { now: 1 }), null);
  assert.strictEqual(M.pickMountainIron(ores, null, { now: 1 }), null);
});

test('mountainFailsPrune : TTL, horloge du futur, entrées invalides', () => {
  const f = [{ key: 'a', at: 100 }, { key: 'b', at: 5000 }, { key: 'c' }, null];
  assert.deepStrictEqual(M.mountainFailsPrune(f, 1000).map((x) => x.key), ['a']);
  assert.deepStrictEqual(M.mountainFailsPrune('x', 1000), []);
});

test('mountainGate : pioche pierre+, PV, surface, eau, nuit du bot peu armé', () => {
  const base = { objectiveOk: true, pickTier: 2, hp: 20, y: 80, night: false, worn: 0 };
  assert.strictEqual(M.mountainGate(base).ok, true);
  assert.strictEqual(M.mountainGate(Object.assign({}, base, { objectiveOk: false })).why, 'objective');
  assert.strictEqual(M.mountainGate(Object.assign({}, base, { pickTier: 1 })).why, 'no_pick');
  assert.strictEqual(M.mountainGate(Object.assign({}, base, { hp: 6 })).why, 'low_hp');
  assert.strictEqual(M.mountainGate(Object.assign({}, base, { y: 30 })).why, 'underground');
  assert.strictEqual(M.mountainGate(Object.assign({}, base, { inWater: true })).why, 'water');
  assert.strictEqual(M.mountainGate(Object.assign({}, base, { night: true })).why, 'night');
  assert.strictEqual(M.mountainGate(Object.assign({}, base, { night: true, worn: 2 })).ok, true);
});
