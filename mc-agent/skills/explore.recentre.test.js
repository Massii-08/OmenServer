'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { explore, nextWaypoints, findAliveBlock } = require('./explore');

test('anneaux autour d\'un bot loin de sa poche confine : 0 point (cause du not_found instantané)', () => {
  const bounds = { x: -384, z: 795, radius: 128 };
  assert.strictEqual(nextWaypoints({ x: -526, y: 78, z: 400 }, { step: 48, maxRadius: 144, bounds }).length, 0);
});

test('explore : poche hors de portée → spirale recentrée sur la poche, pas 0 waypoint', async () => {
  const emits = [];
  const goals = [];
  const bot = {
    entity: { position: { x: -526, y: 78, z: 400 } },
    pathfinder: { async goto(g) { goals.push(g); }, setGoal() {} },
    findBlock: () => null,
    _mcaExploreBounds: { x: -384, z: 795, radius: 128 },
  };
  const r = await explore(bot, { name: 'oak_log', matching: [1], step: 48, maxRadius: 144, emit: (e) => emits.push(e) });
  assert.strictEqual(r.ok, false);
  const rec = emits.find((e) => e.type === 'explore_recentred');
  assert.ok(rec, 'event explore_recentred');
  assert.deepStrictEqual([rec.x, rec.z], [-384, 795]);
  const sum = emits.find((e) => e.type === 'explore_summary');
  assert.ok(sum.waypoints > 0, 'des waypoints ont été tentés');
  for (const g of goals) assert.ok(Math.hypot(g.x - -384, g.z - 795) <= 128 + 1e-6, 'chaque waypoint reste dans la poche');
});

test('explore : bot DANS sa poche → pas de recentrage (comportement d\'origine)', async () => {
  const emits = [];
  const bot = {
    entity: { position: { x: -384, y: 70, z: 795 } },
    pathfinder: { async goto() {}, setGoal() {} },
    findBlock: () => null,
    _mcaExploreBounds: { x: -384, z: 795, radius: 128 },
  };
  await explore(bot, { name: 'oak_log', matching: [1], step: 48, maxRadius: 144, emit: (e) => emits.push(e) });
  assert.ok(!emits.some((e) => e.type === 'explore_recentred'));
});

test('findAliveBlock : saute un bloc mort et prend le suivant vivant ; sans isDead = findBlock', () => {
  const A = { x: 1, y: 0, z: 0 }, B = { x: 5, y: 0, z: 0 };
  const bot = {
    findBlock: () => ({ name: 'oak_log', position: A }),
    findBlocks: () => [A, B],
    blockAt: (p) => ({ name: 'oak_log', position: p }),
  };
  assert.strictEqual(findAliveBlock(bot, [1], 64).position, A);
  assert.strictEqual(findAliveBlock(bot, [1], 64, (p) => p === A).position, B);
  assert.strictEqual(findAliveBlock(bot, [1], 64, () => true), null);
  assert.strictEqual(findAliveBlock({ findBlock: bot.findBlock }, [1], 64, (p) => p === A), null, 'pas de findBlocks → null');
});
