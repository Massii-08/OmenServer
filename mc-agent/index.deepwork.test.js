'use strict';
// CÂBLAGE du chantier de diamant persisté (deepWork.js) et de la cartographie en passant (survey.js),
// Massii 24/10. La LOGIQUE est testée dans deepWork.test.js / survey.test.js ; ici la GLUE de index.js,
// extraite et exécutée dans un bac à sable `vm` (un identifiant oublié lève ici, pas en prod — #56/#61).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const DW = require('./deepWork');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(re, label) {
  const m = SRC.match(re);
  assert.ok(m, `${label} introuvable dans index.js`);
  return m[0];
}
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);
const run = (sb, code) => vm.runInContext("'use strict';\n" + code, sb);

const T0 = 1_800_000_000_000;
const STONE = { name: 'deepslate', boundingBox: 'block' };
const AIR = { name: 'air', boundingBox: 'empty' };

function sandbox({ y = -54, health = 20, memo = {}, hostile = null, digging = null, bookmarkOk = true } = {}) {
  const sb = {
    events: [], memo: Object.assign({}, memo), bookmarks: [], clock: { t: T0 },
    emit(e) { sb.events.push(e); },
    Date: { now: () => sb.clock.t }, Math, Number, Object,
    IS_MAPPER: false, NO_GIVE: true, HOME_WORK: 'work',
    _deepWork: null, _deepWorkLoaded: false, _deepWorkTryAt: 0, _deepWorkRefusedEvAt: 0, _deepWorkPosing: false,
    _workSet: false, _workPos: null, _workDrownTimes: [1], _workStuckTimes: [1],
    _shelterInFlight: null, _migrating: false,
    loadBaseState: () => sb.memo,
    saveBaseState: (st) => { sb.memo = Object.assign({}, st); return true; },
    deepWorkLoad: DW.deepWorkLoad, shouldRefreshDeepWork: DW.shouldRefreshDeepWork, deepSpotCheck: DW.deepSpotCheck,
    deepWorkLanded: DW.deepWorkLanded,
    isInWater: () => false,
    vec3Lib: { Vec3: function (x, yy, z) { this.x = x; this.y = yy; this.z = z; } },
    homewarp: { bookmark: (b, n) => { sb.bookmarks.push(n); return bookmarkOk ? n : false; } },
    bot: {
      entity: { position: { x: 10.5, y, z: 20.5, distanceTo() { return 0; } } },
      health, targetDigBlock: digging, pvp: { target: null },
      blockAt: (q) => (q.y < y ? STONE : AIR),
      nearestEntity: () => hostile,
    },
  };
  vm.createContext(sb);
  for (const f of ['_botXZ', '_loadDeepWork', '_setDeepWork', '_forgetDeepWork', '_onBookmarked', 'deepWorkTick']) run(sb, fnSrc(f));
  run(sb, 'globalThis.__get = (n) => eval(n);');
  return sb;
}

test('index.js : état deepWork déclaré au NIVEAU MODULE (lu par un timer) + timer posé', () => {
  for (const re of [/^let _deepWork = null;/m, /^let _deepWorkLoaded = false;/m, /^let _deepWorkTryAt = 0;/m,
    /^setInterval\(\(\) => \{ try \{ deepWorkTick\(\); \}/m, /^const _survey = createSurvey\(/m]) assert.match(SRC, re);
  assert.match(SRC, /bot\._mcaOnBookmarked = \(i\) => _onBookmarked\(i\);/);
});

test('deepWorkTick : à -54 sur une case sûre → /sethome work + mémo persisté (survit à la mort) + _workSet', () => {
  const sb = sandbox();
  sb.deepWorkTick();
  assert.deepStrictEqual(sb.bookmarks, ['work']);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sb.memo.deepWork)), { x: 10, y: -54, z: 20, at: T0 });
  assert.strictEqual(sb.__get('_workSet'), true);
  assert.ok(sb.events.some((e) => e.type === 'work_bookmarked' && e.ctx === 'deep_site'));
  // 2e tick 15 s après : throttle (pas de nouvelle pose)
  sb.clock.t += 15000;
  sb.deepWorkTick();
  assert.strictEqual(sb.bookmarks.length, 1);
  // le front avance de 30 blocs, 1 min plus tard → re-pose, sans « oubli » parasite (le callback est muet)
  sb.homewarp.bookmark = (b, n) => { sb.bookmarks.push(n); sb._onBookmarked({ name: n, x: 40, y: -54, z: 20 }); return n; };
  sb.bot.entity.position.x = 40.5; sb.clock.t += 60000;
  sb.deepWorkTick();
  assert.strictEqual(sb.bookmarks.length, 2);
  assert.strictEqual(sb.memo.deepWork.x, 40);
  assert.ok(!sb.events.some((e) => e.type === 'deep_work_forgotten'));
});

test('deepWorkTick : jamais en surface, en combat, en minage, blessé, hostile proche, ni case dangereuse', () => {
  assert.strictEqual((() => { const sb = sandbox({ y: 30 }); sb.deepWorkTick(); return sb.bookmarks.length; })(), 0);
  assert.strictEqual((() => { const sb = sandbox({ digging: {} }); sb.deepWorkTick(); return sb.bookmarks.length; })(), 0);
  assert.strictEqual((() => { const sb = sandbox({ health: 6 }); sb.deepWorkTick(); return sb.bookmarks.length; })(), 0);
  const foe = { position: { distanceTo: () => 4 } };
  assert.strictEqual((() => { const sb = sandbox({ hostile: foe }); sb.deepWorkTick(); return sb.bookmarks.length; })(), 0);
  const sb = sandbox();
  sb.bot.blockAt = (q) => (q.y < -54 ? STONE : (q.x === 11 && q.y === -54 ? { name: 'lava', boundingBox: 'empty' } : AIR));
  sb.deepWorkTick();
  assert.strictEqual(sb.bookmarks.length, 0);
  assert.ok(sb.events.some((e) => e.type === 'deep_work_unsafe' && e.why === 'lava_near'));
});

test('_onBookmarked : un /sethome work posé AILLEURS remplace le chantier → oublié (le timer re-pose sur une case vérifiée)', () => {
  const sb = sandbox({ memo: { deepWork: { x: 10, y: -54, z: 20, at: T0 - 1000 } } });
  sb._onBookmarked({ name: 'safe', x: 0, y: 70, z: 0 });
  assert.strictEqual(sb.memo.deepWork.x, 10, 'un autre home ne touche pas au chantier');
  sb._onBookmarked({ name: 'work', x: 11, y: -54, z: 21 });
  assert.strictEqual(sb.memo.deepWork.x, 10, 're-pose au même endroit : inchangé');
  sb._onBookmarked({ name: 'work', x: 0, y: 70, z: 0 });
  assert.strictEqual(sb.memo.deepWork, null);
  assert.ok(sb.events.some((e) => e.type === 'deep_work_forgotten' && e.why === 'work_moved'));
});

test('câblage descend_y54 : /home work vers le chantier persisté AVANT l escalier, oublié si l atterrissage rate', () => {
  const i = SRC.indexOf('// CHANTIER DE DIAMANT PERSISTÉ (deepWork.js, 24/10)');
  assert.ok(i > 0);
  const body = SRC.slice(i, i + 5000);
  const a = body.indexOf('deepWorkWarpPlan(');
  const b = body.indexOf('descendDiagonal(bot, goal.args');
  assert.ok(a > 0 && a < b, 'le plan /home work passe avant l escalier');
  assert.ok(body.indexOf("_forgetDeepWork(_wet ? 'landed_wet' : 'not_landed')") > a);
  assert.ok(body.indexOf('_recentDeathPositions()') > 0 && body.indexOf('_recentDeathPositions()') < b, 'camp de mort consulté');
  // Les abandons du chantier oublient aussi le mémo persisté (sinon /home work y renverrait après la mort).
  for (const tag of ['drowned', 'stuck', 'migrated', 'delhome', 'tp_refused', 'home_missing']) {
    assert.match(SRC, new RegExp(`_forgetDeepWork\\('${tag}'\\)`), tag);
  }
  // une garde `if (…) _workSet = false;` SANS accolades rendrait l'oubli inconditionnel
  assert.doesNotMatch(SRC, /if \([^)]*\) _workSet = false; _forgetDeepWork/);
});

test('survey : timer réservé aux mineurs, occupé = combat/dig/craft/abri/creeper/pilier/hostile', () => {
  assert.match(SRC, /if \(!IS_MAPPER\) _survey\.tick\(bot, \{ busy: surveyBusyNow\(\) \}\)/);
  const sb = { bot: null, _craftDepth: 0, _shelterInFlight: null, _creeperFlee: null, _meleePillar: null };
  vm.createContext(sb);
  run(sb, fnSrc('surveyBusyNow'));
  assert.strictEqual(sb.surveyBusyNow(), true, 'pas de bot');
  sb.bot = { entity: { position: {} }, health: 20, pvp: { target: null }, nearestEntity: () => null };
  assert.strictEqual(sb.surveyBusyNow(), false);
  sb.bot.targetDigBlock = {};
  assert.strictEqual(sb.surveyBusyNow(), true);
  sb.bot.targetDigBlock = null; sb._craftDepth = 1;
  assert.strictEqual(sb.surveyBusyNow(), true);
  sb._craftDepth = 0; sb.bot.nearestEntity = () => ({ position: { distanceTo: () => 5 } });
  assert.strictEqual(sb.surveyBusyNow(), true);
});
