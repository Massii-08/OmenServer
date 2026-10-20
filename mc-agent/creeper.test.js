'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('./creeper');

const creeper = (dx, meta, extra = {}) =>
  Object.assign({ name: 'creeper', position: { x: dx, y: 70, z: 0 }, metadata: meta }, extra);
const at0 = { x: 0, y: 70, z: 0 };
const swelling = () => { const m = []; m[C.SWELL_DIR_INDEX] = 1; return m; };
const idle = () => { const m = []; m[C.SWELL_DIR_INDEX] = -1; return m; };

test('index de la mèche = swell_dir dans minecraft-data (1.20.1 → 1.21.11), ignited = is_ignited', () => {
  for (const v of ['1.20.1', '1.21.1', '1.21.4', '1.21.11']) {
    const keys = require('minecraft-data')(v).entitiesByName.creeper.metadataKeys;
    assert.strictEqual(keys.indexOf('swell_dir'), C.SWELL_DIR_INDEX, v);
    assert.strictEqual(keys.indexOf('is_ignited'), C.IGNITED_INDEX, v);
  }
});

test('isCreeperFusing : swell_dir 1 → oui ; -1 / absent / metadata nulle → non', () => {
  assert.strictEqual(C.isCreeperFusing(creeper(3, swelling())), true);
  assert.strictEqual(C.isCreeperFusing(creeper(3, idle())), false);
  assert.strictEqual(C.isCreeperFusing(creeper(3, [])), false);
  assert.strictEqual(C.isCreeperFusing(creeper(3, undefined)), false);
  assert.strictEqual(C.isCreeperFusing(null), false);
  assert.strictEqual(C.isCreeperFusing({ name: 'zombie', metadata: swelling() }), false, 'seulement un creeper');
});

test('isCreeperFusing : allumé au briquet (is_ignited) → oui ; index lus depuis metadataKeys si fournis', () => {
  const m = []; m[C.IGNITED_INDEX] = true;
  assert.strictEqual(C.isCreeperFusing(creeper(3, m)), true);
  const keys = []; keys[3] = 'swell_dir';
  const m2 = []; m2[3] = 1;
  assert.strictEqual(C.isCreeperFusing(creeper(3, m2), keys), true, 'index pris dans les clés du registre');
});

test('creeperPlan : gonfle ≤ 7 → flee ; gonfle > 7 → ignore ; calme ≤ 4,5 → flee (plus de petit pas) ; calme > 4,5 → ignore', () => {
  assert.strictEqual(C.creeperPlan(creeper(6.9, swelling()), at0), 'flee');
  assert.strictEqual(C.creeperPlan(creeper(8, swelling()), at0), 'ignore');
  assert.strictEqual(C.creeperPlan(creeper(4, idle()), at0), 'flee', 'les 11 morts : step_away à 2,6-4 blocs');
  assert.strictEqual(C.creeperPlan(creeper(2.6, idle()), at0), 'flee');
  assert.strictEqual(C.creeperPlan(creeper(4.5), at0), 'flee', 'metadata absente = calme, mais trop près');
  assert.strictEqual(C.creeperPlan(creeper(4.6), at0), 'ignore');
  assert.strictEqual(C.creeperPlan(creeper(9, idle()), at0), 'ignore');
  assert.strictEqual(C.creeperPlan({ name: 'zombie', position: at0 }, at0), null, 'pas un creeper');
});

test('creeperPlan : position du bot inconnue → prudent (flee)', () => {
  assert.strictEqual(C.creeperPlan(creeper(20, swelling()), null), 'flee');
  assert.strictEqual(C.creeperPlan(creeper(20, idle()), null), 'flee');
});

test('creeperIsThreat : seul un creeper qui GONFLE à ≤ 7 est une menace (cachette) ; calme et proche = fuite, pas cachette', () => {
  assert.strictEqual(C.creeperIsThreat(creeper(5, swelling()), at0), true);
  assert.strictEqual(C.creeperIsThreat(creeper(3, idle()), at0), false);
  assert.strictEqual(C.creeperIsThreat(creeper(10, idle()), at0), false);
});

test('awayPoint : point à `keep` blocs du creeper, à l opposé ; même colonne → cap arbitraire', () => {
  const p = C.awayPoint(at0, { x: 3, y: 70, z: 0 }, 10);
  assert.ok(Math.abs(p.x - -7) < 1e-9 && Math.abs(p.z) < 1e-9);
  const q = C.awayPoint(at0, { x: 0, y: 70, z: 0 }, 6);
  assert.ok(Math.abs(Math.hypot(q.x, q.z) - 6) < 1e-9);
  assert.strictEqual(C.awayPoint(null, at0, 6), null);
});

test('fleeDone : fini à ≥ 8 blocs s il est calme ; s il gonfle encore, seulement au-delà de 10 ; disparu → fini', () => {
  assert.strictEqual(C.fleeDone(creeper(7.9, idle()), at0), false);
  assert.strictEqual(C.fleeDone(creeper(8, idle()), at0), true);
  assert.strictEqual(C.fleeDone(creeper(9, swelling()), at0), false);
  assert.strictEqual(C.fleeDone(creeper(10.5, swelling()), at0), true);
  assert.strictEqual(C.fleeDone(null, at0), true);
  assert.strictEqual(C.fleeDone(creeper(3, idle(), { isValid: false }), at0), true);
  assert.strictEqual(C.fleeDone(creeper(3, idle()), null), false, 'position inconnue : on continue');
});
