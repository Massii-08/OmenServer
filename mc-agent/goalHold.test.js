'use strict';
const test = require('node:test');
const assert = require('node:assert');
const H = require('./goalHold');

function pf() {
  const calls = [];
  return { calls, setGoal(g, d) { calls.push([g, !!d]); return 'ok'; } };
}

test('installGoalHold : sans verrou, setGoal passe tel quel (y compris null)', () => {
  const p = pf(); const st = H.createHoldState(); let t = 1000;
  assert.strictEqual(H.installGoalHold(p, st, () => t), true);
  p.setGoal('A', true); p.setGoal(null);
  assert.deepStrictEqual(p.calls, [['A', true], [null, false]]);
});

test('verrou actif : les appels étrangers (but ou null) sont ignorés et comptés, le propriétaire passe', () => {
  const p = pf(); const st = H.createHoldState(); let t = 1000;
  H.installGoalHold(p, st, () => t);
  H.hold(st, 4000, 'creeper');
  assert.strictEqual(H.isHeld(st, t), true);
  H.holdSetGoal(p, st, 'FLEE');
  p.setGoal('PLANNER'); p.setGoal(null);
  assert.deepStrictEqual(p.calls, [['FLEE', false]]);
  assert.strictEqual(st.dropped, 2);
  t = 4000;   // échu
  p.setGoal('PLANNER');
  assert.deepStrictEqual(p.calls.at(-1), ['PLANNER', false]);
});

test('release : relâche et rend le compte ; double install = idempotent', () => {
  const p = pf(); const st = H.createHoldState(); const t = 1000;
  H.installGoalHold(p, st, () => t);
  const w = p.setGoal;
  assert.strictEqual(H.installGoalHold(p, st, () => t), true);
  assert.strictEqual(p.setGoal, w, 'pas de double enveloppe');
  H.hold(st, 9000); p.setGoal('X');
  assert.strictEqual(H.release(st), 1);
  assert.strictEqual(H.isHeld(st, t), false);
  p.setGoal('Y');
  assert.deepStrictEqual(p.calls, [['Y', false]]);
});

test('hold prolonge sans raccourcir ; installGoalHold refuse un pathfinder invalide', () => {
  const st = H.createHoldState();
  H.hold(st, 5000); H.hold(st, 3000);
  assert.strictEqual(st.until, 5000);
  assert.strictEqual(H.installGoalHold(null, st), false);
  assert.strictEqual(H.installGoalHold({}, st), false);
});

test('holdSetGoal remet bypass à false même si setGoal lève', () => {
  const st = H.createHoldState();
  const p = { setGoal() { throw new Error('boom'); } };
  H.installGoalHold(p, st, () => 0);
  assert.throws(() => H.holdSetGoal(p, st, 'g'));
  assert.strictEqual(st.bypass, false);
});
