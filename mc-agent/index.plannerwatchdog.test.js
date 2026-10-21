'use strict';
// WATCHDOG DU PLANNER (live 21/10, NethBot3 session 48) : `shelter dig_in`, puis plus UN event `goal`
// pendant 10+ min, jour levé — le planner attendait un abri dont `bot.dig` ne rendait jamais la main.
// 1) la décision PURE (plannerWatchdog.js) ; 2) la GLUE de index.js, extraite et exécutée en bac à sable
// `vm` strict (pièges #56/#61 : un identifiant manquant lève ici, pas en prod).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const PW = require('./plannerWatchdog');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const fnSrc = (name) => {
  const m = SRC.match(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'));
  assert.ok(m, `function ${name} introuvable au niveau module de index.js`);
  return m[0];
};
const run = (sb, code) => vm.runInContext("'use strict';\n" + code, sb);
const MIN = 60 * 1000;
const T0 = 1_700_000_000_000;

// ═════════════════════ 1. décision pure ═════════════════════
test('verdict : 6 min sans but, rien de légitime → relance', () => {
  const v = PW.plannerWatchdogVerdict({ now: T0 + 7 * MIN, active: true, lastGoalAt: T0 });
  assert.strictEqual(v.fire, true);
  assert.strictEqual(v.why, 'stale');
  assert.strictEqual(v.idleS, 420);
});
test('verdict : < 6 min, inactif, migration, cooldown → rien', () => {
  assert.strictEqual(PW.plannerWatchdogVerdict({ now: T0 + 5 * MIN, active: true, lastGoalAt: T0 }).fire, false);
  assert.strictEqual(PW.plannerWatchdogVerdict({ now: T0 + 9 * MIN, active: false, lastGoalAt: T0 }).fire, false);
  assert.strictEqual(PW.plannerWatchdogVerdict({ now: T0 + 9 * MIN, active: true, migrating: true, lastGoalAt: T0 }).fire, false);
  assert.strictEqual(PW.plannerWatchdogVerdict({ now: T0 + 9 * MIN, active: true, lastGoalAt: T0, lastFireAt: T0 + 5 * MIN }).why, 'cooldown');
});
test('verdict : abri / sommeil / retenue de nuit / skill = légitimes, mais BORNÉS (17 min)', () => {
  for (const k of [{ shelterSince: T0 + MIN }, { sleeping: true }, { nightHold: 1 }, { skillInFlight: 1 }]) {
    const ok = PW.plannerWatchdogVerdict(Object.assign({ now: T0 + 10 * MIN, active: true, lastGoalAt: T0 }, k));
    assert.strictEqual(ok.fire, false, JSON.stringify(k));
    const stuck = PW.plannerWatchdogVerdict(Object.assign({ now: T0 + 18 * MIN, active: true, lastGoalAt: T0 }, k));
    assert.strictEqual(stuck.fire, true, 'au-delà du plafond : ' + JSON.stringify(k));
  }
  // un abri commencé il y a 17+ min n'est plus légitime même si le dernier but est récent… à 6 min
  const old = PW.plannerWatchdogVerdict({ now: T0 + 25 * MIN, active: true, lastGoalAt: T0 + 18 * MIN, shelterSince: T0 });
  assert.strictEqual(old.fire, true);
  assert.strictEqual(old.why, 'shelter_stuck');
});
test('deriveToken : suit le parent, s annule seul sans toucher le parent', () => {
  const parent = { cancelled: false };
  const t = PW.deriveToken(parent);
  assert.strictEqual(t.cancelled, false);
  t.cancelled = true;
  assert.strictEqual(t.cancelled, true);
  assert.strictEqual(parent.cancelled, false);
  const t2 = PW.deriveToken(parent);
  parent.cancelled = true;
  assert.strictEqual(t2.cancelled, true);
  assert.strictEqual(PW.deriveToken(null).cancelled, false);
});

// ═════════════════════ 2. câblage index.js ═════════════════════
function sandbox(over = {}) {
  const clock = { t: T0 + 8 * MIN };
  const sb = {
    events: [], starts: 0, stops: [], begins: [],
    emit(e) { sb.events.push(e); },
    Date: { now: () => clock.t }, clock,
    world: { objective: { type: 'iron_armor', status: 'in_progress' } },
    taskCtl: { active: 'autonomous', begin(name, cleanup) { sb.begins.push(name); sb.taskCtl.active = name; if (sb._prev) { sb._prev.cancelled = true; } cleanup && cleanup(); const tok = { cancelled: false }; sb._prev = tok; return tok; } },
    _prev: null,
    bot: { isSleeping: false, targetDigBlock: {} },
    _lastGoalAt: T0, _plannerWatchdogAt: 0, _plannerWatchdogBusy: false,
    _migrating: false, _ljSwitching: false,
    _shelterInFlight: null, _shelterTok: null, _shelterStartedAt: 0, _stillBusy: false,
    _nightHold: 0, _skillInFlight: 0, _autoRunners: 1,
    MIGRATION_PREEMPT_WAIT_MS: 1000,
    taskToken: null,
    sleep: async (ms) => { clock.t += ms; },
    stopMotion: (o) => sb.stops.push(o || {}),
    startAutonomous: async () => { sb.starts++; },
    plannerWatchdogVerdict: PW.plannerWatchdogVerdict,
    ...over,
  };
  const ctx = vm.createContext(sb);
  run(ctx, fnSrc('plannerWatchdogState'));
  run(ctx, fnSrc('plannerWatchdogTick'));
  return ctx;
}

test('tick : planner gelé dans un abri zombie (le cas live) → planner_watchdog, abri annulé, creusage coupé, relance', async () => {
  const shTok = { cancelled: false };
  const sb = sandbox({ _shelterInFlight: new Promise(() => {}), _shelterTok: shTok, _shelterStartedAt: T0 - 20 * MIN });
  const v = await sb.plannerWatchdogTick(sb.clock.t);
  assert.strictEqual(v.fire, true);
  const ev = sb.events.find((e) => e.type === 'planner_watchdog');
  assert.ok(ev, 'event planner_watchdog');
  assert.strictEqual(ev.shelter, true);
  assert.strictEqual(shTok.cancelled, true, 'l abri en cours est annulé');
  assert.ok(sb.stops.some((o) => o.arm === true), 'stopMotion({arm:true}) coupe le creusage');
  assert.ok(sb.events.some((e) => e.type === 'planner_watchdog_zombie'), 'runner gelé signalé');
  assert.strictEqual(sb._shelterInFlight, null, 'le nouveau planner ne REJOINT pas l abri zombie');
  assert.strictEqual(sb._stillBusy, false);
  assert.strictEqual(sb.starts, 1, 'startAutonomous relancé');
  assert.deepStrictEqual(sb.begins, ['planner_watchdog']);
});

test('tick : le runner rend la main pendant l attente → relance propre, pas de zombie', async () => {
  const sb = sandbox();
  sb.sleep = async (ms) => { sb.clock.t += ms; sb._autoRunners = 0; };
  await sb.plannerWatchdogTick(sb.clock.t);
  assert.ok(sb.events.some((e) => e.type === 'planner_watchdog'));
  assert.ok(!sb.events.some((e) => e.type === 'planner_watchdog_zombie'));
  assert.strictEqual(sb.starts, 1);
});

test('tick : planner vivant (but récent), mappeur, ou ordre joueur → rien', async () => {
  const fresh = sandbox({ _lastGoalAt: T0 + 7 * MIN });
  assert.strictEqual((await fresh.plannerWatchdogTick(fresh.clock.t)).fire, false);
  const mapper = sandbox({ world: { objective: { type: 'mapper', status: 'in_progress' } } });
  assert.strictEqual((await mapper.plannerWatchdogTick(mapper.clock.t)).fire, false);
  const order = sandbox();
  order.taskCtl.active = 'follow';
  assert.strictEqual((await order.plannerWatchdogTick(order.clock.t)).fire, false);
  for (const sb of [fresh, mapper, order]) assert.strictEqual(sb.starts, 0);
});

test('tick : préempté pendant l attente (mort, ordre) → pas de relance par-dessus', async () => {
  const sb = sandbox();
  sb.sleep = async (ms) => { sb.clock.t += ms; sb._prev.cancelled = true; };
  await sb.plannerWatchdogTick(sb.clock.t);
  assert.strictEqual(sb.starts, 0);
});

test('index.js : watchdog armé au niveau module, `goal` horodaté par les 3 runners, base_return attend l atterrissage', () => {
  assert.match(SRC, /^setInterval\(\(\) => \{ plannerWatchdogTick\(\)\.catch\(\(\) => \{\}\); \}, 30000\);$/m);
  assert.match(SRC, /^let _lastGoalAt = 0;/m);
  assert.strictEqual((SRC.match(/onStep: \(g\) => \{ _lastGoalAt = Date\.now\(\); emit\(\{ type: 'goal'/g) || []).length, 3);
  assert.doesNotMatch(SRC, /onStep: \(g\) => emit\(\{ type: 'goal'/);
  assert.match(SRC, /ctx: 'base_return' \}\)\) \{\s*emit\(\{ type: 'base_return' \}\);\s*try \{ await awaitWarp\(/);
  assert.match(SRC, /shelterUntilDawn\(bot, shTok, \{/);
});
