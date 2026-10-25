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

// ─── REJEU NethBot1 24/10 (session-602) : grappe retentée bloc par bloc + coupures comptées comme
// « inatteignable ». Vraies coordonnées : bot à (121,-39,105) (relevé imminent_bookmark_death), cibles
// visibles successives (120,-9,108) (119,-9,109) (120,-8,108) puis (129,-32,137) (130,-31,137). ──────
const NB1_ORES = [
  { x: 120, y: -9, z: 108 }, { x: 119, y: -9, z: 109 }, { x: 120, y: -8, z: 108 },
  { x: 129, y: -32, z: 137 }, { x: 130, y: -31, z: 137 },
].map((o) => Object.assign({ material: 'deepslate_diamond_ore' }, o));
function nb1Scan(order = NB1_ORES) {
  // Comme _defaultScanLocal : premier minerai non exclu (l'ordre = celui du log).
  const { nearSkipped } = require('./caveHunt');
  return (bot, material, skip) => order.find((o) => !nearSkipped(skip, o)) || null;
}

test('rejeu NethBot1 : une grappe inatteignable est mise de côté EN ENTIER (2 essais au lieu de 5)', async () => {
  const tried = [];
  const events = [];
  const r = await caveHunt(botWith([['iron_pickaxe', 1]], { x: 121, y: -39, z: 105 }), {
    material: 'diamond', count: 1, emit: (e) => events.push(e), nextOreTarget: () => null,
    scanLocal: nb1Scan(), goTo: async (t) => { tried.push([t.x, t.y, t.z]); return false; }, mineAt: async () => 0,
  });
  assert.strictEqual(r.reason, 'no_cave_target');
  assert.deepStrictEqual(tried, [[120, -9, 108], [129, -32, 137]],
    'avant : (120,-9,108) (119,-9,109) (120,-8,108) (129,-32,137) (130,-31,137) — même grappe retentée bloc par bloc');
  const res = events.filter((e) => e.type === 'diamond_cave_result');
  assert.deepStrictEqual(res.map((e) => e.outcome), ['unreachable', 'unreachable']);
});

test('rejeu NethBot1 : une COUPURE (réflexe, détour, TP) n\'est pas un verdict — la même cible est retentée après settle', async () => {
  const tried = [];
  let settles = 0;
  const replies = [{ reached: false, interrupted: true, why: 'goal_changed' }, 'interrupted', true];
  const events = [];
  const r = await caveHunt(botWith([['iron_pickaxe', 1]], { x: 121, y: -39, z: 105 }), {
    material: 'diamond', count: 1, emit: (e) => events.push(e), nextOreTarget: () => null,
    scanLocal: nb1Scan(), settle: async () => { settles++; },
    goTo: async (t) => { tried.push([t.x, t.y, t.z]); return replies.shift(); }, mineAt: async () => 2,
  });
  assert.deepStrictEqual({ ok: r.ok, got: r.got }, { ok: true, got: 2 });
  assert.deepStrictEqual(tried, [[120, -9, 108], [120, -9, 108], [120, -9, 108]]);
  assert.strictEqual(settles, 2);
  assert.deepStrictEqual(events.filter((e) => e.type === 'cave_unreachable'), [], 'une coupure ne produit plus cave_unreachable');
  const res = events.filter((e) => e.type === 'diamond_cave_result');
  assert.deepStrictEqual(res.map((e) => [e.outcome, e.why, e.mined]),
    [['interrupted', 'goal_changed', 0], ['interrupted', 'interrupted', 0], ['mined', null, 2]]);
  assert.ok(res.every((e) => typeof e.took_s === 'number'));
});

test('caveHunt : coupée MAX_INTERRUPTS fois → grappe laissée pour CET appel seulement (pas dans le store)', async () => {
  const { createSkipStore, MAX_INTERRUPTS } = require('./caveHunt');
  const store = createSkipStore();
  const tried = [];
  const r = await caveHunt(botWith([['iron_pickaxe', 1]], { x: 121, y: -39, z: 105 }), {
    material: 'diamond', count: 1, nextOreTarget: () => null, skipStore: store, scanLocal: nb1Scan(),
    goTo: async (t) => { tried.push(t.y); return 'interrupted'; }, mineAt: async () => 0,
  });
  assert.strictEqual(r.reason, 'no_cave_target');
  assert.strictEqual(tried.filter((y) => y > -10).length, MAX_INTERRUPTS, 'grappe haute : 3 coupures puis la suivante');
  assert.strictEqual(store.size(), 0, 'une coupure ne condamne pas la grappe 20 min');
});

test('caveHunt : PV bas (hpOk faux) → on sort tout de suite (low_hp), sans cibler', async () => {
  const r = await caveHunt(botWith([['iron_pickaxe', 1]]), {
    material: 'diamond', count: 1, hpOk: () => false,
    scanLocal: () => { throw new Error('ne doit pas scanner'); }, nextOreTarget: () => null,
  });
  assert.strictEqual(r.reason, 'low_hp');
});

test('caveHunt : grappe de la CARTE voisine d\'une grappe mise de côté → ignorée aussi', async () => {
  const { createSkipStore } = require('./caveHunt');
  const store = createSkipStore();
  store.add('120,-9,108');
  const asked = [];
  const r = await caveHunt(botWith([['iron_pickaxe', 1]], { x: 121, y: -39, z: 105 }), {
    material: 'diamond', count: 1, skipStore: store, scanLocal: () => null,
    nextOreTarget: (m, w, f, o) => { asked.push(new Set(o.skip)); return o.skip.has('119,-9,109') ? null : { x: 119, y: -9, z: 109 }; },
    goTo: async () => { throw new Error('ne doit pas y aller'); }, mineAt: async () => 0,
  });
  assert.strictEqual(r.reason, 'no_cave_target');
  assert.strictEqual(asked.length, 2);
});

test('helpers purs : nearSkipped rayon 4 · approachBudgetMs [45 s, 90 s] · legWaypoint monte/descend en jambes', () => {
  const H = require('./caveHunt');
  assert.strictEqual(H.nearSkipped(new Set(['120,-9,108']), { x: 120, y: -8, z: 108 }), true);
  assert.strictEqual(H.nearSkipped(new Set(['120,-9,108']), { x: 129, y: -32, z: 137 }), false);
  assert.strictEqual(H.approachBudgetMs(0), 45000);
  assert.strictEqual(H.approachBudgetMs(26), 69000);
  assert.strictEqual(H.approachBudgetMs(64), 90000);
  const up = H.legWaypoint({ x: 121, y: -39, z: 105 }, { x: 120, y: -9, z: 108 }, 8);
  assert.strictEqual(up.last, false);
  assert.ok(up.y > -39 && up.y <= -31, `jambe montante : ${up.y}`);
  assert.ok(Math.hypot(up.x - 121, up.y + 39, up.z - 105) <= 8.6);
  assert.deepStrictEqual(H.legWaypoint({ x: 0, y: 0, z: 0 }, { x: 5, y: 3, z: 0 }, 8), { x: 5, y: 3, z: 0, last: true });
  assert.deepStrictEqual(H.normalizeTravel(true), { reached: true, interrupted: false, why: null });
  assert.strictEqual(H.normalizeTravel(false).why, 'unreachable');
});

// ─── 25/10 : minage VÉRIFIÉ, cibles périmées, échecs par bloc ─────────────────────────────────────
const { createStrikeStore } = require('./diamondDig');
const oneTarget = (t) => { let given = 0; return () => (given++ < 10 ? t : null); };

test('REJEU 25/10 : cible périmée (air) relue AVANT le départ → ore_gone, aucun trajet, aucun échec', async () => {
  const events = [];
  const t = { x: -313, y: -34, z: 315 };
  const r = await caveHunt(botWith([['iron_pickaxe', 1]]), {
    material: 'diamond', count: 1, emit: (e) => events.push(e), scanLocal: () => null,
    nextOreTarget: (m, w, f, o) => (o.skip.has('-313,-34,315') ? null : t),
    oreState: () => 'gone',
    goTo: async () => { throw new Error('ne doit pas partir vers une cible disparue'); },
    mineTarget: async () => { throw new Error('ne doit pas miner'); },
  });
  assert.strictEqual(r.reason, 'no_cave_target');
  const gone = events.find((e) => e.type === 'ore_gone');
  assert.deepStrictEqual([gone.x, gone.y, gone.z, gone.world], [-313, -34, 315, 'overworld']);
  const res = events.filter((e) => e.type === 'diamond_cave_result');
  assert.deepStrictEqual(res.map((e) => [e.outcome, e.why]), [['gone', 'stale_target']]);
  assert.strictEqual(events.some((e) => e.type === 'cave_target'), false);
});

test('mineTarget mined → ore_mined (la carte oublie le bloc) et cave_mined', async () => {
  const events = [];
  const r = await caveHunt(botWith([['iron_pickaxe', 1]]), {
    material: 'diamond', count: 1, emit: (e) => events.push(e), scanLocal: () => null,
    nextOreTarget: oneTarget({ x: 1, y: -50, z: 1 }), oreState: () => 'ore', goTo: async () => true,
    mineTarget: async () => ({ outcome: 'mined', mined: 2, broken: true }),
  });
  assert.deepStrictEqual({ ok: r.ok, got: r.got }, { ok: true, got: 2 });
  assert.ok(events.some((e) => e.type === 'ore_mined' && e.x === 1 && e.material === 'diamond'));
  assert.deepStrictEqual(events.filter((e) => e.type === 'diamond_cave_result').map((e) => [e.outcome, e.mined]), [['mined', 2]]);
});

test('blocked : la RAISON est dans le résultat, retenté une fois puis écarté (2 échecs = banni 10 min)', async () => {
  const events = [];
  const strikes = createStrikeStore();
  const t = { x: -311, y: -14, z: 321 };
  let tries = 0;
  const r = await caveHunt(botWith([['iron_pickaxe', 1]]), {
    material: 'diamond', count: 1, emit: (e) => events.push(e), strikeStore: strikes,
    scanLocal: (bot, m, ex) => (ex.has('-311,-14,321') ? null : t), nextOreTarget: () => null,
    oreState: () => 'ore', goTo: async () => true,
    mineTarget: async () => { tries++; return { outcome: 'blocked', why: 'not_visible', mined: 0 }; },
  });
  assert.strictEqual(r.reason, 'no_cave_target');
  assert.strictEqual(tries, 2);
  const res = events.filter((e) => e.type === 'diamond_cave_result');
  assert.deepStrictEqual(res.map((e) => [e.outcome, e.why, e.strikes]), [['blocked', 'not_visible', 1], ['blocked', 'not_visible', 2]]);
  assert.strictEqual(strikes.banned('-311,-14,321'), true);
  assert.strictEqual(strikes.banned('-311,-14,322'), false, 'clé exacte : le voisin de la grappe reste visable');
});

test('blocked sans strikeStore : pas de seconde tentative dans le même appel', async () => {
  let tries = 0;
  const t = { x: 5, y: -50, z: 5 };
  const r = await caveHunt(botWith([['iron_pickaxe', 1]]), {
    material: 'diamond', count: 1, scanLocal: (b, m, ex) => (ex.has('5,-50,5') ? null : t), nextOreTarget: () => null,
    goTo: async () => true, mineTarget: async () => { tries++; return { outcome: 'blocked', why: 'out_of_reach' }; },
  });
  assert.strictEqual(r.reason, 'no_cave_target');
  assert.strictEqual(tries, 1);
});

test('mineTarget gone (disparu à l\'arrivée) → ore_gone, sans strike', async () => {
  const events = [];
  const strikes = createStrikeStore();
  const t = { x: -318, y: -36, z: 315 };
  await caveHunt(botWith([['iron_pickaxe', 1]]), {
    material: 'diamond', count: 1, emit: (e) => events.push(e), strikeStore: strikes,
    scanLocal: (b, m, ex) => (ex.has('-318,-36,315') ? null : t), nextOreTarget: () => null,
    oreState: () => 'ore', goTo: async () => true, mineTarget: async () => ({ outcome: 'gone', why: 'gone' }),
  });
  assert.ok(events.some((e) => e.type === 'ore_gone' && e.x === -318));
  assert.strictEqual(strikes.count('-318,-36,315'), 0);
});

test('coupure : QUI a coupé (by) remonte dans diamond_cave_result', async () => {
  const events = [];
  const replies = [{ reached: false, interrupted: true, why: 'goal_changed', by: 'fleeFrom@fleeFrom.js:12' }, true];
  await caveHunt(botWith([['iron_pickaxe', 1]]), {
    material: 'diamond', count: 1, emit: (e) => events.push(e), scanLocal: () => null,
    nextOreTarget: oneTarget({ x: 2, y: -50, z: 2 }), goTo: async () => replies.shift(),
    mineTarget: async () => ({ outcome: 'mined', mined: 1, broken: true }),
  });
  const res = events.filter((e) => e.type === 'diamond_cave_result');
  assert.deepStrictEqual([res[0].outcome, res[0].why, res[0].by], ['interrupted', 'goal_changed', 'fleeFrom@fleeFrom.js:12']);
});
