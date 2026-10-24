'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { caveIron, TORCH_EVERY_ORES } = require('./caveIron');

const cave = (n = 3) => ({
  key: 'cave:1,2,0', x: 20, y: 40, z: 2, count: n, dist: 30,
  ores: Array.from({ length: n }, (_, i) => ({ material: 'iron_ore', x: 20 + 2 * i, y: 40, z: 2 })),
});

function deps(o = {}) {
  const d = {
    events: [], calls: [], clock: { t: 1000 },
    state: o.state || {},          // "x,y,z" → 'ore'|'gone'|'unknown'
  };
  const k = (ore) => `${ore.x},${ore.y},${ore.z}`;
  Object.assign(d, {
    world: 'overworld',
    emit: (e) => d.events.push(e),
    now: () => d.clock.t,
    travel: async () => { d.calls.push('travel'); return o.travel !== false; },
    markWork: () => { d.calls.push('work'); return true; },
    placeTorch: async () => { d.calls.push('torch'); },
    survivalTick: async () => { d.calls.push('survival'); },
    refreshClaim: () => { d.calls.push('refresh'); },
    oreState: (ore) => d.state[k(ore)] || 'ore',
    approach: async (ore) => { d.calls.push('approach:' + ore.x); if (o.step) d.clock.t += o.step; return !(o.unreach || []).includes(ore.x); },
    canSee: (ore) => !(o.hidden || []).includes(ore.x),
    mineVein: async (ore) => { d.calls.push('mine:' + ore.x); d.state[k(ore)] = 'gone'; return o.veinGain || 1; },
  }, o.over || {});
  return d;
}
const types = (d) => d.events.map((e) => e.type);

test('chemin nominal : cave_target → travel → work → mine chaque minerai → cave_mined', async () => {
  const d = deps();
  const r = await caveIron(Object.assign({ cave: cave(3) }, d));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.mined, 3);
  assert.deepStrictEqual(types(d), ['cave_target', 'ore_mined', 'ore_mined', 'ore_mined', 'cave_mined']);
  const tgt = d.events[0];
  assert.deepStrictEqual([tgt.x, tgt.y, tgt.z, tgt.ores, tgt.dist], [20, 40, 2, 3, 30]);
  assert.strictEqual(d.events[1].world, 'overworld');
  assert.strictEqual(d.calls.indexOf('travel'), 0);
  assert.ok(d.calls.indexOf('work') < d.calls.indexOf('mine:20'));      // home work AVANT de miner
  assert.strictEqual(d.calls.filter((c) => c === 'survival').length, 3);
  assert.strictEqual(d.calls.filter((c) => c === 'torch').length, 1 + Math.floor(3 / TORCH_EVERY_ORES));
  assert.strictEqual(d.events[4].ores, 3);
  assert.ok(Number.isFinite(d.events[4].took_s));
});

test('minerai absent à l\'arrivée : ore_gone (retire de la carte) et on continue la grappe', async () => {
  const d = deps({ state: { '22,40,2': 'gone' } });
  const r = await caveIron(Object.assign({ cave: cave(3) }, d));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.mined, 2);
  const g = d.events.find((e) => e.type === 'ore_gone');
  assert.deepStrictEqual([g.x, g.y, g.z, g.world], [22, 40, 2, 'overworld']);
  assert.ok(!d.calls.includes('mine:22'));
});

test('filon : les voisins déjà emportés par mineVein sont signalés gone, pas re-minés', async () => {
  const d = deps({ over: {} });
  d.mineVein = async (ore) => { d.calls.push('mine:' + ore.x); for (const x of [20, 22, 24]) d.state[`${x},40,2`] = 'gone'; return 3; };
  const r = await caveIron(Object.assign({ cave: cave(3) }, d));
  assert.strictEqual(r.mined, 3);
  assert.deepStrictEqual(d.calls.filter((c) => c.startsWith('mine:')), ['mine:20']);
  assert.strictEqual(d.events.filter((e) => e.type === 'ore_gone').length, 2);
});

test('minerai non visible : jamais miné (pas à travers la paroi)', async () => {
  const d = deps({ hidden: [20, 22, 24] });
  const r = await caveIron(Object.assign({ cave: cave(3) }, d));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'hidden');
  assert.strictEqual(r.hidden, 3);
  assert.ok(!d.calls.some((c) => c.startsWith('mine:')));
  assert.strictEqual(d.events.at(-1).type, 'cave_failed');
  assert.strictEqual(d.events.at(-1).why, 'hidden');
});

test('grappe inatteignable → cave_failed unreachable, rien miné', async () => {
  const d = deps({ travel: false });
  const r = await caveIron(Object.assign({ cave: cave(3) }, d));
  assert.deepStrictEqual([r.ok, r.reason], [false, 'unreachable']);
  assert.deepStrictEqual(types(d), ['cave_target', 'cave_failed']);
  assert.ok(!d.calls.includes('work'));
});

test('trajet COUPÉ (travel → interrupted) → cave_failed interrupted, pas unreachable (22/10)', async () => {
  const d = deps({ over: { travel: async () => 'interrupted' } });
  const r = await caveIron(Object.assign({ cave: cave(3) }, d));
  assert.deepStrictEqual([r.ok, r.reason], [false, 'interrupted']);
  assert.strictEqual(d.events[1].why, 'interrupted');
  assert.ok(!d.calls.includes('work'));
});

test('toute la grappe disparue → all_gone', async () => {
  const st = { '20,40,2': 'gone', '22,40,2': 'gone', '24,40,2': 'gone' };
  const d = deps({ state: st });
  const r = await caveIron(Object.assign({ cave: cave(3) }, d));
  assert.strictEqual(r.reason, 'all_gone');
  assert.strictEqual(d.events.filter((e) => e.type === 'ore_gone').length, 3);
});

test('borné en temps : au-delà de maxMs on s\'arrête (succès partiel si déjà du fer)', async () => {
  const d = deps({ step: 200_000 });                     // chaque approche coûte 200 s
  const r = await caveIron(Object.assign({ cave: cave(5), maxMs: 360_000 }, d));
  assert.strictEqual(r.ok, true);
  assert.ok(r.mined >= 1 && r.mined < 5);
  const d2 = deps({ step: 400_000, unreach: [20] });
  const r2 = await caveIron(Object.assign({ cave: cave(5), maxMs: 360_000 }, d2));
  assert.deepStrictEqual([r2.ok, r2.reason], [false, 'timeout']);
});

test('long trajet (escalier dirigé) : le temps de minage reste garanti après l\'arrivée (22/10)', async () => {
  const d = deps();
  d.travel = async () => { d.clock.t += 340_000; return true; };   // 5 min 40 de trajet sur 6 min
  const r = await caveIron(Object.assign({ cave: cave(3), maxMs: 360_000 }, d));
  assert.deepStrictEqual([r.ok, r.mined], [true, 3]);
});

test('annulation (jeton) : on rend la main', async () => {
  const tok = { cancelled: false };
  const d = deps();
  d.travel = async () => { tok.cancelled = true; return true; };
  const r = await caveIron(Object.assign({ cave: cave(3) }, d), tok);
  assert.deepStrictEqual([r.ok, r.reason], [false, 'cancelled']);
});

test('dépendances qui jettent : jamais de throw, cible absente → no_cave_target', async () => {
  const d = deps();
  d.placeTorch = async () => { throw new Error('x'); };
  d.survivalTick = () => { throw new Error('y'); };
  d.markWork = undefined;
  const r = await caveIron(Object.assign({ cave: cave(2) }, d));
  assert.strictEqual(r.ok, true);
  const r2 = await caveIron({ cave: null, emit: d.emit });
  assert.strictEqual(r2.reason, 'no_cave_target');
});

test('minerai non lu (unknown) après approche : pas miné, compté inatteint', async () => {
  const d = deps({ state: { '20,40,2': 'unknown', '22,40,2': 'unknown', '24,40,2': 'unknown' } });
  const r = await caveIron(Object.assign({ cave: cave(3) }, d));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.unreached, 3);
  assert.strictEqual(r.reason, 'nothing_mined');
});

// ── MESURE trajet vs minage (23/10) : iron_got + travel_s / mine_s sur la fin de chaque essai ──
test('cave_mined porte iron_got, travel_s et mine_s (horloge injectée)', async () => {
  let t = 0;
  const d = deps({ over: {
    now: () => t,
    travel: async () => { t += 90000; return true; },
    mineVein: async () => { t += 10000; return 2; },
  } });
  const r = await caveIron(Object.assign({ cave: cave(3) }, d));
  const end = d.events.at(-1);
  assert.strictEqual(end.type, 'cave_mined');
  assert.deepStrictEqual([end.iron_got, end.travel_s, end.mine_s, end.took_s], [6, 90, 30, 120]);
  assert.deepStrictEqual([r.iron_got, r.travel_s, r.mine_s], [6, 90, 30]);
});

test('cave_failed porte iron_got = 0 et le temps de trajet perdu', async () => {
  let t = 0;
  const d = deps({ over: { now: () => t, travel: async () => { t += 175000; return false; } } });
  const r = await caveIron(Object.assign({ cave: cave(3) }, d));
  const end = d.events.at(-1);
  assert.deepStrictEqual([end.type, end.why, end.iron_got, end.travel_s, end.mine_s, end.took_s],
    ['cave_failed', 'unreachable', 0, 175, 0, 175]);
  assert.strictEqual(r.iron_got, 0);
});

test('cave_target porte la source (live = fer vu par le bot, map = carte) — mesure 24/10', async () => {
  const d = deps();
  await caveIron(Object.assign({ cave: Object.assign(cave(1), { src: 'live' }) }, d));
  assert.strictEqual(d.events[0].src, 'live');
  const d2 = deps();
  await caveIron(Object.assign({ cave: cave(1) }, d2));
  assert.strictEqual(d2.events[0].src, 'map');
});
