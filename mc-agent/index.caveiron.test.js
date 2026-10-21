'use strict';
// CÂBLAGE du fer en grotte (20/10). La logique est dans caveIron.js / skills/caveIron.js ; ici on
// EXÉCUTE le vrai texte des fonctions de index.js dans un bac à sable `vm` strict : un identifiant lu
// hors niveau module (piège #56) → ReferenceError ici, pas en prod. Et on vérifie la FORME réelle de
// la mémoire lue (worlds.<w>.ores {material,x,y,z,exposed,wet}, cf. backend add_ore) — piège #61.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const caveIronPick = require('./caveIron');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(re, label) {
  const m = SRC.match(re);
  assert.ok(m, `${label} introuvable dans index.js (déplacé, renommé, ou déclaré hors niveau module ?)`);
  return m[0];
}
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);
const constSrc = (name) => grab(new RegExp(`^const ${name} = [^;]+;`, 'm'), `const ${name}`);
const letSrc = (name) => grab(new RegExp(`^let ${name} = [^;]+;`, 'm'), `let ${name}`);
const run = (sb, code) => vm.runInContext("'use strict';\n" + code, sb);

const T0 = 1_800_000_000_000;
const ore = (x, y, z, o = {}) => Object.assign({ material: 'iron_ore', x, y, z, at: '2026-10-20T00:00:00Z', exposed: true, wet: false }, o);

function sandbox(o = {}) {
  const clock = { t: T0 };
  const claims = {};
  const sb = {
    events: [], clock, base: o.base || {}, captured: null,
    emit(e) { sb.events.push(e); },
    Date: { now: () => clock.t },
    Object, Math, Number, Array, JSON, Promise, Set, Map, String, RegExp,
    caveIronPick,
    args: { 'world-memory': '/tmp/wm.json' },
    // Forme EXACTE du fichier écrit par le backend (mc_agent_world_memory.add_ore).
    loadMemory: () => ({ worlds: { overworld: { ores: o.ores || [] } } }),
    world: { objective: { type: o.objective || 'iron_armor', status: 'in_progress' } },
    CONFINE: o.confine || null, _confineDyn: null,
    items: o.items || [{ name: 'stone_pickaxe', count: 1 }],
    bot: {
      username: 'NethBot1', _worldKey: 'overworld',
      entity: { position: Object.assign({ x: 0, y: 64, z: 0 }, o.pos || {}) },
      inventory: { items: () => sb.items },
      blockAt: (v) => (o.blockAt ? o.blockAt(v) : { name: 'iron_ore' }),
      canSeeBlock: () => o.canSee !== false,
    },
    loadBaseState: () => sb.base,
    saveBaseState: (st) => { sb.base = st; return true; },
    _teamClaims: o.noClaims ? null : {
      peek: (k) => claims[k] || null,
      tryClaim: (k) => { if (claims[k] && claims[k].by !== 'NethBot1') return false; claims[k] = { by: 'NethBot1', at: clock.t }; return true; },
      refresh: () => true,
      release: (k) => { delete claims[k]; return true; },
    },
    claims,
    taskToken: { cancelled: false },
    vec3Lib: (x, y, z) => ({ x, y, z }),
    isInWater: () => false,
    isLumberjackObjective: () => false,
    homewarp: { bookmark: () => true },
    HOME_WORK: 'work', _workSet: false, _workPos: null, _botXZ: () => ({ x: 0, z: 0 }),
    caveIronSkill: async (opts) => { sb.captured = opts; return o.skillResult || { ok: true, mined: 4 }; },
  };
  vm.createContext(sb);
  run(sb, [constSrc('IRON_CAVE_CACHE_MS'), letSrc('_ironCaveCache'), constSrc('IRON_CAVE_OBJECTIVES'),
    fnSrc('_caveInvTier'), fnSrc('_caveWorldOres'), fnSrc('loadCaveFails'), fnSrc('noteCaveTried'),
    fnSrc('ironCaveCtx'), fnSrc('runCaveIron'),
    'this.ironCaveCtx = ironCaveCtx; this.runCaveIron = runCaveIron; this.noteCaveTried = noteCaveTried;',
    'this.resetCache = () => { _ironCaveCache = { at: 0, cave: null }; };'].join('\n'));
  return sb;
}

const GRAPPE = [ore(20, 50, 0), ore(22, 50, 0), ore(24, 51, 1, { material: 'deepslate_iron_ore' })];

test('ctxExtra expose ironCave (sinon le but est mort-né)', () => {
  assert.match(fnSrc('ctxExtra'), /ironCave: ironCaveCtx\(\)/);
});

test('ironCaveCtx : lit worlds.<w>.ores du backend, rend la grappe', () => {
  const sb = sandbox({ ores: GRAPPE });
  const c = sb.ironCaveCtx();
  assert.ok(c);
  assert.strictEqual(c.count, 3);
  assert.ok(c.key.startsWith('cave:'));
});

test('ironCaveCtx : null hors chaîne armure, sans pioche pierre, minerais enterrés', () => {
  assert.strictEqual(sandbox({ ores: GRAPPE, objective: 'lumberjack' }).ironCaveCtx(), null);
  assert.strictEqual(sandbox({ ores: GRAPPE, objective: 'mapper' }).ironCaveCtx(), null);
  assert.ok(sandbox({ ores: GRAPPE, objective: 'diamond_armor' }).ironCaveCtx());
  assert.strictEqual(sandbox({ ores: GRAPPE, items: [{ name: 'wooden_pickaxe', count: 1 }] }).ironCaveCtx(), null);
  assert.strictEqual(sandbox({ ores: GRAPPE.map((g) => Object.assign({}, g, { exposed: false })) }).ironCaveCtx(), null);
});

test('ironCaveCtx : cache 30 s (on ne relit pas la carte à chaque pas du planner)', () => {
  let reads = 0;
  const sb = sandbox({ ores: GRAPPE });
  const lm = sb.loadMemory;
  sb.loadMemory = () => { reads++; return lm(); };
  sb.ironCaveCtx(); sb.ironCaveCtx();
  assert.strictEqual(reads, 1);
  sb.clock.t += 31000;
  sb.ironCaveCtx();
  assert.strictEqual(reads, 2);
});

test('ironCaveCtx : grappe claimée par un coéquipier → null', () => {
  const sb = sandbox({ ores: GRAPPE });
  const key = sb.ironCaveCtx().key;
  sb.claims[key] = { by: 'NethBot2', at: T0 };
  sb.resetCache();
  assert.strictEqual(sb.ironCaveCtx(), null);
});

test('runCaveIron : claim → skill → release, essai PERSISTÉ dans le mémo base (fusion)', async () => {
  const sb = sandbox({ ores: GRAPPE, base: { deathDebt: { x: 1 } } });
  const r = await sb.runCaveIron();
  assert.strictEqual(r.ok, true);
  assert.ok(sb.captured && sb.captured.cave.count === 3);
  assert.strictEqual(sb.captured.world, 'overworld');
  assert.deepStrictEqual(Object.keys(sb.claims), []);                 // relâchée
  assert.deepStrictEqual(sb.base.deathDebt, { x: 1 });                 // le reste du mémo intact
  assert.strictEqual(sb.base.caveFails.length, 1);
  assert.strictEqual(sb.base.caveFails[0].why, 'done');
  sb.resetCache();
  assert.strictEqual(sb.ironCaveCtx(), null);                          // pas re-ciblée avant 30 min
  sb.clock.t += caveIronPick.CAVE_FAIL_TTL_MS + 1000;
  sb.resetCache();
  assert.ok(sb.ironCaveCtx());
});

test('runCaveIron : échec persisté avec sa raison ; annulation NON persistée', async () => {
  const sb = sandbox({ ores: GRAPPE, skillResult: { ok: false, reason: 'unreachable' } });
  await sb.runCaveIron();
  assert.strictEqual(sb.base.caveFails[0].why, 'unreachable');
  const sb2 = sandbox({ ores: GRAPPE, skillResult: { ok: false, reason: 'cancelled' } });
  await sb2.runCaveIron();
  assert.strictEqual(sb2.base.caveFails, undefined);
});

test('runCaveIron : claim refusée → cave_failed claimed, skill non lancé', async () => {
  const sb = sandbox({ ores: GRAPPE });
  const key = sb.ironCaveCtx().key;
  sb.resetCache();
  sb._teamClaims.peek = () => null;                                     // la lecture était en retard
  sb.claims[key] = { by: 'NethBot2', at: T0 };
  const r = await sb.runCaveIron();
  assert.strictEqual(r.reason, 'claimed');
  assert.strictEqual(sb.captured, null);
  assert.strictEqual(sb.events.at(-1).why, 'claimed');
});

test('runCaveIron : sans grappe → no_cave_target', async () => {
  const r = await sandbox({ ores: [] }).runCaveIron();
  assert.strictEqual(r.reason, 'no_cave_target');
});

test('runCaveIron : sondes passées au skill (état du minerai, vue, home work)', async () => {
  const sb = sandbox({ ores: GRAPPE, blockAt: (v) => (v.x === 20 ? { name: 'iron_ore' } : (v.x === 22 ? { name: 'stone' } : null)) });
  await sb.runCaveIron();
  const d = sb.captured;
  assert.strictEqual(d.oreState({ x: 20, y: 50, z: 0 }), 'ore');
  assert.strictEqual(d.oreState({ x: 22, y: 50, z: 0 }), 'gone');
  assert.strictEqual(d.oreState({ x: 99, y: 50, z: 0 }), 'unknown');
  assert.strictEqual(d.canSee({ x: 20, y: 50, z: 0 }), true);
  assert.strictEqual(d.canSee({ x: 99, y: 50, z: 0 }), false);
  assert.strictEqual(d.markWork(), true);
  assert.strictEqual(sb._workSet, true);
  assert.strictEqual(sb.events.find((e) => e.type === 'work_bookmarked').why, 'iron_cave');
  const sb2 = sandbox({ ores: GRAPPE, canSee: false });
  await sb2.runCaveIron();
  assert.strictEqual(sb2.captured.canSee({ x: 20, y: 50, z: 0 }), false);
});

test('dispatch : runGoalSkill route caveIron, armure avant la grotte, timeout déclaré', () => {
  const rgs = fnSrc('runGoalSkill');
  assert.match(rgs, /goal\.skill === 'caveIron'\) return await runCaveIron\(\)/);
  assert.match(rgs, /goal\.skill === 'branchMine' \|\| goal\.skill === 'caveIron'/);
  assert.match(constSrc('SKILL_TIMEOUTS'), /caveIron: \d+/);
});
