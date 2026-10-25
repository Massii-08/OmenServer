'use strict';
// CÂBLAGE de la sortie d'abri sûre (fix 20/10 — 9 morts juste après `shelter:out` en 1 h). La décision
// est testée dans test/shelter.safeexit.test.js (dawnExitPlan) ; ici, le VRAI texte des fonctions de
// index.js dans un bac à sable `vm` strict : relevé `exitThreats`, geste `onExit`, et le branchement
// dans les DEUX appels de shelterUntilDawn (une glue oubliée = fonctionnalité morte, tests verts, piège #61).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const CR = require('./creeper');
const TG = require('./threatgate');
const GH = require('./goalHold');
const { isFleeHostile } = require('./skills/fleeFrom');
const { NEUTRAL_NO_PROVOKE } = require('./survival');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(re, label) {
  const m = SRC.match(re);
  assert.ok(m, `${label} introuvable dans index.js (déplacé, renommé, ou déclaré hors niveau module ?)`);
  return m[0];
}
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);
const constSrc = (name) => grab(new RegExp(`^const ${name} = [^;]+;`, 'm'), `const ${name}`);
const run = (sb, code) => vm.runInContext("'use strict';\n" + code, sb);

const mob = (name, dx, dz = 0, extra = {}) => Object.assign({ name, kind: 'Hostile mobs', position: { x: dx, y: 70, z: dz }, height: 1.95, isValid: true }, extra);

function sandbox({ entities = [], walls = new Set() } = {}) {
  const sb = {
    events: [], calls: [],
    emit(e) { sb.events.push(e); },
    bot: {
      entity: { position: { x: 0.5, y: 70, z: 0.5 } },
      entities: Object.fromEntries(entities.map((e, i) => [i, e])),
      blockAt: (p) => (walls.has(p.x + ',' + p.y + ',' + p.z) ? { boundingBox: 'block' } : { boundingBox: 'empty' }),
      pathfinder: { setGoal: (g) => sb.calls.push(g ? 'goal:' + Math.round(g.x) + ',' + Math.round(g.z) : 'goal:null') },
    },
    vec3Lib: (x, y, z) => ({ x, y, z }),
    hasLineOfSight: TG.hasLineOfSight, isFleeHostile, NEUTRAL_NO_PROVOKE,
    creeperAwayPoint: CR.awayPoint, holdGoal: GH.hold, holdSetGoal: GH.holdSetGoal,
    createHoldState: GH.createHoldState,
    pfGoals: { GoalNearXZ: function (x, z, r) { this.x = x; this.z = z; this.r = r; } },
    Date,
  };
  vm.createContext(sb);
  for (const c of ['DAWN_EXIT_HOSTILE_RADIUS', 'DAWN_EXIT_CREEPER_RADIUS', 'DAWN_EXIT_AWAY_KEEP', 'DAWN_EXIT_AWAY_HOLD_MS', '_creeperHold']) run(sb, constSrc(c));
  for (const f of ['_shelterExitEye', '_exitThreatList', 'dawnExitThreatsNow', 'exitAwayFromThreats']) run(sb, fnSrc(f));
  run(sb, 'this.__hold = _creeperHold;');
  GH.installGoalHold(sb.bot.pathfinder, sb.__hold);
  return sb;
}

test('dawnExitThreatsNow : zombie en vue à 12 → 1 hostile ; à 20 → 0 ; creeper CALME à 9 → compté ; enderman/vache non', () => {
  const sb = sandbox({ entities: [mob('zombie', 12), mob('skeleton', 20), mob('creeper', 9), mob('enderman', 3),
    { name: 'cow', kind: 'Passive mobs', position: { x: 2, y: 70, z: 0 } }] });
  assert.deepStrictEqual({ ...run(sb, 'dawnExitThreatsNow()') }, { hostiles: 1, creepers: 1, close: 2 });   // close = à ≤ 12 blocs (25/10)
});

test('dawnExitThreatsNow : un zombie derrière un mur (pas de ligne de vue depuis la sortie) ne compte pas ; un creeper si', () => {
  // mur plein de x=5, y 68..80 — entre la sortie et les deux mobs
  const walls = new Set();
  for (let y = 60; y <= 90; y++) for (let z = -3; z <= 3; z++) walls.add('5,' + y + ',' + z);
  const sb = sandbox({ entities: [mob('zombie', 10), mob('creeper', 8)], walls });
  assert.deepStrictEqual({ ...run(sb, 'dawnExitThreatsNow()') }, { hostiles: 0, creepers: 1, close: 1 });
});

test('_shelterExitEye : au fond d un puits couvert, l œil est AU-DESSUS du toit (sinon il ne verrait jamais rien)', () => {
  const walls = new Set(['0,72,0']);   // toit à +2
  const sb = sandbox({ walls });
  const eye = run(sb, '_shelterExitEye({ x: 0.5, y: 70, z: 0.5 })');
  assert.ok(Math.abs(eye.y - (73 + 1.62)) < 1e-9, JSON.stringify(eye));
  const open = sandbox({});
  assert.ok(Math.abs(run(open, '_shelterExitEye({ x: 0.5, y: 70, z: 0.5 })').y - 71.62) < 1e-9);
});

test('exitAwayFromThreats : zombie en vue à l est → but vers l ouest, verrouillé (le planner ne le vole pas) ; personne → rien', () => {
  const sb = sandbox({ entities: [mob('zombie', 6)] });
  run(sb, 'exitAwayFromThreats()');
  assert.ok(sb.calls.length === 1 && sb.calls[0].startsWith('goal:-10,'), sb.calls.join('|'));
  sb.bot.pathfinder.setGoal({ x: 99, z: 99 });   // le planner, aussitôt
  assert.ok(!sb.calls.includes('goal:99,99'), 'verrou de 5 s');
  assert.ok(sb.events.some((e) => e.type === 'dawn_exit_away' && e.n === 1));
  const empty = sandbox({});
  run(empty, 'exitAwayFromThreats()');
  assert.deepStrictEqual(empty.calls, []);
});

test('index.js : les DEUX appels de shelterUntilDawn branchent exitThreats + onExit', () => {
  const n = (SRC.match(/exitThreats: dawnExitThreatsNow, onExit: exitAwayFromThreats/g) || []).length;
  assert.strictEqual(n, 2);
});
