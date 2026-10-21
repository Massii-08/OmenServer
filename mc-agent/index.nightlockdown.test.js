'use strict';
// CÂBLAGE de la DISCIPLINE DE NUIT (19/10 soir, run « de zéro » world_oct9 : 33 morts en 35 min, l'essentiel
// la nuit, flotte partie de zéro donc nue).
//
// La LOGIQUE est testée ailleurs : les décisions pures dans caution.test.js (nightLockdown,
// nightPlannerStep, lockdownShelterNote), l'abri quitté dans skills/shelter.test.js + test/shelter.test.js.
// Ici, la GLUE de index.js — exactement l'endroit où ce projet a déjà perdu des fonctionnalités sans une
// seule erreur (pièges #56/#61 : une garde ajoutée à un seul chemin, un `let` dans onSpawn lu par un timer).
// Technique (cf. index.spawnflee.test.js) : on EXTRAIT le texte réel des fonctions de index.js et on
// l'EXÉCUTE dans un bac à sable `vm` strict dont le seul contenu est ce que le module fournit vraiment au
// niveau module — un identifiant oublié lève une ReferenceError ici, pas en prod.
//
// Ce que ce fichier PROUVE, chemin par chemin, pour un bot NU de NUIT :
//   - squad / regroupement : aucun /tpa ne part ;
//   - entraide de combat : n'engage pas (et le DIT, 1×/min) ;
//   - planner : lance l'abri AU LIEU du skill, le reprend après une interruption, n'en creuse pas un 2e ;
//   - abri : l'écart de 10 min est levé (20 s), un 2e appelant rejoint l'abri en cours ;
//   - quête de nourriture, trajet bois, /tpa vers un cartographe : retenus.
// …et que RIEN ne change pour un bot armé (≥ 2 pièces) ou de jour.

const NW = require('./nightWork');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const C = require('./caution');
const FG = require('./foodGate');
const SH = require('./skills/shelter');
const R = require('./regroup');
const TW = require('./teamwork');
const { DEFENSIVE_HEALTH, isFleeOnlyMob } = require('./reflexes');

function grab(re, label) {
  const m = SRC.match(re);
  assert.ok(m, `${label} introuvable dans index.js (déplacé, renommé, ou déclaré hors niveau module ?)`);
  return m[0];
}
/** Une fonction déclarée au niveau MODULE (colonne 0) — `^}` ferme la fonction, jamais un bloc interne. */
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);
const run = (sb, code) => vm.runInContext("'use strict';\n" + code, sb);
const plain = (x) => JSON.parse(JSON.stringify(x));
const tick = () => new Promise((r) => setImmediate(r));

const T0 = 1_700_000_000_000;
const NIGHT = 18000;
const DAY = 6000;
const PIECES = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];

/**
 * Bac à sable = le niveau MODULE de index.js, réduit à ce que la discipline de nuit lit : le bot (heure,
 * position, pièces portées), la vraie décision pure (caution) et les deux helpers communs RÉELS
 * (nightLockdownNow, nightGateNote). `extra` complète par chemin testé.
 */
function sandbox({ worn = 0, timeOfDay = NIGHT, day = 4, pos = { x: 0, y: 70, z: 0 }, clock = { t: T0 }, bot: botOver = {}, ...extra } = {}) {
  const chat = [];
  const bot = Object.assign({
    username: 'NethBot3',
    time: timeOfDay == null ? undefined : { timeOfDay, day },
    entity: pos && { position: pos },
    health: 20,
    food: 20,
    players: {},
    chat: (m) => chat.push(m),
    nearestEntity: () => null,
  }, botOver);
  const sb = {
    events: [], chat, clock, bot, calls: [],
    emit(e) { sb.events.push(e); },
    Date: { now: () => clock.t },
    setTimeout: () => 0,
    _wornN: worn,
    _wornArmor: () => new Set(PIECES.slice(0, sb._wornN)),
    isNight: SH.isNight,
    nightLockdown: C.nightLockdown, nightPlannerStep: C.nightPlannerStep, lockdownShelterNote: C.lockdownShelterNote,
    NIGHT_SHELTER_GAP_MS: C.NIGHT_SHELTER_GAP_MS, NIGHT_UNDERGROUND_Y: C.NIGHT_UNDERGROUND_Y,
    regroupCaution: C.regroupCaution,
    _nightGateAt: {},
    // NUIT AU TRAVAIL (21/10) : le VRAI relevé « sous terre » ; la descente elle-même est testée dans
    // index.nightwork.test.js — ici elle échoue (false) pour garder le comportement historique de l'abri.
    nightUnderground: NW.nightUnderground, nightDeferGoal: NW.nightDeferGoal, _nightWork: null,
    _nightDeferReturnAt: {}, NIGHT_DEFER_RETURN_MS: 30000,
    tryNightWork: async () => false,
    _furnaceJob: null, FURNACE_JOB_KEEP_SKILLS: new Set(), finishFurnaceJob: async () => {},
    ...extra,
  };
  vm.createContext(sb);
  run(sb, fnSrc('_nightId'));
  run(sb, fnSrc('nightUndergroundNow'));
  run(sb, fnSrc('nightLockdownNow'));
  run(sb, fnSrc('nightGateNote'));
  return sb;
}
const ofType = (sb, type) => sb.events.filter((e) => e.type === type);

// ═════════════════════ 0. niveau MODULE : tout ce qu'un timer lit (piège #56) ═══════════════════════
test('index.js : l état de la discipline de nuit est déclaré au NIVEAU MODULE (lu par des timers ET le planner)', () => {
  for (const decl of [/^let _shelterInFlight = null;/m, /^let _nightHold = 0;/m, /^let _lockdownShelters = null;/m,
    /^const _nightGateAt = \{\};/m, /^let _assistBusy = false;/m, /^let _lastAssistAt = 0;/m,
    /^const NIGHT_HOLD_POLL_MS = /m, /^const NIGHT_HOLD_MAX_MS = /m]) {
    assert.match(SRC, decl);
  }
  for (const name of ['nightLockdownNow', 'nightGateNote', 'holdForNight', 'teamAssistTick', 'foodRunTick', 'woodTripWanted']) {
    assert.ok(fnSrc(name), name);
  }
  // l'ancien état de l'entraide DANS onSpawn a disparu (sinon deux compteurs, dont un mort)
  assert.strictEqual((SRC.match(/let _assistBusy = false;/g) || []).length, 1);
});

// ═════════════════════ 1. le prédicat commun, sur l'état réel ══════════════════════════════════════
test('nightLockdownNow : nu (0-1 pièce) + nuit CONNUE → vrai ; 2 pièces, jour, heure inconnue → faux', () => {
  assert.strictEqual(sandbox({ worn: 0 }).nightLockdownNow(), true);
  assert.strictEqual(sandbox({ worn: 1 }).nightLockdownNow(), true);
  assert.strictEqual(sandbox({ worn: 2 }).nightLockdownNow(), false, 'armé : comportement inchangé');
  assert.strictEqual(sandbox({ worn: 0, timeOfDay: DAY }).nightLockdownNow(), false);
  assert.strictEqual(sandbox({ worn: 0, timeOfDay: null }).nightLockdownNow(), false, 'bot.time pas encore livré');
  const sb = sandbox({ worn: 0 });
  sb.bot.time.timeOfDay = null;
  assert.strictEqual(sb.nightLockdownNow(), false);
});

test('nightLockdownNow : inventaire illisible → 0 pièce = prudent (lockdown la nuit)', () => {
  const sb = sandbox();
  sb._wornArmor = () => { throw new Error('slots'); };
  assert.strictEqual(sb.nightLockdownNow(), true);
});

test('nightGateNote : 1 event `night_gate` par routine et par minute (un gate muet = une fonctionnalité morte)', () => {
  const sb = sandbox();
  assert.strictEqual(sb.nightGateNote('team_assist', { mob: 'zombie' }), true);
  assert.strictEqual(sb.nightGateNote('team_assist'), false);
  assert.strictEqual(sb.nightGateNote('food_run'), true, 'chaque routine a son propre compteur');
  sb.clock.t += 60000;
  assert.strictEqual(sb.nightGateNote('team_assist'), true);
  assert.deepStrictEqual(plain(sb.events.map((e) => [e.what, e.mob || null])),
    [['team_assist', 'zombie'], ['food_run', null], ['team_assist', null]]);
});

// ═════════════════════ 2. squad / regroupement : aucun /tpa (regroupCaution, étendu) ═══════════════
function squadSandbox(opts = {}) {
  const shelters = [];
  const sb = sandbox(Object.assign({
    REGROUP: true,
    presence: { list: () => [{ name: 'NethBot1', role: 'worker', x: 300, y: 70, z: 0, at: T0 }] },
    armorNeed: () => 1, buildCtxInv: () => ({}),
    _stillBusy: false, _imminentBusy: false, _smeltOppBusy: false, _armorBusy: false,
    _migrating: false, _escaping: false, _foodTripBusy: false, _zoneIronMined: 0, _craftDepth: 0,
    _lastSquadAt: 0, _lastRegroupAt: 0, _curGoal: null, _squadSkipWhy: null, _squadSkipAt: 0,
    isLumberjackObjective: () => false,   // bûcheron d'équipe (20/10) : hors sujet ici
    squadTarget: R.squadTarget, pickRegroupTarget: R.pickRegroupTarget,
    isAllowed: () => true, whitelist: null,
    stopMotion() {}, awaitWarp: async () => ({ warped: true }),
    isInWater: () => false,
    maybeNightShelter: async (proactive, o) => { shelters.push({ proactive, opts: o }); return true; },
    shelters,
  }, opts));
  run(sb, fnSrc('regroupNightGuard'));
  run(sb, fnSrc('noteSquadSkip'));
  run(sb, fnSrc('trySquad'));
  run(sb, fnSrc('tryRegroup'));
  return sb;
}

test('SQUAD : nu de nuit → AUCUN /tpa vers le chef ; on s abrite (forcé) à la place', async () => {
  const sb = squadSandbox({ worn: 0 });
  assert.deepStrictEqual(plain(await sb.trySquad()), { ok: false, reason: 'night_shelter' });
  assert.deepStrictEqual(sb.chat, [], 'pas un seul /tpa');
  assert.strictEqual(ofType(sb, 'squad_join').length, 0);
  assert.deepStrictEqual(plain(sb.shelters), [{ proactive: true, opts: { force: true } }]);
  assert.strictEqual(ofType(sb, 'regroup_caution').length, 1);
});

test('REGROUPEMENT : nu de nuit → AUCUN /tpa non plus (même garde, regroupNightGuard)', async () => {
  const sb = squadSandbox({ worn: 1 });
  assert.deepStrictEqual(plain(await sb.tryRegroup()), { ok: false, reason: 'night_shelter' });
  assert.deepStrictEqual(sb.chat, []);
  assert.strictEqual(ofType(sb, 'regroup_tpa').length, 0);
});

test('SQUAD : nu de nuit DANS L EAU → toujours pas de /tpa, et l abri n est pas forcé (le sauvetage garde la main)', async () => {
  const sb = squadSandbox({ worn: 0, isInWater: () => true });
  await sb.trySquad();
  assert.deepStrictEqual(sb.chat, []);
  assert.deepStrictEqual(plain(sb.shelters), [{ proactive: true, opts: {} }]);
});

test('SQUAD / REGROUPEMENT : armé (2 pièces) de nuit, ou nu de JOUR → le /tpa part comme avant', async () => {
  const armed = squadSandbox({ worn: 2 });
  assert.deepStrictEqual(plain(await armed.trySquad()), { ok: true });
  assert.deepStrictEqual(armed.chat, ['/tpa NethBot1']);
  const dayNude = squadSandbox({ worn: 0, timeOfDay: DAY });
  await dayNude.tryRegroup();
  assert.deepStrictEqual(dayNude.chat, ['/tpa NethBot1']);
  assert.strictEqual(dayNude.shelters.length, 0);
});

// 21/10 : le mineur au fond n'est jamais arraché (regroup.squadHold), et le refus est TRACÉ (squad_skip).
test('SQUAD : mineur à y=15 en iron_deep, de jour → aucun /tpa, squad_skip{why:underground} (1 seul event)', async () => {
  const sb = squadSandbox({ worn: 2, timeOfDay: DAY, pos: { x: 4, y: 15, z: 33 } });
  run(sb, "_curGoal = { name: 'iron_deep', skill: 'branchMine', at: 0 }");
  assert.deepStrictEqual(plain(await sb.trySquad()), { ok: false, reason: 'no_need' });
  sb.clock.t += 60000;
  await sb.trySquad();
  assert.deepStrictEqual(sb.chat, []);
  const sk = ofType(sb, 'squad_skip');
  assert.strictEqual(sk.length, 1, 'dédup au changement de raison');
  assert.strictEqual(sk[0].why, 'underground');
  assert.strictEqual(sk[0].goal, 'iron_deep');
  assert.strictEqual(sk[0].y, 15);
});

test('SQUAD : en surface en descente vers le fond, chef de surface → mining_goal, aucun /tpa', async () => {
  const sb = squadSandbox({ worn: 2, timeOfDay: DAY });
  run(sb, "_curGoal = { name: 'descend_y16', skill: 'descendDiagonal', at: 0 }");
  await sb.trySquad();
  assert.deepStrictEqual(sb.chat, []);
  assert.strictEqual(ofType(sb, 'squad_skip')[0].why, 'mining_goal');
});

test('runSkillWithTelemetry : pose _curGoal pendant le skill et le retire après', () => {
  const body = fnSrc('runSkillWithTelemetry');
  assert.match(body, /_curGoal = _cg;/);
  assert.match(body, /if \(_curGoal === _cg\) _curGoal = null;/);
});

// ═════════════════════ 3. entraide de combat : n'engage pas ════════════════════════════════════════
function assistSandbox(opts = {}) {
  const attacks = [];
  const zombie = { name: 'zombie', kind: 'Hostile mobs', position: { x: 6, y: 70, z: 0 } };
  const sb = sandbox(Object.assign({
    _assistBusy: false, _lastAssistAt: 0, _stillBusy: false, _imminentBusy: false,
    presence: { list: () => [{ name: 'NethBot2', role: 'worker' }] },
    DEFENSIVE_HEALTH, isFleeOnlyMob, pickMobAssist: TW.pickMobAssist,
    nearbyHostiles: () => [zombie],
    bestWeapon: () => null,
    attacks,
  }, opts));
  sb.bot.players = { NethBot2: { entity: { position: { x: 5, y: 70, z: 0 } } } };   // coéquipier collé au zombie
  sb.bot.pvp = { attack: (e) => attacks.push(e && e.name) };
  run(sb, fnSrc('teamAssistTick'));
  return sb;
}

test('ENTRAIDE : nu de nuit, un coéquipier attaqué → on NE rejoint PAS la bagarre (et on le dit, 1×/min)', async () => {
  const sb = assistSandbox({ worn: 0 });
  assert.strictEqual(sb.teamAssistTick(), null);
  await tick();
  assert.deepStrictEqual(sb.attacks, [], 'aucun pvp.attack');
  assert.strictEqual(ofType(sb, 'team_assist').length, 0);
  assert.deepStrictEqual(plain(ofType(sb, 'night_gate')), [{ type: 'night_gate', what: 'team_assist', mob: 'zombie', mate: 'NethBot2' }]);
  assert.strictEqual(sb._assistBusy, false, 'rien n est verrouillé : le tick suivant re-décide');
  sb.clock.t += 8000;
  assert.strictEqual(sb.teamAssistTick(), null);
  assert.strictEqual(ofType(sb, 'night_gate').length, 1, 'pas de spam toutes les 4 s');
});

test('ENTRAIDE : rien à secourir → aucun `night_gate` (le gate ne parle que s il a retenu quelque chose)', () => {
  const sb = assistSandbox({ worn: 0, nearbyHostiles: () => [] });
  assert.strictEqual(sb.teamAssistTick(), null);
  assert.strictEqual(sb.events.length, 0);
});

test('ENTRAIDE : armé (2 pièces) de nuit, ou nu de JOUR → secours comme avant (team_assist + pvp.attack)', async () => {
  for (const sb of [assistSandbox({ worn: 2 }), assistSandbox({ worn: 0, timeOfDay: DAY })]) {
    const pick = sb.teamAssistTick();
    await tick();
    assert.ok(pick && pick.mate === 'NethBot2');
    assert.deepStrictEqual(sb.attacks, ['zombie']);
    assert.strictEqual(ofType(sb, 'team_assist').length, 1);
    assert.strictEqual(ofType(sb, 'night_gate').length, 0);
  }
});

test('index.js : le timer d entraide appelle teamAssistTick, et c est le SEUL chemin qui émet team_assist', () => {
  assert.match(SRC, /if \(REGROUP && !IS_MAPPER\) setInterval\(\(\) => \{ teamAssistTick\(\); \}, 4000\);/);
  assert.strictEqual((SRC.match(/type: 'team_assist'/g) || []).length, 1);
  const body = fnSrc('teamAssistTick');
  assert.ok(body.indexOf('nightLockdownNow()') < body.indexOf("type: 'team_assist'"), 'le gate passe AVANT l engagement');
});

// ═════════════════════ 4. le PLANNER : l'abri AU LIEU du skill ═════════════════════════════════════
/**
 * Planner : runSkillWithTelemetry + holdForNight RÉELS. `shelterStub` joue maybeNightShelter (comme le
 * vrai, il date le DÉBUT de l'abri dans lastShelterT) ; `sleep` fait avancer l'horloge et appelle onSleep.
 */
function plannerSandbox({ shelterStub, onSleep, ...opts } = {}) {
  const log = { skills: [], shelters: [], settles: 0, sleeps: [] };
  const sb = sandbox(Object.assign({
    taskToken: { cancelled: false },
    migrationOwnsBot: () => false,
    foodTripYield: async () => {},
    settleSurvivalKit: async () => { log.settles++; },
    runGoalSkill: async (g) => { log.skills.push(g.name); return { ok: true, ran: g.name }; },
    withTimeout: (p) => p, timeoutFor: () => 60000, stopMotion() {},
    MINING_GOALS: new Set(), _zoneMiningMs: 0, noteZoneFailure() {}, _skillInFlight: 0, _curGoal: null,
    woodWaitStep: async () => null,        // bûcheron d'équipe (20/10) : aucun bûcheron → comportement historique
    isInWater: () => false,
    lastShelterT: 0, _shelterInFlight: null, _nightHold: 0,
    NIGHT_HOLD_POLL_MS: 2000, NIGHT_HOLD_MAX_MS: 15 * 60 * 1000,
    log,
  }, opts));
  sb.sleep = async (ms) => { log.sleeps.push(ms); sb.clock.t += ms; if (onSleep) onSleep(sb, log); };
  sb.maybeNightShelter = async (proactive, o) => {
    log.shelters.push({ proactive: proactive === undefined ? null : proactive, opts: o === undefined ? null : o });
    if (proactive === undefined) return false;                // l'appel historique (non proactif) d'après la nuit
    sb.lastShelterT = sb.clock.t;                             // comme le vrai : l'écart part du DÉBUT de l'abri
    return shelterStub ? shelterStub(sb, log) : (sb.bot.time.timeOfDay = DAY, true);   // défaut : terré jusqu'à l'aube
  };
  run(sb, fnSrc('holdForNight'));
  run(sb, fnSrc('runSkillWithTelemetry'));
  return sb;
}
const forced = (log) => log.shelters.filter((s) => s.proactive === true);

test('PLANNER : nu de nuit en surface → l ABRI au lieu du skill, puis la main rendue à l aube SANS lancer le skill', async () => {
  const sb = plannerSandbox({ worn: 0 });
  const r = await sb.runSkillWithTelemetry({ name: 'logs', skill: 'gatherLog' });
  assert.deepStrictEqual(plain(r), { held: 'night' }, 'ni ok:false (failStreak) ni ok:true : une nuit n est pas un verdict sur le but');
  assert.deepStrictEqual(sb.log.skills, [], 'le skill ne part PAS');
  assert.deepStrictEqual(plain(forced(sb.log)), [{ proactive: true, opts: { force: true } }]);
  assert.deepStrictEqual(plain(ofType(sb, 'night_hold')), [{ type: 'night_hold', goal: 'logs', skill: 'gatherLog', y: 70, step: 'shelter' }]);
  const end = ofType(sb, 'night_hold_end');
  assert.strictEqual(end.length, 1);
  assert.strictEqual(end[0].reason, 'dawn');
  assert.strictEqual(sb._nightHold, 0, 'plus retenu une fois la main rendue');
  // à l'aube, le planner re-dérive : le but est relancé au tour suivant, normalement
  const r2 = await sb.runSkillWithTelemetry({ name: 'logs', skill: 'gatherLog' });
  assert.deepStrictEqual(sb.log.skills, ['logs']);
  assert.strictEqual(r2.ok, true);
});

test('PLANNER : armé (2 pièces) de nuit → aucun changement, le skill part (après l appel historique)', async () => {
  const sb = plannerSandbox({ worn: 2 });
  const r = await sb.runSkillWithTelemetry({ name: 'iron_deep', skill: 'branchMine' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(sb.log.skills, ['iron_deep']);
  assert.deepStrictEqual(plain(sb.log.shelters), [{ proactive: null, opts: null }], 'seul maybeNightShelter() d origine');
  assert.strictEqual(ofType(sb, 'night_hold').length, 0);
});

test('PLANNER : nu de JOUR → aucun changement non plus', async () => {
  const sb = plannerSandbox({ worn: 0, timeOfDay: DAY });
  await sb.runSkillWithTelemetry({ name: 'logs', skill: 'gatherLog' });
  assert.deepStrictEqual(sb.log.skills, ['logs']);
  assert.strictEqual(forced(sb.log).length, 0);
});

test('PLANNER : SOUS TERRE la nuit ne change rien — un but de minage part', async () => {
  const sb = plannerSandbox({ worn: 0, pos: { x: 0, y: 16, z: 0 } });
  const r = await sb.runSkillWithTelemetry({ name: 'iron_deep', skill: 'branchMine' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(sb.log.skills, ['iron_deep']);
  assert.strictEqual(forced(sb.log).length, 0, 'pas d abri sous terre (shouldShelter le refuse)');
});

test('PLANNER : sous terre, un but qui REMONTE (bois) rend d abord la main (différé, 21/10), puis attend l aube sur place — ni skill, ni abri, ni sortie', async () => {
  const sb = plannerSandbox({
    worn: 0, pos: { x: 0, y: 16, z: 0 },
    onSleep: (s, log) => { if (log.sleeps.length === 5) s.bot.time.timeOfDay = DAY; },
  });
  // 1er passage : main rendue tout de suite → le planner passe à un but faisable sous terre (nightSkipGoal).
  const r0 = await sb.runSkillWithTelemetry({ name: 'logs', skill: 'gatherLog' });
  assert.deepStrictEqual(plain(r0), { held: 'night' });
  assert.strictEqual(sb.log.sleeps.length, 0);
  // Revenu dans les 30 s (tout le reste est différé aussi) : on attend l'aube sur place, comme avant.
  const r = await sb.runSkillWithTelemetry({ name: 'logs', skill: 'gatherLog' });
  assert.deepStrictEqual(plain(r), { held: 'night' });
  assert.deepStrictEqual(sb.log.skills, []);
  assert.strictEqual(forced(sb.log).length, 0);
  assert.strictEqual(sb.log.sleeps.length, 5);
  assert.strictEqual(sb.log.settles, 2 + 5, 'la survie du kit tourne pendant l attente (1 avant chaque skill, 1 par pas)');
});

test('PLANNER : un abri DÉJÀ en cours (lancé par le timer de squad) → le planner l ATTEND, il ne repart pas couper du bois à côté (NethBot3)', async () => {
  const sb = plannerSandbox({
    worn: 0,
    onSleep: (s, log) => { if (log.sleeps.length === 3) { s._shelterInFlight = null; s.bot.time.timeOfDay = DAY; } },
  });
  sb._shelterInFlight = new Promise(() => {});        // l'abri du timer, en cours
  const r = await sb.runSkillWithTelemetry({ name: 'logs', skill: 'gatherLog' });
  assert.deepStrictEqual(plain(r), { held: 'night' });
  assert.deepStrictEqual(sb.log.skills, []);
  assert.strictEqual(forced(sb.log).length, 0, 'pas de 2e trou');
  assert.strictEqual(sb.log.settles, 1, 'et pas de survie active qui le tirerait hors du trou de l autre');
  assert.strictEqual(sb._nightHold, 0);
});

test('PLANNER : abri INTERROMPU (délogé après 5 min) → ré-abri immédiat, sans attendre 10 min', async () => {
  let n = 0;
  const sb = plannerSandbox({
    worn: 0,
    shelterStub: (s) => { n++; if (n === 1) { s.clock.t += 5 * 60000; return true; } s.bot.time.timeOfDay = DAY; return true; },
  });
  await sb.runSkillWithTelemetry({ name: 'logs', skill: 'gatherLog' });
  assert.strictEqual(forced(sb.log).length, 2, 'le 2e abri suit le 1er');
  assert.deepStrictEqual(sb.log.sleeps, [], 'aucune attente : 5 min > l écart de 20 s');
  assert.deepStrictEqual(sb.log.skills, []);
});

test('PLANNER : abri raté À L INSTANT (void_below au respawn) → mini-écart de 20 s, survie active, puis on réessaie', async () => {
  let n = 0;
  const sb = plannerSandbox({
    worn: 0,
    shelterStub: (s) => { n++; if (n === 1) return true; s.bot.time.timeOfDay = DAY; return true; },
  });
  await sb.runSkillWithTelemetry({ name: 'logs', skill: 'gatherLog' });
  assert.strictEqual(forced(sb.log).length, 2);
  const waited = sb.log.sleeps.reduce((a, b) => a + b, 0);
  assert.ok(waited >= C.NIGHT_SHELTER_GAP_MS && waited < C.NIGHT_SHELTER_GAP_MS + 2000, `attendu ~20 s, pas 10 min (${waited} ms)`);
  assert.ok(sb.log.settles >= 2, 'à découvert entre deux abris, la survie du kit tourne');
});

test('PLANNER : dans l EAU → pas d abri creusé, on attend que le sauvetage l en sorte, PUIS on s abrite', async () => {
  let wet = true;
  const sb = plannerSandbox({
    worn: 0, isInWater: () => wet,
    onSleep: (s, log) => { if (log.sleeps.length === 3) wet = false; },
  });
  await sb.runSkillWithTelemetry({ name: 'logs', skill: 'gatherLog' });
  assert.strictEqual(sb.log.sleeps.length, 3);
  assert.strictEqual(forced(sb.log).length, 1, 'un seul abri, une fois sorti de l eau');
  assert.strictEqual(sb.log.settles, 1, 'pas de survie du kit pendant le sauvetage d eau');
});

test('PLANNER : tâche annulée pendant la nuit (mort → respawn, migration) → cancelled, le skill ne part pas', async () => {
  const sb = plannerSandbox({ worn: 0, shelterStub: (s) => { s.taskToken.cancelled = true; return true; } });
  assert.deepStrictEqual(plain(await sb.runSkillWithTelemetry({ name: 'logs', skill: 'gatherLog' })), { ok: false, reason: 'cancelled' });
  assert.deepStrictEqual(sb.log.skills, []);
  assert.strictEqual(ofType(sb, 'night_hold_end')[0].reason, 'cancelled');
  assert.strictEqual(sb._nightHold, 0);
});

test('PLANNER : garde-fou — une heure FIGÉE (nuit sans fin) ne retient jamais le planner plus de 15 min', async () => {
  const sb = plannerSandbox({ worn: 0, shelterStub: (s) => { s.clock.t += 60000; return true; } });
  const r = await sb.runSkillWithTelemetry({ name: 'logs', skill: 'gatherLog' });
  assert.deepStrictEqual(plain(r), { held: 'night' });
  assert.strictEqual(ofType(sb, 'night_hold_end')[0].reason, 'max');
  assert.ok(forced(sb.log).length <= 17);
});

test('PLANNER : l armure arrive pendant la nuit → on rend la main tout de suite (raison armored)', async () => {
  const sb = plannerSandbox({ worn: 0, shelterStub: (s) => { s._wornN = 2; return true; } });
  await sb.runSkillWithTelemetry({ name: 'logs', skill: 'gatherLog' });
  assert.strictEqual(ofType(sb, 'night_hold_end')[0].reason, 'armored');
});

test('PLANNER : retenue COMPTÉE — un vieux planner qui sort (jeton annulé au respawn) ne libère pas le nouveau', async () => {
  // deux holdForNight concurrents (vieille startAutonomous qui finit de se dérouler + la nouvelle) :
  // un booléen remis à false par le premier laisserait le 2e « non retenu » → desync/rappel confine.
  let release1;
  let n = 0;
  const sb = plannerSandbox({
    worn: 0,
    shelterStub: () => { n++; if (n === 1) return new Promise((r) => { release1 = r; }); return new Promise(() => {}); },
  });
  const tokOld = sb.taskToken;
  const a = sb.holdForNight({ name: 'logs', skill: 'gatherLog' });
  await tick();
  sb.taskToken = { cancelled: false };       // respawn : un nouveau planner, un nouveau jeton
  sb.lastShelterT = 0;
  const b = sb.holdForNight({ name: 'logs', skill: 'gatherLog' });
  await tick();
  assert.strictEqual(sb._nightHold, 2);
  tokOld.cancelled = true;                    // l'ancien est préempté…
  sb.taskToken = tokOld;                      // (il relit le global : on le lui rend le temps de sortir)
  release1(true);
  await a;
  assert.strictEqual(sb._nightHold, 1, '…et le nouveau reste retenu');
  void b;
});

test('ABRI : en lockdown, l abri se TERMINE si le bot en est délogé (endWhenDisplaced) ; armé, comportement d origine', async () => {
  const deps = [];
  const nude = shelterSandbox({ worn: 0 });
  nude.shelterUntilDawn = async (b, tok, d) => { deps.push(d); return { ok: true }; };
  await nude.maybeNightShelter(true, { force: true });
  const armed = shelterSandbox({ worn: 2 });
  armed.shelterUntilDawn = async (b, tok, d) => { deps.push(d); return { ok: true }; };
  await armed.maybeNightShelter(true);
  assert.deepStrictEqual(deps.map((d) => d.endWhenDisplaced()), [true, false]);
  // RELU au délogement, pas figé à l'ouverture : un abri ouvert au crépuscule (avant que isNight ne
  // bascule) se termine aussi si le bot en est délogé une fois la nuit tombée.
  const dusk = shelterSandbox({ worn: 0, timeOfDay: 12500 });
  dusk.bot.blockAt = () => ({ light: 3 });                            // sombre (canopée) : abri même avant la nuit
  dusk.shelterUntilDawn = async (b, tok, d) => { deps.push(d); return { ok: true }; };
  await dusk.maybeNightShelter();
  const d = deps[deps.length - 1];
  assert.strictEqual(d.endWhenDisplaced(), false, 'crépuscule : pas encore de lockdown');
  dusk.bot.time.timeOfDay = NIGHT;
  assert.strictEqual(d.endWhenDisplaced(), true, 'la nuit tombe : délogé = fin de l abri');
  assert.match(fnSrc('maybeNightShelter'), /endWhenDisplaced: \(\) => nightLockdownNow\(\),/);
});

test('index.js : runSkillWithTelemetry passe par holdForNight AVANT le skill, et rend { held } sans lancer runGoalSkill', () => {
  const body = fnSrc('runSkillWithTelemetry');
  const iHold = body.indexOf('await holdForNight(g)');
  assert.ok(iHold > 0);
  assert.ok(iHold < body.indexOf('runGoalSkill(g)'));
  assert.ok(iHold > body.indexOf('await settleSurvivalKit()'), 'la survie immédiate d abord, l abri ensuite');
  assert.match(body, /if \(_night\.held\) return \{ held: 'night' \};/);
});

// ═════════════════════ 5. l'abri lui-même : écart levé, un seul trou, ré-abris comptés ═════════════
function shelterSandbox({ inWater = false, ...opts } = {}) {
  const log = { calls: 0, pending: [] };
  const sb = sandbox(Object.assign({
    deathTimes: [], lastShelterT: 0, _stillBusy: false, taskToken: { cancelled: false },
    FORCED_SHELTER_MIN_GAP_MS: 60000, IS_MAPPER: false, _safeHomeSet: false,
    homewarp: { goHome() { return false; } }, sleep: async () => {}, stopMotion() {},
    shouldShelter: SH.shouldShelter, DAWN_WAIT_MAX_MS: SH.DAWN_WAIT_MAX_MS,
    DAWN_SAFE_EXIT_MAX_MS: SH.DAWN_SAFE_EXIT_MAX_MS,
    dawnExitThreatsNow: () => ({ hostiles: 0, creepers: 0 }), exitAwayFromThreats: () => {},
    hostilesNearNow: () => 0,
    _shelterInFlight: null, _lockdownShelters: null,
    // LIT (20/10) : sans lit à portée, trySleepInBedTonight rend false → l'abri historique (testé dans index.bed.test.js)
    trySleepInBedTonight: async () => false,
    isInWater: () => inWater,
    withTimeout: (p) => p,
    log,
  }, opts));
  sb.bot.blockAt = () => ({ light: 0 });
  sb.bot.entity.position.floored = () => sb.bot.entity.position;
  sb.shelterUntilDawn = async () => { log.calls++; return { ok: true }; };
  run(sb, fnSrc('maybeNightShelter'));
  return sb;
}
const MIN = 60000;

test('ABRI : en lockdown l écart de 10 min est LEVÉ — 30 s après un abri interrompu, on s y remet (même appel non forcé)', async () => {
  const sb = shelterSandbox({ worn: 0 });
  sb.lastShelterT = T0 - 30000;
  assert.strictEqual(await sb.maybeNightShelter(), true);
  assert.strictEqual(sb.log.calls, 1);
  assert.strictEqual(sb.lastShelterT, T0);
  const forcedCall = shelterSandbox({ worn: 0 });
  forcedCall.lastShelterT = T0 - 30000;
  assert.strictEqual(await forcedCall.maybeNightShelter(true, { force: true }), true, 'et le forcé (60 s) aussi');
});

test('ABRI : en lockdown, le mini-écart anti-boucle de 20 s reste (abri raté à l instant → pas de boucle chaude)', async () => {
  const sb = shelterSandbox({ worn: 0 });
  sb.lastShelterT = T0 - 10000;
  assert.strictEqual(await sb.maybeNightShelter(true, { force: true }), false);
  assert.strictEqual(sb.log.calls, 0);
});

test('ABRI : hors lockdown (armé, ou dans l eau) → les écarts historiques intacts (10 min ; 60 s forcé)', async () => {
  const armed = shelterSandbox({ worn: 2 });
  armed.lastShelterT = T0 - 30000;
  assert.strictEqual(await armed.maybeNightShelter(true), false, '10 min');
  assert.strictEqual(await armed.maybeNightShelter(true, { force: true }), false, '60 s');
  armed.lastShelterT = T0 - 61000;
  assert.strictEqual(await armed.maybeNightShelter(true, { force: true }), true);
  const wet = shelterSandbox({ worn: 0, inWater: true });
  wet.lastShelterT = T0 - 30000;
  assert.strictEqual(await wet.maybeNightShelter(true, { force: true }), false, 'dans l eau : pas de trou toutes les 20 s');
  wet.lastShelterT = T0 - 61000;
  assert.strictEqual(await wet.maybeNightShelter(true, { force: true }), true);
});

test('ABRI : UN SEUL trou à la fois — un 2e appelant REJOINT l abri en cours (attend sa fin, rend true)', async () => {
  const sb = shelterSandbox({ worn: 0 });
  let release;
  sb.shelterUntilDawn = () => { sb.log.calls++; return new Promise((r) => { release = () => r({ ok: true }); }); };
  const first = sb.maybeNightShelter(true, { force: true });          // le timer de squad
  await tick();
  assert.ok(sb._shelterInFlight, 'l abri en cours est visible des autres appelants');
  let secondDone = false;
  const second = sb.maybeNightShelter().then((v) => { secondDone = true; return v; });   // le planner
  await tick();
  assert.strictEqual(secondDone, false, 'le 2e appelant ATTEND (il ne repart pas travailler à côté du trou)');
  assert.strictEqual(sb.log.calls, 1, 'pas de 2e trou');
  release();
  assert.deepStrictEqual([await first, await second], [true, true]);
  assert.strictEqual(sb._shelterInFlight, null, 'libéré à la fin');
  assert.strictEqual(sb._stillBusy, false);
});

test('ABRI : les ré-abris d une nuit sont comptés et tracés (`shelter_reenter`, 1×/min max, cumul de la nuit)', async () => {
  const sb = shelterSandbox({ worn: 0 });
  const go = async (dt) => { sb.clock.t += dt; return sb.maybeNightShelter(true, { force: true }); };
  await go(0);                                   // 1er abri de la nuit : pas un ré-abri
  assert.strictEqual(ofType(sb, 'shelter_reenter').length, 0);
  await go(30000);                               // délogé, repris 30 s plus tard
  assert.deepStrictEqual(plain(ofType(sb, 'shelter_reenter')), [{ type: 'shelter_reenter', count: 1 }]);
  await go(30000);                               // encore — compté, pas re-tracé dans la minute
  assert.strictEqual(ofType(sb, 'shelter_reenter').length, 1);
  await go(31000);
  assert.deepStrictEqual(plain(ofType(sb, 'shelter_reenter')).pop(), { type: 'shelter_reenter', count: 3 });
  assert.strictEqual(sb.log.calls, 4);
  // la nuit suivante repart de zéro
  sb.bot.time.day += 1;
  await go(MIN);
  assert.strictEqual(ofType(sb, 'shelter_reenter').length, 2, 'le 1er abri de la nuit suivante n est pas un ré-abri');
});

// ═════════════════════ 6. quête de nourriture, trajet bois, /tpa vers un cartographe ═══════════════
function foodSandbox(opts = {}) {
  const log = { ensure: 0 };
  const sb = sandbox(Object.assign({
    _foodRunBusy: false, _imminentBusy: false, panicInFlight: false, _armorBusy: false, _baseBusy: false,
    foodStock: () => 0, foodRunNeeded: C.foodRunNeeded, foodRunCooldownAfter: C.foodRunCooldownAfter,
    _lastFoodRunAt: 0, _foodRunCooldownMs: C.FOOD_RUN_COOLDOWN_MS,
    withTimeout: (p) => p, FOOD_RUN_TIMEOUT_MS: 70000, FOOD_TRIP_MS: 75000, stopMotion() {},
    ensureFood: async () => { log.ensure++; },
    foodPoints: () => 0, buildCtxInv: () => ({}),
    loadBaseState: () => ({}), saveBaseState: () => true, returnToWork: async () => false,
    undergroundFoodTripDue: FG.undergroundFoodTripDue, foodGateLoad: FG.foodGateLoad, _foodSurfaceTripAt: 0,
    log,
  }, opts));
  sb.bot.food = 10;
  sb.bot.inventory = { items: () => [] };
  run(sb, fnSrc('foodRunTick'));
  return sb;
}

test('NOURRITURE : nu de nuit, affamé et à sec → PAS de quête (chasse, warp, marche), et le rationnement n est pas consommé', async () => {
  const sb = foodSandbox({ worn: 0 });
  await sb.foodRunTick();
  assert.strictEqual(sb.log.ensure, 0);
  assert.strictEqual(ofType(sb, 'food_run').length, 0);
  assert.strictEqual(sb._lastFoodRunAt, 0, 'à l aube la quête part au 1er tick');
  assert.deepStrictEqual(plain(ofType(sb, 'night_gate')), [{ type: 'night_gate', what: 'food_run', food: 10 }]);
  assert.strictEqual(sb._foodRunBusy, false);
});

test('NOURRITURE : armé de nuit, ou nu de JOUR → la quête part comme avant', async () => {
  for (const sb of [foodSandbox({ worn: 2 }), foodSandbox({ worn: 0, timeOfDay: DAY })]) {
    await sb.foodRunTick();
    assert.strictEqual(sb.log.ensure, 1);
    assert.strictEqual(ofType(sb, 'food_run').length, 1);
  }
});

test('index.js : le timer de nourriture appelle foodRunTick (le corps testé est bien celui qui tourne)', () => {
  assert.match(SRC, /^setInterval\(\(\) => \{ foodRunTick\(\)\.catch\(\(\) => \{\}\); \}, 30000\);$/m);
  assert.strictEqual((SRC.match(/type: 'food_run', food/g) || []).length, 1);
});

function woodSandbox(opts = {}) {
  const sb = sandbox(Object.assign({
    NO_GIVE: true,
    WOOD_GOALS: new Set(['logs', 'planks', 'plank_buffer', 'crafting_table', 'sticks', 'wooden_pickaxe']),
    _needsWoodTrip: false, _lastWoodTripAt: 0,
  }, opts));
  run(sb, fnSrc('woodTripWanted'));
  return sb;
}

test('TRAJET BOIS : nu de nuit sous terre → pas de /home safe vers la surface (le skill est tenté sur place)', () => {
  const sb = woodSandbox({ worn: 0, pos: { x: 0, y: 30, z: 0 } });
  assert.strictEqual(sb.woodTripWanted({ name: 'planks' }), false);
  assert.deepStrictEqual(plain(ofType(sb, 'night_gate')), [{ type: 'night_gate', what: 'wood_trip', goal: 'planks' }]);
  assert.strictEqual(sb._lastWoodTripAt, 0, 'cooldown NON consommé');
});

test('TRAJET BOIS : conditions d origine inchangées hors lockdown (jour / armé → oui ; surface, cooldown, sans-give OFF, but non-bois → non)', () => {
  assert.strictEqual(woodSandbox({ worn: 0, timeOfDay: DAY, pos: { x: 0, y: 30, z: 0 } }).woodTripWanted({ name: 'logs' }), true);
  assert.strictEqual(woodSandbox({ worn: 2, pos: { x: 0, y: 30, z: 0 } }).woodTripWanted({ name: 'logs' }), true);
  assert.strictEqual(woodSandbox({ worn: 2, pos: { x: 0, y: 62, z: 0 } }).woodTripWanted({ name: 'logs' }), false, 'déjà en surface');
  assert.strictEqual(woodSandbox({ worn: 2, pos: { x: 0, y: 30, z: 0 }, _lastWoodTripAt: T0 - 60000 }).woodTripWanted({ name: 'logs' }), false);
  assert.strictEqual(woodSandbox({ worn: 2, NO_GIVE: false, pos: { x: 0, y: 30, z: 0 } }).woodTripWanted({ name: 'logs' }), false);
  assert.strictEqual(woodSandbox({ worn: 2, pos: { x: 0, y: 30, z: 0 } }).woodTripWanted({ name: 'iron_deep' }), false);
  assert.strictEqual(woodSandbox({ worn: 2, pos: { x: 0, y: 30, z: 0 }, _needsWoodTrip: true }).woodTripWanted({ name: 'help_pick' }), true);
});

test('index.js : runGoalSkill déclenche le trajet bois via woodTripWanted (et consomme le cooldown juste après)', () => {
  const body = fnSrc('runGoalSkill');
  assert.match(body, /if \(woodTripWanted\(goal\)\) \{\n\s+_lastWoodTripAt = Date\.now\(\);/);
  assert.ok(!/bot\.entity\.position\.y < 62 && \(Date\.now\(\) - _lastWoodTripAt\) > 120000/.test(body), 'plus de copie inline de la condition');
});

function mapperTpSandbox(opts = {}) {
  const sb = sandbox(Object.assign({
    presence: { list: () => [] }, _lastMapperTpAt: 0,
    pickMapperTp: () => ({ name: 'MapBot1', gain: 400 }),
    isAllowed: () => true, whitelist: null, stopMotion() {}, awaitWarp: async () => ({ warped: true }),
  }, opts));
  run(sb, fnSrc('tryTpToMapper'));
  return sb;
}

test('/TPA VERS UN CARTOGRAPHE : nu de nuit → retenu (il est dehors, lui) ; armé ou de jour → part comme avant', async () => {
  const nude = mapperTpSandbox({ worn: 0 });
  assert.deepStrictEqual(plain(await nude.tryTpToMapper({ x: 900, z: 0 })), { ok: false, reason: 'night_lockdown' });
  assert.deepStrictEqual(nude.chat, []);
  assert.strictEqual(nude._lastMapperTpAt, 0, 'cooldown non consommé');
  const armed = mapperTpSandbox({ worn: 2 });
  await armed.tryTpToMapper({ x: 900, z: 0 });
  assert.deepStrictEqual(armed.chat, ['/tpa MapBot1']);
});

// ═════════════════════ 7. les autres chemins qui bougent un bot terré ══════════════════════════════
test('index.js : la chasse au démarrage du cartographe est retenue en lockdown', () => {
  const body = fnSrc('startMapper');
  assert.match(body, /if \(nightLockdownNow\(\)\) nightGateNote\('mapper_start_hunt'\);\n\s+else \{ try \{ await withTimeout\(huntCookGoal\(6\)/);
});

test('index.js : desync / rappel confine respectent la retenue de nuit ; ramassage de minerai et pioche respectent l abri en cours', () => {
  assert.match(SRC, /if \(_stillBusy \|\| _smeltOppBusy \|\| _armorBusy \|\| _nightHold\) \{ _posSamples = \[\]; return; \}/);
  const confine = SRC.split('\n').filter((l) => /const busy = !!bot\.targetDigBlock/.test(l));
  assert.strictEqual(confine.length, 2);
  assert.ok(confine.some((l) => /_nightHold/.test(l)), 'le rappel confine (/home) ne tire pas un bot retenu par la nuit');
  assert.match(SRC, /busy: _imminentBusy \|\| panicInFlight \|\| _armorBusy \|\| _smeltOppBusy \|\| _baseBusy \|\| !!_shelterInFlight,/);
  assert.match(SRC, /if \(_imminentBusy \|\| panicInFlight \|\| _armorBusy \|\| _baseBusy \|\| _migrating \|\| _shelterInFlight\) return;/);
});

test('index.js : tous les appelants de maybeNightShelter passent par le MÊME abri (aucune copie de shelterUntilDawn ailleurs)', () => {
  // DEUX points d'entrée vers le trou : l'abri de nuit (maybeNightShelter) et le repli face à une menace
  // (hideFromThreat, run 10 20/10 : respawn campé, bois sous les flèches). Les deux REJOIGNENT l'abri en
  // cours avant de creuser et publient le leur dans `_shelterInFlight` : un seul trou à la fois.
  assert.strictEqual((SRC.match(/shelterUntilDawn\(bot,/g) || []).length, 2, 'deux points d entrée, pas plus');
  const hide = fnSrc('hideFromThreat');
  assert.ok(hide.indexOf('if (_shelterInFlight)') >= 0 && hide.indexOf('if (_shelterInFlight)') < hide.indexOf('shelterUntilDawn(bot,'),
    'hideFromThreat rallie l abri en cours AVANT de creuser');
  assert.match(hide, /_shelterInFlight = run;/);
  const body = fnSrc('maybeNightShelter');
  assert.ok(body.indexOf('if (_shelterInFlight)') < body.indexOf('shouldShelter(sig)'), 'le ralliement passe avant toute décision');
  assert.match(body, /const _shelterGap = lockdown \? NIGHT_SHELTER_GAP_MS : \(opts\.force \? FORCED_SHELTER_MIN_GAP_MS : 10 \* 60 \* 1000\);/);
});
