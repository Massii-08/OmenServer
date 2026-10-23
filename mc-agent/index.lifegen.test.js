'use strict';
// GÉNÉRATION DE VIE (23/10). Prouvé dans les logs de l'Omen : après `status dead` → `status spawned`, le
// serpentin de branchMine CONTINUAIT (`bm_approach` vers la galerie à ~120 blocs du point de réapparition —
// NethBot1 13:45:48 → re-mort au même front à 13:47:52 ; NethBot2 13:56:26 → re-mort 40 s plus tard), la
// chasse d'avant la mort finissait puis la descente faisait `/home work` vers l'ancien chantier
// (`hunt_cook_done` → `descend_via_home_work` juste après une mort, ×8), et la tranche de fer du bûcheron
// démarrait encore puis faisait `/home work` (`lj_iron_slice start` + `work_return ctx:lj_mine`).
// Cause : la mort n'annulait RIEN (le runner autonome survivait, `autonomous_dup_skipped runners:1`), et le
// code en vol qui relit le GLOBAL `taskToken` y trouvait le jeton VIVANT du runner suivant.
// Ici : la GLUE de index.js dans un bac à sable vm strict (patron de index.shelterhold.test.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createTaskController } = require('./tasks');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(re, label) { const m = SRC.match(re); assert.ok(m, `${label} introuvable dans index.js`); return m[0]; }
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);
const letSrc = (name) => grab(new RegExp(`^let ${name} = [^;]+;`, 'm'), `let ${name}`);
const handlerSrc = (ev) => grab(new RegExp(`^bot\\.on\\('${ev}', \\(\\) => \\{[\\s\\S]*?^\\}\\);$`, 'm'), `bot.on('${ev}')`);

function sandbox(extra = {}) {
  const sb = Object.assign({ events: [], Date, Object, Math, Number, Promise, taskCtl: createTaskController() }, extra);
  sb.emit = (e) => sb.events.push(e);
  vm.createContext(sb);
  vm.runInContext("'use strict';\n" + letSrc('_lifeGen') + '\n' + ['lifeStale', 'dropStaleTask', 'lifeGuardOpts', 'endLifeTasks'].map(fnSrc).join('\n'), sb);
  vm.runInContext('globalThis.__get = (n) => eval(n);', sb);
  return sb;
}
const run = (sb, code) => vm.runInContext(code, sb);

test('_lifeGen est déclaré au NIVEAU MODULE (piège #56 : lu par des timers et des skills)', () => {
  assert.match(SRC, /^let _lifeGen = 0;/m);
});

test('endLifeTasks : génération +1, tâche active ANNULÉE (cleanup), stale_task_dropped {task, gen}', () => {
  const sb = sandbox();
  let cleaned = 0;
  const tok = sb.taskCtl.begin('autonomous', () => { cleaned++; });
  const g0 = sb.__get('_lifeGen');
  assert.strictEqual(run(sb, "endLifeTasks('death')"), 'autonomous');
  assert.strictEqual(sb.__get('_lifeGen'), g0 + 1);
  assert.strictEqual(tok.cancelled, true);
  assert.strictEqual(cleaned, 1, 'stopMotion du jeton tué');
  assert.strictEqual(sb.taskCtl.active, null);
  const ev = sb.events.find((e) => e.type === 'stale_task_dropped');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ev)), { type: 'stale_task_dropped', task: 'autonomous', gen: g0, now: g0 + 1, why: 'death' });
});

test('endLifeTasks sans tâche active : génération +1, aucun event', () => {
  const sb = sandbox();
  assert.strictEqual(run(sb, "endLifeTasks('death')"), null);
  assert.strictEqual(sb.__get('_lifeGen'), 1);
  assert.strictEqual(sb.events.length, 0);
});

test('lifeStale / lifeGuardOpts : vrai dès que la vie a changé, onStale émet stale_task_dropped', () => {
  const sb = sandbox();
  run(sb, 'globalThis.g = _lifeGen; globalThis.guard = lifeGuardOpts("branchMine", g);');
  assert.strictEqual(run(sb, 'lifeStale(g)'), false);
  assert.strictEqual(run(sb, 'guard.isStale()'), false);
  assert.strictEqual(run(sb, 'lifeStale(undefined)'), false, 'sans génération capturée : jamais périmé (appels historiques)');
  run(sb, "endLifeTasks('death')");
  assert.strictEqual(run(sb, 'lifeStale(g)'), true);
  assert.strictEqual(run(sb, 'guard.isStale()'), true);
  run(sb, "guard.onStale('life_changed')");
  const ev = sb.events.find((e) => e.type === 'stale_task_dropped' && e.task === 'branchMine');
  assert.ok(ev);
  assert.strictEqual(ev.gen, 0);
  assert.strictEqual(ev.why, 'life_changed');
  const r = run(sb, "dropStaleTask('descendDiagonal', g)");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'cancelled', 'une mort n\'est ni un échec du but ni un verdict sur la zone');
});

test('câblage : le handler death appelle endLifeTasks, le handler spawn avance la génération AVANT onSpawn', () => {
  assert.match(handlerSrc('death'), /endLifeTasks\('death'\)/);
  const sp = SRC.match(/^bot\.on\('spawn', \(\) => \{\n[^\n]*\n  _floatSettleUntil[\s\S]*?^\}\);$/m);
  assert.ok(sp, 'handler spawn principal');
  const body = sp[0];
  assert.ok(body.indexOf('_lifeGen++') >= 0, 'spawn : _lifeGen++');
  assert.ok(body.indexOf('_lifeGen++') < body.indexOf('onSpawn()'), 'avant onSpawn');
});

test('câblage : runSkillWithTelemetry capture la génération et la passe à runGoalSkill ; vie changée = cancelled', () => {
  const src = fnSrc('runSkillWithTelemetry');
  assert.match(src, /const _gen = _lifeGen;/);
  assert.match(src, /runGoalSkill\(g, _gen\)/);
  assert.match(src, /lifeStale\(_gen\)/);
});

test('câblage : runGoalSkill — branchMine gardé par la vie, pas de /home work ni de bookmark pour une vie finie', () => {
  const src = fnSrc('runGoalSkill');
  assert.match(src, /^async function runGoalSkill\(goal, gen\)/);
  // branchMine du but `branchMine` ET du repli caveHunt reçoivent la garde de vie
  assert.ok((src.match(/lifeGuardOpts\('branchMine', _gen\)/g) || []).length >= 2, 'branchMine ×2 gardés');
  // descente : la garde précède le /home work, et suit l'appel à descendDiagonal (sinon bookmark work au respawn)
  const iHome = src.indexOf("emit({ type: 'descend_via_home_work' })");
  const iGuard = src.indexOf("if (lifeStale(_gen)) return dropStaleTask('descendDiagonal', _gen);");
  assert.ok(iGuard > 0 && iGuard < iHome, 'garde AVANT descend_via_home_work');
  const iCall = src.indexOf('let r = await descendDiagonal(bot, goal.args || {}, taskToken);');
  assert.ok(src.indexOf("if (lifeStale(_gen)) return dropStaleTask('descendDiagonal', _gen);", iCall) > iCall, 'garde APRÈS la descente');
  // branchMine : la garde précède ironLawnEnd / finishFurnaceJob (front mémorisé au point de réapparition sinon)
  const iBM = src.indexOf('const rBM = await branchMine(');
  const iLawn = src.indexOf('ironLawnEnd(rBM)');
  const iStale = src.indexOf('lifeStale(_gen)', iBM);
  assert.ok(iBM > 0 && iStale > iBM && iStale < iLawn);
});

test('câblage : bûcheron — attente et tranche de fer gardées par la vie, pas de /home work pour une vie finie', () => {
  assert.match(fnSrc('lumberjackIdleSkill'), /lifeStale\(_gen\)/);
  assert.match(fnSrc('lumberjackIdleSkill'), /ljIronSliceStep\(_gen\)/);
  assert.match(fnSrc('ljIronSliceStep'), /ljIronSlice\(act, gen\)/);
  const s = fnSrc('ljIronSlice');
  assert.match(s, /lifeStale\(_gen\)/);
  assert.match(s, /if \(act === 'mine' && !lifeStale\(_gen\)\) await ljMineReturn\(\);/);
});

// ── runSkillWithTelemetry exécuté (vrai texte) : la mort pendant le skill / pendant l'attente de nuit ──
function rstSandbox(o = {}) {
  const sb = {
    events: [], skills: [], Date, Promise, Object, Math, Number, taskCtl: createTaskController(),
    migrationOwnsBot: () => false, foodTripYield: async () => {}, settleSurvivalKit: async () => {},
    holdForNight: o.holdForNight || (async () => ({ held: 0, cancelled: false })), maybeNightShelter: async () => false,
    woodWaitStep: async () => null, woodGoalRequestStep: async () => null,
    runGoalSkill: o.runGoalSkill || (async (g) => { sb.skills.push(g.name); return { ok: true }; }),
    withTimeout: (p) => p, timeoutFor: () => 1, stopMotion() {}, MINING_GOALS: new Set(), _zoneMiningMs: 0,
    noteZoneFailure: () => { sb.events.push({ type: 'zone_failure' }); }, _skillInFlight: 0, _curGoal: null,
    _furnaceJob: null, FURNACE_JOB_KEEP_SKILLS: new Set(), finishFurnaceJob: async () => {}, cookBetweenGoals: async () => {},
  };
  sb.emit = (e) => sb.events.push(e);
  vm.createContext(sb);
  vm.runInContext("'use strict';\n" + letSrc('_lifeGen') + '\n' + ['lifeStale', 'dropStaleTask', 'endLifeTasks', 'runSkillWithTelemetry'].map(fnSrc).join('\n'), sb);
  vm.runInContext('globalThis.__get = (n) => eval(n);', sb);
  sb.taskToken = sb.taskCtl.begin('autonomous', () => {});
  return sb;
}

test('mort PENDANT le skill → résultat cancelled (pas un échec du but), stale_task_dropped {task: skill}', async () => {
  const sb = rstSandbox({
    runGoalSkill: async (g) => { vm.runInContext("endLifeTasks('death'); _lifeGen++;", sb); return { ok: false, reason: 'dig_failed' }; },
  });
  const r = await vm.runInContext('runSkillWithTelemetry({ name: "iron_deep", skill: "branchMine" })', sb);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'cancelled');
  const drops = sb.events.filter((e) => e.type === 'stale_task_dropped');
  assert.deepStrictEqual(drops.map((e) => e.task), ['autonomous', 'branchMine']);
  assert.strictEqual(drops[1].gen, 0);
  assert.ok(!sb.events.some((e) => e.type === 'zone_failure'));
});

test('mort pendant l attente de nuit, nouveau runner déjà VIVANT dans le global → le skill de l ancienne vie ne part pas', async () => {
  const sb = rstSandbox({
    holdForNight: async () => {
      vm.runInContext("endLifeTasks('death'); _lifeGen++;", sb);
      sb.taskToken = sb.taskCtl.begin('autonomous', () => {});      // le runner de la nouvelle vie
      return { held: 0, cancelled: false };
    },
  });
  const r = await vm.runInContext('runSkillWithTelemetry({ name: "iron_deep", skill: "branchMine" })', sb);
  assert.strictEqual(r.reason, 'cancelled');
  assert.deepStrictEqual(sb.skills, [], 'aucun skill lancé pour une vie finie');
  assert.strictEqual(sb.taskToken.cancelled, false, 'le jeton de la nouvelle vie est intact');
});

test('vie inchangée → comportement historique (le skill part, son résultat remonte)', async () => {
  const sb = rstSandbox();
  const r = await vm.runInContext('runSkillWithTelemetry({ name: "iron_deep", skill: "branchMine" })', sb);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(sb.skills, ['iron_deep']);
  assert.ok(!sb.events.some((e) => e.type === 'stale_task_dropped'));
});
