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

// ─── Phase 2 : signatures étendues + event + rotation /locate ───

test('findAllSignatures : retourne 1 hit par type présent (village via bell, mineshaft via rail)', () => {
  const world = { bell: { x: 10, y: 70, z: 5 }, rail: { x: -20, y: 30, z: 8 } };
  const bot = {
    registry: { blocksByName: { bell: { id: 1 }, rail: { id: 2 }, end_portal_frame: { id: 3 },
      crying_obsidian: { id: 4 }, mossy_cobblestone: { id: 5 }, nether_bricks: { id: 6 },
      reinforced_deepslate: { id: 7 }, sculk_catalyst: { id: 8 }, infested_cobblestone: { id: 9 }, nether_brick: { id: 10 } } },
    findBlock({ matching }) {
      if (matching.includes(1)) return { name: 'bell', position: world.bell };
      if (matching.includes(2)) return { name: 'rail', position: world.rail };
      return null;
    },
  };
  const out = require('./structures').findAllSignatures(bot);
  const types = out.map((o) => o.type).sort();
  assert.deepStrictEqual(types, ['mineshaft', 'village']);
});

test('structureFoundEvent : event {type, world, kind, x, y, z} floored, y manquant → 64', () => {
  const { structureFoundEvent } = require('./structures');
  const ev = structureFoundEvent('overworld', 'village', { x: 10.7, y: 64.2, z: -3.9 });
  assert.deepStrictEqual(ev, { type: 'structure_found', world: 'overworld', kind: 'village', x: 10, y: 64, z: -4 });
  const ev2 = structureFoundEvent('overworld', 'shipwreck', { x: 1, z: 2 });
  assert.strictEqual(ev2.y, 64);
});

test('LOCATE_KINDS : rotation couvre les structures demandées (tags génériques)', () => {
  const { LOCATE_KINDS } = require('./structures');
  const kinds = LOCATE_KINDS.map((k) => k.kind);
  for (const k of ['village', 'mineshaft', 'stronghold', 'ancient_city', 'ruined_portal']) {
    assert.ok(kinds.includes(k), k);
  }
  assert.ok(LOCATE_KINDS.every((k) => k.arg.includes('minecraft')));
});

test('SIGNATURE : PLUS de donjon par mossy_cobblestone (faux positifs — le spawner seul fait foi)', () => {
  const bot = {
    registry: { blocksByName: { mossy_cobblestone: { id: 5 }, infested_cobblestone: { id: 9 } } },
    findBlock: ({ matching }) => (matching && (matching.includes(5) || matching.includes(9)) ? { name: 'mossy_cobblestone', position: pos(0, 40, 0) } : null),
  };
  const out = require('./structures').findAllSignatures(bot);
  assert.ok(!out.some((o) => o.type === 'dungeon'), 'mossy_cobblestone ne doit plus produire de donjon');
});

test('findAllSignatures : trial_chamber via trial_spawner ou vault', () => {
  const bot = {
    registry: { blocksByName: { trial_spawner: { id: 20 }, vault: { id: 21 } } },
    findBlock: ({ matching }) => (matching && matching.includes(20) ? { name: 'trial_spawner', position: pos(3, 20, 3) } : null),
  };
  const out = require('./structures').findAllSignatures(bot);
  assert.ok(out.some((o) => o.type === 'trial_chamber'), 'trial_spawner → trial_chamber');
});
