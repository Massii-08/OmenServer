'use strict';
// CÂBLAGE « tenir sa case » (live 22/10, NethBot1 session 206 : 5 morts en 85 s au point de réapparition —
// `dig_in → reflex fight → teleported dist:6 → reflex flee → teleported dist:8 → walled_in → flee → mort`).
// Les décisions sont testées en pur (shelter.cell, reflexes, survival, respawnFlee). Ici : la GLUE de
// index.js, exécutée dans un bac à sable vm strict (patron de index.spawnflee.test.js) — un identifiant
// oublié ou un `let` dans onSpawn lu par un timer y devient une ReferenceError, pas un undefined muet.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { shelterHold } = require('./skills/shelter');
const { respawnFleePlan } = require('./respawnFlee');
const { RANGED } = require('./reflexes');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(re, label) { const m = SRC.match(re); assert.ok(m, `${label} introuvable dans index.js`); return m[0]; }
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);
const run = (sb, code) => vm.runInContext("'use strict';\n" + code, sb);

function sandbox(extra = {}) {
  return vm.createContext(Object.assign({ shelterHold, Date, Promise, Number, Object, Math, _meleePillar: null }, extra));
}

test('shelterHoldNow : vrai SEULEMENT abri en cours + bot enterré dans sa case', () => {
  const bot = { entity: { position: { x: 0.5, y: 62, z: 0.5 } }, _mcaShelterCell: { x: 0.5, y: 64, z: 0.5, walled: false } };
  const sb = sandbox({ bot, _shelterInFlight: Promise.resolve() });
  run(sb, fnSrc('shelterHoldNow'));
  assert.strictEqual(run(sb, 'shelterHoldNow()'), true);
  bot.entity.position = { x: 6.5, y: 64, z: 0.5 };                 // reculé hors de la case
  assert.strictEqual(run(sb, 'shelterHoldNow()'), false);
  bot.entity.position = { x: 0.5, y: 62, z: 0.5 };
  sb._shelterInFlight = null;                                       // pas d'abri en cours
  assert.strictEqual(run(sb, 'shelterHoldNow()'), false);
});

test('strikeInPlace : arrête la poursuite pvp, frappe, ne pose aucun but', () => {
  const calls = [];
  const foe = { name: 'zombie', height: 1.95, position: { x: 1, y: 64, z: 0, offset: (a, b, c) => ({ x: 1 + a, y: 64 + b, z: c }) } };
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    pvp: { target: foe, stop: () => calls.push('pvp_stop') },
    lookAt: () => { calls.push('look'); return Promise.resolve(); },
    attack: (e) => calls.push('attack:' + e.name),
    pathfinder: { setGoal: () => calls.push('setGoal') },
  };
  const sb = sandbox({ bot, _auraLastHitAt: 0 });
  run(sb, fnSrc('strikeInPlace'));
  sb.foe = foe;
  run(sb, 'strikeInPlace(foe)');
  assert.deepStrictEqual(calls, ['pvp_stop', 'look', 'attack:zombie']);
  assert.ok(sb._auraLastHitAt > 0);
});

test('respawnThreatsNow marque les TIREURS (ranged) — sinon la fuite d un archer à 10 blocs ne part jamais', () => {
  const bot = { entities: { 1: { name: 'skeleton', position: { x: 10, y: 70, z: 0 } }, 2: { name: 'zombie', position: { x: 30, y: 70, z: 0 } } } };
  const sb = sandbox({ bot, RANGED, isThreatHostile: () => true });
  run(sb, fnSrc('respawnThreatsNow'));
  const t = run(sb, 'respawnThreatsNow()');
  assert.strictEqual(JSON.stringify(t.map((x) => x.ranged)), '[true,false]');
  assert.ok(respawnFleePlan({ self: { x: 0, y: 70, z: 0 }, threats: t }), 'squelette à 10 : on fuit avant de creuser');
});

test('câblage : réflexes et tick de survie du planner reçoivent holdPosition + strikeInPlace', () => {
  const reflexBlock = grab(/installReflexes\(bot, \{[\s\S]*?panicCooldownMs: 8000,/, 'installReflexes(bot, {…})');
  assert.match(reflexBlock, /holdPosition: shelterHoldNow/);
  assert.match(reflexBlock, /strikeInPlace,/);
  assert.match(fnSrc('settleSurvivalKit'), /holdPosition: shelterHoldNow, strikeInPlace/);
});

// ── DEUX PLANNERS (live 22/10, session 206 : `autonomous_resume`/`autonomous_start` ×2 à 4 ms) ─────────
function autoSandbox() {
  const events = []; const bodies = [];
  let tok = { cancelled: false };
  const sb = vm.createContext({
    Date, Promise, Object, Array,
    emit: (e) => events.push(e), events, bodies,
    world: { objective: { type: 'iron_armor', status: 'in_progress' } }, args: {},
    objectiveForStart: (t) => t, buildCtxInv: () => [], _wornArmor: () => new Set(),
    setObjective: () => {}, saveWorld: () => {}, worldFile: 'w.json', stopMotion: () => {},
    taskCtl: { active: null, begin(name) { tok.cancelled = true; tok = { cancelled: false }; this.active = name; return tok; },
      cancel() { tok.cancelled = true; this.active = null; } },
    taskToken: { cancelled: true }, _autoRunners: 0,
    runAutonomousBody: (s, o, t) => new Promise((resolve) => { bodies.push({ t, resolve }); }),
  });
  run(sb, 'var _autoLive = null;');
  run(sb, fnSrc('autonomousDupStart'));
  run(sb, fnSrc('startAutonomous'));
  return sb;
}

test('startAutonomous : un 2e appel pendant qu un runner vit (même objectif) ne lance PAS un 2e planner', () => {
  const sb = autoSandbox();
  run(sb, 'startAutonomous(null); startAutonomous(null);');
  assert.strictEqual(sb.bodies.length, 1, 'un seul runner');
  assert.strictEqual(sb.bodies[0].t.cancelled, false, 'le 1er runner n a pas été annulé par le doublon');
  assert.ok(sb.events.some((e) => e.type === 'autonomous_dup_skipped'));
});

test('startAutonomous : après préemption (taskCtl.cancel / begin d un autre), la relance démarre', () => {
  const sb = autoSandbox();
  run(sb, 'startAutonomous(null);');
  run(sb, 'taskCtl.cancel();');                       // mort, watchdog, migration…
  run(sb, 'startAutonomous(null);');
  assert.strictEqual(sb.bodies.length, 2);
});

test('onSpawn d une vie PASSÉE ne reprend pas le planner (génération de spawn)', () => {
  const body = grab(/^async function onSpawn\(\) \{[\s\S]*?^\}$/m, 'onSpawn');
  assert.match(body, /const spawnGen = \+\+_spawnGen;/);
  const guard = body.indexOf('spawnGen !== _spawnGen');
  const resume = body.indexOf("type: 'autonomous_resume'");
  assert.ok(guard > 0 && resume > guard, 'la garde de génération précède la reprise');
  assert.match(SRC, /^let _spawnGen = 0;$/m, '_spawnGen au niveau module');
});

// ── L'ABRI SURVIT À LA MORT (live 22/10 : `walled_in` à 826301 pour un `dig_in` de 807870) ──────────────
test('abortShelterOnDeath : annule le jeton, libère le verrou, oublie la case et la sortie différée', () => {
  const events = [];
  const tok = { cancelled: false };
  const bot = { _mcaShelterCell: { x: 0, y: 0, z: 0 }, _mcaShelterPending: { mode: 'pit' } };
  const sb = vm.createContext({ emit: (e) => events.push(e), bot, __tok: tok });
  run(sb, 'var _shelterInFlight = Promise.resolve(); var _shelterTok = globalThis.__tok; var _stillBusy = true;');
  run(sb, fnSrc('abortShelterOnDeath'));
  run(sb, 'abortShelterOnDeath()');
  assert.strictEqual(tok.cancelled, true);
  assert.strictEqual(run(sb, '_shelterInFlight'), null);
  assert.strictEqual(run(sb, '_shelterTok'), null);
  assert.strictEqual(run(sb, '_stillBusy'), false);
  assert.strictEqual(bot._mcaShelterCell, null);
  assert.strictEqual(bot._mcaShelterPending, null);
  assert.ok(events.some((e) => e.action === 'death_abort'));
});

test('le handler death appelle abortShelterOnDeath en premier', () => {
  const h = grab(/^bot\.on\('death', \(\) => \{[\s\S]*?^\}\);$/m, "bot.on('death')");
  assert.match(h, /emit\(\{ type: 'status', state: 'dead' \}\);\n  abortShelterOnDeath\(\);/);
});
