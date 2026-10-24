'use strict';
// CÂBLAGE des correctifs du 20/10 (run 943e2c) — le VRAI texte des fonctions de index.js exécuté dans un
// bac à sable `vm` strict (identifiant hors niveau module → ReferenceError ici, pas en prod, piège #56) :
//   1. home inexistant côté serveur (NethBot1) → noté, plus adopté, escalier de repli ;
//   2. manque de bois pour un craft (NethBot2) → demande au bûcheron ; pioche : plus d'échec muet ;
//   3. armure des cartographes PAR LOTS (NethBot2, 11 lingots).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const homewarp = require('./homewarp');
const { HOME_SAFE, HOME_WORK, SAFE_HOME_MIN_Y } = require('./homes');
const { isOutside } = require('./skills/digOut');
const J = require('./jamEscalate');
const L = require('./lumberjack');
const { buildCtxInv } = require('./goals');
const { giftSetPlan, pickMapperToEquip, teamStatus } = require('./teamwork');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(re, label) {
  const m = SRC.match(re);
  assert.ok(m, `${label} introuvable dans index.js (déplacé, renommé, ou déclaré hors niveau module ?)`);
  return m[0];
}
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);
const run = (sb, code) => vm.runInContext("'use strict';\n" + code, sb);
const T0 = 1_800_000_000_000;

// Monde : pierre sous y 60, air au-dessus (NethBot1 emmuré à y 40).
const blockAt = (p) => (p.y < 60 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' });

function base(o = {}) {
  const clock = { t: T0 };
  const sb = {
    events: [], chat: [], clock, memo: o.memo || {}, kicked: [], started: 0,
    emit(e) { sb.events.push(e); },
    Date: { now: () => clock.t },
    Object, Math, Number, Array, JSON, Promise, Set, Map, String, RegExp,
    bot: {
      username: 'NethBot1',
      entity: { position: Object.assign({ x: -43.5, y: 40, z: -339.5 }, o.pos || {}) },
      blockAt: o.blockAt || blockAt,
      chat: (m) => sb.chat.push(m),
      inventory: { items: () => o.items || [] },
    },
    vec3Lib: (x, y, z) => ({ x, y, z }),
    homewarp, HOME_SAFE, HOME_WORK, SAFE_HOME_MIN_Y,
    digOutIsOutside: isOutside,
    jamLoopAtStart: J.jamLoopAtStart, jamLoopMemoWith: J.jamLoopMemoWith, jamLoopCleared: J.jamLoopCleared,
    loadBaseState: () => JSON.parse(JSON.stringify(sb.memo)),
    saveBaseState: (st) => { sb.memo = JSON.parse(JSON.stringify(st)); return true; },
    isInWater: () => false,
    _homeMissingAt: {}, _homeMissingEvAt: {}, HOME_MISSING_EVENT_EVERY_MS: 60000, SAFE_MISSING_MEMO_KEY: 'safeHomeMissingAt',
    _homeRefusedAt: {}, _safeHomeSet: true, _safeHomeSurface: true, _workSet: true,
    _digOutBusy: false, _digOutFailAt: 0, DIG_OUT_RETRY_MS: 180000, _migrating: false,
    world: { objective: { type: 'mapper_armor', status: 'in_progress' } },
    startAutonomous: async () => { sb.started++; },
    ...(o.extra || {}),
  };
  vm.createContext(sb);
  return sb;
}

// ─── 1. Home inexistant ─────────────────────────────────────────────────────────────────────────
test('noteHomeMissing(safe) : plus de filet supposé, mémo marqué, event throttlé', () => {
  const sb = base({ memo: { base: { x: -43, y: 40, z: -340 } } });
  run(sb, fnSrc('noteHomeMissing') + fnSrc('safeHomeKnownMissing'));
  run(sb, 'noteHomeMissing(HOME_SAFE); noteHomeMissing(HOME_SAFE);');
  assert.strictEqual(run(sb, 'safeHomeKnownMissing()'), true);
  assert.strictEqual(run(sb, '_safeHomeSet'), false);
  assert.strictEqual(run(sb, '_homeRefusedAt.safe'), T0);
  assert.strictEqual(sb.memo.safeHomeMissingAt, T0);
  assert.deepStrictEqual(sb.memo.base, { x: -43, y: 40, z: -340 }, 'fusion du mémo');
  assert.strictEqual(sb.events.filter((e) => e.type === 'home_missing').length, 1);
  run(sb, 'noteHomeMissing(HOME_WORK);');
  assert.strictEqual(run(sb, '_workSet'), false);
});

test('messagestr : « Player has not set a home. » après /home safe → noteHomeMissing(safe)', () => {
  const m = SRC.match(/const missingH = refusedH \? null : homewarp\.missingHome\(bot, msg\);\n\s*if \(missingH\) noteHomeMissing\(missingH\);/);
  assert.ok(m, 'le handler messagestr doit attribuer le message au dernier /home');
  const bot = { chat() {} };
  homewarp.goSpawn(bot);
  assert.strictEqual(homewarp.missingHome(bot, 'Player has not set a home.'), 'safe');
});

test('adoption de base : refusée quand le serveur a dit que `safe` n’existe pas', () => {
  assert.match(SRC, /if \(st0 && st0\.base && Number\.isFinite\(st0\.base\.x\) && !_safeHomeSet && !_safeGone\)/);
});

test('noteSafeHome : un /sethome safe après un home manquant → home_set_recovered + mémo nettoyé', () => {
  assert.match(fnSrc('noteSafeHome'), /home_set_recovered/);
  assert.match(fnSrc('noteSafeHome'), /delete memo\[SAFE_MISSING_MEMO_KEY\]/);
});

// ─── Escalier ───────────────────────────────────────────────────────────────────────────────────
function digSb(o = {}) {
  const sb = base(o);
  run(sb, fnSrc('kickDigOut'));
  sb.digOutAndResume = async (why) => { sb.kicked.push(why); return { ok: true }; };
  return sb;
}

test('kickDigOut : emmuré sous terre → escalier lancé', () => {
  const sb = digSb();
  assert.strictEqual(run(sb, "kickDigOut('no_home')"), true);
  assert.deepStrictEqual(sb.kicked, ['no_home']);
});

test('kickDigOut : en surface, dans l’eau, déjà en cours, ou juste après un échec → rien', () => {
  assert.strictEqual(run(digSb({ pos: { y: 70 } }), "kickDigOut('no_home')"), false);
  assert.strictEqual(run(digSb({ extra: { isInWater: () => true } }), "kickDigOut('no_home')"), false);
  assert.strictEqual(run(digSb({ extra: { _digOutBusy: true } }), "kickDigOut('no_home')"), false);
  const sb = digSb({ extra: { _digOutFailAt: T0 - 1000 } });
  assert.strictEqual(run(sb, "kickDigOut('no_home')"), false);
  assert.strictEqual(run(sb, "kickDigOut('jam_loop_repeat')"), true, 'le jam_loop répété passe outre le délai');
});

test('kickDigOut : grande grotte sous terre (ciel ouvert sur 8 blocs) → escalier quand même (y < 58)', () => {
  const cave = (p) => (p.y < 30 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' });
  assert.strictEqual(run(digSb({ blockAt: cave }), "kickDigOut('no_home')"), true);
});

test('digOutAtSpawnIfLooping : 2e jam_loop ici → escalier au démarrage ; 1er → non', () => {
  const p = { x: -43, y: 40, z: -340 };
  const one = J.jamLoopMemoWith({}, p, T0 - 120000);
  const two = J.jamLoopMemoWith(one, p, T0 - 60000);
  const sb1 = digSb({ memo: one });
  run(sb1, fnSrc('digOutAtSpawnIfLooping'));
  assert.strictEqual(run(sb1, 'digOutAtSpawnIfLooping()'), false);
  const sb2 = digSb({ memo: two });
  run(sb2, fnSrc('digOutAtSpawnIfLooping'));
  assert.strictEqual(run(sb2, 'digOutAtSpawnIfLooping()'), true);
  assert.deepStrictEqual(sb2.kicked, ['jam_loop_repeat']);
  assert.ok(sb2.events.some((e) => e.type === 'jam_loop_repeat'));
  // et onSpawn ne lance PAS le planner en parallèle
  assert.match(SRC, /if \(!digOutAtSpawnIfLooping\(\)\) startAutonomous\(null\);/);
});

test('digOutAndResume : préempte, creuse, nettoie le jam_loop, relance le planner', async () => {
  const sb = base({ memo: { jamLoop: { x: -43, y: 40, z: -340, count: 2, at: T0 }, base: { x: 1 } } });
  let begun = null;
  Object.assign(sb, {
    taskCtl: { begin: (n) => { begun = n; return { cancelled: false }; } },
    _skillInFlight: 0, _autoRunners: 0, MIGRATION_PREEMPT_WAIT_MS: 30000, DIG_OUT_MAX_MS: 90000,
    sleep: async () => {}, stopMotion: () => {}, taskToken: null, _jamEsc: { count: 2 }, _jamSample: {},
    digOutSkill: async () => ({ ok: true, steps: 18, dir: { dx: 1, dz: 0 } }),
  });
  run(sb, fnSrc('digOutAndResume'));
  const r = await run(sb, "digOutAndResume('no_home')");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(begun, 'dig_out');
  assert.strictEqual(sb.memo.jamLoop, undefined);
  assert.deepStrictEqual(sb.memo.base, { x: 1 });
  assert.strictEqual(sb.started, 1);
  assert.strictEqual(run(sb, '_digOutBusy'), false);
  const ev = sb.events.find((e) => e.type === 'dig_out');
  assert.strictEqual(ev.ok, true); assert.strictEqual(ev.why, 'no_home'); assert.ok('took_s' in ev && 'dir' in ev);
});

test('digOutAndResume : échec → délai avant re-tentative, planner relancé quand même', async () => {
  const sb = base();
  Object.assign(sb, {
    taskCtl: { begin: () => ({ cancelled: false }) },
    _skillInFlight: 0, _autoRunners: 0, MIGRATION_PREEMPT_WAIT_MS: 30000, DIG_OUT_MAX_MS: 90000,
    sleep: async () => {}, stopMotion: () => {}, taskToken: null, _jamEsc: null, _jamSample: null,
    digOutSkill: async () => ({ ok: false, reason: 'all_blocked:fluid', steps: 0 }),
  });
  run(sb, fnSrc('digOutAndResume'));
  await run(sb, "digOutAndResume('no_home')");
  assert.strictEqual(run(sb, '_digOutFailAt'), T0);
  assert.strictEqual(sb.started, 1);
});

test('relocateToRegion (NO_GIVE) : home manquant → escalier direct ; /home sans effet → escalier', async () => {
  const sb = base();
  Object.assign(sb, {
    NO_GIVE: true, safeHomeVeto: () => null, stopMotion: () => {}, sleep: async () => {},
    args: {}, CONFINE: null, _confineDyn: null,
  });
  sb.kickDigOut = (why) => { sb.kicked.push(why); return true; };
  run(sb, 'let _relocSeq = 0;' + fnSrc('relocateToRegion') + fnSrc('safeHomeKnownMissing'));
  sb._homeMissingAt.safe = T0;
  await run(sb, 'relocateToRegion()');
  assert.deepStrictEqual(sb.kicked, ['no_home']);
  assert.strictEqual(sb.chat.length, 0, 'aucun /home envoyé pour rien');
  delete sb._homeMissingAt.safe;
  await run(sb, 'relocateToRegion()');
  assert.deepStrictEqual(sb.chat, ['/home safe']);
  assert.deepStrictEqual(sb.kicked, ['no_home', 'relocate_no_move']);
});

test('jam-watchdog : giveUp persiste le jam_loop (fusion) ; ignoré pendant l’escalier', () => {
  assert.match(SRC, /const m = jamLoopMemoWith\(loadBaseState\(\), \{ x: p\.x, y: p\.y, z: p\.z \}, now\);/);
  assert.match(SRC, /if \(_digOutBusy\) \{ _jamSample = null; return; \}/);
});

// ─── 2. Bois manquant pour un craft ─────────────────────────────────────────────────────────────
function woodSb(o = {}) {
  const sb = base({ items: o.items, extra: o.extra });
  Object.assign(sb, {
    buildCtxInv, woodShortForFailure: L.woodShortForFailure, isWoodGoal: L.isWoodGoal,
    IS_MAPPER: !!o.mapper, isLumberjackObjective: () => !!o.lj, _nearestTable: () => null,
    waits: [],
    woodWaitStep: async (g, why) => { sb.waits.push({ g, why }); return o.wait === undefined ? { ok: true } : o.wait; },
  });
  run(sb, fnSrc('woodRequestOnShortage'));
  return sb;
}
const NB2 = [{ name: 'acacia_planks', count: 1 }, { name: 'iron_ingot', count: 11 }, { name: 'cobblestone', count: 39 }];

test('woodRequestOnShortage : gift_pick no_sticks avec 1 planche → demande au bûcheron (why tracé)', async () => {
  const sb = woodSb({ items: NB2 });
  const r = await run(sb, "woodRequestOnShortage({ name: 'gift_pick', skill: 'ensurePick' }, 'pick_recovery:no_sticks')");
  assert.deepStrictEqual(r, { ok: true });
  assert.strictEqual(sb.waits.length, 1);
  assert.strictEqual(sb.waits[0].g.skill, 'gatherLog');
  assert.strictEqual(sb.waits[0].why, 'pick_recovery:no_sticks');
});

test('woodRequestOnShortage : pas de manque, but bois, cartographe, bûcheron → null', async () => {
  assert.strictEqual(await run(woodSb({ items: [{ name: 'oak_log', count: 4 }] }),
    "woodRequestOnShortage({ name: 'gift_pick', skill: 'ensurePick' }, 'pick_recovery:no_sticks')"), null);
  assert.strictEqual(await run(woodSb({ items: NB2 }),
    "woodRequestOnShortage({ name: 'logs', skill: 'gatherLog' }, 'not_found')"), null);
  assert.strictEqual(await run(woodSb({ items: NB2, mapper: true }),
    "woodRequestOnShortage({ name: 'gift_pick', skill: 'ensurePick' }, 'pick_recovery:no_sticks')"), null);
  assert.strictEqual(await run(woodSb({ items: NB2, lj: true }),
    "woodRequestOnShortage({ name: 'gift_pick', skill: 'ensurePick' }, 'pick_recovery:no_sticks')"), null);
});

test('runSkillWithTelemetry : un échec appelle la demande de bois ; woodWaitStep trace `why`', () => {
  assert.match(fnSrc('runSkillWithTelemetry'), /const _ww = await woodRequestOnShortage\(g, r && r\.reason\);/);
  assert.match(fnSrc('woodWaitStep'), /why: why \|\| 'wood_goal'/);
  assert.match(fnSrc('_recoverPickaxeInner'), /woodWaitStep\(\{ name: 'pick_recovery', skill: 'gatherLog'/);
});

// ─── 4. Pick recovery sans garde-fou danger (NethBot2 + MapBot2, 21/10) ─────────────────────────
// Mesuré en live : le gather de bois de la récupération de pioche n'avait AUCUN prédicat `danger`,
// contrairement à gatherWoodSafely (le chemin normal de `logs`/gatherLog). Sans lui, explore() ne
// peut jamais couper tôt quand un hostile menace — les réflexes de survie (fleeFrom/creeperTick)
// coupaient le pathfinder d'explore() en boucle, rejet « The goal was changed before it could be
// completed! » sur LES 6 waypoints du 1er anneau en <100ms (`explore_summary reached:0 failedFast:6
// stuck:true`), skill bloqué 240s pour rien, et le bot a frôlé la mort (hp 0.5, NethBot2) pendant le
// thrash au lieu de se cacher comme gatherWoodSafely sait le faire.
test('_recoverPickaxeInner : le gather de bois passe un `danger` — sinon explore() ne coupe jamais face à un hostile', () => {
  assert.match(fnSrc('_recoverPickaxeInner'),
    /gather\(bot, \{ name: logNames, count: 4, explore: true, danger: \(\) => !!woodThreatNow\(\) \}, taskToken\)/);
});

test('recoverPickaxe : un 2e appel ATTEND l’expédition en vol et rend SA raison (plus de `unknown` instantané)', async () => {
  const sb = base();
  let release;
  Object.assign(sb, {
    _pickRecovering: false, _pickRecoveryRun: null,
    bestPickTier: () => -1,
    _recoverPickaxeInner: () => new Promise((res) => { release = res; }),
  });
  run(sb, fnSrc('recoverPickaxe'));
  const first = run(sb, 'recoverPickaxe()');
  const second = run(sb, 'recoverPickaxe()');
  let settled = false;
  second.then(() => { settled = true; });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(settled, false, 'le 2e appel ne rend plus la main tout de suite');
  release({ ok: false, reason: 'pick_recovery:no_sticks' });
  assert.deepStrictEqual(await second, { ok: false, reason: 'pick_recovery:no_sticks' });
  assert.deepStrictEqual(await first, { ok: false, reason: 'pick_recovery:no_sticks' });
  assert.strictEqual(run(sb, '_pickRecovering'), false);
  assert.ok(sb.events.some((e) => e.type === 'pick_recovery_join'));
});

// ─── 3. Armure des cartographes par lots ────────────────────────────────────────────────────────
function giftSb(o = {}) {
  const sb = base({ items: o.items });
  sb.bot.username = 'NethBot2';
  const claims = {};
  Object.assign(sb, {
    giftSetPlan, pickMapperToEquip, teamStatus, giftBatchFor: L.giftBatchFor, ljGiftReady: L.ljGiftReady,
    _teamLatchActive: () => false, NAKED_MAPPER_MAX_WORN: 1,   // cliquet de phase (index.teamlatch.test.js)
    buildCtxInv, isNearlyBroken: () => false, isAllowed: () => true, whitelist: null,
    _wornArmor: () => new Set(['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']),
    presence: { list: () => o.mates || [] },
    _teamClaims: { tryClaim: (k) => { if (claims[k]) return false; claims[k] = 1; return true; }, release: (k) => { delete claims[k]; } },
    _giftTarget: null, _giftAt: 0, _giftDone: new Map(), _giftBatch: null, _giftNeed: null, mapperGiftNeed: L.mapperGiftNeed,
    GIFT_CACHE_MS: 15000, GIFT_DONE_TTL_MS: 300000,
    GIFT_PIECES: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'],
    craftSmart: async ({ name }) => { sb.items.push({ name, count: 1 }); sb.crafted.push(name); return { ok: true }; },
    crafted: [],
  });
  sb.items = (o.items || []).map((i) => Object.assign({}, i));
  sb.bot.inventory.items = () => sb.items;
  run(sb, fnSrc('_giftPocket') + fnSrc('_refreshGiftBatch') + fnSrc('_giftContext') + fnSrc('giftBatchCraftSkill'));
  return sb;
}
const MATES = [
  { name: 'MapBot2', role: 'mapper', at: T0 - 1000, armor: 0, missing: ['iron_boots', 'iron_helmet', 'iron_leggings', 'iron_chestplate'] },
  { name: 'MapBot1', role: 'mapper', at: T0 - 1000, armor: 1, missing: ['iron_helmet', 'iron_leggings', 'iron_chestplate'] },
];

test('_giftContext : 11 lingots (positions-943e2c réel) → lot PLASTRON pour MapBot2 (24/10), pas de mine', async () => {
  const sb = giftSb({ items: [{ name: 'iron_ingot', count: 11 }], mates: MATES });
  const c = run(sb, '_giftContext()');
  assert.strictEqual(c.target, 'MapBot2');
  assert.strictEqual(c.batch, true);
  assert.strictEqual(c.ready, false);
  assert.strictEqual(c.need, 24);                         // lingots du set restant (rien en poche)
  assert.deepStrictEqual(run(sb, '_giftBatch').pieces, ['iron_chestplate']);
  const ev = sb.events.find((e) => e.type === 'gift_batch');
  assert.deepStrictEqual([ev.to, ev.ingots], ['MapBot2', 8]);
  const r = await run(sb, 'giftBatchCraftSkill()');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(sb.crafted, ['iron_chestplate']);
  sb.clock.t += 1000;                                     // dans la fenêtre de cache : `ready` est relu
  const c2 = run(sb, '_giftContext()');
  assert.strictEqual(c2.ready, true);
  assert.strictEqual(c2.batch, true);
});

test('_giftContext : 2 lingots → pas de lot, chemin historique (set complet à miner)', () => {
  const sb = giftSb({ items: [{ name: 'iron_ingot', count: 2 }], mates: MATES });
  const c = run(sb, '_giftContext()');
  assert.strictEqual(c.target, 'MapBot2');
  assert.strictEqual(c.batch, false);
  assert.strictEqual(run(sb, '_giftBatch'), null);
});

test('giftBatchCraftSkill : craft impossible → raison du craft remontée (déclenche la demande de bois)', async () => {
  const sb = giftSb({ items: [{ name: 'iron_ingot', count: 11 }], mates: MATES });
  sb.craftSmart = async () => ({ ok: false, reason: 'no_table:unknown_item' });
  run(sb, '_giftContext()');
  const r = await run(sb, 'giftBatchCraftSkill()');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { ok: false, reason: 'gift_batch_craft:no_table:unknown_item' });
  assert.strictEqual(L.woodShortForFailure({ reason: r.reason, goalName: 'gift_craft', inv: { iron_ingot: 11, acacia_planks: 1 } }), true);
});

test('livraison d’un lot : ses pièces seulement, re-servable après 90 s, event gift_batch delivered', () => {
  const del = SRC.match(/if \(goal\.skill === 'deliverMapperArmor'\) \{[\s\S]*?\n  \}\n/)[0];
  assert.match(del, /_batch \? _batch\.pieces\.slice\(\) : null/);
  assert.match(del, /GIFT_DONE_TTL_MS - GIFT_BATCH_REDO_MS/);
  assert.match(del, /phase: 'delivered'/);
  assert.match(SRC, /giftBatch: !!gift\.batch/);
});
