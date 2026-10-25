'use strict';
const test = require('node:test');
const assert = require('node:assert');
const D = require('./diamondDig');

const T = { x: 10, y: -14, z: 20 };
const eyeAt = (dx = 0) => ({ x: 10.5 + dx, y: -13.5, z: 20.5 });

/** Monde jouet : un bloc à T, une poche de diamants, une pioche. */
function world(o = {}) {
  const s = Object.assign({ name: 'deepslate_diamond_ore', eye: eyeAt(2), visible: true, held: 'iron_pickaxe',
    diamonds: 0, lavaClear: true, digThrows: null, digNoEffect: false, dropLost: false, approachTo: null }, o);
  const calls = [];
  const deps = {
    blockAt: () => (s.name ? { name: s.name } : null),
    eye: () => s.eye,
    canSee: () => s.visible,
    approachLook: async () => { calls.push('approach'); if (s.approachTo) Object.assign(s, s.approachTo); },
    clearLava: async () => s.lavaClear,
    equipPick: async () => { calls.push('equip'); return s.held; },
    dig: async () => {
      calls.push('dig');
      if (s.digThrows) throw new Error(s.digThrows);
      if (!s.digNoEffect) s.name = 'air';
    },
    pickup: async () => { calls.push('pickup'); if (!s.dropLost) s.diamonds += 1; },
    vein: async () => { calls.push('vein'); },
    count: () => s.diamonds,
    cancelled: () => false,
  };
  return { s, deps, calls };
}

test('oreStateOf / eyeDist / digRefusal : états et raisons', () => {
  assert.strictEqual(D.oreStateOf(null), 'unknown');
  assert.strictEqual(D.oreStateOf({ name: 'air' }), 'gone');
  assert.strictEqual(D.oreStateOf({ name: 'diamond_ore' }), 'ore');
  assert.ok(Math.abs(D.eyeDist(eyeAt(3), T) - 3) < 1e-9);
  const ok = { state: 'ore', dist: 3, visible: true, lavaLeft: false, blockName: 'deepslate_diamond_ore', held: 'iron_pickaxe' };
  assert.strictEqual(D.digRefusal(ok), null);
  assert.strictEqual(D.digRefusal(Object.assign({}, ok, { held: 'stone_pickaxe' })), 'no_tool');
  assert.strictEqual(D.digRefusal(Object.assign({}, ok, { held: 'shield' })), 'no_tool');
  assert.strictEqual(D.digRefusal(Object.assign({}, ok, { dist: 5 })), 'out_of_reach');
  assert.strictEqual(D.digRefusal(Object.assign({}, ok, { visible: false })), 'not_visible');
  assert.strictEqual(D.digRefusal(Object.assign({}, ok, { lavaLeft: true })), 'lava');
  assert.strictEqual(D.digRefusal(Object.assign({}, ok, { state: 'gone' })), 'gone');
});

test('diamant à portée et visible : équipe, casse, ramasse, suit le filon → mined', async () => {
  const w = world();
  const r = await D.digVisibleOre(T, w.deps);
  assert.deepStrictEqual([r.outcome, r.mined, r.broken], ['mined', 1, true]);
  assert.deepStrictEqual(w.calls, ['equip', 'dig', 'pickup', 'vein']);
});

test('REJEU 25/10 : « arrivé » à 6 blocs (hors portée) → se place d\'abord, puis casse (plus de nothing_mined)', async () => {
  const w = world({ eye: eyeAt(5.8), visible: false, approachTo: { eye: eyeAt(3), visible: true } });
  const r = await D.digVisibleOre(T, w.deps);
  assert.strictEqual(r.outcome, 'mined');
  assert.strictEqual(w.calls[0], 'approach');
});

test('placement raté : la raison est dite (out_of_reach / not_visible), jamais de dig', async () => {
  const a = world({ eye: eyeAt(5.8) });
  const ra = await D.digVisibleOre(T, a.deps);
  assert.deepStrictEqual([ra.outcome, ra.why], ['blocked', 'out_of_reach']);
  assert.ok(!a.calls.includes('dig'));
  const b = world({ visible: false });
  const rb = await D.digVisibleOre(T, b.deps);
  assert.deepStrictEqual([rb.outcome, rb.why], ['blocked', 'not_visible']);
  assert.ok(!b.calls.includes('dig'));
});

test('cible périmée (air) : gone sans trajet ni dig', async () => {
  const w = world({ name: 'air' });
  const r = await D.digVisibleOre(T, w.deps);
  assert.strictEqual(r.outcome, 'gone');
  assert.deepStrictEqual(w.calls, []);
});

test('le diamant disparaît pendant la mise en place (un coéquipier) → gone', async () => {
  const w = world({ eye: eyeAt(6), approachTo: { name: 'air' } });
  assert.strictEqual((await D.digVisibleOre(T, w.deps)).outcome, 'gone');
});

test('chunk non chargé → blocked unloaded', async () => {
  const w = world({ name: null });
  assert.deepStrictEqual(((r) => [r.outcome, r.why])(await D.digVisibleOre(T, w.deps)), ['blocked', 'unloaded']);
});

test('pioche de pierre seulement → blocked no_tool, jamais de dig', async () => {
  const w = world({ held: 'stone_pickaxe' });
  const r = await D.digVisibleOre(T, w.deps);
  assert.deepStrictEqual([r.outcome, r.why], ['blocked', 'no_tool']);
  assert.ok(!w.calls.includes('dig'));
});

test('lave non murable → blocked lava, ni équipement ni dig', async () => {
  const w = world({ lavaClear: false });
  const r = await D.digVisibleOre(T, w.deps);
  assert.deepStrictEqual([r.outcome, r.why], ['blocked', 'lava']);
  assert.ok(!w.calls.includes('dig'));
});

test('dig qui rejette → la raison remonte ; dig sans effet → dig_no_effect', async () => {
  const a = world({ digThrows: 'Digging aborted' });
  assert.match((await D.digVisibleOre(T, a.deps)).why, /^dig_error:/);
  const b = world({ digNoEffect: true });
  assert.strictEqual((await D.digVisibleOre(T, b.deps)).why, 'dig_no_effect');
});

test('bloc cassé mais drop perdu → blocked drop_lost, broken=true (la carte l\'oublie)', async () => {
  const w = world({ dropLost: true });
  const r = await D.digVisibleOre(T, w.deps);
  assert.deepStrictEqual([r.outcome, r.why, r.broken], ['blocked', 'drop_lost', true]);
});

test('createStrikeStore : banni au 2e échec du même bloc, levé après 10 min', () => {
  let now = 0;
  const s = D.createStrikeStore({ now: () => now });
  assert.strictEqual(s.fail('1,2,3'), 1);
  assert.strictEqual(s.banned('1,2,3'), false);
  assert.strictEqual(s.fail('1,2,3'), 2);
  assert.strictEqual(s.banned('1,2,3'), true);
  assert.deepStrictEqual(s.bannedKeys(), ['1,2,3']);
  assert.strictEqual(s.banned('1,2,4'), false);
  now = 10 * 60 * 1000;
  assert.strictEqual(s.banned('1,2,3'), false);
  assert.strictEqual(s.count('1,2,3'), 0);
});
