'use strict';
// CÂBLAGE du cliquet de phase d'équipe (fix 24/10 soir). Logique pure dans teamwork.js / lumberjack.js ;
// ici on EXÉCUTE le vrai texte de teamPhaseTick / lumberjackTick / currentTeamPhase dans un bac à sable
// `vm` strict (piège #56 : une variable lue par un timer hors niveau module → ReferenceError ici).
//
// Vécu (sessions 545-562, events team_phase) : diamond → mappers_armor → miners_armor → … parce que
// l'armure s'use ; NethBot2 (28 diamants) réélu bûcheron, diamant arrêté.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const T = require('./teamwork');
const L = require('./lumberjack');
const { buildCtxInv, diamondTargetOf } = require('./goals');
const P = require('./diamondPhase');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(re, label) {
  const m = SRC.match(re);
  assert.ok(m, `${label} introuvable dans index.js`);
  return m[0];
}
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);
const constSrc = (name) => grab(new RegExp(`^const ${name} = [^;]+;`, 'm'), `const ${name}`);
const letSrc = (name) => grab(new RegExp(`^let ${name} = [^;]+;`, 'm'), `let ${name}`);
const run = (sb, code) => vm.runInContext("'use strict';\n" + code, sb);

const T0 = 1_800_000_000_000;
const FULL = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];
const W = (name, o = {}) => Object.assign({ name, role: 'worker', worn: 4, armor: 4, at: T0 - 1000, x: 0, z: 0 }, o);
const MP = (name, o = {}) => Object.assign({ name, role: 'mapper', worn: 4, armor: 4, missing: [], at: T0 - 1000, x: 0, z: 0 }, o);

function fakeClaims(sb) {
  return {
    map: {},
    tryClaim(k) { const c = this.map[k]; if (c && c.by !== sb.bot.username) return false; this.map[k] = { by: sb.bot.username, at: sb.clock.t }; return true; },
    refresh(k) { const c = this.map[k]; if (!c || c.by !== sb.bot.username) return false; c.at = sb.clock.t; return true; },
    release(k) { const c = this.map[k]; if (!c || c.by !== sb.bot.username) return false; delete this.map[k]; return true; },
    peek(k) { const c = this.map[k]; return c ? { by: c.by, at: c.at } : null; },
  };
}

function sandbox(o = {}) {
  const clock = { t: T0 };
  const sb = {
    events: [], calls: [], clock, base: o.base || {}, mates: o.mates || [],
    emit(e) { sb.events.push(e); },
    Date: { now: () => clock.t },
    Object, Math, Number, Array, JSON, Promise, Set, Map, String,
    items: (o.items || []).slice(),
    bot: { username: o.name || 'NethBot2', entity: { position: { x: 0, y: -50, z: 0 } }, inventory: { items: () => sb.items } },
    world: { objective: Object.assign({ type: 'diamond', status: 'in_progress' }, o.objective || {}) },
    presence: { list: () => sb.mates },
    IS_MAPPER: !!o.isMapper,
    whitelist: null,
    isAllowed: () => true,
    _wornArmor: () => new Set(o.worn || FULL),
    wornIronCount: L.wornIronCount, LUMBERJACK_MIN_WORN: L.LUMBERJACK_MIN_WORN,
    buildCtxInv, diamondTargetOf,
    teamPhase: T.teamPhase, latchedTeamPhase: T.latchedTeamPhase, pickDivertedMiner: T.pickDivertedMiner,
    teamStatus: T.teamStatus, TEAM_LATCH_STALE_MS: T.TEAM_LATCH_STALE_MS,
    lumberjackRetireForDiamond: L.lumberjackRetireForDiamond, logCount: L.logCount,
    preferredLumberjack: L.preferredLumberjack, lumberjackVerdict: L.lumberjackVerdict,
    loadBaseState: () => sb.base,
    saveBaseState: (st) => { sb.base = st; return true; },
    freshGiftTarget: () => { sb.calls.push('freshGiftTarget'); return o.giftTarget === undefined ? 'MapBot1' : o.giftTarget; },
    releaseGiftTarget: (n) => sb.calls.push('release:' + n),
    switchObjective: async (to, why) => { sb.calls.push('switch:' + to + ':' + why); return true; },
    switchLumberjack: async (toLj, why) => { sb.calls.push('lj:' + toLj + ':' + why); return true; },
    _ljSwitching: false,
    latchedMinerObjective: P.latchedMinerObjective,
  };
  sb._teamClaims = fakeClaims(sb);
  vm.createContext(sb);
  for (const c of ['TEAM_PHASE_TICK_MS', 'DIAMOND_PROGRESS_EVERY_MS', 'TEAM_SWITCH_COOLDOWN_MS', 'LJ_CLAIM']) run(sb, constSrc(c));
  for (const l of ['_teamPhaseLast', '_diamondProgressAt', '_teamSwitchAt', '_teamLatch', '_teamLatchLoaded', '_ironDetourAt', '_ironDetourLoaded']) run(sb, letSrc(l));
  for (const f of ['_loadTeamLatch', '_teamLatchActive', '_saveTeamLatch', '_loadIronDetour', '_setIronDetour', 'latchedObjectiveNow', 'currentTeamPhase', 'teamPhaseTick',
    'isLumberjackObjective', 'lumberjackTick']) run(sb, fnSrc(f));
  run(sb, 'globalThis.__get = (n) => eval(n); globalThis.__set = (n, v) => eval(n + " = v");');
  return sb;
}

const phases = (sb) => sb.events.filter((e) => e.type === 'team_phase');

test('teamPhaseTick : diamond atteint → cliquet persisté ; une pièce usée (4 → 2) ne fait PAS redescendre la phase', async () => {
  const sb = sandbox({ name: 'NethBot1', mates: [W('NethBot2', { diamonds: 28 }), W('NethBot3'), MP('MapBot1'), MP('MapBot2')] });
  assert.strictEqual(await run(sb, 'teamPhaseTick()'), 'diamond');
  assert.strictEqual(phases(sb).length, 1);
  assert.ok(sb.base.teamLatch && sb.base.teamLatch.at === T0 && sb.base.teamLatch.last === 'diamond');
  // l'armure s'use : NethBot1 tombe à 2 portées, un cartographe à 3
  sb.clock.t += 60000;
  run(sb, '_wornArmor = () => new Set(["iron_helmet", "iron_boots"])');
  sb.mates = [W('NethBot2', { diamonds: 28 }), W('NethBot3'), MP('MapBot1', { worn: 3, missing: ['iron_boots'] }), MP('MapBot2')];
  assert.strictEqual(await run(sb, 'teamPhaseTick()'), 'diamond');
  assert.strictEqual(phases(sb).length, 1, 'aucun team_phase : pas de vrai changement');
  assert.ok(!sb.calls.some((c) => c.startsWith('switch:')), 'personne n’est rappelé pour une pièce usée');
});

test('teamPhaseTick : respawn (process neuf) → cliquet relu du mémo, pas de team_phase from:null', async () => {
  const sb = sandbox({ name: 'NethBot1', base: { teamLatch: { at: T0 - 120000, last: 'diamond' } },
    mates: [W('NethBot2', { worn: 1 }), MP('MapBot1', { worn: 2, missing: ['iron_chestplate'] })] });
  assert.strictEqual(await run(sb, 'teamPhaseTick()'), 'diamond');
  assert.strictEqual(phases(sb).length, 0);
  assert.strictEqual(sb.base.teamLatch.at, T0, 'cliquet rafraîchi');
});

test('teamPhaseTick : cartographe VRAIMENT nu en phase diamant → seul le mineur au MOINS de diamants revient l’armer', async () => {
  const mates = [W('NethBot1', { diamonds: 28 }), W('NethBot3', { diamonds: 4 }), MP('MapBot1', { worn: 0, missing: ['iron_chestplate'] })];
  const best = sandbox({ name: 'NethBot2', items: [{ name: 'diamond', count: 30 }], base: { teamLatch: { at: T0, last: 'diamond' } }, mates });
  await run(best, 'teamPhaseTick()');
  assert.ok(!best.calls.some((c) => c.startsWith('switch:')), 'le meilleur mineur reste au diamant');
  const low = sandbox({ name: 'NethBot3', items: [{ name: 'diamond', count: 4 }], base: { teamLatch: { at: T0, last: 'diamond' } },
    mates: [W('NethBot1', { diamonds: 28 }), W('NethBot2', { diamonds: 30 }), MP('MapBot1', { worn: 0, missing: ['iron_chestplate'] })] });
  await run(low, 'teamPhaseTick()');
  assert.ok(low.calls.includes('switch:mapper_armor:team_mappers_armor'));
  // cartographe à 2 pièces : personne
  const two = sandbox({ name: 'NethBot3', base: { teamLatch: { at: T0, last: 'diamond' } },
    mates: [W('NethBot1', { diamonds: 28 }), MP('MapBot1', { worn: 2, missing: ['iron_chestplate'] })] });
  await run(two, 'teamPhaseTick()');
  assert.ok(!two.calls.some((c) => c.startsWith('switch:')));
});

test('teamPhaseTick (avant cliquet) : phase mappers_armor → un seul mineur détourné, celui qui a le moins de diamants', async () => {
  const mates = [W('NethBot1', { diamonds: 2 }), MP('MapBot1', { worn: 2, missing: ['iron_chestplate'] })];
  const sb = sandbox({ name: 'NethBot2', items: [{ name: 'diamond', count: 28 }], mates });
  assert.strictEqual(await run(sb, 'teamPhaseTick()'), 'mappers_armor');
  assert.ok(!sb.calls.some((c) => c.startsWith('switch:')));
  const sb2 = sandbox({ name: 'NethBot1', items: [{ name: 'diamond', count: 2 }], mates: [W('NethBot2', { diamonds: 28 }), MP('MapBot1', { worn: 2, missing: ['iron_chestplate'] })] });
  await run(sb2, 'teamPhaseTick()');
  assert.ok(sb2.calls.includes('switch:mapper_armor:team_mappers_armor'));
});

test('lumberjackTick : phase diamant cliquetée → AUCUNE élection, même avec un mineur à 2 pièces', async () => {
  const sb = sandbox({ name: 'NethBot2', items: [{ name: 'diamond', count: 28 }], base: { teamLatch: { at: T0, last: 'diamond' } },
    mates: [W('NethBot1', { worn: 2, armor: 2, diamonds: 3 }), W('NethBot3', { diamonds: 5 }), MP('MapBot1')] });
  const v = await run(sb, 'lumberjackTick()');
  assert.strictEqual(v, 'follower');
  assert.ok(!sb.calls.some((c) => c.startsWith('lj:true')));
  assert.strictEqual(sb._teamClaims.peek('lumberjack'), null);
});

test('lumberjackTick : bûcheron élu à tort en phase diamant → retour au diamant immédiat (stock vide compris)', async () => {
  const sb = sandbox({ name: 'NethBot2', objective: { type: 'lumberjack' }, base: { teamLatch: { at: T0, last: 'diamond' } },
    items: [{ name: 'oak_log', count: 5 }], mates: [W('NethBot1', { worn: 2 }), W('NethBot3'), MP('MapBot1')] });
  sb._teamClaims.tryClaim('lumberjack');
  assert.strictEqual(await run(sb, 'lumberjackTick()'), 'release');
  assert.ok(sb.calls.includes('lj:false:team_diamond'));
  assert.strictEqual(sb._teamClaims.peek('lumberjack'), null);
});

test('câblage : heartbeat phaseLatched, armor_repair, pickMapperToEquip maxWorn, preferredLumberjack diamants, variables MODULE', () => {
  assert.match(SRC, /phaseLatched: _teamLatchActive\(\)/);
  assert.match(SRC, /for \(const r of armorRepairs\(_wornBefore, \[\.\.\._wornArmor\(\)\]\)\) emit\(\{ type: 'armor_repair', slot: r\.slot, item: r\.item/);
  assert.match(SRC, /opts: _teamLatchActive\(\) \? \{ maxWorn: NAKED_MAPPER_MAX_WORN \} : \{\}/);
  assert.match(fnSrc('lumberjackTick'), /preferredLumberjack\(\{ selfName: bot\.username, selfArmor, selfWorn, selfDiamonds, mates, now \}\)/);
  assert.match(fnSrc('lumberjackTick'), /currentTeamPhase\(mates, selfWorn, now\)/);
  for (const v of ['_teamLatch', '_teamLatchLoaded', '_teamPhaseLast']) assert.match(SRC, new RegExp('^let ' + v + ' = ', 'm'), v);
});

// ── CLIQUET → OBJECTIF DIAMANT (24/10 soir, 1 h sans diamant : NethBot1/2 re-seedés iron_armor) ──────
test('teamPhaseTick : cliquet + objectif iron_armor (3 pièces) → rebascule au diamant, diamond_progress dans le même tick', async () => {
  const sb = sandbox({ name: 'NethBot2', objective: { type: 'iron_armor' }, worn: FULL.slice(0, 3),
    base: { teamLatch: { at: T0, last: 'diamond' } }, mates: [W('NethBot1'), W('NethBot3'), MP('MapBot1')] });
  sb.switchObjective = async (to, why) => { sb.calls.push('switch:' + to + ':' + why); sb.world.objective.type = to; return true; };
  await run(sb, 'teamPhaseTick()');
  assert.ok(sb.calls.includes('switch:diamond:latched_latched'), JSON.stringify(sb.calls));
  assert.ok(sb.events.some((e) => e.type === 'objective_latched' && e.from === 'iron_armor' && e.to === 'diamond' && e.at === 'tick'));
  assert.ok(sb.events.some((e) => e.type === 'diamond_progress'));
});

test('teamPhaseTick : cliquet + mineur nu au diamant → détour iron_armor (persisté), puis retour au diamant au bout de 20 min', async () => {
  const sb = sandbox({ name: 'NethBot1', worn: [], base: { teamLatch: { at: T0, last: 'diamond' } },
    mates: [W('NethBot2'), W('NethBot3'), MP('MapBot1')] });
  sb.switchObjective = async (to, why) => { sb.calls.push('switch:' + to + ':' + why); sb.world.objective.type = to; return true; };
  await run(sb, 'teamPhaseTick()');
  assert.ok(sb.calls.includes('switch:iron_armor:latched_naked_detour'), JSON.stringify(sb.calls));
  assert.strictEqual(sb.base.ironDetour.at, T0);
  sb.clock.t += 10 * 60000;
  await run(sb, 'teamPhaseTick()');
  assert.strictEqual(sb.calls.filter((c) => c.startsWith('switch:')).length, 1, 'détour en cours : pas de va-et-vient');
  sb.clock.t += 10 * 60000;
  await run(sb, 'teamPhaseTick()');
  assert.ok(sb.calls.includes('switch:diamond:latched_detour_spent'), JSON.stringify(sb.calls));
});

test('teamPhaseTick : cliquet + mapper_armor (vrai détournement) → jamais réécrit par le tick', async () => {
  const sb = sandbox({ name: 'NethBot3', objective: { type: 'mapper_armor' }, base: { teamLatch: { at: T0, last: 'diamond' } },
    mates: [W('NethBot1'), MP('MapBot1', { worn: 0, missing: ['iron_chestplate'] })] });
  await run(sb, 'teamPhaseTick()');
  assert.ok(!sb.calls.some((c) => c.startsWith('switch:')), JSON.stringify(sb.calls));
});
