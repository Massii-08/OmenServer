'use strict';
// HOME `safe` CAMPÉ (live 19/10, MapBot2 : 8 morts en 3 min, chaque secours le ramenait au camp du
// spawn) — le CÂBLAGE d'index.js, EXÉCUTÉ.
//
// La logique est testée dans homeSafety.test.js (pur) et homewarp.test.js (veto dans goHome). Ici on
// extrait le texte RÉEL des fonctions de glue et on l'exécute dans un bac à sable `vm` strict dont le
// seul contenu est ce que le module fournit vraiment au niveau module : un identifiant oublié ou un
// `let` déclaré dans onSpawn lève une ReferenceError ici, pas en prod (pièges #56/#61).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const H = require('./homeSafety');
const homewarp = require('./homewarp');
const { HOME_SAFE, SAFE_HOME_MIN_Y, isSilentSafeFailure } = require('./homes');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(re, label) {
  const m = SRC.match(re);
  assert.ok(m, `${label} introuvable dans index.js (déplacé, renommé, ou déclaré hors niveau module ?)`);
  return m[0];
}
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);
const run = (sb, code) => vm.runInContext("'use strict';\n" + code, sb);
const plain = (x) => JSON.parse(JSON.stringify(x));

const T0 = 1_700_000_000_000;
const MIN = 60 * 1000;
const DAY = 6000;
const NIGHT = 18000;
const zombie = (x, z, y = 70) => ({ name: 'zombie', kind: 'Hostile mobs', position: { x, y, z }, isValid: true });

const GLUE = ['loadDeathPositions', '_recentDeathPositions', 'recordDeathPosition', 'noteSafeHome', '_isFoe',
  'noteHostileNearSafeHome', 'safeHomeVeto', '_campedAt', 'maybeMoveCampedSafeHome', 'poseSafeHomeAtSpawn'];

/**
 * Bac à sable = le niveau MODULE de index.js, réduit à ce que ces fonctions ont le droit de lire.
 * `disk` est le « fichier » du mémo de base : partagé entre deux bacs, il joue la relance du process.
 */
function glue({ disk = { memo: null }, clock = { t: T0 }, bot: botOver = {}, ...extra } = {}) {
  const chat = [];
  const bot = Object.assign({
    entity: { position: { x: 0, y: 70, z: 0 }, onGround: true },
    entities: {},
    time: { timeOfDay: DAY },
    chat: (m) => chat.push(m),
  }, botOver);
  const sb = {
    events: [], chat, disk, clock, bot, saves: 0,
    emit(e) { sb.events.push(e); },
    Date: { now: () => clock.t },
    loadBaseState: () => (disk.memo ? JSON.parse(JSON.stringify(disk.memo)) : null),
    saveBaseState(st) { disk.memo = JSON.parse(JSON.stringify(st)); sb.saves++; return true; },
    homewarp,
    isInWater: () => false,
    isNight: (b) => !!(b && b.time && b.time.timeOfDay >= 12800 && b.time.timeOfDay <= 23200),
    isFleeHostile: (e) => !!(e && (e.kind === 'Hostile mobs' || e.name === 'creeper')),
    NEUTRAL_NO_PROVOKE: new Set(['enderman']),
    // ce que index.js importe de ./homeSafety et ./homes
    homeCamped: H.homeCamped, rescueWarpVeto: H.rescueWarpVeto, safeHomeMove: H.safeHomeMove,
    spawnSafeHomeAction: H.spawnSafeHomeAction, deathPosPrune: H.deathPosPrune, deathPosLoad: H.deathPosLoad,
    deathPosMemoWith: H.deathPosMemoWith, safeHomeLoad: H.safeHomeLoad, safeHomeMemoWith: H.safeHomeMemoWith,
    nearestHostile: H.nearestHostile, hostileNearHome: H.hostileNearHome, CAMPED_EVENT_EVERY_MS: H.CAMPED_EVENT_EVERY_MS,
    HOME_SAFE, SAFE_HOME_MIN_Y, DEFAULT_CONFINE_RADIUS: 140,
    // état de niveau module
    _deathPos: [], _deathPosLoaded: false, _hostileNearHomeAt: 0, _homeCampedEventAt: 0, _safeHomeMovedAt: 0,
    _safeHomeSet: false, _safeHomeSurface: false, _safeHomePos: null,
    _migrating: false, _escaping: false, _baseBusy: false, _imminentBusy: false, _stillBusy: false,
    CONFINE: null, _confineDyn: null, _anchorSet: false, IS_MAPPER: true, NO_GIVE: true,
    world: { objective: { type: 'mapper', status: 'in_progress' } },
    ...extra,
  };
  vm.createContext(sb);
  for (const f of GLUE) run(sb, fnSrc(f));
  return sb;
}

// Le camp du spawn : 2 morts récentes à côté du home (positions telles que le mémo les garde).
const SPAWN_CAMP = [{ x: 2, y: 70, z: 1, at: T0 - 3 * MIN }, { x: -4, y: 69, z: 3, at: T0 - MIN }];
const campedMemo = (more = {}) => ({ deathPos: SPAWN_CAMP.slice(), ...more });

// ═════════════════════════════ 1. positions de mort : écrire, relire au process suivant ═════════════
test('recordDeathPosition : écrit `deathPos` en PRÉSERVANT le reste du mémo (aller-retour complet, piège #61)', () => {
  const disk = { memo: { base: { x: 10, y: 70, z: -4 }, deaths: [T0 - 1000], deathDebt: { x: 1, y: 2, z: 3, at: T0 }, zone: { anchoredAt: T0 - 5 }, safeHome: { x: 0, y: 70, z: 0, at: T0 - 9 } } };
  const sb = glue({ disk });
  assert.strictEqual(sb.recordDeathPosition({ x: -3.4, y: 70.2, z: -1.6 }), true);
  assert.deepStrictEqual(disk.memo.deathPos, [{ x: -3, y: 70, z: -2, at: T0 }]);
  assert.deepStrictEqual(disk.memo.base, { x: 10, y: 70, z: -4 });
  assert.deepStrictEqual(disk.memo.deaths, [T0 - 1000]);
  assert.deepStrictEqual(disk.memo.deathDebt, { x: 1, y: 2, z: 3, at: T0 });
  assert.deepStrictEqual(disk.memo.zone, { anchoredAt: T0 - 5 });
  assert.deepStrictEqual(disk.memo.safeHome, { x: 0, y: 70, z: 0, at: T0 - 9 });
});

test('GÉNÉRATIONS : le process B (mémoire vide, même fichier) sait que le home du spawn est campé', () => {
  const disk = { memo: { safeHome: { x: 0, y: 70, z: 0, at: T0 - 9 * MIN } } };
  const A = glue({ disk, clock: { t: T0 - 2 * MIN } });
  A.recordDeathPosition({ x: 3, y: 70, z: 0 });
  A.clock.t = T0 - MIN;
  A.recordDeathPosition({ x: -5, y: 70, z: 2 });
  const B = glue({ disk });
  assert.strictEqual(B._deathPos.length, 0, 'mémoire neuve');
  assert.strictEqual(B._recentDeathPositions().length, 2, 'relues du mémo');
  assert.strictEqual(B._campedAt({ x: 0, y: 70, z: 0 }), true);
});

test('recordDeathPosition : écriture ratée → le DIT et rend false ; position absente → false sans écrire', () => {
  const sb = glue({ saveBaseState: () => false });
  assert.strictEqual(sb.recordDeathPosition({ x: 1, y: 70, z: 1 }), false);
  assert.ok(sb.events.some((e) => e.type === 'death_pos_save_failed'));
  const sb2 = glue();
  assert.strictEqual(sb2.recordDeathPosition(null), false);
  assert.strictEqual(sb2.saves, 0);
});

test('loadDeathPositions : UNE fois par process, sans perdre une mort notée avant le chargement', () => {
  const disk = { memo: campedMemo() };
  const sb = glue({ disk, _deathPos: [{ x: 50, y: 70, z: 50, at: T0 - 1000 }] });
  sb.loadDeathPositions();
  assert.strictEqual(sb._deathPos.length, 3);
  disk.memo = { deathPos: [] };
  sb.loadDeathPositions();
  assert.strictEqual(sb._deathPos.length, 3, 'ne repart pas du fichier');
});

// ═════════════════════════════ 2. noteSafeHome : tout /sethome safe est mémorisé ══════════════════
test('noteSafeHome : état du process + `safeHome` persisté, mémo fusionné ; l hostile vu près de l ANCIEN home est oublié', () => {
  const disk = { memo: { deathPos: SPAWN_CAMP.slice(), base: { x: 1, y: 70, z: 1 } } };
  const sb = glue({ disk, _hostileNearHomeAt: T0 - 1000 });
  sb.noteSafeHome({ x: 120.4, y: 72, z: 40.6 }, 'camped');
  assert.strictEqual(sb._safeHomeSet, true);
  assert.strictEqual(sb._safeHomeSurface, true);
  assert.deepStrictEqual(plain(sb._safeHomePos), { x: 120.4, y: 72, z: 40.6 });
  assert.strictEqual(sb._hostileNearHomeAt, 0);
  assert.deepStrictEqual(disk.memo.safeHome, { x: 120, y: 72, z: 41, at: T0, why: 'camped' });
  assert.deepStrictEqual(disk.memo.base, { x: 1, y: 70, z: 1 });
  assert.strictEqual(disk.memo.deathPos.length, 2);
  sb.noteSafeHome({ x: 5, y: 40, z: 5 }, 'spawn');
  assert.strictEqual(sb._safeHomeSurface, false, 'sous la surface → pas un safe de surface');
});

// ═════════════════════════════ 3. safeHomeVeto : LE point de décision ═════════════════════════════
test('safeHomeVeto : home campé + NUIT → veto, `home_safe_camped` tracé UNE fois par minute', () => {
  const sb = glue({ disk: { memo: campedMemo() }, bot: { time: { timeOfDay: NIGHT } }, _safeHomePos: { x: 0, y: 70, z: 0 } });
  const v = sb.safeHomeVeto('drowning');
  assert.ok(v && v.veto);
  assert.strictEqual(v.why, 'night');
  assert.deepStrictEqual(plain(sb.events), [{ type: 'home_safe_camped', why: 'night', deaths: 2, ctx: 'drowning' }]);
  sb.clock.t += 30 * 1000;
  assert.ok(sb.safeHomeVeto('imminent'));
  assert.strictEqual(sb.events.length, 1, 'pas de spam : 1×/min');
  sb.clock.t += 31 * 1000;
  assert.ok(sb.safeHomeVeto('imminent'));
  assert.strictEqual(sb.events.length, 2);
});

test('safeHomeVeto : de JOUR, un zombie VU à 10 blocs du home → veto (why hostile_near_home), et la mémoire tient 5 min', () => {
  const sb = glue({ disk: { memo: campedMemo() }, _safeHomePos: { x: 0, y: 70, z: 0 },
    bot: { entities: { 1: zombie(8, 6) } } });
  assert.strictEqual(sb.safeHomeVeto('x').why, 'hostile_near_home');
  assert.strictEqual(sb._hostileNearHomeAt, T0);
  sb.bot.entities = {};                 // le bot est parti : il ne voit plus le home
  sb.clock.t += 4 * MIN;
  assert.ok(sb.safeHomeVeto('x'), 'encore signalé (4 min)');
  sb.clock.t += 2 * MIN;
  assert.strictEqual(sb.safeHomeVeto('x'), null, 'oublié au-delà de 5 min');
});

test('safeHomeVeto : de jour sans hostile signalé → le secours part (null) ; home pas campé → null ; home inconnu → null', () => {
  assert.strictEqual(glue({ disk: { memo: campedMemo() }, _safeHomePos: { x: 0, y: 70, z: 0 } }).safeHomeVeto('x'), null);
  assert.strictEqual(glue({ disk: { memo: { deathPos: [SPAWN_CAMP[0]] } }, bot: { time: { timeOfDay: NIGHT } }, _safeHomePos: { x: 0, y: 70, z: 0 } }).safeHomeVeto('x'), null);
  assert.strictEqual(glue({ disk: { memo: campedMemo() }, bot: { time: { timeOfDay: NIGHT } } }).safeHomeVeto('x'), null);
});

test('safeHomeVeto : l enderman (neutre) et les entités retirées du monde ne sont pas un hostile signalé', () => {
  const sb = glue({ disk: { memo: campedMemo() }, _safeHomePos: { x: 0, y: 70, z: 0 },
    bot: { entities: { 1: Object.assign(zombie(3, 0), { name: 'enderman' }), 2: Object.assign(zombie(4, 0), { isValid: false }) } } });
  assert.strictEqual(sb.safeHomeVeto('x'), null);
});

test('safeHomeVeto : une lecture qui lève ne bloque JAMAIS un secours', () => {
  const sb = glue({ disk: { memo: campedMemo() }, _safeHomePos: { x: 0, y: 70, z: 0 }, bot: { time: { timeOfDay: NIGHT } } });
  Object.defineProperty(sb.bot, 'entities', { get() { throw new Error('boom'); } });
  // l'hostile est illisible, mais la nuit suffit : le veto reste correct, et rien ne remonte
  assert.ok(sb.safeHomeVeto('x'));
  const sb2 = glue({ _safeHomePos: { x: 0, y: 70, z: 0 }, loadBaseState: () => { throw new Error('EIO'); }, bot: { time: { timeOfDay: NIGHT } } });
  assert.strictEqual(sb2.safeHomeVeto('x'), null);
});

test('homewarp.goHome(bot, safe) branché sur safeHomeVeto : campé la nuit → AUCUN /home safe ne part', () => {
  const sb = glue({ disk: { memo: campedMemo() }, bot: { time: { timeOfDay: NIGHT } }, _safeHomePos: { x: 0, y: 70, z: 0 } });
  // exactement le branchement d'index.js : bot._mcaSafeVeto = (ctx) => !!safeHomeVeto(ctx);
  run(sb, grab(/^bot\._mcaSafeVeto = \(ctx\) => !!safeHomeVeto\(ctx\);$/m, 'bot._mcaSafeVeto'));
  assert.strictEqual(homewarp.goHome(sb.bot, 'safe', { ctx: 'mapper_night' }), false);
  assert.strictEqual(homewarp.goSpawn(sb.bot), false);
  assert.deepStrictEqual(sb.chat, []);
  sb.bot.time.timeOfDay = DAY;
  assert.strictEqual(homewarp.goHome(sb.bot, 'safe'), 'safe');
  assert.deepStrictEqual(sb.chat, ['/home safe']);
});

// ═════════════════════════════ 4. safeWarpHome : veto AVANT toute mise en sécurité ═══════════════
function warpGlue(extra = {}) {
  const calls = [];
  const sb = glue({
    nearbyHostiles: () => [], SCAFFOLD: ['dirt'], stopMotion: () => calls.push('stop'),
    withTimeout: async (p) => p, secureSpot: async (b, t) => { calls.push('secure:' + t); },
    taskToken: { cancelled: false }, awaitWarp: async () => { calls.push('await'); return { warped: true }; },
    isSilentSafeFailure, _safeNoopStreak: 0, SAFE_NOOP_MAX: 3, _homeRefusedAt: {},
    ...extra,
  });
  sb.bot.inventory = { items: () => [] };
  sb.bot.blockAt = () => null;
  sb.bot.entity.position.floored = () => ({ offset: () => ({}) });
  run(sb, fnSrc('safeWarpHome'));
  return { sb, calls };
}

test('safeWarpHome(safe) : home campé la nuit → rend l échec ({warped:false, camped:true}) SANS se murer ni envoyer /home', async () => {
  const { sb, calls } = warpGlue({ disk: { memo: campedMemo() }, bot: { time: { timeOfDay: NIGHT } }, _safeHomePos: { x: 0, y: 70, z: 0 } });
  const r = await sb.safeWarpHome('safe', { ctx: 'water_rescue' });
  assert.deepStrictEqual(plain(r), { warped: false, cancelled: false, camped: true, why: 'night' });
  assert.deepStrictEqual(calls, [], 'ni secureSpot, ni stopMotion, ni attente de warp');
  assert.deepStrictEqual(sb.chat, []);
  assert.ok(sb.events.some((e) => e.type === 'home_safe_camped' && e.ctx === 'water_rescue'));
  assert.strictEqual(sb._safeNoopStreak, 0, 'un veto n est pas un /home muet (signet cassé)');
});

test('safeWarpHome : home sain → comportement d avant (le /home part)', async () => {
  const { sb, calls } = warpGlue({ _safeHomePos: { x: 0, y: 70, z: 0 }, bot: { time: { timeOfDay: NIGHT } } });
  const r = await sb.safeWarpHome('safe');
  assert.strictEqual(r.warped, true);
  assert.deepStrictEqual(sb.chat, ['/home safe']);
  assert.ok(calls.includes('await'));
});

test('safeWarpHome(work) : le veto du home safe ne concerne pas les autres homes', async () => {
  const { sb } = warpGlue({ disk: { memo: campedMemo() }, bot: { time: { timeOfDay: NIGHT } }, _safeHomePos: { x: 0, y: 70, z: 0 } });
  await sb.safeWarpHome('work');
  assert.deepStrictEqual(sb.chat, ['/home work']);
});

// ═════════════════════════════ 5. re-pose hors du camp ═════════════════════════════════════════════
function moveGlue(extra = {}) {
  return glue({
    disk: { memo: campedMemo({ base: { x: 0, y: 70, z: 0 }, personal: true, worldSpawn: { x: -3, z: -1 } }) },
    _safeHomeSet: true, _safeHomeSurface: true, _safeHomePos: { x: 0, y: 70, z: 0 },
    bot: { entity: { position: { x: 120, y: 72, z: 40 }, onGround: true } },
    ...extra,
  });
}

test('re-pose : de jour, au calme, en surface, loin du camp → /sethome safe ICI + /spawnpoint + event home_safe_moved', () => {
  const sb = moveGlue();
  const d = sb.maybeMoveCampedSafeHome();
  assert.strictEqual(d.move, true);
  assert.deepStrictEqual(sb.chat, ['/sethome safe', '/spawnpoint']);
  assert.deepStrictEqual(plain(sb._safeHomePos), { x: 120, y: 72, z: 40 });
  assert.deepStrictEqual(sb.disk.memo.safeHome, { x: 120, y: 72, z: 40, at: T0, why: 'camped' });
  assert.strictEqual(sb._safeHomeMovedAt, T0);
  const ev = sb.events.find((e) => e.type === 'home_safe_moved');
  assert.deepStrictEqual(plain(ev), { type: 'home_safe_moved', from: { x: 0, y: 70, z: 0 }, to: { x: 120, y: 72, z: 40 }, deaths: 2 });
  assert.ok(!sb.chat.some((c) => /delhome|sethome (work|death)/.test(c)), 'schéma 3 homes intact : on écrase `safe`, rien d autre');
});

test('re-pose (OUVRIER) : la BASE suit — base persistée (fusion), confine et borne d exploration ré-ancrés', () => {
  const sb = moveGlue({ IS_MAPPER: false, CONFINE: { x: 0, z: 0, radius: 140 }, _confineDyn: { x: 0, z: 0, radius: 140 }, _anchorSet: true });
  sb.maybeMoveCampedSafeHome();
  assert.deepStrictEqual(sb.disk.memo.base, { x: 120, y: 72, z: 40 });
  assert.strictEqual(sb.disk.memo.personal, true, 'les autres champs de la base traversent');
  assert.deepStrictEqual(sb.disk.memo.worldSpawn, { x: -3, z: -1 });
  assert.strictEqual(sb.disk.memo.deathPos.length, 2);
  assert.deepStrictEqual(plain(sb.CONFINE), { x: 120, z: 40, radius: 140 });
  assert.deepStrictEqual(plain(sb._confineDyn), { x: 120, z: 40, radius: 140 });
  assert.deepStrictEqual(plain(sb.bot._mcaExploreBounds), { x: 120, z: 40, radius: 280 });
});

test('re-pose (CARTOGRAPHE) : pas de base (il n en a pas) — seul son home et son ancre bougent', () => {
  const sb = moveGlue({ _confineDyn: { x: 0, z: 0, radius: 140 }, _anchorSet: true });
  sb.maybeMoveCampedSafeHome();
  assert.deepStrictEqual(sb.disk.memo.base, { x: 0, y: 70, z: 0 }, 'la base n est pas réécrite pour un cartographe');
  assert.deepStrictEqual(plain(sb._confineDyn), { x: 120, z: 40, radius: 140 });
});

test('re-pose : jamais de nuit, ni avec un hostile à ≤ 24 blocs, ni sous terre, ni en plein saut', () => {
  for (const over of [
    { bot: { time: { timeOfDay: NIGHT }, entity: { position: { x: 120, y: 72, z: 40 }, onGround: true } } },
    { bot: { entities: { 1: zombie(130, 45, 72) }, entity: { position: { x: 120, y: 72, z: 40 }, onGround: true } } },
    { bot: { entity: { position: { x: 120, y: 40, z: 40 }, onGround: true } } },
    { bot: { entity: { position: { x: 120, y: 72, z: 40 }, onGround: false } } },
    { bot: { time: null, entity: { position: { x: 120, y: 72, z: 40 }, onGround: true } } },
  ]) {
    const sb = moveGlue(over);
    const d = sb.maybeMoveCampedSafeHome();
    assert.strictEqual(d.move, false, JSON.stringify(over));
    assert.deepStrictEqual(sb.chat, []);
  }
});

test('re-pose : jamais pendant que le bot est MORT (sa position est celle du cadavre, entre death et respawn)', () => {
  const sb = moveGlue();
  sb.bot.isAlive = false;
  assert.strictEqual(sb.maybeMoveCampedSafeHome(), null);
  assert.deepStrictEqual(sb.chat, []);
});

test('re-pose : pas pendant une tâche qui possède le bot ou re-pose `safe` elle-même', () => {
  for (const flag of ['_migrating', '_escaping', '_baseBusy', '_imminentBusy', '_stillBusy']) {
    const sb = moveGlue({ [flag]: true });
    assert.strictEqual(sb.maybeMoveCampedSafeHome(), null, flag);
    assert.deepStrictEqual(sb.chat, [], flag);
  }
});

test('re-pose : au plus 1 fois / 5 min — y compris à travers une relance du process (safeHome.why = camped)', () => {
  const sb = moveGlue({ _safeHomeMovedAt: T0 - 2 * MIN });
  assert.strictEqual(sb.maybeMoveCampedSafeHome().reason, 'cooldown');
  const sb2 = moveGlue();
  sb2.disk.memo.safeHome = { x: 0, y: 70, z: 0, at: T0 - 2 * MIN, why: 'camped' };
  assert.strictEqual(sb2.maybeMoveCampedSafeHome().reason, 'cooldown');
  const sb3 = moveGlue();
  sb3.disk.memo.safeHome = { x: 0, y: 70, z: 0, at: T0 - 2 * MIN, why: 'spawn' };
  assert.strictEqual(sb3.maybeMoveCampedSafeHome().move, true, 'une pose ordinaire ne compte pas comme déménagement');
});

test('re-pose : note au passage un hostile vu près du HOME (même quand le bot ne bouge pas le home)', () => {
  const sb = moveGlue({ bot: { entities: { 1: zombie(5, 5) }, entity: { position: { x: 10, y: 70, z: 0 }, onGround: true } } });
  sb.maybeMoveCampedSafeHome();
  assert.strictEqual(sb._hostileNearHomeAt, T0);
});

// ═════════════════════════════ 6. au spawn : ne pas re-poser `safe` DANS le camp ═════════════════
const spawnAt = (extra = {}) => glue({ bot: { entity: { position: { x: -3, y: 70, z: -1 }, onGround: true } }, ...extra });

test('spawn sain : pose `safe` ici comme avant (et le mémorise)', () => {
  const sb = spawnAt();
  sb.poseSafeHomeAtSpawn();
  assert.deepStrictEqual(sb.chat, ['/sethome safe']);
  assert.strictEqual(sb._safeHomeSet, true);
  assert.deepStrictEqual(sb.disk.memo.safeHome, { x: -3, y: 70, z: -1, at: T0, why: 'spawn' });
  const ev = sb.events.find((e) => e.type === 'safe_home_set');
  assert.deepStrictEqual(plain(ev), { type: 'safe_home_set', surface: true, x: -3, y: 70, z: -1 });
});

test('spawn CAMPÉ (process neuf après un death_loop) + home persisté sain → ADOPTÉ, rien re-posé dans le camp, l ancre suit', () => {
  const disk = { memo: campedMemo({ safeHome: { x: 300, y: 75, z: 80, at: T0 - 4 * MIN, why: 'camped' } }) };
  const sb = spawnAt({ disk });
  sb.poseSafeHomeAtSpawn();
  assert.deepStrictEqual(sb.chat, [], 'pas de /sethome safe au camp');
  assert.strictEqual(sb._safeHomeSet, true);
  assert.deepStrictEqual(plain(sb._safeHomePos), { x: 300, y: 75, z: 80 });
  assert.ok(sb.events.some((e) => e.type === 'safe_home_adopted' && e.x === 300));
  assert.strictEqual(sb._anchorSet, true, 'sinon l auto-ancrage reposerait `safe` à deux pas du camp');
  assert.deepStrictEqual(plain(sb._confineDyn), { x: 300, z: 80, radius: 140 });
});

test('spawn campé + home persisté sain, mais confine STATIQUE (arène) → adopté sans toucher à l ancre', () => {
  const disk = { memo: campedMemo({ safeHome: { x: 300, y: 75, z: 80, at: T0 - 4 * MIN } }) };
  const sb = spawnAt({ disk, CONFINE: { x: 0, z: 0, radius: 64 } });
  sb.poseSafeHomeAtSpawn();
  assert.strictEqual(sb._anchorSet, false);
  assert.strictEqual(sb._confineDyn, null);
});

test('spawn campé sans home connu → on pose quand même (un home connu, même campé, est mis sous veto)', () => {
  const sb = spawnAt({ disk: { memo: campedMemo() } });
  sb.poseSafeHomeAtSpawn();
  assert.deepStrictEqual(sb.chat, ['/sethome safe']);
  assert.ok(sb.events.some((e) => e.type === 'safe_home_set' && e.camped === true));
});

test('spawn campé avec un safe déjà en main (amélioration surface) → on le GARDE, on ne le déplace pas dans le camp', () => {
  const sb = spawnAt({ disk: { memo: campedMemo() }, _safeHomeSet: true, _safeHomeSurface: false, _safeHomePos: { x: 5, y: 40, z: 5 } });
  sb.poseSafeHomeAtSpawn();
  assert.deepStrictEqual(sb.chat, []);
  assert.deepStrictEqual(plain(sb._safeHomePos), { x: 5, y: 40, z: 5 });
  assert.ok(sb.events.some((e) => e.type === 'safe_home_kept'));
});

test('spawn : les pieds dans l eau / safe de surface déjà posé → rien (comportement d avant)', () => {
  const wet = spawnAt({ isInWater: () => true });
  wet.poseSafeHomeAtSpawn();
  assert.deepStrictEqual(wet.chat, []);
  const done = spawnAt({ _safeHomeSet: true, _safeHomeSurface: true, _safeHomePos: { x: 1, y: 70, z: 1 } });
  done.poseSafeHomeAtSpawn();
  assert.deepStrictEqual(done.chat, []);
});

// ═════════════════════════════ 7. câblage (niveau module, chemins de secours, aller-retour) ════════
test('index.js : les gardes du home campé sont de NIVEAU MODULE (colonne 0) — piège #56', () => {
  for (const name of ['_deathPos', '_deathPosLoaded', '_hostileNearHomeAt', '_homeCampedEventAt', '_safeHomeMovedAt']) {
    assert.match(SRC, new RegExp(`^let ${name}\\b`, 'm'), `${name} doit être déclaré en \`let\` à la colonne 0`);
  }
});

test('index.js : importe de ./homeSafety tout ce que la glue utilise', () => {
  const imp = grab(/const \{[^}]*\} = require\('\.\/homeSafety'\);/, "require('./homeSafety')");
  for (const name of ['homeCamped', 'rescueWarpVeto', 'safeHomeMove', 'spawnSafeHomeAction', 'deathPosPrune', 'deathPosLoad',
    'deathPosMemoWith', 'safeHomeLoad', 'safeHomeMemoWith', 'nearestHostile', 'hostileNearHome', 'CAMPED_EVENT_EVERY_MS']) {
    assert.ok(new RegExp(`\\b${name}\\b`).test(imp), `${name} manque dans l import de ./homeSafety`);
  }
});

test('index.js : le veto est branché sur homewarp.goHome au niveau module, la re-pose tourne dans un timer', () => {
  assert.match(SRC, /^bot\._mcaSafeVeto = \(ctx\) => !!safeHomeVeto\(ctx\);$/m);
  assert.match(SRC, /^setInterval\(\(\) => \{\n  try \{ maybeMoveCampedSafeHome\(\); \} catch \(e\) \{[^}]*\}\n\}, \d+\);$/m);
});

test('point d entrée UNIQUE : seul homewarp.js envoie un /home — sinon un /home safe échapperait au veto', () => {
  // (Le /home tapé sur ORDRE — commande LLM whitelistée, runCommand — passe par bot.chat(String(cmd)) :
  //  c'est le retour volontaire, il n'est jamais bloqué, et il n'apparaît pas comme littéral ici.)
  const dirs = [__dirname, path.join(__dirname, 'skills')];
  let seen = 0;
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.js') || f.endsWith('.test.js') || f === 'homewarp.js') continue;
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      seen++;
      assert.ok(!/chat\(\s*['"`]\/home\b/.test(src), `${f} : bot.chat('/home …') en direct — passer par homewarp.goHome`);
      assert.ok(!/['"`]\/home ['"`]\s*\+/.test(src), `${f} : '/home ' + … en direct — passer par homewarp.goHome`);
    }
  }
  assert.ok(seen > 20, 'le balayage a bien vu les modules');
});

test('index.js : TOUT /sethome safe est suivi de noteSafeHome (sinon le process suivant croit son home ailleurs)', () => {
  const re = /homewarp\.bookmark\(bot, (?:'safe'|HOME_SAFE|CONFINE_HOME)\)/g;
  let m; let n = 0;
  while ((m = re.exec(SRC))) {
    n++;
    const after = SRC.slice(m.index, m.index + 420);
    assert.ok(/noteSafeHome\(/.test(after), `/sethome safe sans noteSafeHome juste après : …${SRC.slice(m.index, m.index + 120)}…`);
  }
  assert.ok(n >= 6, `on attend ≥ 6 poses de safe (spawn, ancre, reset, base, migration, re-pose) — vu ${n}`);
});

test('index.js : la position de la mort est écrite AVANT process.exit(2) (le process suivant doit la relire)', () => {
  const h = grab(/^bot\.on\('death', \(\) => \{[\s\S]*?^\}\);$/m, "bot.on('death')");
  const rec = h.indexOf('recordDeathPosition(');
  const exit = h.lastIndexOf('process.exit(2);');
  assert.ok(rec > 0 && rec < exit);
});

test('index.js : les secours qui ont un REPLI le prennent quand le home est campé', () => {
  // noyade : nager vers la rive (escapeWater) reste le repli — 3 chemins (persistant/noyade, échecs, océan)
  const vetoes = SRC.match(/safeHomeVeto\('(?:water_rescue|drowning|ocean)'\)\) \{\s*emit\(\{ type: 'water_rescue_no_warp'[^\n]*\n?\s*try \{ await escapeWater\(bot/g) || [];
  assert.strictEqual(vetoes.length, 3, 'les 3 sauvetages de noyade NO_GIVE doivent nager quand le home est campé');
  // imminent : même dégradation qu'un safe refusé
  assert.match(SRC, /if \(verdict === 'escape' && safeHomeVeto\('imminent'\)\) verdict = 'escape_no_warp';/);
  // fuite d'un camp de mort : à pied si le home est campé
  assert.match(fnSrc('fleeDeathCamp'), /!safeHomeVeto\('death_camp_flee'\)/);
  // safeWarpHome consulte le veto AVANT de se murer / d'envoyer le /home
  const w = fnSrc('safeWarpHome');
  assert.ok(w.indexOf('safeHomeVeto(') > 0 && w.indexOf('safeHomeVeto(') < w.indexOf('secureSpot('));
  // onSpawn passe par la décision « spawn campé »
  assert.match(grab(/^async function onSpawn\(\) \{[\s\S]*?^\}$/m, 'onSpawn'), /poseSafeHomeAtSpawn\(\);/);
});
