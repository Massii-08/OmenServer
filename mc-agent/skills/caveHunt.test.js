'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { caveHunt, pickTierOf } = require('./caveHunt');

const botWith = (items, pos = { x: 0, y: -50, z: 0 }) => ({
  inventory: { items: () => items.map(([name, count]) => ({ name, count })) },
  entity: { position: pos },
});

test('pickTierOf : retient le MEILLEUR palier en poche', () => {
  assert.strictEqual(pickTierOf({ wooden_pickaxe: 1, iron_pickaxe: 1 }), 3);
  assert.strictEqual(pickTierOf({ stone_pickaxe: 2 }), 2);
  assert.strictEqual(pickTierOf({}), 0);
});

test('caveHunt : sans pioche fer, on ne part pas chasser le diamant', async () => {
  const r = await caveHunt(botWith([['stone_pickaxe', 1]]), {
    material: 'diamond', count: 1, nextOreTarget: () => { throw new Error('ne doit pas cibler'); },
  });
  assert.strictEqual(r.reason, 'no_pick');
});

// Le coeur de la demande : on ne cible QUE de l'exposé et JAMAIS du noye.
test('caveHunt : exige exposedOnly ET excludeWet a chaque selection', async () => {
  const seen = [];
  await caveHunt(botWith([['iron_pickaxe', 1]]), {
    material: 'diamond', count: 1,
    nextOreTarget: (mem, w, from, o) => { seen.push(o); return null; },
  });
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].exposedOnly, true, 'jamais un minerai enterre');
  assert.strictEqual(seen[0].excludeWet, true, 'jamais une grotte inondee');
  assert.deepStrictEqual(seen[0].allowTypes, ['diamond']);
});

test('caveHunt : aucune cible cave → no_cave_target (signal de trajet, pas une erreur)', async () => {
  const r = await caveHunt(botWith([['iron_pickaxe', 1]]), {
    material: 'diamond', count: 2, nextOreTarget: () => null,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_cave_target');
  assert.strictEqual(r.got, 0);
});

test('caveHunt : enchaine les cibles jusqu au compte demande', async () => {
  let n = 0;
  const r = await caveHunt(botWith([['iron_pickaxe', 1]]), {
    material: 'diamond', count: 3,
    nextOreTarget: () => (n < 3 ? { x: n, y: -50, z: 0, material: 'diamond_ore' } : null),
    goTo: async () => true,
    mineAt: async () => { n++; return 1; },
  });
  assert.deepStrictEqual({ ok: r.ok, got: r.got }, { ok: true, got: 3 });
});

test('caveHunt : cible inatteignable → on la met de cote au lieu de s y acharner', async () => {
  const asked = [];
  let calls = 0;
  const r = await caveHunt(botWith([['iron_pickaxe', 1]]), {
    material: 'diamond', count: 1,
    nextOreTarget: (mem, w, from, o) => {
      asked.push(new Set(o.skip));
      calls++;
      return calls === 1 ? { x: 7, y: -50, z: 7 } : null;
    },
    goTo: async () => false,          // jamais atteignable
    mineAt: async () => 0,
  });
  assert.strictEqual(r.reason, 'no_cave_target');
  assert.ok(asked[1].has('7,-50,7'), 'la cible ratee doit etre exclue au tour suivant');
});

test('caveHunt : annulation respectee', async () => {
  const token = { cancelled: true };
  const r = await caveHunt(botWith([['iron_pickaxe', 1]]), {
    material: 'diamond', count: 1, nextOreTarget: () => ({ x: 0, y: 0, z: 0 }),
  }, token);
  assert.strictEqual(r.reason, 'cancelled');
});
