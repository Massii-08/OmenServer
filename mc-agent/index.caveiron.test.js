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
    // + `caves` (mc_agent_world_memory.add_cave : {x,y,z,at,flooded}).
    loadMemory: () => ({ worlds: { overworld: { ores: o.ores || [], caves: o.caves || [] } } }),
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
    // Scan ciblé des chunks chargés (ores.scanExposedOres) : le fer que le bot VOIT (24/10).
    scans: [],
    oresScan: {
      scanExposedOres: (b, opts) => { sb.scans.push(opts); return o.live || []; },
      isWaterAdjacent: (b, p) => !!(o.liveWet && o.liveWet(p)),
    },
  };
  vm.createContext(sb);
  run(sb, [constSrc('IRON_CAVE_CACHE_MS'), letSrc('_ironCaveCache'), constSrc('IRON_CAVE_OBJECTIVES'),
    letSrc('_caveCooldownEmitted'), letSrc('_caveDisabledEmitted'),
    letSrc('_tpCount'), letSrc('_caveTripBusy'), letSrc('_caveInterrupts'), constSrc('CAVE_INTERRUPT_WINDOW_MS'),
    constSrc('CAVE_PULLED_AWAY'), fnSrc('caveTravelVerdict'),
    letSrc('_caveLastRawIron'), letSrc('_caveTooFarEmitAt'),
    fnSrc('_caveRawIron'), fnSrc('_caveBudgetBlocks'), fnSrc('_caveBudgetRecord'),
    fnSrc('_caveInvTier'), fnSrc('_caveLiveIronScan'), fnSrc('_caveWorld'), fnSrc('_caveWorldOres'), fnSrc('loadCaveFails'), fnSrc('noteCaveTried'),
    fnSrc('ironCaveCtx'), fnSrc('runCaveIron'), fnSrc('ironCaveBeforeGather'),
    'this.ironCaveBeforeGather = ironCaveBeforeGather;',
    'this.ironCaveCtx = ironCaveCtx; this.runCaveIron = runCaveIron; this.noteCaveTried = noteCaveTried;',
    'this.resetCache = () => { _ironCaveCache = { at: 0, cave: null }; };'].join('\n'));
  return sb;
}

const GRAPPE = [ore(20, 50, 0), ore(22, 50, 0), ore(24, 51, 1, { material: 'deepslate_iron_ore' })];

test('ctxExtra expose ironCave (sinon le but est mort-né)', () => {
  // 22/10 : via ironCaveForPlanner (garde PV, caveIron.caveHpOk), qui rend ironCaveCtx() au-dessus de 12 PV.
  assert.match(fnSrc('ctxExtra'), /ironCave: ironCaveForPlanner\(\)/);
  assert.match(fnSrc('ironCaveForPlanner'), /return ironCaveCtx\(\);/);
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

// ── 21/10 : accès plausible + escalade du disjoncteur ──
// 44 blocs sous le bot (y 64). 23/10 : rapprochée de 10 blocs à plat (centre à ~46 blocs 3D) — à x≈22
// elle était à 49 blocs 3D, hors de la portée de 48 (caveIron.caveInReach), qui n'est pas l'objet de ce test.
const DEEP = [ore(10, 20, 0), ore(12, 20, 0), ore(14, 21, 1)];

test('ironCaveCtx : grappe PROFONDE ciblable sans entrée de grotte connue (22/10 : escalier dirigé ; 943e2c n\'a que 3 entrées)', () => {
  const c = sandbox({ ores: DEEP }).ironCaveCtx();
  assert.ok(c, 'plus de filtre « accès plausible »');
  assert.strictEqual(c.y, 20);
  assert.ok(sandbox({ ores: DEEP, caves: [{ x: 25, y: 60, z: 5, at: 'x', flooded: true }] }).ironCaveCtx(), 'une entrée inondée ne retire plus rien');
});

test('ironCaveCtx : 2e repos du disjoncteur en 2 h → iron_cave coupé 2 h, persisté (survit au respawn)', () => {
  const MIN = 60_000;
  const unreach = (ago, x) => ({ x, y: 64, z: 0, key: 'k' + x, why: 'unreachable', at: T0 - ago });
  // 1er déclenchement il y a 1 h, déjà persisté ; 3 nouveaux échecs maintenant → 2e déclenchement
  const base = { keep: 1, caveBreaks: [{ at: T0 - 60 * MIN, until: T0 - 40 * MIN }],
    caveFails: [unreach(4 * MIN, 500), unreach(2 * MIN, 550), unreach(MIN, 600)] };
  const sb = sandbox({ ores: GRAPPE, base });
  assert.strictEqual(sb.ironCaveCtx(), null);
  assert.strictEqual(sb.base.caveBreaks.length, 2);
  assert.strictEqual(sb.base.keep, 1, 'mémo fusionné');
  const ev = sb.events.find((e) => e.type === 'cave_disabled');
  assert.ok(ev && ev.until > T0 + 100 * MIN);
  // process neuf (respawn), échecs expirés : toujours coupé grâce au mémo
  const sb2 = sandbox({ ores: GRAPPE, base: { caveBreaks: sb.base.caveBreaks } });
  sb2.clock.t = T0 + 60 * MIN;
  assert.strictEqual(sb2.ironCaveCtx(), null);
  sb2.clock.t = T0 + caveIronPick.CAVE_DISABLE_MS + 1000;
  sb2.resetCache();
  assert.ok(sb2.ironCaveCtx(), 'au bout de 2 h, les grottes reviennent');
  // un seul déclenchement : repos simple, pas de coupure
  const sb3 = sandbox({ ores: GRAPPE, base: { caveFails: [unreach(4 * MIN, 500), unreach(2 * MIN, 550), unreach(MIN, 600)] } });
  assert.strictEqual(sb3.ironCaveCtx(), null);
  assert.strictEqual(sb3.base.caveBreaks.length, 1);
  assert.ok(!sb3.events.some((e) => e.type === 'cave_disabled'));
});

test('dispatch : runGoalSkill route caveIron, armure avant la grotte, timeout déclaré', () => {
  const rgs = fnSrc('runGoalSkill');
  assert.match(rgs, /goal\.skill === 'caveIron'\) return await runCaveIron\(\)/);
  assert.match(rgs, /goal\.skill === 'branchMine' \|\| goal\.skill === 'caveIron'/);
  assert.match(constSrc('SKILL_TIMEOUTS'), /caveIron: \d+/);
});


// ── BUDGET DE GROTTES + PORTÉE (23/10, chrono NethBot2 : 25 iron_cave, 20 ratés, 1 fer en 77 min) ──
test('ironCaveCtx : grappe à > 48 blocs 3D écartée → cave_too_far ; une plus proche passe devant', () => {
  const FAR = [ore(60, 64, 0), ore(62, 64, 0), ore(64, 64, 0)];             // 3 minerais à ~62 blocs
  const sb = sandbox({ ores: FAR });
  assert.strictEqual(sb.ironCaveCtx(), null);
  const ev = sb.events.find((e) => e.type === 'cave_too_far');
  assert.ok(ev);
  assert.deepStrictEqual([ev.ores, ev.dist3d, ev.fallback], [3, 62, false]);
  const BIG = [0, 2, 4, 6, 8, 10].map((d) => ore(52 + d, 64, 0));             // 6 minerais à ~57 blocs
  assert.ok(sandbox({ ores: BIG }).ironCaveCtx(), 'grosse grappe (≥ 6) : portée 64');
  const both = sandbox({ ores: FAR.concat([ore(30, 64, 0), ore(32, 64, 0), ore(34, 64, 0)]) });
  assert.strictEqual(both.ironCaveCtx().x, 32);
});

test('runCaveIron + ironCaveCtx : 3 essais ratés en 15 min → cave_budget_exhausted, coupé 12 min, PERSISTÉ (fusion)', async () => {
  const MIN = 60_000;
  // Trois grappes distinctes : une grappe ratée est mise de côté 30 min (caveFails), la suivante est visée.
  const ores = GRAPPE.concat([ore(0, 50, 20), ore(2, 50, 20), ore(4, 50, 20)], [ore(-20, 50, 0), ore(-22, 50, 0), ore(-24, 50, 0)]);
  const sb = sandbox({ ores, base: { keep: 1 } });
  for (const why of ['unreachable', 'hidden', 'stair_missed']) {
    sb.resetCache();
    sb.caveIronSkill = async () => ({ ok: false, reason: why, mined: 0, iron_got: 0, took_s: 100 });
    const r = await sb.runCaveIron();
    assert.strictEqual(r.reason, why, 'chaque essai a bien lancé le skill');
    sb.clock.t += 3 * MIN;
  }
  sb.resetCache();
  assert.strictEqual(sb.ironCaveCtx(), null, 'budget épuisé → pas de grotte, la chaîne passe au branch-mine');
  const ev = sb.events.find((e) => e.type === 'cave_budget_exhausted');
  assert.ok(ev);
  assert.strictEqual(ev.fails, 3);
  assert.strictEqual(ev.until, sb.clock.t + 12 * MIN);
  assert.strictEqual(sb.base.keep, 1, 'mémo base FUSIONNÉ');
  assert.strictEqual(sb.base.caveBudget.until, ev.until);
  // Survit au self-healing : un process neuf (nouveau bac à sable) relit le mémo base.
  const fresh = sandbox({ ores: [ore(-20, 64, 30), ore(-22, 64, 30), ore(-24, 64, 30)], base: sb.base });
  fresh.clock.t = sb.clock.t + 5 * MIN;
  assert.strictEqual(fresh.ironCaveCtx(), null);
  fresh.clock.t = sb.clock.t + 13 * MIN;
  fresh.resetCache();
  assert.ok(fresh.ironCaveCtx(), 'après 12 min, iron_cave revient');
});

test('ironCaveCtx : du raw_iron gagné ailleurs remet l\'horloge « sans fer » à zéro', () => {
  const MIN = 60_000;
  const att = (agoMin) => ({ at: T0 - agoMin * MIN, start: T0 - (agoMin + 2) * MIN, why: 'unreachable', iron: 0 });
  const base = { caveBudget: { attempts: [att(19), att(17)] } };              // 21 min sans fer, 2 trajets
  const sb = sandbox({ ores: GRAPPE, base });
  sb.ironCaveCtx();                                                            // 1re lecture = calibrage
  assert.ok(sb.events.some((e) => e.type === 'cave_budget_exhausted' && e.minutesNoIron >= 20));
  const sb2 = sandbox({ ores: GRAPPE, base: { caveBudget: { attempts: [att(19), att(17)] } } });
  sb2.clock.t -= 10 * MIN;                                                     // 11 min sans fer : OK
  run(sb2, 'this.resetCache();');
  assert.ok(sb2.ironCaveCtx());
  sb2.items = sb2.items.concat([{ name: 'raw_iron', count: 3 }]);              // branch-mine : du fer
  sb2.clock.t += 10 * MIN;
  sb2.resetCache();
  assert.ok(sb2.ironCaveCtx(), 'le fer gagné entre-temps annule le verdict « 20 min sans fer »');
  assert.ok(Number.isFinite(sb2.base.caveBudget.lastIronAt));
});

test('runCaveIron : claim refusée → cave_failed porte iron_got 0 (mesure)', async () => {
  const sb = sandbox({ ores: GRAPPE });
  const c = sb.ironCaveCtx();
  sb.resetCache();
  sb._teamClaims.peek = () => null;
  sb.claims[c.key] = { by: 'NethBot9', at: T0 };
  await sb.runCaveIron();
  const ev = sb.events.find((e) => e.type === 'cave_failed');
  assert.deepStrictEqual([ev.why, ev.iron_got], ['claimed', 0]);
  assert.ok(!sb.base.caveBudget, 'claimed n\'est pas un trajet : non compté');
});

// ── FER VISIBLE AUTOUR DU BOT (24/10) : scan ciblé fer + chaînes d'équipe ──
const LIVE = (x, y, z) => ({ material: 'deepslate_iron_ore', x, y, z });
test('ironCaveCtx : mineur à -54 sans rien sur la carte → le deepslate_iron_ore VU à 10 blocs (src live)', () => {
  const sb = sandbox({ ores: [], objective: 'mapper_armor', pos: { x: 0, y: -54, z: 0 },
    items: [{ name: 'diamond_pickaxe', count: 1 }], live: [LIVE(10, -54, 0)] });
  const c = sb.ironCaveCtx();
  assert.ok(c, 'la grappe vue');
  assert.strictEqual(c.src, 'live');
  assert.strictEqual(c.count, 1);
  assert.strictEqual(JSON.stringify(sb.scans[0].names.slice().sort()), JSON.stringify(['deepslate_iron_ore', 'iron_ore']));
  assert.strictEqual(sb.scans[0].maxDistance, 64);
});
test('ironCaveCtx : iron_help aussi ; diamond seulement en force ; fer vu noyé → écarté', () => {
  const o = { ores: [], pos: { x: 0, y: -54, z: 0 }, items: [{ name: 'iron_pickaxe', count: 1 }], live: [LIVE(8, -54, 0)] };
  assert.ok(sandbox(Object.assign({}, o, { objective: 'iron_help' })).ironCaveCtx());
  assert.strictEqual(sandbox(Object.assign({}, o, { objective: 'diamond' })).ironCaveCtx(), null);
  assert.ok(sandbox(Object.assign({}, o, { objective: 'diamond' })).ironCaveCtx({ force: true }));
  assert.strictEqual(sandbox(Object.assign({}, o, { objective: 'iron_help', liveWet: () => true })).ironCaveCtx(), null);
});
test('ironCaveCtx : carte ET vue → la plus rentable (une grappe vue tout près bat une grappe de carte lointaine)', () => {
  const far = [ore(40, -54, 0), ore(42, -54, 0), ore(44, -54, 0)];
  const sb = sandbox({ ores: far, objective: 'mapper_armor', pos: { x: 0, y: -54, z: 0 },
    items: [{ name: 'iron_pickaxe', count: 1 }], live: [LIVE(4, -54, 0), LIVE(5, -54, 1), LIVE(6, -54, 0)] });
  const c = sb.ironCaveCtx();
  assert.strictEqual(c.src, 'live');
  assert.ok(c.x < 10);
  const sb2 = sandbox({ ores: far, objective: 'mapper_armor', pos: { x: 0, y: -54, z: 0 }, items: [{ name: 'iron_pickaxe', count: 1 }] });
  assert.strictEqual(sb2.ironCaveCtx().src, 'map', 'sans rien en vue → la carte');
});
test('runCaveIron({force}) : objectif diamant → la grappe vue est minée (ironCaveCtx forcé)', async () => {
  const sb = sandbox({ ores: [], objective: 'diamond', pos: { x: 0, y: -54, z: 0 },
    items: [{ name: 'diamond_pickaxe', count: 1 }], live: [LIVE(6, -54, 0)] });
  assert.strictEqual((await sb.runCaveIron()).reason, 'no_cave_target');
  sb.resetCache();
  const r = await sb.runCaveIron({ force: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(sb.captured.cave.src, 'live');
});

test('ironCaveBeforeGather : chaîne diamant à -54 → grotte VUE minée avant la récolte/galerie ; blessé ou rien en vue → null', async () => {
  const mk = (o) => sandbox(Object.assign({ ores: [], objective: 'diamond', pos: { x: 0, y: -54, z: 0 },
    items: [{ name: 'iron_pickaxe', count: 1 }], live: [LIVE(6, -54, 0)] }, o));
  const sb = mk();
  sb.bot.health = 20;
  const r = await sb.ironCaveBeforeGather({ name: 'iron_ore' });
  assert.strictEqual(r.ok, true);
  assert.ok(sb.events.some((e) => e.type === 'iron_cave_first' && e.src === 'live' && e.goal === 'iron_ore'));
  const hurt = mk();
  hurt.bot.health = 6;
  assert.strictEqual(await hurt.ironCaveBeforeGather({ name: 'iron_ore' }), null);
  assert.strictEqual(hurt.captured, null, 'pas de grotte à 6 PV');
  const none = mk({ live: [] });
  assert.strictEqual(await none.ironCaveBeforeGather({ name: 'iron_ore' }), null);
  const failed = mk({ skillResult: { ok: false, reason: 'hidden' } });
  assert.strictEqual(await failed.ironCaveBeforeGather({ name: 'iron_ore' }), null, 'essai raté → repli récolte/galerie');
});

test('runGoalSkill : la récolte de fer essaie la grotte AVANT ironGatherPlan (branch-mine de repli)', () => {
  const src = fnSrc('runGoalSkill');
  const i = src.indexOf('ironCaveBeforeGather(goal)');
  assert.ok(i > 0);
  assert.ok(i < src.indexOf('ironGatherPlan('));
});
