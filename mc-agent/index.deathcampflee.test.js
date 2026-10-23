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
const { deathCampDefersToMigration, migrationCancelEffect, migrationResumeDecision } = require('./zone');

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
    deathCampDefersToMigration, _migrationTarget: null,
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

// ─── MIGRATION EN COURS (live 23/10, NethBot1 session 397) ──────────────────────────────────────
// `zone_migration_start` → `death_camp_ban` + `death_camp_flee via:foot` → `zone_migration_failed
// cancelled:true legs:1` 658 ms après le départ : la fuite au hasard (90 blocs) remplaçait une marche
// qui quittait DÉJÀ la zone (cible à 84 blocs du camp, hors du rayon banni).

test('fleeDeathCamp pendant une migration dont la cible est hors du camp → la migration CONTINUE (elle est la fuite)', async () => {
  let gotos = 0;
  const sb = sandbox({ gotoImpl: async () => { gotos++; } });
  const migTok = sb.taskCtl.begin('migration');
  sb._migrating = true;
  sb._migrationTarget = { x: -256, z: 128 };
  let warps = 0;
  sb._safeHomePos = { x: 900, z: 900 }; sb.safeWarpHome = async () => { warps++; };
  await sb.fleeDeathCamp(FROM);
  assert.strictEqual(migTok.cancelled, false, 'la migration garde la main');
  assert.strictEqual(sb.taskCtl.active, 'migration');
  assert.strictEqual(gotos, 0, 'aucun but pathfinder posé par-dessus la jambe');
  assert.strictEqual(warps, 0, 'pas de /home safe qui ramènerait le marcheur en arrière');
  assert.ok(sb.events.some((e) => e.type === 'death_camp_flee' && e.via === 'migration'));
});

test('fleeDeathCamp pendant une migration dont la CIBLE est dans le camp → fuite, puis planner rallumé (la migration reprendra)', async () => {
  const sb = sandbox();
  sb.deathzones = { isBanned: (zones, x, z) => x === -256 && z === 128 };
  const migTok = sb.taskCtl.begin('migration');
  sb._migrating = true;
  sb._migrationTarget = { x: -256, z: 128 };
  // la migration se déroule pendant l'attente de la fuite
  sb.sleep = async () => { sb._migrating = false; sb._autoRunners = 0; sb._skillInFlight = 0; };
  await sb.fleeDeathCamp(FROM);
  assert.strictEqual(migTok.cancelled, true);
  assert.ok(sb.events.some((e) => e.type === 'death_camp_flee' && e.via === 'foot'));
  assert.strictEqual(sb.starts, 1, 'la fuite a coupé une MIGRATION du planner : elle rallume le planner');
});

// ─── Annulation de migration : ni cooldown ni cible écartée ; reprise si urgence ─────────────────
function cancelSandbox() {
  const taskCtl = createTaskController();
  const sb = vm.createContext({
    events: [], failed: 0, migrations: [],
    emit(e) { sb.events.push(e); },
    taskCtl, migrationCancelEffect, migrationResumeDecision,
    noteMigrationFailed() { sb.failed++; },
    _migrationResume: null, _migrationInterrupts: 0, _migrating: false, _migrationLegs: 1,
    world: { objective: { type: 'iron_armor', status: 'in_progress' } },
    bot: { time: { timeOfDay: 1000 } }, isNight: () => false,
    migrateZone: async (reason) => { sb.migrations.push(reason); },
    Math, Date, String, Number, Promise,
  });
  vm.runInContext("'use strict';\n" + fnSrc('onMigrationCancelled') + '\n' + fnSrc('maybeResumeMigration'), sb);
  return sb;
}

test('onMigrationCancelled : préemptée par la fuite de camp → PAS de noteMigrationFailed, reprise mémorisée', () => {
  const sb = cancelSandbox();
  sb.taskCtl.begin('death_camp_flee');
  sb.onMigrationCancelled('wood', { x: -256, z: 128 }, 'walk');
  assert.strictEqual(sb.failed, 0, 'ni cooldown ni cible écartée 45 min');
  assert.ok(sb._migrationResume && sb._migrationResume.reason === 'wood');
  const ev = sb.events.find((e) => e.type === 'zone_migration_failed');
  assert.ok(ev && ev.cancelled === true && ev.by === 'death_camp_flee' && ev.resume === true);
});

test('onMigrationCancelled : au-delà de 3 interruptions d affilée (mort à chaque reprise) → échec réel, plus de reprise', () => {
  const sb = cancelSandbox();
  sb.taskCtl.begin('autonomous');
  for (let i = 0; i < 3; i++) sb.onMigrationCancelled('wood', { x: 1, z: 2 }, 'walk');
  assert.strictEqual(sb.failed, 0, 'les 3 premières sont des accidents');
  assert.ok(sb._migrationResume);
  sb.onMigrationCancelled('wood', { x: 1, z: 2 }, 'walk');
  assert.strictEqual(sb.failed, 1, 'la 4ᵉ : le trek tue le bot → noteMigrationFailed (cooldown court)');
  assert.strictEqual(sb._migrationResume, null);
  assert.strictEqual(sb._migrationInterrupts, 0, 'compteur remis à zéro avec l échec');
});

test('onMigrationCancelled : ordre joueur → pas de reprise, pas de cooldown non plus', () => {
  const sb = cancelSandbox();
  sb.taskCtl.begin('follow');
  sb.onMigrationCancelled('wood', null, 'walk');
  assert.strictEqual(sb.failed, 0);
  assert.strictEqual(sb._migrationResume, null);
});

test('maybeResumeMigration : attend que le planner ait la main, puis relance la migration UNE fois', async () => {
  const sb = cancelSandbox();
  sb._migrationResume = { reason: 'wood', at: Date.now() };
  sb.taskCtl.begin('death_camp_flee');
  assert.strictEqual(sb.maybeResumeMigration(), 'wait');
  assert.strictEqual(sb.migrations.length, 0);
  sb.taskCtl.begin('autonomous');
  assert.strictEqual(sb.maybeResumeMigration(), 'resume');
  assert.deepStrictEqual(sb.migrations, ['wood']);
  assert.strictEqual(sb._migrationResume, null);
  assert.strictEqual(sb.maybeResumeMigration(), 'none');
  assert.ok(sb.events.some((e) => e.type === 'zone_migration_resume' && e.reason === 'wood'));
});

test('maybeResumeMigration : de nuit on attend ; reprise périmée → abandonnée', () => {
  const sb = cancelSandbox();
  sb.isNight = () => true;
  sb._migrationResume = { reason: 'wood', at: Date.now() };
  sb.taskCtl.begin('autonomous');
  assert.strictEqual(sb.maybeResumeMigration(), 'wait');
  sb._migrationResume = { reason: 'wood', at: Date.now() - 16 * 60000 };
  assert.strictEqual(sb.maybeResumeMigration(), 'drop');
  assert.strictEqual(sb._migrationResume, null);
  assert.strictEqual(sb.migrations.length, 0);
});
