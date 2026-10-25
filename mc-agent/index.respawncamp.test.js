'use strict';
// POINT DE RÉAPPARITION CAMPÉ — sortir comme un joueur (live 23/10, NethBot1 : 9 morts en 20 min au même
// point 5,71,-605, nu, à ~600 blocs de l'équipe). Le CÂBLAGE d'index.js, EXÉCUTÉ dans un bac à sable `vm`
// strict (même méthode que index.respawnguard.test.js) : un identifiant oublié ou un `let` déclaré dans
// onSpawn lève une ReferenceError ICI (pièges #56/#61). Les décisions sont testées pures (respawnEscape.test.js).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const U = require('./unstuck');
const H = require('./homeSafety');
const RC = require('./respawnCamp');
const RE = require('./respawnEscape');
const voidGuard = require('./voidGuard');
const vec3Lib = require('vec3');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(re, label) {
  const m = SRC.match(re);
  assert.ok(m, `${label} introuvable dans index.js (déplacé, renommé, ou déclaré hors niveau module ?)`);
  return m[0];
}
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);
const constSrc = (name) => grab(new RegExp(`^const ${name} = [^;]+;`, 'm'), `const ${name}`);
const run = (sb, code) => vm.runInContext("'use strict';\n" + code, sb);

const T0 = 1_800_000_000_000;
const CAMP = { x: 5, y: 71, z: -605 };
const campDeaths = () => [{ x: 5, y: 70, z: -607, at: T0 - 200000 }, { x: 3, y: 70, z: -604, at: T0 - 30000 }];
const armedMate = (o = {}) => Object.assign({ name: 'NethBot3', role: 'worker', x: -363, z: -26, y: 15, at: T0 - 20000, worn: 3, ironZone: 10 }, o);
const zombie = (x, z, y = 70) => ({ name: 'zombie', kind: 'Hostile mobs', position: new vec3Lib.Vec3(x, y, z), isValid: true });

test('index.js : état du ré-ancrage de NIVEAU MODULE + timer branché (piège #56)', () => {
  for (const v of ['_campReanchor', '_spawnVetoLast', '_campReanchorWhy']) {
    assert.match(SRC, new RegExp(`^let ${v} = `, 'm'), `${v} doit être déclaré au niveau module`);
  }
  assert.match(SRC, /^setInterval\(campReanchorTick, CAMP_REANCHOR_TICK_MS\);$/m);
  assert.match(SRC, /^const respawnEscape = require\('\.\/respawnEscape'\);/m);
  assert.match(SRC, /_guard = await guardSpawn\(\)/, 'onSpawn lit le résultat de guardSpawn (retour de base sauté après un sauvetage)');
  assert.match(SRC, /act === 'return' && _campRescued/);
});

// ═══════════════════════════ 1. respawnCampRescue : /tpa chez un coéquipier armé ═════════════════════
function rescueSb({ mates = [armedMate()], deaths = campDeaths(), warp = true, allowed = true, dieDuringWait = false, presence = true } = {}) {
  const clock = { t: T0 };
  const chat = [];
  const sb = {
    events: [], chat, calls: [], clock,
    emit(e) { sb.events.push(e); },
    Date: { now: () => clock.t }, Math, Number, Object, String, Array,
    bot: { username: 'NethBot1', entity: { position: { x: CAMP.x, y: CAMP.y, z: CAMP.z } }, chat: (m) => chat.push(m) },
    respawnCamp: RC, respawnEscape: RE,
    loadBaseState: () => ({}),
    _recentDeathPositions: () => deaths,
    presence: presence ? { list: () => mates } : null,
    isAllowed: () => allowed, whitelist: [],
    taskCtl: { cancel: () => sb.calls.push('cancel') }, stopMotion: () => sb.calls.push('stop'),
    awaitWarp: async () => { if (dieDuringWait) sb._lifeGen++; return { warped: warp }; },
    _lifeGen: 1, _campReanchor: null, _lastRegroupAt: 0, _lastSquadAt: 0, _confineGraceUntil: 0,
  };
  vm.createContext(sb);
  run(sb, constSrc('CAMP_TPA_WAIT_MS'));
  run(sb, fnSrc('respawnCampRescue'));
  return sb;
}

test('rescue : camp (2 morts en 5 min ici) + coéquipier armé → /tpa, respawn_camp_escape via tpa, base et confine neutralisés', async () => {
  const sb = rescueSb();
  const r = await sb.respawnCampRescue();
  assert.strictEqual(r.via, 'tpa');
  assert.deepStrictEqual(sb.chat, ['/tpa NethBot3']);
  const ev = sb.events.find((e) => e.type === 'respawn_camp_escape');
  assert.ok(ev && ev.via === 'tpa' && ev.to === 'NethBot3' && ev.camp.x === 5 && ev.camp.z === -605);
  assert.ok(sb._campReanchor && sb._campReanchor.x === 5, 'le ré-ancrage hors du camp reste en attente');
  assert.strictEqual(sb._lastSquadAt, T0, 'pas de /tpa de squad dans la foulée');
  assert.ok(sb._confineGraceUntil >= T0 + 10 * 60000, 'pas de rappel /home vers la base campée');
});

test('rescue : pas de camp → null, rien envoyé, aucune attente', async () => {
  const sb = rescueSb({ deaths: [campDeaths()[0]] });
  assert.strictEqual(await sb.respawnCampRescue(), null);
  assert.deepStrictEqual(sb.chat, []);
  assert.strictEqual(sb._campReanchor, null);
});

// 25/10 (keepInventory OFF) : remplace la règle du 23/10. La fuite à pied échouait sur place au milieu des
// zombies (NethBot1 : 5 morts en 80 s, `escaped:false dist:1`) ; un coéquipier nu mais LOIN du camp sauve.
test('rescue : camp et coéquipiers nus → /tpa chez le plus armé d entre eux, loin du camp', async () => {
  const sb = rescueSb({ mates: [armedMate({ worn: 0 }), armedMate({ name: 'NethBot2', worn: 1 })] });
  const r = await sb.respawnCampRescue();
  assert.strictEqual(r.via, 'tpa');
  assert.strictEqual(r.to, 'NethBot2');
});

test('rescue : /tpa non coché, /tpa raté, ou sans présence → fuite à pied ; mort pendant l attente → la vie suivante décide', async () => {
  const blocked = rescueSb({ allowed: false });
  assert.strictEqual((await blocked.respawnCampRescue()).via, 'foot');
  assert.ok(blocked.events.some((e) => e.type === 'respawn_camp_tpa_blocked'));
  const failed = rescueSb({ warp: false });
  assert.strictEqual((await failed.respawnCampRescue()).via, 'foot');
  assert.ok(failed.events.some((e) => e.type === 'respawn_camp_tpa_failed'));
  assert.strictEqual((await rescueSb({ presence: false }).respawnCampRescue()).via, 'foot');
  const dead = rescueSb({ dieDuringWait: true });
  assert.strictEqual((await dead.respawnCampRescue()).via, 'dead');
  assert.ok(!dead.events.some((e) => e.type === 'respawn_camp_escape'));
});

// ═══════════════════════════ 2. guardSpawn : le camp passe AVANT l'abri ═══════════════════════════════
function guardSb(rescue, { escapeRes = { escaped: true }, danger = null } = {}) {
  const sb = {
    events: [], calls: [],
    emit(e) { sb.events.push(e); },
    _escapeOnSpawn: true, Math, Object,
    _wornArmor: () => new Set(),
    respawnCampRescue: async () => rescue,
    escapeDeathCamp: async (o) => { sb.calls.push('escape:' + (o && o.camp ? 'camp' : 'plain')); return escapeRes; },
    spawnDangerNow: () => danger,
    hideFromThreat: async (why) => { sb.calls.push('hide:' + why); return { ok: true }; },
    senseSpawnDanger: async () => { sb.calls.push('sense'); return null; },
  };
  vm.createContext(sb);
  run(sb, fnSrc('guardSpawn'));
  return sb;
}

test('guardSpawn : téléporté chez un coéquipier → rien d autre (ni observation, ni abri dans le camp)', async () => {
  const sb = guardSb({ via: 'tpa', camp: { x: 5, z: -605 } });
  const plan = await sb.guardSpawn();
  assert.deepStrictEqual({ act: plan.act, campRescue: plan.campRescue }, { act: 'tpa', campRescue: true });
  assert.deepStrictEqual(sb.calls, []);
  assert.strictEqual(sb._escapeOnSpawn, false);
});

test('guardSpawn : camp sans coéquipier → fuite à pied MODE CAMP d abord (même avec un zombie à 4 blocs), pas d abri avant', async () => {
  const sb = guardSb({ via: 'foot', camp: { x: 5, z: -605 } }, { danger: { mob: 'zombie', dist: 4 } });
  const plan = await sb.guardSpawn();
  assert.deepStrictEqual(sb.calls, ['escape:camp']);
  assert.strictEqual(plan.campRescue, true, 'sorti : le retour de base vers le camp sera sauté');
  assert.ok(sb.events.some((e) => e.type === 'spawn_guard' && e.reason === 'respawn_camped'));
});

test('guardSpawn : fuite de camp ratée et danger → abri ; pas de camp → comportement d avant', async () => {
  const sb = guardSb({ via: 'foot', camp: { x: 5, z: -605 } }, { escapeRes: { escaped: false }, danger: { mob: 'zombie', dist: 4 } });
  const plan = await sb.guardSpawn();
  assert.deepStrictEqual(sb.calls, ['escape:camp', 'hide:escape']);
  assert.strictEqual(plan.campRescue, false);
  const plain = guardSb(null);
  plain._escapeOnSpawn = false;
  run(plain, constSrc('SPAWN_SENSE_MS'));   // inutilisé : senseSpawnDanger est simulé
  plain.spawnGuardPlan = U.spawnGuardPlan; plain.isNight = () => false; plain.bot = { time: { timeOfDay: 6000 } };
  assert.strictEqual((await plain.guardSpawn()).act, 'none');
  assert.deepStrictEqual(plain.calls, ['sense']);
});

// ═══════════════════════════ 3. escapeDeathCamp en mode camp : ≥ 48 blocs, sans s'arrêter ════════════
function escapeSb({ moveTo = null } = {}) {
  const sb = {
    events: [], calls: [], Math, Object, Number,
    emit(e) { sb.events.push(e); },
    Date, setInterval, clearInterval, setTimeout, clearTimeout, Promise,
    bot: {
      entity: { position: { x: CAMP.x, y: CAMP.y, z: CAMP.z } },
      nearestEntity: () => null,
      setControlState: (k, v) => sb.calls.push('ctl:' + k + ':' + v),
      pathfinder: { goto: async (g) => { sb.goal = g; if (moveTo) sb.bot.entity.position = moveTo(g); } },
    },
    isFleeHostile: () => true, NO_GIVE: true,
    escapePlan: U.escapePlan, escapeReached: U.escapeReached, canReanchorSpawn: U.canReanchorSpawn, ESCAPE_SAFE_RADIUS: U.ESCAPE_SAFE_RADIUS,
    pfGoals: { GoalNearXZ: function (x, z, r) { this.x = x; this.z = z; this.r = r; } },
    _escapeGen: 0, _escaping: false, taskCtl: { cancel: () => {} }, stopMotion: () => sb.calls.push('stop'),
    spawnDangerNow: () => ({ flee: true, mob: 'zombie', dist: 4, worn: 0 }),   // toujours un zombie : le camp
    anchorSpawnpoint: () => { sb.calls.push('anchor'); return true; },
    relocateToRegion: async () => {}, nearbyHostiles: () => [], respawnEscape: RE,
  };
  vm.createContext(sb);
  for (const c of ['ESCAPE_WALK_TIMEOUT_MS', 'ESCAPE_THREAT_POLL_MS', 'CAMP_ESCAPE_WALK_TIMEOUT_MS']) run(sb, constSrc(c));
  run(sb, fnSrc('withTimeout'));
  run(sb, fnSrc('escapeDeathCamp'));
  return sb;
}

test('escapeDeathCamp (camp) : cible à ≥ 48 blocs, sprint, jamais coupée par le zombie, aucun /spawnpoint sur place', async () => {
  const sb = escapeSb({ moveTo: (g) => ({ x: g.x, y: 64, z: g.z }) });
  const r = await sb.escapeDeathCamp({ camp: { x: 5, z: -605 } });
  assert.ok(Math.hypot(sb.goal.x - 5, sb.goal.z + 605) >= 47, 'but à ≥ 48 blocs du camp');
  assert.strictEqual(r.escaped, true);
  assert.ok(sb.calls.includes('ctl:sprint:true'));
  assert.ok(!sb.calls.includes('anchor'), 'le /spawnpoint vient du tick, au calme');
  const ev = sb.events.find((e) => e.type === 'respawn_camp_escape');
  assert.ok(ev && ev.via === 'foot' && ev.escaped === true && ev.dist >= 47);
  assert.ok(!sb.events.some((e) => e.type === 'death_camp_escape_threat'));
});

test('escapeDeathCamp (camp) : resté à 20 blocs → escaped false', async () => {
  const sb = escapeSb({ moveTo: () => ({ x: 25, y: 64, z: -605 }) });
  const r = await sb.escapeDeathCamp({ camp: { x: 5, z: -605 } });
  assert.strictEqual(r.escaped, false);
  assert.ok(sb.events.some((e) => e.type === 'respawn_camp_escape' && e.escaped === false));
});

// ═══════════════════════════ 4. anchorSpawnpoint + campReanchorTick : reposer AILLEURS ═══════════════
function anchorSb({ pos = { x: -60, y: 64, z: -605 }, deaths = campDeaths(), pending = { x: 5, z: -605, at: T0 - 60000, via: 'respawn' },
  entities = {}, light = { light: 0, skyLight: 15 }, night = false, ground = true, onGround = true,
  memo = { base: { x: 24, y: 73, z: -604 } }, mapper = false, confine = { x: 24, z: -604, radius: 140 } } = {}) {
  const clock = { t: T0 };
  const chat = [];
  const bot = {
    entity: { position: new vec3Lib.Vec3(pos.x, pos.y, pos.z), onGround },
    health: 20, entities, chat: (m) => chat.push(m),
    time: { timeOfDay: night ? 18000 : 6000 },
    blockAt: (v) => {
      if (v.y < pos.y) return { name: ground ? 'stone' : 'air', boundingBox: ground ? 'block' : 'empty', position: v };
      return Object.assign({ name: 'air', boundingBox: 'empty', position: v }, light);
    },
  };
  const sb = {
    events: [], chat, clock, bot, Math, Number, Object,
    emit(e) { sb.events.push(e); },
    Date: { now: () => clock.t },
    spawnpointVeto: H.spawnpointVeto, _recentDeathPositions: () => deaths,
    voidGuard, vec3Lib, respawnEscape: RE,
    nearbyHostiles: (b, r) => Object.values(b.entities).filter((e) => e.position.distanceTo(b.entity.position) <= r),
    isInWater: () => false, isNight: (b) => b.time.timeOfDay >= 12800 && b.time.timeOfDay <= 23200,
    _escaping: false, _shelterInFlight: null, _meleePillar: null, _voidRescueBusy: false, _voidReanchorBusy: false,
    _campReanchor: pending, _spawnVetoLast: null, _campReanchorWhy: null,
    // déplacement de la base hors du camp (23/10)
    disk: { memo }, IS_MAPPER: mapper, CONFINE: confine, _confineDyn: null, HOME_SAFE: 'safe',
    loadBaseState: () => (sb.disk.memo ? JSON.parse(JSON.stringify(sb.disk.memo)) : null),
    saveBaseState(st) { sb.disk.memo = JSON.parse(JSON.stringify(st)); return true; },
    respawnCamp: RC, homeCamped: H.homeCamped,
    deathSpots: { isBanned: () => false }, deathzones: { isBanned: () => false }, _dzones: [],
    homewarp: { bookmark: (b, name) => { chat.push('/sethome ' + name); return true; } },
    noteSafeHome: (p, why) => { sb.safeNoted = { x: p.x, z: p.z, why }; return true; },
  };
  vm.createContext(sb);
  run(sb, constSrc('SPAWN_VETO_EVENT_EVERY_MS'));
  for (const f of ['_groundHere', '_campedAt', 'moveBaseOutOfCamp', 'anchorSpawnpoint', 'campReanchorTick']) run(sb, fnSrc(f));
  return sb;
}

test('tick : sorti à 65 blocs, sol plein, au calme, de jour → /spawnpoint ICI + spawn_reanchored, attente vidée', () => {
  const sb = anchorSb();
  sb.campReanchorTick();
  assert.deepStrictEqual(sb.chat, ['/spawnpoint', '/sethome safe'], 'la base (dans le camp) suit avec son home safe');
  const ev = sb.events.find((e) => e.type === 'spawn_reanchored');
  assert.ok(ev && ev.why === 'respawn_camp' && ev.dist >= 48 && ev.camp.x === 5 && ev.via === 'respawn');
  assert.strictEqual(sb._campReanchor, null);
});

test('tick : encore dans le camp, zombie à 6 blocs, vide sous les pieds, ou nuit à découvert → rien (raison tracée une fois)', () => {
  const close = anchorSb({ pos: { x: -20, y: 64, z: -605 } });
  close.campReanchorTick();
  assert.deepStrictEqual(close.chat, []);
  const hostile = anchorSb({ entities: { 1: zombie(-54, -605, 64) } });
  hostile.campReanchorTick(); hostile.campReanchorTick();
  assert.deepStrictEqual(hostile.chat, []);
  assert.strictEqual(hostile.events.filter((e) => e.type === 'spawn_reanchor_wait').length, 1, 'dédup');
  assert.strictEqual(hostile.events[0].reason, 'hostile_near');
  const vide = anchorSb({ ground: false });
  vide.campReanchorTick();
  assert.deepStrictEqual(vide.chat, []);
  assert.ok(vide.events.some((e) => e.type === 'spawn_reanchor_wait' && e.reason === 'no_ground'));
  const nuit = anchorSb({ night: true });
  nuit.campReanchorTick();
  assert.deepStrictEqual(nuit.chat, []);
  assert.ok(nuit.events.some((e) => e.reason === 'dark'));
  const galerie = anchorSb({ night: true, light: { light: 13, skyLight: 0 } });
  galerie.campReanchorTick();
  assert.strictEqual(galerie.chat[0], '/spawnpoint', 'galerie éclairée chez le mineur : oui');
});

test('anchorSpawnpoint : veto camped → l attente « ailleurs » est posée ; veto répété au même endroit = 1 event / min', () => {
  const sb = anchorSb({ pos: { x: 4, y: 64, z: -606 }, pending: null });
  for (let i = 0; i < 20; i++) { assert.strictEqual(sb.anchorSpawnpoint('void_reanchor'), false); sb.clock.t += 3000; }
  assert.strictEqual(sb.events.filter((e) => e.type === 'spawnpoint_vetoed').length, 1, 'session 477 : 100+ events, un toutes les 3 s');
  assert.ok(sb._campReanchor && sb._campReanchor.via === 'veto');
  sb.clock.t += 61000;
  sb.anchorSpawnpoint('void_reanchor');
  assert.strictEqual(sb.events.filter((e) => e.type === 'spawnpoint_vetoed').length, 2);
});

test('anchorSpawnpoint : un /spawnpoint posé loin du camp par un AUTRE appelant règle aussi l attente', () => {
  const sb = anchorSb();
  assert.strictEqual(sb.anchorSpawnpoint('camp_escape'), true);
  assert.strictEqual(sb._campReanchor, null);
  assert.ok(sb.events.some((e) => e.type === 'spawn_reanchored' && e.why === 'camp_escape'));
  const near = anchorSb({ pos: { x: -40, y: 64, z: -605 }, deaths: [] });
  assert.strictEqual(near.anchorSpawnpoint('camp_escape'), true, 'posé (pas campé selon homeSafety)…');
  assert.ok(near._campReanchor, '… mais à < 48 blocs : l attente continue');
});

// ═══════════════════════════ 5. reanchorAfterVoid : passe la main au lieu de spammer ═══════════════════
test('reanchorAfterVoid : camp ici → void_reanchor_deferred, rattrapage vide arrêté, ré-ancrage ailleurs en attente', async () => {
  const sb = {
    events: [], chat: [], Math, Object, Number,
    emit(e) { sb.events.push(e); },
    Date: { now: () => T0 },
    bot: { entity: { position: { x: 4, y: 64, z: -606 }, onGround: true }, chat: (m) => sb.chat.push(m) },
    homeCamped: H.homeCamped, _recentDeathPositions: () => campDeaths(),
    _spawnOverVoidAt: T0 - 1000, _spawnOverVoidPos: { x: 5, z: -605 }, _voidReanchorBusy: false, _voidRescueBusy: false,
    _campReanchor: null,
    stepToSafeGround: async () => { sb.chat.push('STEP'); return true; },
    anchorSpawnpoint: () => { sb.chat.push('ANCHOR'); return false; },
  };
  vm.createContext(sb);
  for (const f of ['_campedAt', 'reanchorAfterVoid']) run(sb, fnSrc(f));
  await sb.reanchorAfterVoid();
  assert.deepStrictEqual(sb.chat, [], 'ni pas vers le sol ni ancrage dans le camp');
  assert.strictEqual(sb._spawnOverVoidAt, 0);
  assert.ok(sb._campReanchor && sb._campReanchor.via === 'void');
  assert.ok(sb.events.some((e) => e.type === 'void_reanchor_deferred' && e.reason === 'camped'));
});

// ═══════════════════════════ 6. la BASE suit quand elle est dans le camp ═════════════════════════════
test('base dans le camp (19 blocs, NethBot1 23/10) → base + home safe + confine déplacés au nouveau point sûr (mémo FUSIONNÉ)', () => {
  const sb = anchorSb({ memo: { base: { x: 24, y: 73, z: -604 }, respawnLives: [{ x: 5, z: -605, t: T0 - 1000 }], zone: { k: 1 } } });
  sb.campReanchorTick();
  assert.deepStrictEqual(sb.disk.memo.base, { x: -60, y: 64, z: -605 });
  assert.ok(sb.disk.memo.zone && sb.disk.memo.respawnLives, 'les autres champs du mémo traversent (piège #61)');
  assert.deepStrictEqual({ x: sb.safeNoted.x, why: sb.safeNoted.why }, { x: -60, why: 'camped' });
  assert.deepStrictEqual({ x: sb.CONFINE.x, z: sb.CONFINE.z, radius: sb.CONFINE.radius }, { x: -60, z: -605, radius: 140 });
  assert.ok(sb.bot._mcaExploreBounds && sb.bot._mcaExploreBounds.x === -60);
  const ev = sb.events.find((e) => e.type === 'base_moved_from_camp');
  assert.ok(ev && ev.from.x === 24 && ev.to.x === -60 && ev.safe === true);
});

test('base SAINE (loin de tout camp) → elle ne bouge pas ; cartographe → jamais de base déplacée', () => {
  const sb = anchorSb({ memo: { base: { x: 300, y: 70, z: 300 } }, confine: { x: 300, z: 300, radius: 140 } });
  sb.campReanchorTick();
  assert.deepStrictEqual(sb.chat, ['/spawnpoint']);
  assert.deepStrictEqual(sb.disk.memo.base, { x: 300, y: 70, z: 300 });
  assert.strictEqual(sb.CONFINE.x, 300);
  assert.ok(!sb.events.some((e) => e.type === 'base_moved_from_camp'));
  const m = anchorSb({ mapper: true });
  m.campReanchorTick();
  assert.deepStrictEqual(m.disk.memo.base, { x: 24, y: 73, z: -604 });
});

test('base hors du rayon du camp mais lieu BANNI (deathSpots) → elle suit aussi', () => {
  const sb = anchorSb({ memo: { base: { x: 80, y: 70, z: -605 } } });
  sb.deathSpots = { isBanned: (x, z) => x === 80 && z === -605 };
  sb.campReanchorTick();
  assert.deepStrictEqual(sb.disk.memo.base, { x: -60, y: 64, z: -605 });
  assert.ok(sb.events.some((e) => e.type === 'base_moved_from_camp' && e.flagged === true));
});

test('respawnEscape.baseInCamp : rayon 24, camps multiples, drapeau, entrées absurdes', () => {
  assert.strictEqual(RE.baseInCamp({ base: { x: 24, z: -604 }, camps: [{ x: 5, z: -605 }] }), true);
  assert.strictEqual(RE.baseInCamp({ base: { x: 40, z: -604 }, camps: [{ x: 5, z: -605 }] }), false);
  assert.strictEqual(RE.baseInCamp({ base: { x: 40, z: -604 }, camps: [null, { x: 45, z: -600 }] }), true);
  assert.strictEqual(RE.baseInCamp({ base: { x: 40, z: -604 }, camps: [], flagged: true }), true);
  assert.strictEqual(RE.baseInCamp({ base: null, camps: [{ x: 5, z: -605 }], flagged: true }), false);
});
