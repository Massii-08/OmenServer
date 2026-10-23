'use strict';
// MIGRATION INTERROMPUE ≠ MIGRATION RATÉE (live 23/10, NethBot1 session 397) : `zone_migration_start`
// (bois, cible à 106 blocs) → remontée /home safe → 2ᵉ alerte PV au home → `death_camp_ban` →
// `fleeDeathCamp` prend la main (`taskCtl.begin('death_camp_flee')`) → `zone_migration_failed
// cancelled:true legs:1` 658 ms après le départ, cooldown armé + cible écartée 45 min, la nuit tombe.
const test = require('node:test');
const assert = require('node:assert');
const {
  migrationCancelEffect, migrationResumeDecision, deathCampDefersToMigration, MIGRATION_RESUME_TTL_MS,
} = require('./zone');

test('migrationCancelEffect : une préemption n arme JAMAIS de cooldown (ce n est pas un verdict sur la zone)', () => {
  for (const by of ['death_camp_flee', 'skeleton_rush', 'autonomous', 'dig_out', null, 'follow', 'guard', 'come']) {
    assert.strictEqual(migrationCancelEffect({ preemptedBy: by }).armCooldown, false, String(by));
  }
});

test('migrationCancelEffect : urgence vitale / respawn / évasion → REPRISE ; ordre joueur → pas de reprise', () => {
  for (const by of ['death_camp_flee', 'skeleton_rush', 'autonomous', 'dig_out', 'planner_watchdog', null, undefined]) {
    assert.strictEqual(migrationCancelEffect({ preemptedBy: by }).resume, true, String(by));
  }
  for (const by of ['follow', 'come', 'goto', 'guard', 'take', 'mineDown', 'pvp', 'loiter', 'lumberjack_switch']) {
    assert.strictEqual(migrationCancelEffect({ preemptedBy: by }).resume, false, by);
  }
  assert.strictEqual(migrationCancelEffect().resume, true, 'appel sans argument : préempteur inconnu = reprise');
});

test('migrationCancelEffect : interrompue encore et encore (mort à chaque reprise) → échec réel, cooldown COURT', () => {
  const { MIGRATION_MAX_INTERRUPTS } = require('./zone');
  assert.strictEqual(MIGRATION_MAX_INTERRUPTS, 3);
  assert.deepStrictEqual(migrationCancelEffect({ preemptedBy: 'autonomous', interrupts: 2 }), { armCooldown: false, resume: true });
  assert.deepStrictEqual(migrationCancelEffect({ preemptedBy: 'autonomous', interrupts: 3 }), { armCooldown: true, resume: false });
  assert.deepStrictEqual(migrationCancelEffect({ preemptedBy: 'follow', interrupts: 5 }), { armCooldown: false, resume: false },
    'un ordre joueur n est jamais un verdict');
});

test('migrationResumeDecision : reprend dès que le planner a la main, de jour', () => {
  const pending = { reason: 'wood', at: 1000 };
  assert.strictEqual(migrationResumeDecision({ pending: null, now: 2000, activeTask: 'autonomous' }), 'none');
  assert.strictEqual(migrationResumeDecision({ pending, now: 2000, activeTask: 'autonomous', isNight: false }), 'resume');
  assert.strictEqual(migrationResumeDecision({ pending, now: 2000, activeTask: 'autonomous', isNight: null }), 'resume',
    'heure inconnue → pas de gate (comme le verdict)');
  assert.strictEqual(migrationResumeDecision({ pending, now: 2000, activeTask: 'death_camp_flee' }), 'wait');
  assert.strictEqual(migrationResumeDecision({ pending, now: 2000, activeTask: null }), 'wait');
  assert.strictEqual(migrationResumeDecision({ pending, now: 2000, activeTask: 'autonomous', migrating: true }), 'wait');
  assert.strictEqual(migrationResumeDecision({ pending, now: 2000, activeTask: 'autonomous', isNight: true }), 'wait');
  assert.strictEqual(migrationResumeDecision({ pending, now: 1000 + MIGRATION_RESUME_TTL_MS + 1, activeTask: 'autonomous' }), 'drop');
  assert.strictEqual(migrationResumeDecision({ pending: { reason: 'wood' }, now: 2000, activeTask: 'autonomous' }), 'drop',
    'reprise sans horodatage = illisible → abandonnée');
});

test('deathCampDefersToMigration : la migration EST la fuite (elle quitte la zone) — sauf si sa cible est dans le camp', () => {
  assert.strictEqual(deathCampDefersToMigration({ activeTask: 'migration', targetBanned: false }), true);
  assert.strictEqual(deathCampDefersToMigration({ activeTask: 'migration' }), true, 'marche à l aveugle : cible nulle');
  assert.strictEqual(deathCampDefersToMigration({ activeTask: 'migration', targetBanned: true }), false);
  assert.strictEqual(deathCampDefersToMigration({ activeTask: 'autonomous', targetBanned: false }), false);
  assert.strictEqual(deathCampDefersToMigration({}), false);
});

// ─── Jambes « beyond_loaded » : but XZ, jamais une sphère 3D à un y deviné ────────────────────────
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { migrationLeg, LEG_DIST, legDigRetry } = require('./zone');
const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

test('migrationLegTo : la jambe vise GoalNearXZ(leg.x, leg.z) — atteignable à toute altitude de surface — et avance', async () => {
  const fn = SRC.match(/^async function migrationLegTo\([^)]*\) \{[\s\S]*?^\}$/m);
  assert.ok(fn, 'migrationLegTo introuvable');
  const goals = [];
  const pos = { x: -242, y: 71, z: 25 };
  const sb = vm.createContext({
    emit() {}, legDigRetry, _legDigEmitted: new WeakSet(), SAFE_HOME_MIN_Y: 58,
    stopMotion() {}, withTimeout: (p) => p, Movements: function () {},
    withTempMovements: async (bot, M, opts, f) => f(),
    pfGoals: {
      GoalNearXZ: function (x, z, r) { this.kind = 'xz'; this.x = x; this.z = z; this.r = r; },
      GoalNear: function () { this.kind = '3d'; }, GoalY: function () { this.kind = 'y'; },
    },
    bot: { entity: { position: pos }, pathfinder: { goto: async (g) => { goals.push(g); pos.x = g.x; pos.z = g.z; } } },
    Math, Number, Promise, String,
  });
  vm.runInContext("'use strict';\n" + fn[0], sb);
  // cible à 106 blocs (le cas live) : la 1re jambe fait LEG_DIST blocs vers elle
  const heading = Math.atan2(128 - 25, -256 - -242);
  const leg = migrationLeg({ from: { x: pos.x, z: pos.z }, heading, legs: 0 });
  assert.strictEqual(LEG_DIST, 64);
  await sb.migrationLegTo(leg, 71, { cancelled: false });
  assert.strictEqual(goals.length, 1, 'jambe réussie : pas de repli en creusant');
  assert.strictEqual(goals[0].kind, 'xz');
  assert.strictEqual(goals[0].x, leg.x); assert.strictEqual(goals[0].z, leg.z);
  assert.ok(Math.hypot(pos.x - -242, pos.z - 25) >= 60, 'le bot a progressé d une jambe');
});

test('migrationLegTo : préemptée → aucun but posé', async () => {
  const fn = SRC.match(/^async function migrationLegTo\([^)]*\) \{[\s\S]*?^\}$/m);
  let gotos = 0;
  const sb = vm.createContext({
    emit() {}, legDigRetry, _legDigEmitted: new WeakSet(), SAFE_HOME_MIN_Y: 58, stopMotion() {},
    withTimeout: (p) => p, Movements: function () {}, withTempMovements: async (b, M, o, f) => f(),
    pfGoals: { GoalNearXZ: function () {}, GoalY: function () {} },
    bot: { entity: { position: { x: 0, y: 70, z: 0 } }, pathfinder: { goto: async () => { gotos++; } } },
    Math, Number, Promise, String,
  });
  vm.runInContext("'use strict';\n" + fn[0], sb);
  await sb.migrationLegTo({ x: 64, z: 0 }, 70, { cancelled: true });
  assert.strictEqual(gotos, 0);
});
