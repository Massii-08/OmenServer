'use strict';
// PHASE DIAMANT (24/10 soir) — 1 h sans un diamant de plus alors que le cliquet était posé :
//   NethBot1/2 : objectif re-seedé `iron_armor` par le backend à chaque respawn (world-576/577.json),
//                chaîne qui ne finit jamais (pièces usées = non portées) → jamais de retour au diamant ;
//   NethBot3   : objectif diamond, pioche fer cassée à y -53 → `iron_ore not_found` ×21 en 10 min.
// Pur (diamondPhase) + objectiveForStart + glue d'index.js en bac à sable vm strict.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const P = require('./diamondPhase');
const G = require('./goals');

const MIN = 60000;
const NOW = 1792825000000;
const IRON_SET = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];

// ─── latchedMinerObjective ──────────────────────────────────────────────────────────────────────
test('cliquet : iron_armor / iron_help re-seedés → diamond pour un mineur armé (≥ 2 pièces)', () => {
  for (const o of ['iron_armor', 'iron_help']) {
    for (const worn of [2, 3, 4]) {
      const d = P.latchedMinerObjective({ objective: o, latched: true, worn, detourAt: null, now: NOW });
      assert.deepStrictEqual(d, { objective: 'diamond', detourAt: null, why: 'latched' }, `${o} worn ${worn}`);
    }
  }
});

test('cliquet : diamond reste diamond pour un mineur armé', () => {
  const d = P.latchedMinerObjective({ objective: 'diamond', latched: true, worn: 3, detourAt: null, now: NOW });
  assert.strictEqual(d.objective, 'diamond');
});

test('sans cliquet / cartographe / objectif hors filière → null (chemin historique)', () => {
  assert.strictEqual(P.latchedMinerObjective({ objective: 'iron_armor', latched: false, worn: 4, now: NOW }), null);
  assert.strictEqual(P.latchedMinerObjective({ objective: 'iron_armor', latched: true, isMapper: true, worn: 0, now: NOW }), null);
  for (const o of ['mapper', 'lumberjack', 'resource', 'stone_pickaxe', 'iron_pickaxe']) {
    assert.strictEqual(P.latchedMinerObjective({ objective: o, latched: true, worn: 4, now: NOW }), null, o);
  }
});

test('mapper_armor : réécrit au RESPAWN seulement (un vrai détournement en cours de process est gardé)', () => {
  assert.strictEqual(P.latchedMinerObjective({ objective: 'mapper_armor', latched: true, worn: 4, now: NOW }), null);
  const d = P.latchedMinerObjective({ objective: 'mapper_armor', latched: true, worn: 4, now: NOW, fromSpawn: true });
  assert.strictEqual(d.objective, 'diamond');
});

test('mineur VRAIMENT nu (≤ 1 pièce) : détour fer borné, puis diamant même s’il reste nu', () => {
  for (const worn of [0, 1]) {
    const d0 = P.latchedMinerObjective({ objective: 'diamond', latched: true, worn, detourAt: null, now: NOW });
    assert.deepStrictEqual(d0, { objective: 'iron_armor', detourAt: NOW, why: 'naked_detour' });
  }
  // détour en cours : on le garde, sa date de départ ne bouge pas (le respawn ne le relance pas à zéro)
  const d1 = P.latchedMinerObjective({ objective: 'iron_armor', latched: true, worn: 0, detourAt: NOW, now: NOW + 10 * MIN });
  assert.deepStrictEqual(d1, { objective: 'iron_armor', detourAt: NOW, why: 'naked_detour' });
  // détour écoulé (20 min) : retour au diamant, nu ou pas
  const d2 = P.latchedMinerObjective({ objective: 'iron_armor', latched: true, worn: 0, detourAt: NOW, now: NOW + P.IRON_DETOUR_MS });
  assert.deepStrictEqual(d2, { objective: 'diamond', detourAt: NOW, why: 'detour_spent' });
  // pendant le cooldown : pas de nouveau détour
  const d3 = P.latchedMinerObjective({ objective: 'diamond', latched: true, worn: 0, detourAt: NOW, now: NOW + 50 * MIN });
  assert.strictEqual(d3.objective, 'diamond');
  // cycle révolu (détour + cooldown) : un nouveau détour est permis
  const d4 = P.latchedMinerObjective({ objective: 'diamond', latched: true, worn: 0, detourAt: NOW, now: NOW + 61 * MIN });
  assert.deepStrictEqual(d4, { objective: 'iron_armor', detourAt: NOW + 61 * MIN, why: 'naked_detour' });
});

test('détour : 2 pièces reforgées en route → retour immédiat au diamant', () => {
  const d = P.latchedMinerObjective({ objective: 'iron_armor', latched: true, worn: 2, detourAt: NOW, now: NOW + 5 * MIN });
  assert.strictEqual(d.objective, 'diamond');
});

test('détour : date du FUTUR (mémo d’une autre horloge) = aucun détour connu', () => {
  const d = P.latchedMinerObjective({ objective: 'diamond', latched: true, worn: 0, detourAt: NOW + 999 * MIN, now: NOW });
  assert.deepStrictEqual(d, { objective: 'iron_armor', detourAt: NOW, why: 'naked_detour' });
});

// ─── objectiveForStart ──────────────────────────────────────────────────────────────────────────
test('objectiveForStart : cliquet actif → diamond (prime sur la régression iron_help → iron_armor)', () => {
  assert.strictEqual(G.objectiveForStart('iron_armor', { inv: {}, worn: IRON_SET.slice(0, 3), latched: true, now: NOW }), 'diamond');
  assert.strictEqual(G.objectiveForStart('iron_help', { inv: {}, worn: IRON_SET.slice(0, 2), latched: true, now: NOW }), 'diamond');
  assert.strictEqual(G.objectiveForStart('mapper_armor', { inv: {}, worn: IRON_SET, latched: true, fromSpawn: true, now: NOW }), 'diamond');
  // nu : détour fer
  assert.strictEqual(G.objectiveForStart('diamond', { inv: {}, worn: [], latched: true, now: NOW }), 'iron_armor');
  // sans cliquet : comportement historique intact
  assert.strictEqual(G.objectiveForStart('iron_help', { inv: {}, worn: IRON_SET.slice(0, 3) }), 'iron_armor');
  assert.strictEqual(G.objectiveForStart('iron_armor', { inv: {}, worn: IRON_SET.slice(0, 3) }), 'iron_armor');
});

test('chainAfterDone : sous le cliquet, la fin du détour iron_armor mène au diamant', () => {
  const dec = G.chainAfterDone({ objective: 'iron_armor', steps: 4, mates: [{ role: 'worker', need: 9 }],
    canTp: true, giftTarget: null, emptyDoneAt: {}, now: NOW, latched: true });
  assert.strictEqual(dec.next, 'diamond');
});

test('la chaîne diamant garde les timers de forge/fonte (réparation sans quitter le diamant)', () => {
  assert.ok(G.wantsOpportunisticArmor('diamond'));
  const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.match(SRC, /const _SMELT_TIMER_OBJ = new Set\(\[[^\]]*'diamond'/);
});

// ─── repli branch-mine du fer introuvable ───────────────────────────────────────────────────────
test('isIronOreGather : seulement le gather de minerai de fer', () => {
  assert.ok(P.isIronOreGather({ skill: 'gather', args: { name: ['iron_ore', 'deepslate_iron_ore'], count: 3 } }));
  assert.ok(P.isIronOreGather({ skill: 'gather', args: { name: 'deepslate_iron_ore' } }));
  assert.ok(!P.isIronOreGather({ skill: 'gather', args: { name: 'stone' } }));
  assert.ok(!P.isIronOreGather({ skill: 'branchMine', args: { name: 'iron_ore' } }));
  assert.ok(!P.isIronOreGather(null));
});

test('ironGatherPlan : < 3 not_found en 10 min → récolte normale ; au 3e → branch-mine', () => {
  let t = [];
  t = P.noteIronGatherFail(t, NOW);
  t = P.noteIronGatherFail(t, NOW + MIN);
  assert.strictEqual(P.ironGatherPlan({ times: t, now: NOW + 2 * MIN, y: -53 }), null);
  t = P.noteIronGatherFail(t, NOW + 2 * MIN);
  const p = P.ironGatherPlan({ times: t, now: NOW + 2 * MIN, y: -53 });
  assert.strictEqual(p.action, 'branch');
  assert.strictEqual(p.fails, 3);
  assert.strictEqual(p.branchArgs.allowDeeper, true, 'mine AU NIVEAU COURANT (y -53 : deepslate_iron_ore)');
  assert.strictEqual(p.branchArgs.targetY, 16);
});

test('ironGatherPlan : en surface → descente à Y16 d’abord (jamais de récolte de surface)', () => {
  const t = [NOW, NOW + 1, NOW + 2];
  const p = P.ironGatherPlan({ times: t, now: NOW + 3, y: 70 });
  assert.strictEqual(p.action, 'descend_then_branch');
  assert.deepStrictEqual(p.descendArgs, { targetY: 16 });
});

test('ironGatherPlan : les échecs de plus de 10 min ne comptent plus', () => {
  const t = [NOW, NOW + 1, NOW + 2];
  assert.strictEqual(P.ironGatherPlan({ times: t, now: NOW + 2 + P.IRON_GATHER_WINDOW_MS, y: -53 }), null);
  assert.deepStrictEqual(P.noteIronGatherFail(t, NOW + 11 * MIN, false), []);
});

// ─── glue d'index.js ────────────────────────────────────────────────────────────────────────────
const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(re, label) { const m = SRC.match(re); assert.ok(m, `${label} introuvable dans index.js`); return m[0]; }
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);
const run = (sb, code) => vm.runInContext("'use strict';\n" + code, sb);

function startSandbox({ objective, worn, latched, detour = null }) {
  const events = []; const bodies = []; const saved = [];
  let base = { ironDetour: detour === null ? undefined : { at: detour } };
  let tok = { cancelled: false };
  const sb = vm.createContext({
    Date, Promise, Object, Array, Number,
    emit: (e) => events.push(e), events, bodies, saved,
    world: { objective: { type: objective, status: 'in_progress' } }, args: {},
    IS_MAPPER: false, latchedMinerObjective: P.latchedMinerObjective,
    wornIronCount: (w) => w.length, _wornArmor: () => new Set(worn),
    _teamLatchActive: () => latched,
    loadBaseState: () => base, saveBaseState: (st) => { base = st; saved.push(st); },
    objectiveForStart: () => 'iron_armor', buildCtxInv: () => ({}), bot: {},
    _giftTarget: null, releaseGiftTarget: () => {},
    setObjective: (w, o) => { w.objective = o; }, saveWorld: () => {}, worldFile: 'w.json', stopMotion: () => {},
    taskCtl: { active: null, begin(name) { tok.cancelled = true; tok = { cancelled: false }; this.active = name; return tok; } },
    taskToken: { cancelled: true }, _autoRunners: 0,
    runAutonomousBody: (s, o) => { bodies.push(o); return Promise.resolve(); },
  });
  run(sb, 'var _autoLive = null; var _skelRushBusy = false; var _skelPlannerPending = false; var _ironDetourAt = null; var _ironDetourLoaded = false;');
  for (const f of ['autonomousDupStart', '_loadIronDetour', '_setIronDetour', 'latchedObjectiveNow', 'startAutonomous']) run(sb, fnSrc(f));
  return sb;
}

test('startAutonomous : cliquet + iron_armor re-seedé (NethBot2, 3 pièces) → planner lancé sur diamond', async () => {
  const sb = startSandbox({ objective: 'iron_armor', worn: IRON_SET.slice(0, 3), latched: true });
  await run(sb, 'startAutonomous(null, { fromSpawn: true })');
  assert.deepStrictEqual(Array.from(sb.bodies), ['diamond']);
  assert.strictEqual(run(sb, 'world.objective.type'), 'diamond', 'le world.json reçoit diamond');
  assert.ok(sb.events.some((e) => e.type === 'objective_latched' && e.from === 'iron_armor' && e.to === 'diamond'));
});

test('startAutonomous : cliquet + mineur nu (NethBot1, 0 pièce) → détour iron_armor persisté', async () => {
  const sb = startSandbox({ objective: 'diamond', worn: [], latched: true });
  await run(sb, 'startAutonomous(null, { fromSpawn: true })');
  assert.deepStrictEqual(Array.from(sb.bodies), ['iron_armor']);
  assert.ok(sb.saved.some((st) => st.ironDetour && Number.isFinite(st.ironDetour.at)), 'début du détour dans le mémo base');
});

test('startAutonomous : sans cliquet → objectiveForStart historique', async () => {
  const sb = startSandbox({ objective: 'iron_help', worn: [], latched: false });
  await run(sb, 'startAutonomous(null)');
  assert.deepStrictEqual(Array.from(sb.bodies), ['iron_armor']);
  assert.ok(!sb.events.some((e) => e.type === 'objective_latched'));
});

test('câblage : onSpawn relance avec fromSpawn, teamPhaseTick rebascule, gather fer → repli branch-mine', () => {
  assert.match(SRC, /startAutonomous\(null, \{ fromSpawn: true \}\)/);
  const tick = fnSrc('teamPhaseTick');
  assert.match(tick, /latchedObjectiveNow\(objT, false\)/);
  assert.match(tick, /switchObjective\(lat\.objective/);
  // la bascule précède le diamond_progress : un mineur rebasculé au diamant le publie dans le même tick
  assert.ok(tick.indexOf('latchedObjectiveNow') < tick.indexOf("type: 'diamond_progress'"));
  const rgs = fnSrc('runGoalSkill');
  assert.match(rgs, /ironGatherPlan\(\{ times: _ironGatherFails/);
  assert.match(rgs, /_ironGatherFails = noteIronGatherFail\(_ironGatherFails, Date\.now\(\)\)/);
  assert.match(fnSrc('ironGatherBranch'), /skill: 'branchMine'/);
  // NIVEAU MODULE (#56) : états lus par les timers
  assert.match(SRC, /^let _ironGatherFails = \[\];$/m);
  assert.match(SRC, /^let _ironDetourAt = null;$/m);
});

test('teamPhaseTick : diamond_progress émis quand l’objectif est diamond', async () => {
  const events = [];
  const sb = vm.createContext({
    Date, Promise, Object, Array, Number, emit: (e) => events.push(e),
    presence: { list: () => [] }, bot: { entity: {}, username: 'NethBot3' }, IS_MAPPER: false,
    world: { objective: { type: 'diamond', status: 'in_progress' } },
    wornIronCount: (w) => w.length, _wornArmor: () => new Set(IRON_SET),
    currentTeamPhase: () => ({ phase: 'diamond', latched: true, raw: 'diamond', minersArmored: 3, miners: 3, mappersServed: 0, mappers: 2 }),
    _saveTeamLatch: () => {}, latchedObjectiveNow: () => ({ objective: 'diamond', detourAt: null, why: 'latched' }),
    buildCtxInv: () => ({ diamond: 18 }), diamondTargetOf: () => 192, isAllowed: () => false, whitelist: [],
    TEAM_SWITCH_COOLDOWN_MS: 180000, DIAMOND_PROGRESS_EVERY_MS: 120000,
  });
  run(sb, 'var _teamPhaseLast = "diamond"; var _diamondProgressAt = 0; var _teamSwitchAt = 0;');
  run(sb, fnSrc('teamPhaseTick'));
  await run(sb, 'teamPhaseTick()');
  assert.ok(events.some((e) => e.type === 'diamond_progress' && e.have === 18 && e.target === 192));
});

// ─── PIOCHE EN DIAMANT (24/10 soir) ─────────────────────────────────────────────────────────────
const { canHarvestWith } = require('./tools');
const ctxDia = (inv, o = {}) => Object.assign({ inv, worn: IRON_SET, y: -53, hasTable: false }, o);

test('wantsDiamondPick : sans pioche fer+, 3 💎 + 2 bâtons + table posable → oui', () => {
  assert.ok(G.wantsDiamondPick(ctxDia({ diamond: 18, stick: 2, crafting_table: 1 })));
  assert.ok(G.wantsDiamondPick(ctxDia({ diamond: 3, stick: 2, oak_planks: 4 })));
  assert.ok(G.wantsDiamondPick(ctxDia({ diamond: 3, stick: 2 }, { hasTable: true })));
});

test('wantsDiamondPick : matière manquante → non (jamais bloquant)', () => {
  assert.ok(!G.wantsDiamondPick(ctxDia({ diamond: 2, stick: 2, crafting_table: 1 })), '< 3 💎');
  assert.ok(!G.wantsDiamondPick(ctxDia({ diamond: 18, stick: 1, crafting_table: 1 })), '< 2 bâtons');
  assert.ok(!G.wantsDiamondPick(ctxDia({ diamond: 18, stick: 2 })), 'pas de table posable');
  assert.ok(!G.wantsDiamondPick(ctxDia({ diamond: 18, stick: 2, crafting_table: 1, diamond_pickaxe: 1 })), 'déjà une');
});

test('wantsDiamondPick : avec une pioche fer valide → amélioration UNE fois', () => {
  const inv = { diamond: 5, stick: 2, crafting_table: 1, iron_pickaxe: 1 };
  assert.ok(G.wantsDiamondPick(ctxDia(inv)));
  assert.ok(!G.wantsDiamondPick(ctxDia(inv, { diaPickUpgraded: true })), 'déjà faite : on garde la pioche fer');
  // …mais sans pioche fer, la casse de la diamant se répare toujours en diamant
  assert.ok(G.wantsDiamondPick(ctxDia({ diamond: 5, stick: 2, crafting_table: 1 }, { diaPickUpgraded: true })));
});

test('chaîne diamant (NethBot3 : 18 💎, pioche fer cassée, y -53) → 1er but = dia_pick, pas iron_ore', () => {
  const chain = G.chainFor('diamond');
  const c = ctxDia({ diamond: 18, stick: 4, crafting_table: 1, iron_ingot: 1, stone_pickaxe: 1, cobblestone: 20, furnace: 1 });
  assert.strictEqual(G.firstUnmet(chain, c).name, 'dia_pick');
  const g = G.firstUnmet(chain, c);
  assert.deepStrictEqual(g.args, { name: 'diamond_pickaxe', count: 1 });
});

test('chaîne diamant : pioche diamant SEULE en poche → aucun but d’outil ni de fer (pas de pioche bois/fer)', () => {
  const chain = G.chainFor('diamond');
  const c = ctxDia({ diamond: 15, diamond_pickaxe: 1, cobblestone: 20, stick: 0 }, { y: -54 });
  const g = G.firstUnmet(chain, c);
  assert.ok(g, 'la chaîne continue');
  assert.ok(!['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'iron_ore', 'iron_ingot', 'logs', 'dia_pick'].includes(g.name), g.name);
  assert.strictEqual(g.name, 'diamond_caves');
});

test('canHarvestWith : la pioche diamant récolte diamant, fer et deepslate (garde de récolte OK)', () => {
  for (const b of ['diamond_ore', 'deepslate_diamond_ore', 'deepslate_iron_ore', 'iron_ore', 'redstone_ore', 'gold_ore', 'stone']) {
    assert.ok(canHarvestWith(b, 'diamond_pickaxe'), b);
  }
  assert.ok(!canHarvestWith('diamond_ore', 'stone_pickaxe'), 'pierre : toujours refusé');
});

test('craftDiamondPick : craft réussi → 3 💎 comptés (spent), amélioration notée, event', async () => {
  const events = [];
  let inv = { diamond: 18, stick: 2, iron_pickaxe: 1 };
  let base = {};
  const sb = vm.createContext({
    Date, Promise, Object, Math, Number, emit: (e) => events.push(e), bot: {},
    buildCtxInv: () => Object.assign({}, inv),
    craftSmart: async () => { inv = { diamond: 15, stick: 0, iron_pickaxe: 1, diamond_pickaxe: 1 }; return { ok: true }; },
    loadBaseState: () => base, saveBaseState: (b) => { base = b; },
  });
  run(sb, 'var _diaPick = null;');
  run(sb, fnSrc('_diaPickState')); run(sb, fnSrc('craftDiamondPick'));
  const r = await run(sb, "craftDiamondPick({ name: 'dia_pick', args: { name: 'diamond_pickaxe', count: 1 } })");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(JSON.stringify(base.diamondPick), JSON.stringify({ spent: 3, upgraded: true }));
  assert.ok(events.some((e) => e.type === 'diamond_pick_crafted' && e.used === 3 && e.have === 15));
  // un craft sans effet n'est pas un succès et ne compte rien
  inv = { diamond: 18, stick: 2 };
  sb.craftSmart = async () => ({ ok: true });
  const r2 = await run(sb, "craftDiamondPick({ name: 'dia_pick', args: { name: 'diamond_pickaxe', count: 1 } })");
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(base.diamondPick.spent, 3);
});

test('câblage : dia_pick routé vers craftDiamondPick ; diamond_progress publie spent + mined ; ctxExtra porte diaPickUpgraded', () => {
  assert.match(fnSrc('runGoalSkill'), /if \(goal\.name === 'dia_pick'\) return craftDiamondPick\(goal\);/);
  const tick = fnSrc('teamPhaseTick');
  assert.match(tick, /type: 'diamond_progress', have: _have, target: diamondTargetOf\(world\.objective\), spent: _spent, mined: _have \+ _spent/);
  assert.match(fnSrc('ctxExtra'), /offhand, diaPickUpgraded,/);
  assert.match(SRC, /^let _diaPick = null;$/m);
});
