'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { depositPlan, restorePlan, hasStonePick, STASH_RESTORE_RADIUS } = require('./stash');

const kitInv = (more = []) => [
  { name: 'stone_pickaxe', count: 1 }, { name: 'furnace', count: 1 },
  { name: 'oak_log', count: 10 }, { name: 'birch_log', count: 4 }, { name: 'oak_planks', count: 12 },
  { name: 'stick', count: 9 }, { name: 'cooked_beef', count: 9 }, { name: 'cobblestone', count: 5 }, ...more,
];
const ready = (inv, more = {}) => depositPlan(Object.assign({ inv, hasFurnace: true, stash: null, nearBase: true, safe: true }, more));

test('depositPlan : outils pierre + four, à la base, au calme → dépose le SURPLUS seulement', () => {
  const r = ready(kitInv());
  assert.strictEqual(r.act, 'deposit');
  const by = Object.fromEntries(r.items.map((i) => [i.name, i.count]));
  assert.strictEqual((by.oak_log || 0) + (by.birch_log || 0), 10, '14 bûches, on en garde 4');
  assert.strictEqual(by.oak_planks, 4, '12 planches, on en garde 8');
  assert.strictEqual(by.stick, 3, '9 bâtons : 4 gardés + 2 réservés à la pioche de rechange');
  assert.strictEqual(by.cooked_beef, 3, '9 de nourriture, on en garde 6');
  assert.strictEqual(r.craftSparePick, true, '5 cobble + 9 bâtons : de quoi fabriquer la rechange');
  assert.strictEqual(by.stone_pickaxe, 1, 'la rechange FABRIQUÉE part au coffre, jamais sa seule pioche');
  const poor = ready(kitInv().filter((i) => i.name !== 'cobblestone'));
  assert.ok(!poor.items.some((i) => i.name === 'stone_pickaxe'), 'sans cobble : pas de rechange, la seule pioche reste en poche');
});

test('depositPlan : 2 pioches pierre → l une part au coffre ; cobble + bâtons → pioche de rechange à fabriquer', () => {
  const two = ready(kitInv([{ name: 'stone_pickaxe', count: 1 }]));
  assert.ok(two.items.some((i) => i.name === 'stone_pickaxe' && i.count === 1));
  const inv = [{ name: 'stone_pickaxe', count: 1 }, { name: 'stick', count: 6 }, { name: 'cobblestone', count: 3 }];
  const r = ready(inv);
  assert.strictEqual(r.act, 'deposit');
  assert.strictEqual(r.craftSparePick, true);
});

test('depositPlan : préconditions (pas de pioche pierre, pas de four, loin de la base, danger, déjà déposé, rien à déposer)', () => {
  assert.strictEqual(ready([{ name: 'wooden_pickaxe', count: 1 }, { name: 'oak_log', count: 20 }]).reason, 'no_stone_tools');
  assert.strictEqual(ready(kitInv(), { hasFurnace: false }).reason, 'no_furnace');
  assert.strictEqual(ready(kitInv(), { nearBase: false }).reason, 'not_at_base');
  assert.strictEqual(ready(kitInv(), { safe: false }).reason, 'unsafe');
  assert.strictEqual(ready(kitInv(), { stash: { x: 0, z: 0, items: [{ name: 'stick', count: 1 }] } }).reason, 'already_stashed');
  assert.strictEqual(ready([{ name: 'stone_pickaxe', count: 1 }]).reason, 'no_surplus');
  assert.strictEqual(depositPlan().act, 'skip');
});

test('restorePlan : nu, près du coffre, zone saine → restore ; keepInventory ON (pioche gardée) → skip', () => {
  const stash = { x: 10, y: 70, z: 0, items: [{ name: 'oak_log', count: 8 }] };
  assert.deepStrictEqual(restorePlan({ stash, pos: { x: 0, y: 70, z: 0 }, inv: [], camped: false }), { act: 'restore', reason: 'ok', dist: 10 });
  assert.strictEqual(restorePlan({ stash, pos: { x: 0, z: 0 }, inv: [{ name: 'stone_pickaxe', count: 1 }] }).reason, 'has_pickaxe');
});

test('restorePlan : trop loin, campé, sans coffre, sans position → skip', () => {
  const stash = { x: 0, y: 70, z: 0, items: [{ name: 'stick', count: 2 }] };
  assert.strictEqual(restorePlan({ stash, pos: { x: STASH_RESTORE_RADIUS + 1, z: 0 }, inv: [] }).reason, 'too_far');
  assert.strictEqual(restorePlan({ stash, pos: { x: 5, z: 0 }, inv: [], camped: true }).reason, 'camped');
  assert.strictEqual(restorePlan({ stash: null, pos: { x: 0, z: 0 } }).reason, 'no_stash');
  assert.strictEqual(restorePlan({ stash: { x: 0, z: 0, items: [] }, pos: { x: 0, z: 0 } }).reason, 'no_stash');
  assert.strictEqual(restorePlan({ stash, pos: null, inv: [] }).reason, 'no_position');
});

test('hasStonePick : bois/or ne comptent pas', () => {
  assert.strictEqual(hasStonePick([{ name: 'wooden_pickaxe', count: 1 }]), false);
  assert.strictEqual(hasStonePick([{ name: 'iron_pickaxe', count: 1 }]), true);
  assert.strictEqual(hasStonePick(null), false);
});
