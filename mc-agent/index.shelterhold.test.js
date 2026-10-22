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
  return vm.createContext(Object.assign({ shelterHold, Date, Promise, Number, Object, Math }, extra));
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
