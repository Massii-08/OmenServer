'use strict';
// PLANNER ORPHELIN (live 24/10, NethBot1 session 599 + NethBot2 session 583) : deux charges sur squelette
// enchaînées → la 2e préemptait la relance de la 1re puis faisait taskCtl.cancel() → plus un runner, plus de
// tâche, 18-24 min sans un `goal`. 1) décision PURE (plannerRevive.js) ; 2) GLUE index.js en bac à sable vm.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const PR = require('./plannerRevive');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const fnSrc = (name) => {
  const m = SRC.match(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'));
  assert.ok(m, `function ${name} introuvable au niveau module de index.js`);
  return m[0];
};
const MIN = 60 * 1000;
const T0 = 1_700_000_000_000;

// ═════════════════════ 1. décision pure ═════════════════════
test('rushResumesPlanner : planner/migration coupés, ou dette d une charge préemptée', () => {
  assert.strictEqual(PR.rushResumesPlanner({ prevTask: 'autonomous' }), true);
  assert.strictEqual(PR.rushResumesPlanner({ prevTask: 'migration' }), true);
  assert.strictEqual(PR.rushResumesPlanner({ prevTask: 'skeleton_rush', outerOwes: true }), true);
  assert.strictEqual(PR.rushResumesPlanner({ prevTask: 'skeleton_rush', outerOwes: false }), false);
  assert.strictEqual(PR.rushResumesPlanner({ prevTask: null, outerOwes: true }), false);
  assert.strictEqual(PR.rushResumesPlanner({ prevTask: 'follow', outerOwes: true }), false);
  assert.strictEqual(PR.rushResumesPlanner(), false);
});

const base = (o = {}) => Object.assign({ now: T0 + 4 * MIN, chain: true, alive: true, runners: 0, owner: null,
  lastGoalAt: T0, orphanSince: T0 + 3 * MIN, lastFireAt: 0 }, o);

test('orphelin : 4 min sans goal, aucun runner, confirmé 60 s → relance', () => {
  const v = PR.plannerOrphanVerdict(base());
  assert.deepStrictEqual(v, { fire: true, why: 'orphan', idleS: 240, orphan: true });
  // owner résiduel non joueur (charge finie qui n a jamais rendu la main) : orphelin quand même
  assert.strictEqual(PR.plannerOrphanVerdict(base({ owner: 'skeleton_rush' })).fire, true);
  assert.strictEqual(PR.plannerOrphanVerdict(base({ owner: 'autonomous' })).fire, true);
});

test('orphelin : < 3 min, confirmation en cours, cooldown → pas encore (mais orphan:true)', () => {
  const fresh = PR.plannerOrphanVerdict(base({ now: T0 + 2 * MIN }));
  assert.strictEqual(fresh.fire, false); assert.strictEqual(fresh.why, 'fresh'); assert.strictEqual(fresh.orphan, true);
  const conf = PR.plannerOrphanVerdict(base({ orphanSince: 0 }));
  assert.strictEqual(conf.why, 'confirming'); assert.strictEqual(conf.orphan, true);
  assert.strictEqual(PR.plannerOrphanVerdict(base({ orphanSince: T0 + 4 * MIN - 10000 })).why, 'confirming');
  assert.strictEqual(PR.plannerOrphanVerdict(base({ lastFireAt: T0 + 2 * MIN })).why, 'cooldown');
});

test('orphelin : tout ce qui retient légitimement le planner bloque la relance (orphan:false)', () => {
  const cases = {
    no_chain: { chain: false }, dead: { alive: false }, running: { runners: 1 },
    player_parked: { parked: true }, player_order: { owner: 'follow' }, migrating: { migrating: true },
    shelter: { shelter: true }, sleeping: { sleeping: true }, night_hold: { nightHold: 1 },
    skill: { skillInFlight: 1 }, survival_busy: { survivalBusy: true },
  };
  for (const [why, o] of Object.entries(cases)) {
    const v = PR.plannerOrphanVerdict(base(o));
    assert.strictEqual(v.fire, false, why);
    assert.strictEqual(v.why, why);
    assert.strictEqual(v.orphan, false, why);
  }
  for (const o of ['come', 'goto', 'guard', 'loiter', 'pvp', 'take']) {
    assert.strictEqual(PR.plannerOrphanVerdict(base({ owner: o })).why, 'player_order', o);
  }
});

// ═════════════════════ 2. câblage index.js ═════════════════════
function sandbox(over = {}) {
  const clock = { t: T0 };
  const sb = {
    events: [], starts: 0,
    emit(e) { sb.events.push(e); }, Date: { now: () => clock.t }, clock, Number,
    world: { objective: { type: 'diamond', status: 'in_progress' } },
    taskCtl: { active: null },
    bot: { entity: { position: {} }, health: 20, isSleeping: false },
    _lastGoalAt: T0, _plannerOrphanSince: 0, _plannerReviveAt: 0, _plannerParked: false,
    _autoRunners: 0, _migrating: false, _ljSwitching: false, _shelterInFlight: null, _nightHold: 0, _skillInFlight: 0,
    _skelRushBusy: false, _escaping: false, _foodTripBusy: false, _huntCookBusy: 0, _imminentBusy: false,
    _stillBusy: false, _plannerWatchdogBusy: false, _baseBusy: false,
    startAutonomous: async () => { sb.starts++; },
    plannerOrphanVerdict: PR.plannerOrphanVerdict,
    ...over,
  };
  const ctx = vm.createContext(sb);
  vm.runInContext("'use strict';\n" + fnSrc('plannerOrphanState') + '\n' + fnSrc('plannerOrphanTick'), ctx);
  return ctx;
}

test('tick : séquence live NethBot1 — planner mort après 2 charges, 15 s de pas → relance UNE fois à ~3 min, event planner_revived', () => {
  const sb = sandbox({ taskCtl: { active: null } });
  let fired = 0;
  for (let s = 0; s <= 6 * 60; s += 15) {
    sb.clock.t = T0 + s * 1000;
    const v = sb.plannerOrphanTick(sb.clock.t);
    if (v.fire) fired++;
  }
  assert.strictEqual(fired, 2, '3 min puis 6 min (cooldown 3 min) — le startAutonomous du bac à sable ne remet pas de runner');
  assert.strictEqual(sb.starts, 2);
  const ev = sb.events.find((e) => e.type === 'planner_revived');
  assert.ok(ev);
  assert.strictEqual(ev.idle_s, 180);
  assert.strictEqual(ev.owner, null);
  assert.strictEqual(ev.objective, 'diamond');
});

test('tick : un runner reparti (startAutonomous réel) → plus de relance', () => {
  const sb = sandbox();
  sb.startAutonomous = async () => { sb.starts++; sb._autoRunners = 1; };
  for (let s = 0; s <= 10 * 60; s += 15) sb.plannerOrphanTick(T0 + s * 1000);
  assert.strictEqual(sb.starts, 1);
});

test('tick : stop joueur, abri de nuit, charge en cours, mort, cartographe → jamais de relance', () => {
  for (const over of [{ _plannerParked: true }, { _shelterInFlight: {} }, { _skelRushBusy: true }, { _huntCookBusy: 1 },
    { bot: { entity: null, health: 0 } }, { world: { objective: { type: 'mapper', status: 'in_progress' } } },
    { taskCtl: { active: 'guard' } }, { _autoRunners: 1 }]) {
    const sb = sandbox(over);
    for (let s = 0; s <= 10 * 60; s += 15) sb.plannerOrphanTick(T0 + s * 1000);
    assert.strictEqual(sb.starts, 0, JSON.stringify(Object.keys(over)));
  }
});

test('tick : l orphelinat interrompu (skill qui démarre) remet la confirmation à zéro', () => {
  const sb = sandbox();
  sb.plannerOrphanTick(T0 + 3 * MIN);              // orphelin vu
  assert.ok(sb._plannerOrphanSince > 0);
  sb._skillInFlight = 1;
  sb.plannerOrphanTick(T0 + 3 * MIN + 15000);
  assert.strictEqual(sb._plannerOrphanSince, 0);
  sb._skillInFlight = 0;
  assert.strictEqual(sb.plannerOrphanTick(T0 + 3 * MIN + 30000).why, 'confirming');
  assert.strictEqual(sb.starts, 0);
});

// restartPlannerAfterFlee : la dette d une charge préemptée passe à la fuite ; branche préemptée TRACÉE.
function restartSandbox(over = {}) {
  const clock = { t: T0 };
  const sb = {
    events: [], starts: 0, emit(e) { sb.events.push(e); }, Date: { now: () => clock.t },
    world: { objective: { type: 'diamond', status: 'in_progress' } }, taskCtl: { active: 'death_camp_flee' },
    _skillInFlight: 0, _autoRunners: 0, _migrating: false, _ljSwitching: false, _skelRushOwesPlanner: false,
    MIGRATION_PREEMPT_WAIT_MS: 1000, sleep: async (ms) => { clock.t += ms; },
    startAutonomous: async () => { sb.starts++; },
    ...over,
  };
  const ctx = vm.createContext(sb);
  vm.runInContext("'use strict';\n" + fnSrc('restartPlannerAfterFlee') + '\nglobalThis.owes = () => _skelRushOwesPlanner;', ctx);
  return ctx;
}

test('restartPlannerAfterFlee : fuite qui a coupé une charge DÉBITRICE → relance et solde la dette', async () => {
  const sb = restartSandbox({ _skelRushOwesPlanner: true });
  assert.strictEqual(await sb.restartPlannerAfterFlee({ cancelled: false }, 'skeleton_rush'), true);
  assert.strictEqual(sb.starts, 1);
  assert.strictEqual(sb._skelRushOwesPlanner, false);
});

test('restartPlannerAfterFlee : charge non débitrice coupée → rien (comportement historique)', async () => {
  const sb = restartSandbox();
  assert.strictEqual(await sb.restartPlannerAfterFlee({ cancelled: false }, 'skeleton_rush'), false);
  assert.strictEqual(sb.starts, 0);
});

test('restartPlannerAfterFlee : jeton préempté → planner_restart_skipped (autrefois muet), dette conservée', async () => {
  const sb = restartSandbox({ _skelRushOwesPlanner: true, taskCtl: { active: 'skeleton_rush' } });
  assert.strictEqual(await sb.restartPlannerAfterFlee({ cancelled: true }, 'autonomous', 'skeleton_rush_planner_restart'), false);
  const ev = sb.events.find((e) => e.type === 'planner_restart_skipped');
  assert.ok(ev);
  assert.strictEqual(ev.why, 'preempted');
  assert.strictEqual(ev.by, 'skeleton_rush');
  assert.strictEqual(ev.owes, true);
  assert.strictEqual(sb._skelRushOwesPlanner, true);
});

test('index.js : timer orphelin armé au niveau module, état lu au niveau module, ordre joueur parqué', () => {
  assert.match(SRC, /^setInterval\(\(\) => \{ try \{ plannerOrphanTick\(\); \} catch \(e\) \{ \/\* best-effort \*\/ \} \}, 15000\);$/m);
  for (const v of ['_plannerOrphanSince', '_plannerReviveAt', '_plannerParked', '_skelRushOwesPlanner']) {
    assert.match(SRC, new RegExp(`^let ${v} = `, 'm'), v + ' au niveau module (piège #56)');
  }
  assert.match(SRC, /if \(\['stop', 'afk', 'guard', 'follow', 'pvp'\]\.includes\(order\.verb\)\) _plannerParked = true;/);
  assert.match(fnSrc('runAutonomousBody'), /_plannerParked = false;/);
});
