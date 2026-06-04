'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { ORE_NAMES, isExposed, scanExposedOres, exposedOreFoundEvent } = require('./ores');

// Fake monde 3D : fonction (x,y,z) → nom de bloc. blockAt construit le bloc.
// boundingBox 'empty' pour air/cave_air/void_air/water/lava, 'block' sinon ; null pour 'unloaded'.
const _EMPTY = new Set(['air', 'cave_air', 'void_air', 'water', 'lava']);
function makeBot(world, extra = {}) {
  return Object.assign({
    blockAt(p) {
      const name = world(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      if (name === 'unloaded') return null;
      return { name, position: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
               boundingBox: _EMPTY.has(name) ? 'empty' : 'block' };
    },
  }, extra);
}

// ─── isExposed ───────────────────────────────────────────────────────────────

test('isExposed : minerai avec un voisin air → true', () => {
  // voisin +x = air, le reste stone (le minerai lui-même importe peu)
  const w = (x, y, z) => (x === 11 && y === 64 && z === 0) ? 'air' : 'stone';
  assert.strictEqual(isExposed(makeBot(w), { x: 10, y: 64, z: 0 }), true);
});

test('isExposed : minerai enterré (6 voisins stone) → false', () => {
  const w = () => 'stone';
  assert.strictEqual(isExposed(makeBot(w), { x: 10, y: 64, z: 0 }), false);
});

test('isExposed : voisin cave_air → true', () => {
  const w = (x, y, z) => (x === 10 && y === 65 && z === 0) ? 'cave_air' : 'stone';
  assert.strictEqual(isExposed(makeBot(w), { x: 10, y: 64, z: 0 }), true);
});

test('isExposed : voisin water (minerai visible sous l\'eau) → true', () => {
  const w = (x, y, z) => (x === 10 && y === 64 && z === 1) ? 'water' : 'stone';
  assert.strictEqual(isExposed(makeBot(w), { x: 10, y: 64, z: 0 }), true);
});

test('isExposed : 5 stone + 1 lava (lave seule) → false', () => {
  const w = (x, y, z) => (x === 10 && y === 63 && z === 0) ? 'lava' : 'stone';
  assert.strictEqual(isExposed(makeBot(w), { x: 10, y: 64, z: 0 }), false);
});

test('isExposed : voisin lava + voisin air (l\'air suffit) → true', () => {
  const w = (x, y, z) => {
    if (x === 10 && y === 63 && z === 0) return 'lava';
    if (x === 10 && y === 65 && z === 0) return 'air';
    return 'stone';
  };
  assert.strictEqual(isExposed(makeBot(w), { x: 10, y: 64, z: 0 }), true);
});

test('isExposed : voisin null (chunk non chargé) + 5 stone → false', () => {
  const w = (x, y, z) => (x === 11 && y === 64 && z === 0) ? 'unloaded' : 'stone';
  assert.strictEqual(isExposed(makeBot(w), { x: 10, y: 64, z: 0 }), false);
});

test('isExposed : bot sans blockAt → false', () => {
  assert.strictEqual(isExposed({}, { x: 10, y: 64, z: 0 }), false);
  assert.strictEqual(isExposed(null, { x: 10, y: 64, z: 0 }), false);
});

// ─── scanExposedOres ─────────────────────────────────────────────────────────

function makeRegistry(map) {
  return { blocksByName: map };
}

test('scanExposedOres : 3 trouvés (1 exposé, 1 enterré, 1 chunk non chargé) → 1 seul', () => {
  const exposedPos = { x: 5, y: 30, z: 5 };
  const buriedPos = { x: 6, y: 31, z: 6 };
  const unloadedPos = { x: 7, y: 32, z: 7 };
  // monde : iron exposé (voisin +x air), diamond enterré, position non chargée → null
  const w = (x, y, z) => {
    if (x === 5 && y === 30 && z === 5) return 'iron_ore';
    if (x === 6 && y === 30 && z === 5) return 'air'; // voisin +x de l'iron → exposé
    if (x === 6 && y === 31 && z === 6) return 'diamond_ore';
    if (x === 7 && y === 32 && z === 7) return 'unloaded';
    return 'stone';
  };
  let received = null;
  const bot = makeBot(w, {
    registry: makeRegistry({ iron_ore: { id: 10 }, diamond_ore: { id: 11 } }),
    findBlocks(opts) { received = opts; return [exposedPos, buriedPos, unloadedPos]; },
  });
  const out = scanExposedOres(bot);
  assert.deepStrictEqual(received, { matching: [10, 11], maxDistance: 48, count: 40 });
  assert.deepStrictEqual(out, [{ material: 'iron_ore', x: 5, y: 30, z: 5 }]);
});

test('scanExposedOres : noms absents du registry → skip (pas de crash)', () => {
  // registry sans ancient_debris ni la plupart → ne garde que iron_ore
  const w = (x, y, z) => {
    if (x === 0 && y === 10 && z === 0) return 'iron_ore';
    if (x === 1 && y === 10 && z === 0) return 'air';
    return 'stone';
  };
  let received = null;
  const bot = makeBot(w, {
    registry: makeRegistry({ iron_ore: { id: 10 } }),
    findBlocks(opts) { received = opts; return [{ x: 0, y: 10, z: 0 }]; },
  });
  const out = scanExposedOres(bot);
  assert.deepStrictEqual(received.matching, [10]); // seul id résolu
  assert.deepStrictEqual(out, [{ material: 'iron_ore', x: 0, y: 10, z: 0 }]);
});

test('scanExposedOres : registry vide → [] sans appeler findBlocks', () => {
  let called = false;
  const bot = makeBot(() => 'stone', {
    registry: makeRegistry({}),
    findBlocks() { called = true; return []; },
  });
  assert.deepStrictEqual(scanExposedOres(bot), []);
  assert.strictEqual(called, false);
});

test('scanExposedOres : findBlocks throw → []', () => {
  const bot = makeBot(() => 'stone', {
    registry: makeRegistry({ iron_ore: { id: 10 } }),
    findBlocks() { throw new Error('boom'); },
  });
  assert.deepStrictEqual(scanExposedOres(bot), []);
});

test('scanExposedOres : blockAt null sur une position → skip', () => {
  const bot = makeBot(() => 'unloaded', {
    registry: makeRegistry({ iron_ore: { id: 10 } }),
    findBlocks() { return [{ x: 0, y: 0, z: 0 }]; },
  });
  assert.deepStrictEqual(scanExposedOres(bot), []);
});

// ─── exposedOreFoundEvent ────────────────────────────────────────────────────

test('exposedOreFoundEvent : shape exacte + floor des coords fractionnaires', () => {
  const ev = exposedOreFoundEvent('overworld', 'diamond_ore', { x: 12.7, y: 11.2, z: -3.9 });
  assert.deepStrictEqual(ev, {
    type: 'exposed_ore_found', world: 'overworld', material: 'diamond_ore',
    x: 12, y: 11, z: -4,
  });
});

// ─── ORE_NAMES ───────────────────────────────────────────────────────────────

test('ORE_NAMES contient les minerais clés', () => {
  assert.ok(Array.isArray(ORE_NAMES));
  for (const n of ['coal_ore', 'iron_ore', 'diamond_ore', 'deepslate_diamond_ore', 'ancient_debris']) {
    assert.ok(ORE_NAMES.includes(n), `manque ${n}`);
  }
});
