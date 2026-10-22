'use strict';
// CÂBLAGE (live 22/10, NethBot1 session 152) : `fleeDeathCamp` (via:foot) coupait la tâche par
// `taskCtl.cancel()` et ne rallumait RIEN — plus un seul `goal` jusqu'au watchdog (6 min), et la nuit
// chaque abri dérivait du jeton mort. La fuite prend désormais la main avec son jeton et rallume le
// planner en partant (patron migrateZone/dig_out), sauf préemption entre-temps.
// Technique (cf. index.nightlockdown.test.js) : le texte RÉEL de index.js exécuté dans un bac à sable
// vm strict qui ne contient que le niveau module nécessaire — un identifiant oublié lève ici.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createTaskController } = require('./tasks');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const fnSrc = (name) => {
  const m = SRC.match(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'));
  assert.ok(m, `function ${name} introuvable au niveau module de index.js`);
  return m[0];
};

function sandbox({ gotoImpl, objective = { type: 'iron_armor', status: 'in_progress' } } = {}) {
  const taskCtl = createTaskController();
  const sb = vm.createContext({
    events: [], starts: 0,
    emit(e) { sb.events.push(e); },
    taskCtl,
    world: { objective },
    _safeHomePos: null, _dzones: [], deathzones: { isBanned: () => false }, deathSpots: { isBanned: () => false },
    safeHomeVeto: () => false, safeWarpHome: async () => {},
    stopMotion() {}, _escaping: false, _migrating: false, _ljSwitching: false,
    _skillInFlight: 0, _autoRunners: 0, MIGRATION_PREEMPT_WAIT_MS: 30000,
    sleep: async () => { sb._autoRunners = 0; sb._skillInFlight = 0; },   // l'ancien planner sort pendant l'attente
    withTimeout: (p) => p,
    pfGoals: { GoalNearXZ: function (x, z, r) { this.x = x; this.z = z; this.r = r; } },
    bot: { pathfinder: { goto: gotoImpl || (async () => {}) } },
    startAutonomous: async () => { sb.starts++; },
    Math, Date, String, Promise,
  });
  vm.runInContext("'use strict';\n" + fnSrc('fleeDeathCamp') + '\n' + fnSrc('restartPlannerAfterFlee'), sb);
  return sb;
}
const FROM = { x: 112, y: 69, z: -51 };

test('fleeDeathCamp : planner coupé → fuite à pied → planner RALLUMÉ (après que l ancien a rendu la main)', async () => {
  const sb = sandbox();
  const plannerTok = sb.taskCtl.begin('autonomous');
  sb._autoRunners = 1; sb._skillInFlight = 1;
  await sb.fleeDeathCamp(FROM);
  assert.strictEqual(plannerTok.cancelled, true, 'la fuite coupe bien le planner');
  assert.strictEqual(sb.starts, 1);
  assert.ok(sb.events.some((e) => e.type === 'death_camp_flee' && e.via === 'foot'));
  assert.ok(sb.events.some((e) => e.type === 'death_camp_flee_done' && e.restart === true));
  assert.strictEqual(sb._escaping, false);
});

test('fleeDeathCamp : fuite ÉCHOUÉE (goto qui lève) → planner rallumé quand même', async () => {
  const sb = sandbox({ gotoImpl: async () => { throw new Error('NoPath'); } });
  sb.taskCtl.begin('autonomous');
  await sb.fleeDeathCamp(FROM);
  assert.strictEqual(sb.starts, 1);
});

test('fleeDeathCamp : un ORDRE joueur / une migration prend la main pendant la fuite → pas de relance', async () => {
  const sb = sandbox({ gotoImpl: async () => { sb.taskCtl.begin('follow'); } });
  sb.taskCtl.begin('autonomous');
  await sb.fleeDeathCamp(FROM);
  assert.strictEqual(sb.starts, 0);
  const sb2 = sandbox({ gotoImpl: async () => { sb2._migrating = true; } });
  sb2.taskCtl.begin('autonomous');
  await sb2.fleeDeathCamp(FROM);
  assert.strictEqual(sb2.starts, 0, 'migration en cours : elle rallumera elle-même le planner');
});

test('fleeDeathCamp : ce qui tournait n était PAS le planner (ordre joueur, stop/afk) → on ne relance pas l autonomie', async () => {
  const sb = sandbox();
  sb.taskCtl.begin('guard');
  await sb.fleeDeathCamp(FROM);
  assert.strictEqual(sb.starts, 0);
  const idle = sandbox();                    // stop/afk : taskCtl.cancel(), plus rien d actif
  await idle.fleeDeathCamp(FROM);
  assert.strictEqual(idle.starts, 0);
});

test('fleeDeathCamp : objectif terminé → pas de relance', async () => {
  const sb = sandbox({ objective: { type: 'iron_armor', status: 'done' } });
  sb.taskCtl.begin('autonomous');
  await sb.fleeDeathCamp(FROM);
  assert.strictEqual(sb.starts, 0);
});

test('fleeDeathCamp : fuite vers le home safe → chemin inchangé (pas de préemption, pas de relance)', async () => {
  const sb = sandbox();
  sb._safeHomePos = { x: 500, z: 500 };
  const plannerTok = sb.taskCtl.begin('autonomous');
  await sb.fleeDeathCamp(FROM);
  assert.strictEqual(plannerTok.cancelled, false);
  assert.strictEqual(sb.starts, 0);
});
