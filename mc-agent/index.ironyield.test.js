'use strict';
// CÂBLAGE du rendement fer (22/10, chrono world_oct22 : 12 `ore_mined` en 61 min pour la flotte).
// Le vrai texte des fonctions de index.js tourne dans un bac à sable `vm` strict : un identifiant lu
// hors niveau module (piège #56) → ReferenceError ici, pas en prod.
//   - trajets de grotte COUPÉS → `interrupted`, hors disjoncteur (faux `unreachable` → iron_cave coupé 2 h)
//   - escalier dirigé vers une grappe profonde (caveAccessible retiré, mémoire 943e2c : 3 entrées de grotte)
//   - junk jeté DERRIÈRE soi (il était re-ramassé au pas suivant : 11 tris d'affilée à 22 cases libres)
//   - branch-mine en lacets repris AU FRONT (10 appels repartis du même home work)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const caveIronPick = require('./caveIron');
const lawnMine = require('./lawnMine');

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
const plain = (v) => JSON.parse(JSON.stringify(v));

const T0 = 1_800_000_000_000;

// ═════════════════════ 1. verdict d'un trajet raté (pur) ═══════════════════════════════════════════
function verdictSandbox() {
  const sb = { Number, Math, Array, String };
  vm.createContext(sb);
  run(sb, [constSrc('CAVE_PULLED_AWAY'), fnSrc('caveTravelVerdict'), 'this.v = caveTravelVerdict;'].join('\n'));
  return sb;
}

test('caveTravelVerdict : TP, but volé (GoalChanged), bot emmené plus loin → interrupted ; sinon unreachable (false)', () => {
  const { v } = verdictSandbox();
  assert.strictEqual(v({ teleported: true, errs: [], d0: 30, d1: 30 }), 'interrupted');
  const gc = new Error('The goal was changed before it could be completed!'); gc.name = 'GoalChanged';
  assert.strictEqual(v({ teleported: false, errs: [gc], d0: 6, d1: 6 }), 'interrupted');
  assert.strictEqual(v({ errs: [{ message: 'The goal was changed before it could be completed!' }], d0: 6, d1: 6 }), 'interrupted');
  assert.strictEqual(v({ errs: [], d0: 20, d1: 40 }), 'interrupted', 'fuite / poussée : plus loin qu\'au départ');
  const np = new Error('No path to the goal!'); np.name = 'NoPath';
  assert.strictEqual(v({ errs: [np], d0: 20, d1: 18 }), false);
  assert.strictEqual(v({}), false);
  // PathStopped venu d'ailleurs (réflexe de combat, couvert) = coupure ; provoqué par NOTRE échéance = non
  const ps = new Error('Path was stopped before it could be completed! Thus, the desired goal was not reached.'); ps.name = 'PathStopped';
  assert.strictEqual(v({ errs: [ps], d0: 12, d1: 12 }), 'interrupted');
  assert.strictEqual(v({ errs: [{ name: 'OwnTimeout' }, ps], d0: 12, d1: 12 }), false);
  // l'escalier n'a pas atteint la couche → stair_missed (hors disjoncteur), pas unreachable
  assert.strictEqual(v({ errs: [np], d0: 20, d1: 18, stairMissed: true }), 'stair_missed');
});

test('_caveGotoOre : l\'erreur du pathfinder ARRIVE au verdict malgré withTimeout (qui avale les rejets)', async () => {
  const errs = [];
  const sb = {
    Math, Promise, setTimeout, clearTimeout,
    bot: { entity: { position: { x: 0, y: 30, z: 0 } }, pathfinder: { goto: async () => { const e = new Error('Path was stopped'); e.name = 'PathStopped'; throw e; } } },
    openNeighborOf: () => null,
    pfGoals: { GoalNear: function () {} },
    Movements: function () {},
    withTempMovements: async (b, M, c, fn) => fn(),
    stopMotion() {},
  };
  vm.createContext(sb);
  run(sb, [fnSrc('withTimeout'), fnSrc('_caveGotoOre'), 'this.go = _caveGotoOre;'].join('\n'));
  assert.strictEqual(await sb.go({ x: 40, y: 30, z: 0 }, { cancelled: false }, errs), false);
  assert.deepStrictEqual(errs.map((e) => e.name), ['PathStopped', 'PathStopped']);
});

// ═════════════════════ 2. runCaveIron : coupure ≠ verdict ══════════════════════════════════════════
const ore = (x, y, z, o = {}) => Object.assign({ material: 'iron_ore', x, y, z, at: '2026-10-22T00:00:00Z', exposed: true, wet: false }, o);
const GRAPPE = [ore(20, 50, 0), ore(22, 50, 0), ore(24, 51, 1)];

function caveSandbox(o = {}) {
  const clock = { t: T0 };
  const sb = {
    events: [], clock, base: o.base || {}, results: (o.results || []).slice(), captured: null,
    emit(e) { sb.events.push(e); },
    Date: { now: () => clock.t },
    Object, Math, Number, Array, JSON, Promise, Set, Map, String, RegExp,
    caveIronPick,
    args: { 'world-memory': '/tmp/wm.json' },
    loadMemory: () => ({ worlds: { overworld: { ores: o.ores || GRAPPE, caves: [] } } }),
    world: { objective: { type: 'iron_armor', status: 'in_progress' } },
    CONFINE: null, _confineDyn: null,
    bot: {
      username: 'NethBot2', _worldKey: 'overworld',
      entity: { position: { x: 0, y: 64, z: 0 } },
      inventory: { items: () => [{ name: 'stone_pickaxe', count: 1 }] },
      blockAt: () => ({ name: 'iron_ore' }),
    },
    loadBaseState: () => sb.base,
    saveBaseState: (st) => { sb.base = st; return true; },
    _teamClaims: null,
    taskToken: { cancelled: false },
    vec3Lib: (x, y, z) => ({ x, y, z }),
    isInWater: () => false,
    isLumberjackObjective: () => false,
    homewarp: { bookmark: () => true },
    HOME_WORK: 'work', _workSet: false, _workPos: null, _botXZ: () => ({ x: 0, z: 0 }),
    caveIronSkill: async (opts) => { sb.captured = opts; return sb.results.shift() || { ok: false, reason: 'interrupted' }; },
    oresScan: { scanExposedOres: () => [], isWaterAdjacent: () => false },   // fer VU (24/10) : rien en vue ici
  };
  vm.createContext(sb);
  run(sb, [constSrc('IRON_CAVE_CACHE_MS'), letSrc('_ironCaveCache'), constSrc('IRON_CAVE_OBJECTIVES'),
    letSrc('_caveCooldownEmitted'), letSrc('_caveDisabledEmitted'),
    letSrc('_tpCount'), letSrc('_caveTripBusy'), letSrc('_caveInterrupts'), constSrc('CAVE_INTERRUPT_WINDOW_MS'),
    letSrc('_caveLastRawIron'), letSrc('_caveTooFarEmitAt'),
    fnSrc('_caveRawIron'), fnSrc('_caveBudgetBlocks'), fnSrc('_caveBudgetRecord'),
    fnSrc('_caveInvTier'), fnSrc('_caveLiveIronScan'), fnSrc('_caveWorld'), fnSrc('loadCaveFails'), fnSrc('noteCaveTried'),
    fnSrc('ironCaveCtx'), fnSrc('runCaveIron'),
    'this.runCaveIron = runCaveIron; this.busy = () => _caveTripBusy;'].join('\n'));
  return sb;
}

test('runCaveIron : 1re coupure → rien noté (la grappe reste ciblable) ; 2e en 10 min → mise de côté, HORS disjoncteur', async () => {
  const sb = caveSandbox();
  const r1 = await sb.runCaveIron();
  assert.strictEqual(r1.reason, 'interrupted');
  assert.ok(!sb.base.caveFails || sb.base.caveFails.length === 0, 'une coupure n\'est pas un verdict');
  sb.clock.t += 60_000;
  await sb.runCaveIron();
  assert.strictEqual(sb.base.caveFails.length, 1);
  assert.strictEqual(sb.base.caveFails[0].why, 'interrupted');
  // 3 coupures (sur 3 grappes) n'arment jamais le disjoncteur `unreachable`
  const fails = ['interrupted', 'interrupted', 'interrupted'].map((why, i) => ({ x: i * 20, y: 50, z: 0, key: 'k' + i, why, at: T0 - i * 60_000 }));
  assert.strictEqual(caveIronPick.caveCooldownUntil(fails, T0), 0);
});

test('runCaveIron : drapeau _caveTripBusy levé PENDANT le trajet (lu par trySquad/tryRegroup), rabaissé après', async () => {
  const sb = caveSandbox();
  let during = null;
  sb.caveIronSkill = async () => { during = sb.busy(); return { ok: true, mined: 3 }; };
  await sb.runCaveIron();
  assert.strictEqual(during, true);
  assert.strictEqual(sb.busy(), false);
});

test('runCaveIron : stair_missed noté (mise de côté 30 min) mais n\'arme jamais le disjoncteur', async () => {
  const sb = caveSandbox({ results: [{ ok: false, reason: 'stair_missed' }] });
  await sb.runCaveIron();
  assert.strictEqual(sb.base.caveFails[0].why, 'stair_missed');
  const fails = [0, 1, 2].map((i) => ({ x: i * 20, y: 50, z: 0, key: 'k' + i, why: 'stair_missed', at: T0 - i * 60_000 }));
  assert.strictEqual(caveIronPick.caveCooldownUntil(fails, T0), 0);
});

test('runCaveIron : un vrai unreachable reste noté comme avant (le disjoncteur est gardé)', async () => {
  const sb = caveSandbox({ results: [{ ok: false, reason: 'unreachable' }] });
  await sb.runCaveIron();
  assert.strictEqual(sb.base.caveFails[0].why, 'unreachable');
});

test('index.js : le trajet de grotte passe par l\'escalier dirigé puis l\'approche fine, et rend le verdict', () => {
  const body = fnSrc('runCaveIron');
  assert.match(body, /stair = await _caveStairTo\(e, tok\)/);
  assert.match(body, /return caveTravelVerdict\(\{ teleported: _tpCount > tp0, errs, d0, d1, stairMissed: !!\(stair && stair\.tried && !stair\.reached\) \}\);/);
  assert.match(body, /if \(stair && stair\.teleported\) return 'interrupted';/);
  assert.ok(body.indexOf('await _caveStairTo(e, tok)') < body.indexOf('_caveGotoOre(e, tok, errs)'));
  assert.match(SRC, /_floatSettleUntil = Date\.now\(\) \+ 15000; _tpCount\+\+; \}/, 'onTeleport compte les TP');
  assert.match(SRC, /_caveTripBusy \|\| _craftDepth > 0( \|\| _skelRushBusy)?( \|\| _huntCookBusy > 0)?;\n  const pick = squadTarget\(/, 'trySquad respecte le trajet de grotte');
});

// ═════════════════════ 3. escalier dirigé ══════════════════════════════════════════════════════════
function stairSandbox(o = {}) {
  const sb = {
    events: [], looks: [], descends: [], gotos: [],
    emit(e) { sb.events.push(e); },
    Object, Math, Number, Array, JSON, Promise, String, RegExp,
    caveIronPick,
    bot: {
      entity: { position: Object.assign({ x: 0, y: 70, z: 0 }, o.pos || {}) },
      look: async (yaw) => { sb.looks.push(yaw); },
      pathfinder: { goto: async (g) => { sb.gotos.push(g); if (o.walk) Object.assign(sb.bot.entity.position, o.walk); } },
    },
    Movements: function M() {},
    pfGoals: {
      GoalNearXZ: function (x, z, r) { this.x = x; this.z = z; this.r = r; },
      GoalNear: function (x, y, z, r) { this.x = x; this.y = y; this.z = z; this.r = r; this.near3d = true; },
    },
    withTempMovements: async (b, M, cfg, fn) => fn(),
    withTimeout: async (p) => p,
    stopMotion() {},
    descentSurvivalTick: async () => {},
    descendDiagonal: async (b, opts) => {
      sb.descends.push(plain(opts));
      const r = (o.descend || []).shift() || { ok: true };
      // Simule l'escalier marche par marche : stopWhen relu à chaque marche (comme descendDiagonal).
      if (r.toY !== undefined) {
        while (b.entity.position.y > r.toY) {
          if (opts.stopWhen && opts.stopWhen()) return { ok: true, stopped: true };
          if (r.tpAtY !== undefined && b.entity.position.y <= r.tpAtY) { sb.bump(); Object.assign(b.entity.position, r.tpTo); delete r.tpAtY; continue; }
          b.entity.position.y -= 1; b.entity.position.x += 1;
        }
      }
      return r;
    },
  };
  vm.createContext(sb);
  run(sb, [letSrc('_tpCount'), fnSrc('_caveStairTo'), 'this.stair = _caveStairTo; this.bump = () => { _tpCount++; };'].join('\n'));
  return sb;
}

test('_caveStairTo : marche au départ du plan, se tourne VERS la grappe, S\'ARRÊTE à sa couche (± 1)', async () => {
  const sb = stairSandbox({ walk: { x: 0, z: 10 }, descend: [{ ok: false, toY: -20 }] });   // l'escalier irait à -20 si on le laissait
  const r = await sb.stair({ x: 50, y: 32, z: 10 }, { cancelled: false });
  assert.deepStrictEqual(plain(r), { tried: true, reached: true, overshot: false, teleported: false });
  assert.ok(Math.abs(sb.bot.entity.position.y - 32) <= 1, `arrêté à y=${sb.bot.entity.position.y}`);
  assert.strictEqual(sb.gotos.length, 1);
  assert.deepStrictEqual([sb.gotos[0].x, sb.gotos[0].z], [12, 10], "départ 38 blocs avant la grappe (drop 70→32)");
  assert.strictEqual(sb.looks[0], caveIronPick.yawOf({ dx: 1, dz: 0 }));
  assert.ok(sb.events.some((e) => e.type === 'cave_stair') && sb.events.some((e) => e.type === 'cave_stair_done' && e.reached));
});

test('_caveStairTo : TÉLÉPORTÉ en plein escalier (mort, /tpa) → arrêt net, teleported, pas de remontée', async () => {
  const sb = stairSandbox({ descend: [{ ok: false, toY: -20, tpAtY: 50, tpTo: { x: -478, y: 15, z: -64 } }] });
  const r = await sb.stair({ x: 50, y: 32, z: 10 }, { cancelled: false });
  assert.strictEqual(r.teleported, true);
  assert.strictEqual(r.reached, false);
  assert.strictEqual(sb.bot.entity.position.y, 15, 'plus aucune marche après le TP');
  assert.strictEqual(sb.descends.length, 1, 'pas de nouveau cap après un TP');
  assert.ok(!sb.gotos.some((g) => g.near3d), 'pas de remontée vers la grappe depuis l\'autre bout de la carte');
});

test('_caveStairTo : DÉPASSÉ (sous la couche) → remonte vers la grappe en GoalNear 3D, canDig', async () => {
  const sb = stairSandbox();
  sb.descendDiagonal = async (b) => { b.entity.position.y = 20; return { ok: true }; };   // tombe sous la grappe d'un coup
  const r = await sb.stair({ x: 50, y: 32, z: 10 }, { cancelled: false });
  assert.strictEqual(r.overshot, true);
  const up = sb.gotos.find((g) => g.near3d);
  assert.ok(up && up.y === 32, 'remontée vers la couche de la grappe');
});

test('_caveStairTo : eau devant → change de cap et reprend ; grappe proche en hauteur → pas d\'escalier', async () => {
  const sb = stairSandbox({ pos: { x: 0, y: 70, z: 10 }, descend: [{ ok: false, reason: 'water_ahead', toY: 60 }, { ok: true, toY: 20 }] });
  await sb.stair({ x: 50, y: 20, z: 10 }, { cancelled: false });
  assert.strictEqual(sb.descends.length, 2);
  assert.notStrictEqual(sb.looks[1], sb.looks[0], 'nouveau cap après l\'eau');
  const flat = stairSandbox();
  assert.deepStrictEqual(plain(await flat.stair({ x: 10, y: 67, z: 0 }, { cancelled: false })), { tried: false });
  assert.strictEqual(flat.descends.length, 0);
});

// ═════════════════════ 4. junk jeté derrière soi ══════════════════════════════════════════════════
test('tossJunkBehind : se retourne (yaw + π), jette, remet le regard ; branchSurvivalTick l\'utilise', async () => {
  const order = [];
  const sb = {
    Number, Math,
    tossJunk: async () => { order.push('toss'); },
  };
  vm.createContext(sb);
  run(sb, [fnSrc('tossJunkBehind'), 'this.f = tossJunkBehind;'].join('\n'));
  const b = { entity: { yaw: 1, pitch: 0.2 }, look: async (y, p) => { order.push(['look', +y.toFixed(3), p]); } };
  await sb.f(b);
  assert.deepStrictEqual(order, [['look', +(1 + Math.PI).toFixed(3), 0], 'toss', ['look', 1, 0.2]]);
  assert.match(fnSrc('branchSurvivalTick'), /await tossJunkBehind\(bot\);/);
});

// ═════════════════════ 5. lacets repris au front ══════════════════════════════════════════════════
function lawnSandbox(o = {}) {
  const clock = { t: T0 };
  const sb = {
    events: [], base: o.base || {}, marks: 0, clock,
    emit(e) { sb.events.push(e); },
    Date: { now: () => clock.t }, Object, Math, Number,
    lawnMine,
    bot: { entity: { position: Object.assign({ x: 100.5, y: 15, z: -40.5 }, o.pos || {}) } },
    loadBaseState: () => sb.base,
    saveBaseState: (st) => { sb.base = st; return true; },
    NO_GIVE: o.noGive !== false,
    isLumberjackObjective: () => false,
    isInWater: () => false,
    homewarp: { bookmark: () => { sb.marks++; return true; } },
    HOME_WORK: 'work', _workSet: false, _workPos: o.workPos || null, _botXZ: () => ({ x: 100, z: -41 }),
  };
  vm.createContext(sb);
  run(sb, [constSrc('IRON_LAWN_WORK_MOVE'), fnSrc('ironLawnStart'), fnSrc('ironLawnEnd'),
    'this.start = ironLawnStart; this.end = ironLawnEnd; this.workPos = () => _workPos;'].join('\n'));
  return sb;
}

test('ironLawnEnd → ironLawnStart : état mémorisé (mémo base FUSIONNÉ) et home work re-posé au front', () => {
  const sb = lawnSandbox({ base: { deathDebt: { x: 1 } }, workPos: { x: 70, z: -56 } });
  const st = lawnMine.lawnInit({ dx: 1, dz: 0 }, { rng: () => 0 });
  assert.strictEqual(sb.end({ ok: true, lawn: st }), true);
  assert.deepStrictEqual(sb.base.deathDebt, { x: 1 }, 'fusion : rien d\'autre n\'est effacé');
  assert.deepStrictEqual([sb.base.ironLawn.x, sb.base.ironLawn.y, sb.base.ironLawn.z], [100, 15, -41]);
  assert.strictEqual(sb.marks, 1);
  assert.ok(sb.events.some((e) => e.type === 'work_bookmarked' && e.ctx === 'lawn_front'));
  assert.deepStrictEqual(plain(sb.start()), plain(st), 'au front : on reprend');
  sb.bot.entity.position = { x: 160, y: 15, z: -40 };
  assert.strictEqual(sb.start(), null, 'ailleurs : nouveau tracé');
});

test('ironLawnEnd : front à < 8 blocs du work actuel → pas de /sethome ; hors NO_GIVE → pas de /sethome', () => {
  const st = lawnMine.lawnInit({ dx: 1, dz: 0 }, { rng: () => 0 });
  const near = lawnSandbox({ workPos: { x: 97, z: -40 } });
  near.end({ ok: true, lawn: st });
  assert.strictEqual(near.marks, 0);
  const off = lawnSandbox({ noGive: false });
  off.end({ ok: true, lawn: st });
  assert.strictEqual(off.marks, 0);
  assert.ok(off.base.ironLawn, 'l\'état est quand même mémorisé');
});

test('index.js : iron_deep passe lawnState à branchMine et mémorise le front ; goals.js active les lacets', () => {
  assert.match(SRC, /const _lawnState = \(goal\.args && goal\.args\.lawn\) \? ironLawnStart\(\) : null;/);
  assert.match(SRC, /_lawnState \? \{ lawnState: _lawnState \} : \{\},\n      lifeGuardOpts\('branchMine', _gen\)\), taskToken\);\n[\s\S]{0,400}?\n    if \(goal\.args && goal\.args\.lawn\) \{ try \{ ironLawnEnd\(rBM\); \}/);
  const { IRON_ARMOR_CHAIN } = require('./goals');
  const chains = [IRON_ARMOR_CHAIN].filter(Boolean);
  const g = chains.flat().find((x) => x && x.name === 'iron_deep');
  assert.ok(g, 'iron_deep dans la chaîne armure fer');
  assert.ok(g.args.lawn, 'lawn activé');
});
