'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createStickyReclaim } = require('./stickyReclaim');

// Fake timers : capture les callbacks, déclenchement manuel.
function fakeClock() {
  let id = 0;
  const timers = new Map();
  return {
    setT: (fn, ms) => { id++; timers.set(id, { fn, ms }); return id; },
    clearT: (t) => { timers.delete(t); },
    fire(t) { const e = timers.get(t); if (e) { timers.delete(t); e.fn(); } },
    fireAll() { for (const k of [...timers.keys()]) this.fire(k); },
    count() { return timers.size; },
  };
}

test('sticky: pas de reclaim immédiat après schedule (le dwell est la règle)', () => {
  const clock = fakeClock();
  const reclaimed = [];
  const s = createStickyReclaim((p) => reclaimed.push(p), 12000, clock.setT, clock.clearT);
  s.schedule({ x: 1, y: 2, z: 3 });
  assert.deepStrictEqual(reclaimed, []);
  assert.deepStrictEqual(s.pending(), { x: 1, y: 2, z: 3 });
});

test('sticky: reclaim après le délai (une seule fois)', () => {
  const clock = fakeClock();
  const reclaimed = [];
  const s = createStickyReclaim((p) => reclaimed.push(p), 12000, clock.setT, clock.clearT);
  s.schedule({ x: 1, y: 2, z: 3 });
  clock.fireAll();
  assert.strictEqual(reclaimed.length, 1);
  assert.strictEqual(s.pending(), null);
});

test('sticky: re-schedule MÊME pos = burst de crafts → délai repoussé, pas de reclaim entre-temps', () => {
  const clock = fakeClock();
  const reclaimed = [];
  const s = createStickyReclaim((p) => reclaimed.push(p), 12000, clock.setT, clock.clearT);
  const pos = { x: 1, y: 2, z: 3 };
  s.schedule(pos);
  s.schedule(pos); // 2e craft du burst : la table reste posée
  s.schedule(pos); // 3e
  assert.deepStrictEqual(reclaimed, []);
  assert.strictEqual(clock.count(), 1); // un seul timer actif
  clock.fireAll();
  assert.strictEqual(reclaimed.length, 1);
});

test('sticky: nouvelle pos AILLEURS → l\'ancienne table est reprise tout de suite', () => {
  const clock = fakeClock();
  const reclaimed = [];
  const s = createStickyReclaim((p) => reclaimed.push(p), 12000, clock.setT, clock.clearT);
  s.schedule({ x: 1, y: 2, z: 3 });
  s.schedule({ x: 50, y: 2, z: 3 });
  assert.deepStrictEqual(reclaimed, [{ x: 1, y: 2, z: 3 }]); // pas de table orpheline
  clock.fireAll();
  assert.strictEqual(reclaimed.length, 2);
});

test('sticky: cancel annule sans reprendre', () => {
  const clock = fakeClock();
  const reclaimed = [];
  const s = createStickyReclaim((p) => reclaimed.push(p), 12000, clock.setT, clock.clearT);
  s.schedule({ x: 1, y: 2, z: 3 });
  s.cancel();
  clock.fireAll();
  assert.deepStrictEqual(reclaimed, []);
});
