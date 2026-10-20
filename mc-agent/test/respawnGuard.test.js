'use strict';
// Run 10 (20/10, 375 morts / 10 h) — les décisions PURES des 3 correctifs :
//   1. premières secondes après un respawn : se TERRER plutôt que courir (unstuck.spawnGuardPlan) ;
//      jamais de /spawnpoint dans une zone campée (homeSafety.spawnpointVeto) ;
//   2. bois sans mourir : exploration courte quand nu (gather.woodExploreShape), arrêt NET sur danger
//      (gather `danger`, explore `danger`, gotoWithTimeout `abortIf`) ;
//   3. keepInventory : la dette de mort se lève d'elle-même (homes.inventoryKept / debtAction).
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnGuardPlan, SPAWN_DANGER_MIN_WORN } = require('../unstuck');
const { spawnpointVeto, CAMP_MIN_DEATHS } = require('../homeSafety');
const { inventoryKept, debtAction, DEBT_MIN_WORN } = require('../homes');
const { gather, woodExploreShape, WOOD_NAKED_MAX_RADIUS } = require('../skills/gather');
const { explore, gotoWithTimeout } = require('../skills/explore');

// ── 1. spawnGuardPlan ────────────────────────────────────────────────────────────────────────────
test('spawnGuardPlan : nu + hostile proche → hide (même sans évasion armée)', () => {
  assert.deepStrictEqual(spawnGuardPlan({ danger: true, worn: 0 }), { act: 'hide', reason: 'hostile_near' });
  assert.strictEqual(spawnGuardPlan({ danger: true, worn: 1, escapeArmed: true, night: false }).act, 'hide');
});

test('spawnGuardPlan : nu + camp + nuit → hide (plus de course à découvert de nuit)', () => {
  assert.deepStrictEqual(spawnGuardPlan({ escapeArmed: true, night: true, worn: 0 }), { act: 'hide', reason: 'camp_night' });
});

test('spawnGuardPlan : camp de jour sans hostile en vue → escape (fuite à pied d avant)', () => {
  assert.deepStrictEqual(spawnGuardPlan({ escapeArmed: true, night: false, worn: 0 }), { act: 'escape', reason: 'camp' });
  // heure inconnue (bot.time pas livré) → pas de règle de nuit
  assert.strictEqual(spawnGuardPlan({ escapeArmed: true, night: null, worn: 0 }).act, 'escape');
});

test('spawnGuardPlan : rien d armé, rien en vue → none ; armuré → comportement d avant', () => {
  assert.strictEqual(spawnGuardPlan({}).act, 'none');
  assert.strictEqual(spawnGuardPlan(null).act, 'none');
  assert.strictEqual(spawnGuardPlan({ danger: true, worn: SPAWN_DANGER_MIN_WORN }).act, 'none');
  assert.strictEqual(spawnGuardPlan({ danger: true, escapeArmed: true, night: true, worn: 4 }).act, 'escape');
});

// ── 1bis. spawnpointVeto ─────────────────────────────────────────────────────────────────────────
const NOW = 1_700_000_000_000;
test('spawnpointVeto : 2 morts récentes à ≤ 24 blocs → veto camped', () => {
  const deaths = [{ x: 3, y: 70, z: 0, at: NOW - 60000 }, { x: -4, y: 70, z: 2, at: NOW - 120000 }];
  assert.strictEqual(CAMP_MIN_DEATHS, 2);
  const v = spawnpointVeto({ pos: { x: 0, y: 70, z: 0 }, deaths, now: NOW });
  assert.deepStrictEqual(v, { veto: true, reason: 'camped', deaths: 2 });
});

test('spawnpointVeto : morts loin ou vieilles → pas de veto ; position illisible → veto', () => {
  const far = [{ x: 200, y: 70, z: 0, at: NOW - 60000 }, { x: 210, y: 70, z: 0, at: NOW - 60000 }];
  assert.strictEqual(spawnpointVeto({ pos: { x: 0, y: 70, z: 0 }, deaths: far, now: NOW }).veto, false);
  const old = [{ x: 1, y: 70, z: 0, at: NOW - 3 * 3600e3 }, { x: 2, y: 70, z: 0, at: NOW - 3 * 3600e3 }];
  assert.strictEqual(spawnpointVeto({ pos: { x: 0, y: 70, z: 0 }, deaths: old, now: NOW }).veto, false);
  assert.deepStrictEqual(spawnpointVeto({ pos: null, deaths: [], now: NOW }), { veto: true, reason: 'no_position' });
  assert.strictEqual(spawnpointVeto().veto, true);
});

// ── 3. keepInventory ─────────────────────────────────────────────────────────────────────────────
test('inventoryKept : moitié ou plus d avant → gardé ; vide → non ; rien avant → non (pas de preuve)', () => {
  assert.strictEqual(inventoryKept({ before: 40, after: 40 }), true);
  assert.strictEqual(inventoryKept({ before: 40, after: 20 }), true);
  assert.strictEqual(inventoryKept({ before: 40, after: 0 }), false);
  assert.strictEqual(inventoryKept({ before: 40, after: 6 }), false, 'un /kit de respawn ne passe pas pour un inventaire gardé');
  assert.strictEqual(inventoryKept({ before: 0, after: 10 }), false);
  assert.strictEqual(inventoryKept(), false);
});

test('debtAction : keptInventory → settle AVANT tout départ (même de jour, même armé)', () => {
  const debt = { x: 1, y: 2, z: 3, at: NOW - 30000 };
  assert.deepStrictEqual(debtAction({ debt, now: NOW, keptInventory: true }), { act: 'settle', reason: 'kept_inventory' });
  assert.deepStrictEqual(debtAction({ debt, now: NOW, keptInventory: true, night: true, worn: 0 }), { act: 'settle', reason: 'kept_inventory' });
  // keepInventory OFF : inchangé
  assert.strictEqual(debtAction({ debt, now: NOW, keptInventory: false }).act, 'recover');
  assert.strictEqual(debtAction({ debt, now: NOW, night: true, worn: 0 }).act, 'defer');
  assert.strictEqual(DEBT_MIN_WORN, SPAWN_DANGER_MIN_WORN);
});

// ── 2. bois ──────────────────────────────────────────────────────────────────────────────────────
test('woodExploreShape : nu → anneaux courts (≤ 144) ; armuré → forme par défaut (null)', () => {
  assert.deepStrictEqual(woodExploreShape({ worn: 0 }), { step: 48, maxRadius: WOOD_NAKED_MAX_RADIUS });
  assert.deepStrictEqual(woodExploreShape({ worn: 1 }), { step: 48, maxRadius: 144 });
  assert.strictEqual(woodExploreShape({ worn: 2 }), null);
  assert.ok(woodExploreShape());
});

function woodBot({ found = false, onGoto = null } = {}) {
  const calls = { collect: 0, goto: 0, setGoal: 0 };
  return {
    calls,
    registry: { blocksByName: { oak_log: { id: 17 } } },
    inventory: { items: () => [] },
    entity: { position: { x: 0, y: 70, z: 0, distanceTo: () => 99 } },
    findBlock: () => (found ? { name: 'oak_log', position: { x: 1, y: 70, z: 1 } } : null),
    nearestEntity: () => null,
    equip: async () => {},
    collectBlock: { collect: async () => { calls.collect++; } },
    pvp: { attack: () => {} },
    pathfinder: {
      goto: (g) => { calls.goto++; return onGoto ? onGoto(g) : Promise.resolve(); },
      setGoal: () => { calls.setGoal++; },
    },
  };
}

test('gather : danger dès le départ → rend la main sans rien toucher (reason danger)', async () => {
  const bot = woodBot({ found: true });
  const r = await gather(bot, { name: 'oak_log', count: 3, explore: true, danger: () => true });
  assert.deepStrictEqual(r, { ok: false, got: 0, reason: 'danger' });
  assert.strictEqual(bot.calls.collect, 0);
  assert.strictEqual(bot.calls.goto, 0);
});

test('gather : danger qui lève → ignoré (on récolte comme avant)', async () => {
  const bot = woodBot({ found: true });
  const r = await gather(bot, { name: 'oak_log', count: 2, danger: () => { throw new Error('x'); } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(bot.calls.collect, 2);
});

test('gather : la forme courte et le danger arrivent jusqu à explore (waypoints ≤ 144 blocs)', async () => {
  const pts = [];
  const bot = woodBot({ onGoto: (g) => { pts.push(g); return Promise.resolve(); } });
  const r = await gather(bot, { name: 'oak_log', count: 1, explore: true, exploreShape: woodExploreShape({ worn: 0 }) });
  assert.strictEqual(r.ok, false);
  assert.ok(pts.length > 0, 'explore a tourné');
  for (const g of pts) {
    const x = g.x != null ? g.x : (g.goal && g.goal.x);
    const z = g.z != null ? g.z : (g.goal && g.goal.z);
    if (x == null) continue;
    assert.ok(Math.hypot(x, z) <= 144 + 20, `waypoint hors forme courte : ${Math.round(Math.hypot(x, z))}`);
  }
});

test('explore : danger PENDANT un trajet → trajet coupé (setGoal null), reason danger, pas d épuisement', async () => {
  let armed = false;
  const bot = woodBot({ onGoto: () => new Promise(() => { armed = true; }) });  // trajet qui ne finit jamais
  const exhausted = new Set();
  const t0 = Date.now();
  const r = await explore(bot, { name: 'oak_log', matching: [17], danger: () => armed, exhausted, emit: () => {} });
  assert.deepStrictEqual(r, { ok: false, reason: 'danger' });
  assert.ok(bot.calls.setGoal >= 1, 'le pathfinder doit être coupé');
  assert.ok(Date.now() - t0 < 3000, 'coupure rapide (poll 500 ms), pas au bout des 90 s');
  assert.strictEqual(exhausted.size, 0);
});

test('gotoWithTimeout : sans abortIf → comportement d origine ; abortIf qui lève → ignoré', async () => {
  const bot = woodBot();
  await gotoWithTimeout(bot, {}, 1000);
  await gotoWithTimeout(bot, {}, 1000, () => { throw new Error('x'); });
  const slow = woodBot({ onGoto: () => new Promise((res) => setTimeout(res, 700)) });
  await gotoWithTimeout(slow, {}, 2000, () => { throw new Error('x'); });   // pas de rejet 'goto_danger'
  await assert.rejects(gotoWithTimeout(woodBot({ onGoto: () => new Promise(() => {}) }), {}, 2000, () => true), /goto_danger/);
});
