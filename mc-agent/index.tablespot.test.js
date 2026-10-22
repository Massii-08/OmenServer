'use strict';
// CÂBLAGE du 22/10 (NethBot3 : `crafting_table` timeout ×4, `spare_picks` `no_table:no_space` ×4) — on
// exécute le VRAI texte de index.js dans un bac à sable `vm` strict (piège #56).
//   reclaimBlock        : collectBlock BORNÉ (il pathfindait sans fin vers une table hors d'atteinte)
//   recycleNearbyTable  : table d'un autre étage ignorée ; goto raté → liste noire, pas de reprise
//   withCraftingTable   : 2 échecs no_space au même endroit → se décaler (stepAsideForTable) puis re-tenter
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const TS = require('./tableSpot');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(re, label) {
  const m = SRC.match(re);
  assert.ok(m, `${label} introuvable dans index.js (déplacé, renommé, ou déclaré hors niveau module ?)`);
  return m[0];
}
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);
const constSrc = (name) => grab(new RegExp(`^const ${name} = [^;]+;`, 'm'), `const ${name}`);
const run = (sb, code) => vm.runInContext("'use strict';\n" + code, sb);

function v(x, y, z) {
  return { x, y, z,
    distanceTo(o) { return Math.hypot(o.x - this.x, o.y - this.y, o.z - this.z); },
    floored() { return v(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)); } };
}

function sandbox(o = {}) {
  const sb = {
    events: [], gotos: [], blacklisted: [], collects: 0,
    emit(e) { sb.events.push(e); },
    recycleWorthIt: TS.recycleWorthIt, createNoSpaceMemo: TS.createNoSpaceMemo, stepAsideCells: TS.stepAsideCells,
    TABLE_SEEK: 48, TABLE_REACH: 6,
    _badTables: { has: () => false },
    _nearestTable: o.nearestTable || (() => null),
    stopMotion: () => { sb.stopped = (sb.stopped || 0) + 1; },
    sleep: async () => {},
    taskToken: { cancelled: false },
    vec3Lib: (x, y, z) => ({ x, y, z }),
    Math, Date, Promise, setTimeout, clearTimeout,
    bestToolFor: () => null,
    pfGoals: {
      GoalNear: function (x, y, z) { this.x = x; this.y = y; this.z = z; },
      GoalBlock: function (x, y, z) { this.x = x; this.y = y; this.z = z; this.block = true; },
    },
    bot: {
      entity: { position: o.pos || v(0.5, 15, 0.5) },
      registry: { blocksByName: { crafting_table: { id: 58 } } },
      findBlock: () => null,
      blockAt: o.blockAt || (() => null),
      equip: async () => {},
      inventory: { items: () => (o.items || []) },
      collectBlock: { collect: o.collect || (() => { sb.collects++; return new Promise(() => {}); }), cancelTask: () => { sb.cancelled = true; } },
      pathfinder: { goto: async (g) => { sb.gotos.push(g); if (o.onGoto) o.onGoto(g, sb); } },
    },
  };
  vm.createContext(sb);
  run(sb, [fnSrc('withTimeout'), constSrc('RECLAIM_COLLECT_MS').replace(/= \d+;/, '= 30;'),
    fnSrc('reclaimBlock'), fnSrc('recycleNearbyTable'),
    'const _noSpaceMemo = createNoSpaceMemo();', constSrc('STEP_ASIDE_GOTO_MS'), fnSrc('stepAsideForTable'),
    'this.reclaimBlock = reclaimBlock; this.recycleNearbyTable = recycleNearbyTable; this.stepAsideForTable = stepAsideForTable;',
    'this.memo = _noSpaceMemo;'].join('\n'));
  return sb;
}

test('reclaimBlock : collectBlock qui ne rend jamais la main → borné, annulé, reclaim_failed, sans 2e essai', async () => {
  const sb = sandbox({ blockAt: (p) => ({ name: 'crafting_table', boundingBox: 'block', position: p }) });
  const t0 = Date.now();
  await sb.reclaimBlock(v(0, 53, 0));
  assert.ok(Date.now() - t0 < 2000);
  assert.strictEqual(sb.collects, 1, 'pas de 2e collect à l\'aveugle après un timeout');
  assert.strictEqual(sb.cancelled, true);
  assert.ok(sb.events.some((e) => e.type === 'reclaim_failed'));
});

test('recycleNearbyTable : table abandonnée 38 blocs plus haut (cas NethBot3) → liste noire, AUCUN trajet', async () => {
  const table = { position: v(-309, 53, 342) };
  const sb = sandbox({ pos: v(-304.5, 15, 331.5), nearestTable: () => table });
  const r = await sb.recycleNearbyTable((p, why) => sb.blacklisted.push(why));
  assert.strictEqual(r, null, 'aucune candidate → l\'appelant fabrique sur place');
  assert.deepStrictEqual(sb.blacklisted, ['other_level']);
  assert.strictEqual(sb.gotos.length, 0);
  assert.strictEqual(sb.collects, 0);
});

test('recycleNearbyTable : même étage mais goto raté → liste noire unreachable, pas de reprise', async () => {
  const table = { position: v(20, 16, 0) };
  const sb = sandbox({ nearestTable: () => table });        // goto ne bouge pas le bot
  const r = await sb.recycleNearbyTable((p, why) => sb.blacklisted.push(why));
  assert.strictEqual(r, false);
  assert.deepStrictEqual(sb.blacklisted, ['unreachable']);
  assert.strictEqual(sb.collects, 0, 'pas de collectBlock vers une table qu\'on n\'a pas atteinte');
  assert.ok(sb.events.some((e) => e.type === 'table_recycled' && e.ok === false && e.why === 'unreachable'));
});

test('stepAsideForTable : tunnel vers l\'est → GoalBlock à 2 blocs, déplacé, event ok', async () => {
  const world = {};
  for (let x = -1; x <= 5; x++) { world[`${x},14,0`] = 'stone'; world[`${x},15,0`] = 'air'; world[`${x},16,0`] = 'air'; }
  world['-2,15,0'] = 'stone';
  const sb = sandbox({
    blockAt: (p) => { const n = world[`${p.x},${p.y},${p.z}`]; return n ? { name: n, boundingBox: n === 'air' ? 'empty' : 'block' } : null; },
    onGoto: (g, s) => { s.bot.entity.position = v(g.x + 0.5, g.y, g.z + 0.5); },
  });
  assert.strictEqual(await sb.stepAsideForTable(), true);
  assert.ok(sb.gotos[0].block && sb.gotos[0].x === 2 && sb.gotos[0].z === 0, JSON.stringify(sb.gotos[0]));
  assert.ok(sb.events.some((e) => e.type === 'table_step_aside' && e.ok === true && e.dist === 2));
});

test('stepAsideForTable : aucune case praticable → false, event ok:false (jamais de boucle muette)', async () => {
  const sb = sandbox({});
  assert.strictEqual(await sb.stepAsideForTable(), false);
  assert.ok(sb.events.some((e) => e.type === 'table_step_aside' && e.ok === false));
});

test('withCraftingTable (source) : no_space noté par endroit, décalage AVANT le repli findLandTarget, jamais en inPlace ni sur unloaded', () => {
  const body = fnSrc('withCraftingTable');
  const i = body.indexOf('_noSpaceMemo.note(');
  const j = body.indexOf('stepAsideForTable()');
  const k = body.indexOf('findLandTarget(bot, 24)');
  assert.ok(i > 0 && j > i && k > j, 'note → décalage → repli');
  assert.match(body, /place\.reason === 'no_space' && !place\.unloaded/);
  assert.match(body, /!inPlace && _noSpaceMemo\.shouldShift\(/);
  assert.match(SRC, /^const _noSpaceMemo = createNoSpaceMemo\(\);/m, 'mémoire au NIVEAU MODULE (#56)');
});
