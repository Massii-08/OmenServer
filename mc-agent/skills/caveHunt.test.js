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

// ─── Yeux locaux : voir les grottes AUTOUR, pas seulement celles de la carte ────────────────────
// Massii, live 26/07 : « ils ont plein de cave autour mais je ne vois aucun qui va vers ». La 1re
// version ne consultait que la memoire de monde : sans minerai cartographie a proximite elle
// rendait no_cave_target et le bot creusait, alors qu'une grotte pleine de minerai etait visible.
test('caveHunt : aucune cible mappee mais une VISIBLE → on y va au lieu de creuser', async () => {
  let mined = 0;
  const r = await caveHunt(botWith([['iron_pickaxe', 1]]), {
    material: 'diamond', count: 1,
    nextOreTarget: () => null,                                   // la carte ne sait rien
    scanLocal: () => (mined ? null : { x: 5, y: -50, z: 5, material: 'diamond_ore' }),
    goTo: async () => true,
    mineAt: async () => { mined = 1; return 1; },
  });
  assert.deepStrictEqual({ ok: r.ok, got: r.got }, { ok: true, got: 1 });
});

test('caveHunt : ni carte ni vue → no_cave_target (le trajet reste le dernier recours)', async () => {
  const r = await caveHunt(botWith([['iron_pickaxe', 1]]), {
    material: 'diamond', count: 1,
    nextOreTarget: () => null,
    scanLocal: () => null,
  });
  assert.strictEqual(r.reason, 'no_cave_target');
});

// ─── DIAMANT VISIBLE DANS LA GROTTE (Massii en jeu 24/10 : « pourquoi NethBot1 creuse sans viser les
// diamants visibles dans les cavernes ? ») ──────────────────────────────────────────────────────────
// Le scan local demandait à findBlocks les 40 minerais LES PLUS PROCHES, tous types confondus, puis gardait
// les diamants : à -54 le charbon / redstone / fer d'à côté remplissait les 40 places et le diamant de la
// grotte, à 25 blocs, n'était jamais dans la liste.
function caveWorld({ diamond = { x: 25, y: -54, z: 0 }, others = 60 } = {}) {
  const ids = { coal_ore: 1, deepslate_coal_ore: 2, deepslate_redstone_ore: 3, deepslate_diamond_ore: 4, diamond_ore: 5 };
  const blocks = new Map();
  for (let i = 0; i < others; i++) blocks.set(`${2 + (i % 10)},-54,${Math.floor(i / 10) - 3}`, 'deepslate_redstone_ore');
  if (diamond) blocks.set(`${diamond.x},${diamond.y},${diamond.z}`, 'deepslate_diamond_ore');
  const me = { x: 0, y: -54, z: 0 };
  const bot = {
    entity: { position: me },
    inventory: { items: () => [{ name: 'iron_pickaxe', count: 1 }] },
    registry: { blocksByName: Object.fromEntries(Object.entries(ids).map(([n, id]) => [n, { id }])) },
    findBlocks({ matching, maxDistance, count }) {
      const want = new Set(matching);
      return [...blocks.entries()]
        .map(([k, n]) => { const [x, y, z] = k.split(',').map(Number); return { x, y, z, n }; })
        .filter((b) => want.has(ids[b.n]) && Math.hypot(b.x - me.x, b.y - me.y, b.z - me.z) <= maxDistance)
        .sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))
        .slice(0, count);
    },
    blockAt(q) {
      const k = `${Math.floor(q.x)},${Math.floor(q.y)},${Math.floor(q.z)}`;
      if (blocks.has(k)) return { name: blocks.get(k), boundingBox: 'block' };
      return { name: 'cave_air', boundingBox: 'empty' };       // grotte : tout est ouvert autour
    },
  };
  return bot;
}

test('caveHunt : le diamant VISIBLE à 25 blocs est visé même si 60 autres minerais sont plus près', async () => {
  const bot = caveWorld();
  const events = [];
  const targets = [];
  await caveHunt(bot, {
    material: 'diamond', count: 1, emit: (e) => events.push(e), nextOreTarget: () => null,
    goTo: async (t) => { targets.push(t); return true; }, mineAt: async () => 1,
  });
  assert.deepStrictEqual(targets.map((t) => [t.x, t.y, t.z]), [[25, -54, 0]]);
  const ev = events.find((e) => e.type === 'diamond_cave_target');
  assert.ok(ev, 'event diamond_cave_target');
  assert.deepStrictEqual([ev.x, ev.y, ev.z, ev.dist, ev.ores, ev.src], [25, -54, 0, 25, 1, 'local']);
});

test('caveHunt : cible de la carte limitée à 64 blocs (3D) ; inatteignable mémorisée ENTRE deux appels (skipStore)', async () => {
  const { createSkipStore } = require('./caveHunt');
  const store = createSkipStore(20 * 60 * 1000);
  const asked = [];
  const pick = (mem, w, from, o) => { asked.push(o); return o.skip.has('5,-50,0') ? null : { x: 5, y: -50, z: 0, material: 'diamond_ore' }; };
  const run = () => caveHunt(botWith([['iron_pickaxe', 1]]), {
    material: 'diamond', count: 1, nextOreTarget: pick, skipStore: store, scanLocal: () => null,
    goTo: async () => false, mineAt: async () => 0,
  });
  await run();
  assert.strictEqual(asked[0].maxDist, 64);
  assert.strictEqual(store.has('5,-50,0'), true);
  asked.length = 0;
  const r = await run();
  assert.strictEqual(r.reason, 'no_cave_target');
  assert.strictEqual(asked.length, 1, 'la cible ratée au 1er appel n\'est plus retentée');
});
