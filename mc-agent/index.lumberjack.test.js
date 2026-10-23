'use strict';
// CÂBLAGE du bûcheron d'équipe (20/10). La logique est dans lumberjack.js ; ici on EXÉCUTE le vrai
// texte des fonctions de index.js dans un bac à sable `vm` strict : un identifiant lu hors niveau
// module (piège #56) → ReferenceError ici, pas en prod.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const L = require('./lumberjack');
const { buildCtxInv } = require('./goals');
const { teamStatus } = require('./teamwork');

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

function fakeClaims(sb) {
  return {
    map: {},
    tryClaim(k) { const c = this.map[k]; if (c && c.by !== sb.bot.username) return false; this.map[k] = { by: sb.bot.username, at: sb.clock.t }; return true; },
    refresh(k) { const c = this.map[k]; if (!c || c.by !== sb.bot.username) return false; c.at = sb.clock.t; return true; },
    release(k) { const c = this.map[k]; if (!c || c.by !== sb.bot.username) return false; delete this.map[k]; return true; },
    peek(k) { const c = this.map[k]; return c ? { by: c.by, at: c.at } : null; },
  };
}

function sandbox(o = {}) {
  const clock = { t: T0 };
  const sb = {
    events: [], calls: [], clock, base: o.base || {}, mates: o.mates || [],
    emit(e) { sb.events.push(e); },
    Date: { now: () => clock.t },
    Object, Math, Number, Array, JSON, Promise, Set, Map, String,
    sleep: async (ms) => { clock.t += ms; if (sb.onSleep) sb.onSleep(clock.t); },
    items: (o.items || []).slice(),
    bot: {
      username: o.name || 'NethBot2',
      entity: { position: Object.assign({ x: 0, y: 16, z: 0, offset() { return this; } }, o.pos || {}) },
      players: {},
      inventory: { items: () => sb.items },
      chat: (m) => sb.calls.push('chat:' + m),
      lookAt: async () => {},
      toss: async (type, meta, count) => {
        sb.calls.push(['toss', type, count]);
        const it = sb.items.find((i) => i.type === type);
        it.count -= count;
        if (it.count <= 0) sb.items.splice(sb.items.indexOf(it), 1);
      },
    },
    world: { objective: Object.assign({ type: 'iron_armor', status: 'in_progress' }, o.objective || {}) },
    presence: { list: () => sb.mates },
    taskToken: { cancelled: false },
    taskCtl: { active: 'autonomous', begin: (n) => { sb.calls.push('begin:' + n); sb.taskCtl.active = n; return { cancelled: false }; } },
    _skillInFlight: 0, _autoRunners: 0, _migrating: false, MIGRATION_PREEMPT_WAIT_MS: 30000,
    migrationOwnsBot: () => false,
    stopMotion: () => sb.calls.push('stop'),
    IS_MAPPER: !!o.isMapper,
    whitelist: null,
    isAllowed: () => o.tpa !== false,
    awaitWarp: async () => ({ warped: o.warp !== false }),
    returnToWork: async (why) => { sb.calls.push('returnToWork:' + why); return o.workBack !== false; },
    safeWarpHome: async (n, op) => { sb.calls.push('home:' + n + ':' + op.ctx); },
    markWorkBeforeTrip: (why) => { sb.calls.push('markWork:' + why); return true; },
    homewarp: { bookmark: (b, n) => { sb.calls.push('sethome:' + n); return true; } },
    isInWater: () => false,
    _botXZ: () => ({ x: 0, z: 0 }),
    _workSet: false, _workPos: null,
    HOME_SAFE: 'safe', HOME_WORK: 'work', SAFE_HOME_MIN_Y: 50,
    loadBaseState: () => sb.base,
    saveBaseState: (st) => { sb.base = st; return true; },
    setObjective: (w, obj) => { w.objective = obj; },
    saveWorld: () => {}, worldFile: 'w.json',
    startAutonomous: async () => { sb.calls.push('startAutonomous'); },
    _wornArmor: () => new Set(o.worn || []),
    isNight: () => false,
    buildCtxInv, teamStatus,
    _ljReleaseGift: () => sb.calls.push('ljReleaseGift'),   // armure du bûcheron (testée dans index.ljarmor.test.js)
    isWoodGoal: L.isWoodGoal, woodWantFor: L.woodWantFor, logCount: L.logCount, activeLumberjack: L.activeLumberjack,
    woodWaitDecision: L.woodWaitDecision, preferredLumberjack: L.preferredLumberjack, lumberjackVerdict: L.lumberjackVerdict,
    wornIronCount: L.wornIronCount, LUMBERJACK_MIN_WORN: L.LUMBERJACK_MIN_WORN,
    pickWoodRequest: L.pickWoodRequest, tossPlan: L.tossPlan, ljSwitchBlock: L.ljSwitchBlock,
    pickJunkToToss: require('./skills/craft').pickJunkToToss,
    WOOD_REQUEST_TTL_MS: L.WOOD_REQUEST_TTL_MS, WOOD_UNDERGROUND_Y: L.WOOD_UNDERGROUND_Y, WOOD_MIN_GIFT: L.WOOD_MIN_GIFT, LUMBERJACK_STOCK: L.LUMBERJACK_STOCK,
    // temps mort → fer (21/10) : testé dans index.ljiron.test.js ; ici « rien d'utile » = attente historique
    ljIronSliceStep: async () => (o.slice ? o.slice() : null), LJ_IRON_CHECK_MS: L.LJ_IRON_CHECK_MS,
    woodNoWoodHere: () => !!o.noWoodHere,
  };
  sb._teamClaims = o.noClaims ? null : fakeClaims(sb);
  vm.createContext(sb);
  for (const c of ['LJ_CLAIM', 'LJ_TICK_MS', 'LJ_CACHE_MS', 'LJ_IDLE_MAX_MS', 'WOOD_DONE_TTL_MS', 'WOOD_FAIL_TTL_MS',
    'WOOD_WAIT_POLL_MS', 'WOOD_WAIT_LJ_CHECK_MS', '_woodDone', '_woodFailed', '_ljEvAt']) run(sb, constSrc(c));
  for (const l of ['_woodReq', '_woodTimedOutAt', '_woodReqLoaded', '_beatNow', '_ljTarget', '_ljAt', '_ljSwitching']) run(sb, letSrc(l));
  for (const f of ['_ljEmit', 'isLumberjackObjective', 'loadWoodRequest', 'setWoodRequest', 'woodWaitStep', '_ljContext',
    'bookmarkCuttingSpot', 'tossLogsTo', 'deliverWoodSkill', 'lumberjackIdleSkill', '_ljResignCleanup', 'switchLumberjack', 'lumberjackTick']) run(sb, fnSrc(f));
  // exposer les `let` du contexte (inaccessibles comme propriétés de l'objet global)
  run(sb, 'globalThis.__get = (n) => eval(n); globalThis.__set = (n, v) => eval(n + " = v");');
  return sb;
}

const LJ = (o = {}) => Object.assign({ name: 'NethBot3', role: 'lumberjack', at: T0 - 1000, armor: 4, x: 0, z: 0 }, o);
const LOGS_GOAL = { name: 'logs', skill: 'gatherLog', args: { count: 6 } };

test('ouvrier, but bois, bûcheron actif → demande publiée (mémo + heartbeat) puis bois reçu → ok sans remonter', async () => {
  const sb = sandbox({ mates: [LJ()] });
  let beats = 0;
  run(sb, '_beatNow = () => { globalThis.__beats = (globalThis.__beats || 0) + 1; };');
  sb.onSleep = (t) => { if (t >= T0 + 5000 && !sb.items.length) sb.items.push({ name: 'oak_log', type: 7, count: 16 }); };
  const r = await run(sb, 'woodWaitStep(' + JSON.stringify(LOGS_GOAL) + ')');
  beats = sb.__beats;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { ok: true });
  const req = sb.events.find((e) => e.type === 'wood_request');
  assert.ok(req && req.want === 16 && req.lumberjack === 'NethBot3');
  assert.ok(sb.events.some((e) => e.type === 'wood_wait'));
  assert.ok(sb.events.some((e) => e.type === 'wood_received' && e.count === 16));
  assert.strictEqual(sb.__get('_woodReq'), null, 'demande retirée une fois servie');
  assert.ok(!('woodRequest' in sb.base));
  assert.ok(beats >= 2, 'publiée à la pose ET au retrait');
});

test('la demande persistée survit au respawn : nouveau process → même horloge, puis timeout à 4 min → repli', async () => {
  const sb = sandbox({ mates: [LJ()], base: { woodRequest: { want: 16, at: T0 - 230000 }, other: 1 } });
  // le bûcheron reste « frais » pendant l'attente
  sb.onSleep = (t) => { sb.mates[0].at = t - 1000; };
  const r = await run(sb, 'woodWaitStep(' + JSON.stringify(LOGS_GOAL) + ')');
  assert.strictEqual(r, null, 'repli : le skill bois tourne normalement');
  assert.ok(sb.clock.t - T0 <= 11000, 'il n\'a attendu que le reliquat des 4 min, pas 4 min de plus');
  const to = sb.events.find((e) => e.type === 'wood_request_timeout');
  assert.ok(to && to.waited_s >= 240);
  assert.ok(!sb.events.some((e) => e.type === 'wood_request'), 'pas de nouvelle demande');
  assert.strictEqual(sb.base.other, 1, 'le mémo est FUSIONNÉ');
  assert.ok(sb.base.woodTimedOutAt > 0);
  // et juste après : autonomie 10 min, plus de demande
  const r2 = await run(sb, 'woodWaitStep(' + JSON.stringify(LOGS_GOAL) + ')');
  assert.strictEqual(r2, null);
  assert.ok(!sb.events.some((e) => e.type === 'wood_request'));
});

test('pas de bûcheron (ou je suis cartographe / bûcheron) → comportement historique immédiat', async () => {
  const s1 = sandbox({ mates: [] });
  assert.strictEqual(await run(s1, 'woodWaitStep(' + JSON.stringify(LOGS_GOAL) + ')'), null);
  assert.strictEqual(s1.events.length, 0);
  const s2 = sandbox({ mates: [LJ()], isMapper: true });
  assert.strictEqual(await run(s2, 'woodWaitStep(' + JSON.stringify(LOGS_GOAL) + ')'), null);
  const s3 = sandbox({ mates: [LJ({ name: 'Other' })], objective: { type: 'lumberjack' } });
  assert.strictEqual(await run(s3, 'woodWaitStep(' + JSON.stringify(LOGS_GOAL) + ')'), null);
  // but non-bois : jamais d'attente
  const s4 = sandbox({ mates: [LJ()] });
  assert.strictEqual(await run(s4, 'woodWaitStep({"name":"iron_deep","skill":"branchMine","args":{}})'), null);
});

test('le bûcheron disparaît pendant l\'attente → wood_wait_end puis repli', async () => {
  const sb = sandbox({ mates: [LJ()] });
  sb.onSleep = (t) => { if (t > T0 + 5000) sb.mates.length = 0; };
  const r = await run(sb, 'woodWaitStep(' + JSON.stringify(LOGS_GOAL) + ')');
  assert.strictEqual(r, null);
  assert.ok(sb.events.some((e) => e.type === 'wood_wait_end' && e.reason === 'no_lumberjack'));
  assert.strictEqual(sb.__get('_woodReq'), null);
});

test('annulation (migration/ordre) pendant l\'attente → cancelled', async () => {
  const sb = sandbox({ mates: [LJ()] });
  sb.onSleep = () => { sb.taskToken.cancelled = true; };
  const r = await run(sb, 'woodWaitStep(' + JSON.stringify(LOGS_GOAL) + ')');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { ok: false, reason: 'cancelled' });
});

test('bûcheron : _ljContext réserve la demande la plus ancienne (claim wood:<to>), une autre si déjà prise', () => {
  const mates = [
    { name: 'NethBot1', role: 'worker', at: T0 - 1000, woodWant: 16, woodAt: T0 - 90000 },
    { name: 'NethBot2', role: 'worker', at: T0 - 1000, woodWant: 16, woodAt: T0 - 30000 },
  ];
  const sb = sandbox({ name: 'NethBot3', mates, objective: { type: 'lumberjack' }, items: [{ name: 'oak_log', type: 7, count: 40 }] });
  sb._teamClaims.map['wood:NethBot1'] = { by: 'Intrus', at: T0 };
  const pick = run(sb, '_ljContext()');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(pick)), { to: 'NethBot2', amount: 16, want: 16 });
  assert.strictEqual(sb._teamClaims.map['wood:NethBot2'].by, 'NethBot3');
});

test('bûcheron : livraison = sethome work au spot de coupe, /tpa, toss du nombre DEMANDÉ, retour /home work', async () => {
  const sb = sandbox({
    name: 'NethBot3', objective: { type: 'lumberjack' }, pos: { y: 70 },
    mates: [{ name: 'NethBot2', role: 'worker', at: T0 - 1000, woodWant: 16, woodAt: T0 - 30000 }],
    items: [{ name: 'oak_log', type: 7, count: 10 }, { name: 'birch_log', type: 8, count: 30 }],
  });
  run(sb, '_ljContext()');
  const r = await run(sb, 'deliverWoodSkill()');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { ok: true });
  assert.deepStrictEqual(sb.calls.filter((c) => typeof c === 'string' && (c.startsWith('sethome') || c.startsWith('chat') || c.startsWith('returnToWork'))),
    ['sethome:work', 'chat:/tpa NethBot2', 'returnToWork:wood_delivered']);
  const tossed = sb.calls.filter((c) => Array.isArray(c) && c[0] === 'toss').reduce((a, c) => a + c[2], 0);
  assert.strictEqual(tossed, 16);
  assert.strictEqual(L.logCount(buildCtxInv(sb.bot)), 24, 'il garde le reste');
  assert.ok(sb.events.some((e) => e.type === 'wood_delivered' && e.to === 'NethBot2' && e.count === 16));
  assert.strictEqual(sb._teamClaims.map['wood:NethBot2'], undefined, 'réservation rendue');
  assert.strictEqual(sb.__get('_ljTarget'), null);
  assert.ok(sb.__get('_woodDone').has('NethBot2'), 'pas resservi tant que son heartbeat le dit demandeur');
});

test('bûcheron : /tpa raté → lumberjack_tpa_failed, réservation rendue, rien jeté', async () => {
  const sb = sandbox({
    name: 'NethBot3', objective: { type: 'lumberjack' }, warp: false, pos: { y: 70 },
    mates: [{ name: 'NethBot2', role: 'worker', at: T0 - 1000, woodWant: 16, woodAt: T0 - 30000 }],
    items: [{ name: 'oak_log', type: 7, count: 40 }],
  });
  run(sb, '_ljContext()');
  const r = await run(sb, 'deliverWoodSkill()');
  assert.strictEqual(r.ok, false);
  assert.ok(sb.events.some((e) => e.type === 'lumberjack_tpa_failed' && e.to === 'NethBot2'));
  assert.strictEqual(sb._teamClaims.map['wood:NethBot2'], undefined);
  assert.ok(!sb.calls.some((c) => Array.isArray(c) && c[0] === 'toss'));
});

test('bûcheron : sans spot de coupe posé, retour par /home safe', async () => {
  const sb = sandbox({
    name: 'NethBot3', objective: { type: 'lumberjack' }, workBack: false, pos: { y: 70 },
    mates: [{ name: 'NethBot2', role: 'worker', at: T0 - 1000, woodWant: 16, woodAt: T0 - 30000 }],
    items: [{ name: 'oak_log', type: 7, count: 40 }],
  });
  run(sb, '_ljContext()');
  await run(sb, 'deliverWoodSkill()');
  assert.ok(sb.calls.includes('home:safe:lumberjack_return'));
});

test('élection : le mieux armé prend la claim et bascule en chaîne lumberjack (préemption + relance)', async () => {
  const sb = sandbox({
    name: 'NethBot3', worn: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'], pos: { y: 16 },
    mates: [{ name: 'NethBot2', role: 'worker', at: T0 - 1000, armor: 1 }, { name: 'MapBot1', role: 'mapper', at: T0, armor: 4 }],
  });
  const v = await run(sb, 'lumberjackTick()');
  assert.strictEqual(v, 'claim');
  assert.strictEqual(sb._teamClaims.map.lumberjack.by, 'NethBot3');
  assert.strictEqual(sb.world.objective.type, 'lumberjack');
  assert.strictEqual(sb.base.lumberjackPrev, 'iron_armor');
  assert.ok(sb.calls.includes('begin:lumberjack_switch'));
  assert.ok(sb.calls.includes('home:safe:lumberjack_surface'), 'au fond → remonte à la base');
  assert.ok(sb.calls.includes('startAutonomous'));
  assert.ok(sb.events.some((e) => e.type === 'lumberjack_elected' && e.from === 'iron_armor'));
});

test('élection : un autre tient la claim → follower ; le bûcheron qui perd sa claim rend le rôle', async () => {
  const s1 = sandbox({ name: 'NethBot1', worn: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'],
    mates: [{ name: 'NethBot3', role: 'lumberjack', at: T0 - 1000, armor: 4 }] });
  s1._teamClaims.map.lumberjack = { by: 'NethBot3', at: T0 - 5000 };
  assert.strictEqual(await run(s1, 'lumberjackTick()'), 'follower');
  assert.strictEqual(s1.world.objective.type, 'iron_armor');

  const s2 = sandbox({ name: 'NethBot1', objective: { type: 'lumberjack' }, base: { lumberjackPrev: 'mapper_armor' },
    mates: [{ name: 'NethBot3', role: 'worker', at: T0 - 1000, armor: 4 }] });
  s2._teamClaims.map.lumberjack = { by: 'NethBot3', at: T0 - 5000 };
  assert.strictEqual(await run(s2, 'lumberjackTick()'), 'follower');
  assert.strictEqual(s2.world.objective.type, 'mapper_armor');
  assert.ok(s2.events.some((e) => e.type === 'lumberjack_resigned' && e.why === 'claim_lost'));
  assert.ok(!('lumberjackPrev' in s2.base));
});

test('élection : jamais un cartographe, jamais sans /tpa, jamais par-dessus un ordre joueur', async () => {
  const mates = [{ name: 'NethBot2', role: 'worker', at: T0 - 1000, armor: 0 }];
  const m = sandbox({ name: 'MapBot1', isMapper: true, mates });
  assert.strictEqual(await run(m, 'lumberjackTick()'), null);
  const t = sandbox({ name: 'NethBot1', tpa: false, mates });
  assert.strictEqual(await run(t, 'lumberjackTick()'), null);
  // (21/10 : 4/4 portées exigées pour être élu — l'ancienne version élisait à 1 seule botte)
  const o = sandbox({ name: 'NethBot1', mates, worn: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'] });
  o.taskCtl.active = 'order';
  assert.strictEqual(await run(o, 'lumberjackTick()'), 'claim');
  assert.strictEqual(o.world.objective.type, 'iron_armor', 'claim prise mais pas de bascule pendant un ordre');
  assert.ok(!o.calls.includes('startAutonomous'));
});

test('élection (21/10) : personne à 4/4 portées → aucun bûcheron, aucune claim (chacun suit iron_armor)', async () => {
  const sb = sandbox({ name: 'NethBot1', worn: ['iron_helmet', 'iron_chestplate', 'iron_boots'],
    items: [{ name: 'iron_leggings', type: 9, count: 1 }],           // 4 ACQUISES, 3 portées
    mates: [{ name: 'NethBot2', role: 'worker', at: T0 - 1000, armor: 4, worn: 3 },
      { name: 'NethBot3', role: 'worker', at: T0 - 1000, armor: 0, worn: 0 }] });
  assert.strictEqual(await run(sb, 'lumberjackTick()'), 'follower');
  assert.ok(!sb._teamClaims.map.lumberjack, 'pas de claim');
  assert.strictEqual(sb.world.objective.type, 'iron_armor');
  assert.ok(!sb.events.some((e) => e.type === 'lumberjack_elected'));
});

test('élection (21/10) : le bûcheron qui perd une pièce rend le rôle et REFORGE (iron_armor), pas son objectif d\'avant', async () => {
  const sb = sandbox({ name: 'NethBot1', objective: { type: 'lumberjack' }, base: { lumberjackPrev: 'mapper_armor', keep: 1 },
    worn: ['iron_helmet', 'iron_chestplate', 'iron_boots'],          // jambières usées → absentes de _wornArmor
    mates: [{ name: 'NethBot3', role: 'worker', at: T0 - 1000, armor: 4, worn: 4 }] });
  sb._teamClaims.map.lumberjack = { by: 'NethBot1', at: T0 - 5000 };
  assert.strictEqual(await run(sb, 'lumberjackTick()'), 'release');
  assert.ok(!sb._teamClaims.map.lumberjack, 'claim libérée : un autre ouvrier 4/4 peut être élu');
  assert.strictEqual(sb.world.objective.type, 'iron_armor');
  assert.ok(sb.events.some((e) => e.type === 'lumberjack_resigned' && e.why === 'unarmored' && e.to === 'iron_armor'));
  assert.ok(!('lumberjackPrev' in sb.base));
  assert.strictEqual(sb.base.keep, 1, 'mémo fusionné');
  // et l'ouvrier 4/4 (NethBot3) est élu au tick suivant
  const s3 = sandbox({ name: 'NethBot3', worn: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'],
    mates: [{ name: 'NethBot1', role: 'worker', at: T0 - 1000, armor: 4, worn: 3 }] });
  assert.strictEqual(await run(s3, 'lumberjackTick()'), 'claim');
  assert.strictEqual(s3.world.objective.type, 'lumberjack');
});

test('heartbeat : publie `worn` (pièces PORTÉES), lu par l\'élection des coéquipiers', () => {
  assert.match(SRC, /if \(st\) st\.worn = wornIronCount\(\[\.\.\._wornArmor\(\)\]\);/);
  assert.match(fnSrc('lumberjackTick'), /preferredLumberjack\(\{ selfName: bot\.username, selfArmor, selfWorn, mates, now \}\)/);
});

test('bûcheron au repos : rend la main dès qu\'une demande arrive', async () => {
  const sb = sandbox({ name: 'NethBot3', objective: { type: 'lumberjack' }, mates: [],
    items: [{ name: 'oak_log', type: 7, count: 60 }] });
  sb.onSleep = (t) => { if (t > T0 + 15000 && !sb.mates.length) sb.mates.push({ name: 'NethBot2', role: 'worker', at: t, woodWant: 16, woodAt: t }); };
  const r = await run(sb, 'lumberjackIdleSkill()');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { ok: true });
  assert.ok(sb.clock.t - T0 < 60000);
});

test('câblage : runSkillWithTelemetry consulte woodWaitStep APRÈS la nuit et ne lance pas le skill bois servi', async () => {
  const skills = [];
  const sb = {
    emit() {}, Date: { now: () => T0 }, Promise,
    taskToken: { cancelled: false }, migrationOwnsBot: () => false,
    foodTripYield: async () => {}, settleSurvivalKit: async () => {},
    holdForNight: async () => ({ held: 0, cancelled: false }), maybeNightShelter: async () => false,
    woodWaitStep: async (g) => (g.skill === 'gatherLog' ? { ok: true } : null),
    woodGoalRequestStep: async () => null,
    runGoalSkill: async (g) => { skills.push(g.name); return { ok: true }; },
    withTimeout: (p) => p, timeoutFor: () => 1, stopMotion() {}, MINING_GOALS: new Set(), _zoneMiningMs: 0,
    noteZoneFailure() {}, _skillInFlight: 0, _curGoal: null,
    _furnaceJob: null, FURNACE_JOB_KEEP_SKILLS: new Set(), finishFurnaceJob: async () => {}, cookBetweenGoals: async () => {},
  };
  vm.createContext(sb);
  run(sb, fnSrc('runSkillWithTelemetry'));
  const r = await run(sb, 'runSkillWithTelemetry({ name: "logs", skill: "gatherLog" })');
  assert.strictEqual(r.ok, true);
  await run(sb, 'runSkillWithTelemetry({ name: "iron_deep", skill: "branchMine" })');
  assert.deepStrictEqual(skills, ['iron_deep']);
});

test('index.js : état du bûcheron au NIVEAU MODULE, rôle publié, intervalle d\'élection posé', () => {
  for (const decl of [/^let _woodReq = null;/m, /^let _beatNow = null;/m, /^let _ljTarget = null;/m, /^const _woodDone = new Map\(\);/m]) {
    assert.match(SRC, decl);
  }
  assert.match(SRC, /_objT === 'lumberjack' \? 'lumberjack' : 'worker'/);
  assert.match(SRC, /teamStatus\(invB, \[\.\.\._wornArmor\(\)\], _woodReq\)/);
  assert.match(SRC, /setInterval\(\(\) => \{ lumberjackTick\(\)\.catch/);
  assert.match(SRC, /if \(goal\.skill === 'deliverWood'\) return deliverWoodSkill\(\);/);
  assert.match(SRC, /woodRequest: isLumberjackObjective\(\) \? _ljContext\(\) : null/);
});

test('attente avec inventaire PLEIN → une pile de déchet jetée pour pouvoir ramasser les bûches', async () => {
  const sb = sandbox({ mates: [LJ()], items: [{ name: 'dirt', type: 9, count: 64 }, { name: 'iron_ingot', type: 3, count: 5 }] });
  sb.bot.inventory.emptySlotCount = () => 0;
  sb.onSleep = (t) => { if (t >= T0 + 3000 && !sb.items.some((i) => i.name.endsWith('_log'))) sb.items.push({ name: 'oak_log', type: 7, count: 16 }); };
  await run(sb, 'woodWaitStep(' + JSON.stringify(LOGS_GOAL) + ')');
  assert.ok(sb.events.some((e) => e.type === 'wood_wait_room' && e.tossed === 'dirt'));
  assert.ok(sb.items.some((i) => i.name === 'iron_ingot'), 'jamais autre chose que du déchet');
});

// 21/10 : `lj_stock`/`logs` timeout accusent la ZONE (pondérés) — sinon le bûcheron (63 min de `lj_stock`)
// et NethBot2 (28,6 min de `logs`) restaient dans une zone rasée avec `logsNotFound:0`.
test('câblage : noteZoneFailure compte lj_stock/logs timeout comme manque de bois (pondéré)', () => {
  const Z = require('./zone');
  const sb = {
    Date: { now: () => T0 }, zoneFailureKind: Z.zoneFailureKind, zoneFailureWeight: Z.zoneFailureWeight,
    windowAdd: Z.windowAdd, _zoneWaterFails: 0, _zoneWaterWin: [], _zoneLogsNotFound: 0, _zoneLogsWin: [],
    _needsWoodTrip: false,
  };
  vm.createContext(sb);
  run(sb, fnSrc('noteZoneFailure'));
  run(sb, "noteZoneFailure('lj_stock', 'timeout')");
  run(sb, "noteZoneFailure('logs', 'timeout')");
  run(sb, "noteZoneFailure('furnace', 'timeout')");
  assert.strictEqual(sb._zoneLogsNotFound, 2 * Z.WOOD_TIMEOUT_WEIGHT);
  assert.strictEqual(Z.windowSum(sb._zoneLogsWin, T0), 2 * Z.WOOD_TIMEOUT_WEIGHT);
  assert.strictEqual(sb._needsWoodTrip, true);
});

test('ouvrier en SURFACE (y>=50) avec bûcheron actif : pas de demande, pas d\'attente, il récolte lui-même', async () => {
  const sb = sandbox({ mates: [LJ()], pos: { y: 70 } });
  const r = await run(sb, 'woodWaitStep(' + JSON.stringify(LOGS_GOAL) + ')');
  assert.strictEqual(r, null);
  assert.ok(!sb.events.some((e) => e.type === 'wood_request' || e.type === 'wood_wait'));
  assert.strictEqual(sb.__get('_woodReq'), null);
});

test('ouvrier SOUS TERRE (y<50) avec bûcheron actif : demande publiée comme avant', async () => {
  const sb = sandbox({ mates: [LJ()], pos: { y: 20 } });
  sb.onSleep = (t) => { if (t >= T0 + 5000 && !sb.items.length) sb.items.push({ name: 'oak_log', type: 7, count: 16 }); };
  const r = await run(sb, 'woodWaitStep(' + JSON.stringify(LOGS_GOAL) + ')');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { ok: true });
  assert.ok(sb.events.some((e) => e.type === 'wood_request'));
});

test('ouvrier en SURFACE (y 54) mais zone PROUVÉE sans bois (NethBot2 23/10) : demande au bûcheron', async () => {
  const sb = sandbox({ mates: [LJ()], pos: { y: 54 }, noWoodHere: true });
  sb.onSleep = (t) => { if (t >= T0 + 5000 && !sb.items.length) sb.items.push({ name: 'oak_log', type: 7, count: 16 }); };
  const r = await run(sb, 'woodWaitStep(' + JSON.stringify(LOGS_GOAL) + ')');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { ok: true });
  assert.ok(sb.events.some((e) => e.type === 'wood_request'));
  assert.ok(sb.events.some((e) => e.type === 'wood_received'));
});

// ─── 22/10, NethBot1 session 239 : bûcheron vidé (RCON clear) resté bûcheron ──────────────────────
const UNARMORED_LJ = (o = {}) => sandbox(Object.assign({ name: 'NethBot1', objective: { type: 'lumberjack' },
  base: { lumberjackPrev: 'iron_help', keep: 1 }, worn: [],
  mates: [{ name: 'NethBot3', role: 'worker', at: T0 - 1000, armor: 0, worn: 0 }] }, o));

test('bûcheron vidé pendant une MIGRATION : rendu refusé → lumberjack_switch_refused {why, active}, rien ne bascule', async () => {
  const sb = UNARMORED_LJ();
  sb._teamClaims.map.lumberjack = { by: 'NethBot1', at: T0 - 5000 };
  sb.taskCtl.active = 'migration'; sb._migrating = true;
  assert.strictEqual(await run(sb, 'lumberjackTick()'), 'release');
  const ref = sb.events.find((e) => e.type === 'lumberjack_switch_refused');
  assert.ok(ref, 'le refus se voit');
  assert.strictEqual(ref.why, 'migration');
  assert.strictEqual(ref.active, 'migration');
  assert.strictEqual(sb.world.objective.type, 'lumberjack', 'la migration garde la main (le redémarrage régressera)');
  assert.ok(!sb.calls.includes('begin:lumberjack_switch'));
  assert.strictEqual(sb.__get('_ljSwitching'), false);
});

test('bûcheron vidé pendant un secours (fuite de camp) : refus motivé `safety`, pas de préemption', async () => {
  const sb = UNARMORED_LJ();
  sb.taskCtl.active = 'death_camp_flee';
  await run(sb, 'lumberjackTick()');
  assert.ok(sb.events.some((e) => e.type === 'lumberjack_switch_refused' && e.why === 'safety' && e.active === 'death_camp_flee'));
  assert.ok(!sb.calls.includes('begin:lumberjack_switch'));
});

test('bûcheron vidé pendant que le watchdog du planner a la main : préempté, rôle rendu, iron_armor relancé', async () => {
  const sb = UNARMORED_LJ();
  sb.taskCtl.active = 'planner_watchdog';
  assert.strictEqual(await run(sb, 'lumberjackTick()'), 'release');
  assert.ok(sb.calls.includes('begin:lumberjack_switch'));
  assert.strictEqual(sb.world.objective.type, 'iron_armor');
  assert.ok(sb.events.some((e) => e.type === 'lumberjack_resigned' && e.why === 'unarmored'));
  assert.ok(!('lumberjackPrev' in sb.base));
  assert.strictEqual(sb.base.keep, 1);
  assert.ok(sb.calls.includes('startAutonomous'));
  assert.strictEqual(sb.__get('_ljSwitching'), false);
});

test('_ljSwitching revient à false même si la bascule LÈVE (finally)', async () => {
  const sb = UNARMORED_LJ();
  sb.saveBaseState = () => { throw new Error('disque plein'); };
  await assert.rejects(run(sb, 'switchLumberjack(false, "unarmored")'));
  assert.strictEqual(sb.__get('_ljSwitching'), false);
});

test('_ljResignCleanup : lumberjackPrev effacé (mémo FUSIONNÉ), work oublié, livraison et cadeau rendus', () => {
  const sb = UNARMORED_LJ();
  sb._teamClaims.map['wood:NethBot2'] = { by: 'NethBot1', at: T0 };
  run(sb, '_ljTarget = { to: "NethBot2", amount: 16, want: 16 }; _workSet = true;');
  run(sb, '_ljResignCleanup()');
  assert.ok(!('lumberjackPrev' in sb.base));
  assert.strictEqual(sb.base.keep, 1);
  assert.strictEqual(sb.__get('_ljTarget'), null);
  assert.ok(!sb._teamClaims.map['wood:NethBot2']);
  assert.ok(sb.calls.includes('ljReleaseGift'));
  assert.strictEqual(sb._workSet, false);
});

test('câblage : startAutonomous nettoie le rôle quand objectiveForStart ramène un bûcheron à iron_armor', () => {
  const body = fnSrc('startAutonomous');
  assert.match(body, /objectiveForStart\(/);
  assert.match(body, /objType === 'lumberjack'[\s\S]*_ljResignCleanup\(\)/);
  assert.match(body, /release\(LJ_CLAIM\)/);
});
