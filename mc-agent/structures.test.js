'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const st = require('./structures');

function pos(x, y, z) {
  return { x, y, z, distanceTo(o) { return Math.sqrt((x - o.x) ** 2 + (y - o.y) ** 2 + (z - o.z) ** 2); } };
}

test('parseStructureIds : strings + objets {match}/{text}, filtre les vides', () => {
  assert.deepStrictEqual(
    st.parseStructureIds(['minecraft:village', { match: 'minecraft:fortress' }, { text: 'datapack:ruins' }, '', null]),
    ['minecraft:village', 'minecraft:fortress', 'datapack:ruins']);
});

test('parseLocateResponse : "nearest X at [x, ~, z] (d blocks away)"', () => {
  assert.deepStrictEqual(
    st.parseLocateResponse('The nearest minecraft:village is at [100, ~, -240] (317 blocks away)'),
    { x: 100, z: -240, dist: 317 });
  assert.deepStrictEqual(st.parseLocateResponse('[40, 63, 8] (5 blocks away)'), { x: 40, z: 8, dist: 5 });
  assert.strictEqual(st.parseLocateResponse('Could not find structure'), null);
  assert.strictEqual(st.parseLocateResponse(null), null);
});

test('detectMobCluster : ≥minCount hostiles proches → found + centre ; sinon found:false', () => {
  const bot = {
    entity: { position: pos(0, 64, 0) },
    entities: {
      1: { kind: 'Hostile mobs', position: pos(2, 64, 0) },
      2: { kind: 'Hostile mobs', position: pos(0, 64, 2) },
      3: { type: 'hostile', position: pos(-2, 64, 0) },
      4: { type: 'monster', position: pos(0, 64, -2) },
      5: { kind: 'Animals', position: pos(1, 64, 1) },     // passif → ignoré
      6: { kind: 'Hostile mobs', position: pos(100, 64, 0) }, // trop loin → ignoré
    },
  };
  const r = st.detectMobCluster(bot, { radius: 12, minCount: 4 });
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.count, 4);
  assert.ok(Math.abs(r.center.x) < 1e-9 && Math.abs(r.center.z) < 1e-9); // barycentre ≈ origine
});

test('detectMobCluster : pas assez d\'hostiles → found:false', () => {
  const bot = { entity: { position: pos(0, 64, 0) }, entities: { 1: { kind: 'Hostile mobs', position: pos(1, 64, 0) } } };
  assert.strictEqual(st.detectMobCluster(bot, { minCount: 4 }).found, false);
});

test('findSpawner : un spawner à portée = donjon', () => {
  const bot = {
    registry: { blocksByName: { spawner: { id: 52 } } },
    findBlock: ({ matching }) => (matching && matching.includes(52) ? { name: 'spawner', position: pos(8, 30, 8) } : null),
  };
  const r = st.findSpawner(bot);
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.type, 'dungeon');
  assert.ok(r.pos.x === 8 && r.pos.y === 30 && r.pos.z === 8);
});

test('findSignature : nether_bricks → fortress ; rien → found:false', () => {
  const bot = {
    registry: { blocksByName: { nether_bricks: { id: 112 } } },
    findBlock: ({ matching }) => (matching && matching.includes(112) ? { name: 'nether_bricks', position: pos(5, 70, 5) } : null),
  };
  const r = st.findSignature(bot);
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.type, 'fortress');
  const empty = { registry: { blocksByName: {} }, findBlock: () => null };
  assert.strictEqual(st.findSignature(empty).found, false);
});
