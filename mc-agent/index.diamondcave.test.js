'use strict';
// APPROCHE D'UN DIAMANT VISIBLE (24/10, session-601 NethBot3 : 70 `diamond_cave_target` en ~50 min pour
// +7 diamants ; session-602 NethBot1 : (120,-9,108) → unreachable en 8 s, (119,-9,109) 7 s, (120,-8,108) 3 s…).
// Le vrai texte de diamondCaveGoto / _caveLegsTo / _caveGotoOre tourne dans un bac à sable `vm` strict
// (piège #56 : un identifiant hors niveau module → ReferenceError ici, pas en prod).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const caveHuntLib = require('./skills/caveHunt');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(re, label) {
  const m = SRC.match(re);
  assert.ok(m, `${label} introuvable dans index.js (déplacé, renommé, ou déclaré hors niveau module ?)`);
  return m[0];
}
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);
const constSrc = (name) => grab(new RegExp(`^const ${name} = [^;]+;`, 'm'), `const ${name}`);
const letSrc = (name) => grab(new RegExp(`^let ${name} = [^;]+;`, 'm'), `let ${name}`);
const run = (sb, code) => vm.runInContext("'use strict';\n" + code, sb);

const err = (name, message) => { const e = new Error(message); e.name = name; return e; };

/**
 * Monde jouet : le pathfinder ne sait PAS relier un but lointain dans la roche (NoPath au-delà de
 * `reach` blocs, comme l'A* borné), mais relie une jambe courte en creusant. `script(goal, canDig)` peut
 * surcharger (GoalChanged d'un réflexe, TP…).
 */
function sandbox({ bot0 = { x: 121, y: -39, z: 105 }, reach = 10, script = null } = {}) {
  const clock = { t: 1_800_000_000_000 };
  const sb = {
    Math, Promise, Number, Array, String, Object, JSON, RegExp, Infinity,
    setTimeout: (f, ms) => setTimeout(f, 0), clearTimeout,
    Date: { now: () => clock.t },
    clock, calls: [], events: [], movesStack: [],
    emit(e) { sb.events.push(e); },
    caveApproachBudgetMs: caveHuntLib.approachBudgetMs,
    caveLegWaypoint: caveHuntLib.legWaypoint,
    openNeighborOf: () => null,
    stopMotion() {},
    Movements: function () {},
    withTempMovements: async (b, M, tweaks, fn) => { sb.movesStack.push(tweaks); try { return await fn(); } finally { sb.movesStack.pop(); } },
    pfGoals: { GoalNear: function (x, y, z, r) { Object.assign(this, { x, y, z, r }); } },
    _caveStairTo: async () => ({ tried: false }),
    bot: {
      entity: { position: Object.assign({}, bot0) },
      pathfinder: {
        goto: async (g) => {
          const canDig = !!(sb.movesStack[sb.movesStack.length - 1] || {}).canDig;
          clock.t += 4000;                                       // chaque essai coûte du temps réel
          sb.calls.push({ canDig, goal: [g.x, g.y, g.z] });
          const p = sb.bot.entity.position;
          if (script) { const r = script(g, canDig, sb); if (r !== undefined) { if (r instanceof Error) throw r; return r; } }
          const d = Math.hypot(g.x - p.x, g.y - p.y, g.z - p.z);
          if (!canDig || d > reach) throw err('NoPath', 'No path to the goal!');
          Object.assign(p, { x: g.x, y: g.y, z: g.z });         // jambe courte en creusant : on y est
          return true;
        },
      },
    },
  };
  vm.createContext(sb);
  sb._goalTrace = { lastInterrupter: () => sb.interrupter || null };
  run(sb, [letSrc('_tpCount'), constSrc('CAVE_PULLED_AWAY'), fnSrc('withTimeout'), fnSrc('caveTravelVerdict'), fnSrc('caveInterruptCause'),
    fnSrc('_caveGotoOre'), fnSrc('_caveLegsTo'), fnSrc('diamondCaveGoto'),
    'this.go = diamondCaveGoto; this.gotoOre = _caveGotoOre; this.tp = () => { _tpCount++; };'].join('\n'));
  return sb;
}

const T_UP = { x: 120, y: -9, z: 108 };   // la grappe de NethBot1, 30 blocs PLUS HAUT que lui

test('rejeu NethBot1 : diamant 30 blocs plus HAUT, but unique = NoPath → atteint par JAMBES en creusant', async () => {
  const sb = sandbox();
  const r = await sb.go(T_UP, { cancelled: false });
  assert.deepStrictEqual({ reached: r.reached, why: r.why }, { reached: true, why: 'legs' });
  // Avant : 2 goto (ouverture puis creusant, but unique à 30 blocs), NoPath, `cave_unreachable`.
  assert.deepStrictEqual(sb.calls.slice(0, 2).map((c) => c.canDig), [false, true]);
  const legs = sb.calls.slice(2);
  assert.ok(legs.length >= 3 && legs.every((c) => c.canDig), 'jambes en creusant');
  assert.ok(legs[0].goal[1] > -39 && legs[0].goal[1] < -9, 'la 1re jambe MONTE (y réel interpolé)');
  const p = sb.bot.entity.position;
  assert.ok(Math.hypot(p.x - T_UP.x, p.y - T_UP.y, p.z - T_UP.z) <= 6);
  assert.ok(sb.events.some((e) => e.type === 'cave_legs'));
});

test('preuve : l\'ANCIENNE approche (_caveGotoOre seul, but unique) conclut inatteignable sur la même cible', async () => {
  const sb = sandbox();
  assert.strictEqual(await sb.gotoOre(T_UP, { cancelled: false }, []), false);
  assert.deepStrictEqual(sb.calls.map((c) => c.canDig), [false, true], 'ouverture puis creusant, but à 30 blocs : NoPath ×2');
});

test('diamondCaveGoto : but VOLÉ par un réflexe (GoalChanged) → interrupted, pas de jambes, pas de verdict', async () => {
  const sb = sandbox({ script: (g, canDig) => (canDig ? undefined : err('GoalChanged', 'The goal was changed before it could be completed!')) });
  const r = await sb.go(T_UP, { cancelled: false });
  assert.deepStrictEqual({ reached: r.reached, interrupted: r.interrupted }, { reached: false, interrupted: true });
  assert.strictEqual(sb.calls.length, 2, 'ouverture (coupée) + creusant (NoPath) — on ne part pas en jambes sur un trajet coupé');
});

test('diamondCaveGoto : TÉLÉPORTÉ (death_camp_flee /home safe) en plein trajet → interrupted/teleported', async () => {
  const sb = sandbox({ script: (g, canDig, s) => { s.tp(); Object.assign(s.bot.entity.position, { x: 139, y: 67, z: 17 }); return err('PathStopped', 'Path was stopped'); } });
  const r = await sb.go(T_UP, { cancelled: false });
  assert.deepStrictEqual({ reached: r.reached, interrupted: r.interrupted, why: r.why }, { reached: false, interrupted: true, why: 'teleported' });
});

test('diamondCaveGoto : roche que même les jambes ne percent pas → inatteignable BORNÉ (≤ budget 45-90 s)', async () => {
  const sb = sandbox({ reach: 0 });   // rien n'est jamais relié
  const t0 = sb.clock.t;
  const r = await sb.go(T_UP, { cancelled: false });
  assert.strictEqual(r.reached, false);
  assert.strictEqual(r.interrupted, false);
  assert.ok(['nopath', 'no_progress', 'timeout'].includes(r.why), r.why);
  const dt = sb.clock.t - t0;
  assert.ok(dt <= caveHuntLib.approachBudgetMs(31) + 20000, `borné : ${dt} ms`);
  assert.ok(sb.calls.length <= 6, 'deux jambes sans progrès → on arrête');
});

test('diamondCaveGoto : déjà à portée → aucun trajet', async () => {
  const sb = sandbox({ bot0: { x: 120, y: -10, z: 106 } });
  const r = await sb.go(T_UP, { cancelled: false });
  assert.strictEqual(r.reached, true);
  assert.strictEqual(sb.calls.length, 0);
});

test('câblage : la chasse diamant passe par diamondCaveGoto / _caveSettle / caveHpOk et lève _diamondHuntBusy', () => {
  const i = SRC.indexOf("if (goal.skill === 'caveHunt')");
  const body = SRC.slice(i, i + 2500);
  assert.match(body, /goTo: \(t\) => diamondCaveGoto\(t, tokCH\)/);
  assert.match(body, /settle: \(\) => _caveSettle\(tokCH\)/);
  assert.match(body, /hpOk: \(\) => caveIronPick\.caveHpOk/);
  assert.match(body, /_diamondHuntBusy = true;[\s\S]*finally \{ _diamondHuntBusy = false; \}/);
  assert.match(SRC, /^let _diamondHuntBusy = false;/m, '_diamondHuntBusy au NIVEAU MODULE (lu par le timer du ramassage)');
  assert.match(SRC, /rareHunt: _diamondHuntBusy/);
  assert.ok(fnSrc('_caveSettle'));
});

test('coupure : la CAUSE (goal_changed) et QUI a coupé (goalTrace) sont rendues — 25/10, 32 interrupted anonymes', async () => {
  const sb = sandbox({ script: (g, canDig) => (canDig ? undefined : err('GoalChanged', 'The goal was changed before it could be completed!')) });
  sb.interrupter = 'fleeFrom@fleeFrom.js:42';
  const r = await sb.go(T_UP, { cancelled: false });
  assert.deepStrictEqual({ interrupted: r.interrupted, why: r.why, by: r.by }, { interrupted: true, why: 'goal_changed', by: 'fleeFrom@fleeFrom.js:42' });
});

// ─── 25/10 : _digDiamondAt — le VRAI texte d'index.js (piège #56 : tout identifiant hors module casse ici) ──
test('_digDiamondAt : arrivé à 6 blocs → se place (GoalLookAtBlock), équipe la pioche fer, casse, ramasse → mined', async () => {
  const vec3 = require('vec3');
  const dd = require('./skills/diamondDig');
  const T = { x: -386, y: -14, z: 322 };
  const state = { ore: 'deepslate_diamond_ore', inv: [{ name: 'iron_pickaxe', count: 1 }, { name: 'shield', count: 1 }], held: { name: 'shield' } };
  const calls = [];
  const bot = {
    entity: { position: vec3(-380.5, -14, 322.5) },
    get heldItem() { return state.held; },
    inventory: { items: () => state.inv },
    blockAt: (p) => (p.x === T.x && p.y === T.y && p.z === T.z ? { name: state.ore, position: p } : { name: 'cave_air', position: p }),
    canSeeBlock: () => true,
    entities: {},
    world: { raycast: () => null },
    equip: async (item) => { calls.push('equip:' + item.name); state.held = item; },
    dig: async (b, force, face) => { calls.push('dig:' + face); state.ore = 'air'; state.inv.push({ name: 'diamond', count: 1 }); },
    stopDigging() {},
    pathfinder: { goto: async (g) => { calls.push('goto:' + g.kind); if (g.kind === 'look') bot.entity.position = vec3(-383.5, -14, 322.5); } },
  };
  const sb = {
    Math, Promise, Number, Array, String, Object, JSON, Infinity,
    setTimeout: (f) => setTimeout(f, 0), clearTimeout, Date,
    bot, vec3Lib: vec3, events: [], emit(e) { sb.events.push(e); }, stopMotion() {},
    sleep: async () => {}, Movements: function () {},
    withTempMovements: async (b, M, t, fn) => fn(),
    pfGoals: { GoalLookAtBlock: function () { this.kind = 'look'; }, GoalNear: function () { this.kind = 'near'; } },
    bmNeighborsHaveLava: () => null, bmWallLava: async () => false,
    bestToolFor: () => state.inv[0],
    floodFillVein: async () => 0,
    digVisibleOre: dd.digVisibleOre, DIAMOND_ORES: dd.DIAMOND_ORES,
  };
  vm.createContext(sb);
  run(sb, [fnSrc('withTimeout'), constSrc('_DIA_FACES'), fnSrc('_diamondFaceVisible'), fnSrc('_digDiamondAt'),
    'this.dig = _digDiamondAt;'].join('\n'));
  const r = await sb.dig(T, { cancelled: false });
  assert.deepStrictEqual([r.outcome, r.mined, r.broken], ['mined', 1, true]);
  assert.deepStrictEqual(calls.slice(0, 3), ['goto:look', 'equip:iron_pickaxe', 'dig:raycast']);
});
