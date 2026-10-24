'use strict';
// Câblage index.js de la réponse au squelette (22/10). Sandbox vm : fonctions de NIVEAU MODULE extraites
// (piège #56), exécutées sur un faux bot. Mesure live d'origine : `aura_hit {skeleton, dist:2.8}` →
// `fight_refused low_hp` → `reflex flee` → « shot by Skeleton ».
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { decideSkeletonResponse, findCoverCell, zigzagSide, shooterSees, rushStopReason, eatDuringRush, callerFromStack, rushRearmWanted, rushEquipBlocked } = require('./skeletonResponse');
const { createTaskController } = require('./tasks');
const goalHold = require('./goalHold');
const { FOODS, EMERGENCY_FOODS } = require('./reflexes');
const { RANGED } = require('./reflexes');
const { isFleeHostile } = require('./skills/fleeFrom');
const { createFightBreaker } = require('./fightBreaker');
const { rushResumesPlanner } = require('./plannerRevive');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(re, label) {
  const m = SRC.match(re);
  assert.ok(m, `${label} introuvable dans index.js`);
  return m[0];
}
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);
const constSrc = (name) => grab(new RegExp(`^const ${name} = [^;]+;`, 'm'), `const ${name}`);
const NAMES = ['skeletonRushYield', 'skeletonVitalHazard', 'escapeWater', 'stopMotion', '_skelIsFood', 'skeletonEquipAllowed', '_skelBlockAt', 'skeletonSees', 'skeletonHurtRecently', 'skeletonSituation', '_skelWeapon', '_skelShield', '_skelShieldUp', '_skelRush', '_skelCover',
  'skeletonRespond', 'skeletonAwareFlee', 'skeletonFirstFlee'];

function setup({ health = 9, skel = { x: 2.8, y: 64, z: 0 }, zombie = null, items = null, los = true, mapper = false, prevTask = null } = {}) {
  const ents = {};
  const s = skel && { id: 7, name: 'skeleton', type: 'hostile', kind: 'Hostile mobs', position: Object.assign({ offset: () => ({}) }, skel) };
  if (s) ents[7] = s;
  if (zombie) ents[8] = { id: 8, name: 'zombie', type: 'hostile', kind: 'Hostile mobs', position: zombie };
  const calls = { raw: [], flee: 0, cover: 0, grant: [], stop: 0, restart: [] };
  const taskCtl = createTaskController();
  if (prevTask) taskCtl.begin(prevTask, () => {});
  const bot = {
    health, entity: { position: { x: 0, y: 64, z: 0 }, onGround: true }, entities: ents,
    inventory: { items: () => items || [{ name: 'stone_sword', count: 1 }, { name: 'cobblestone', count: 32 }], slots: [] },
    pvp: { target: null, stop() { calls.stop++; this.target = null; } },
    // sol plein en y ≤ 63 ; sans ligne de vue : mur plein x=5 (y 64-66) entre le bot et le squelette
    blockAt: (v) => ({ boundingBox: (v.y <= 63 || (!los && v.x === 5 && v.y <= 66)) ? 'block' : 'empty',
      shapes: [[0, 0, 0, 1, 1, 1]] }),
    setControlState() {}, lookAt: async () => {}, activateItem() {}, deactivateItem() {},
    heldItem: null, usingHeldItem: false, food: 20,
    equip: async (it) => { calls.equips = (calls.equips || []).concat(it && it.name); bot.heldItem = it; },
    pathfinder: { goto: async () => {}, setGoal() {} },
  };
  const fb = createFightBreaker();
  const grant = fb.grant;
  fb.grant = (o) => { calls.grant.push(o); grant(o); };
  const events = [];
  const sb = {
    bot, IS_MAPPER: mapper, RANGED, isFleeHostile, Date, Math, Object, String, Number, Promise, setInterval, clearInterval, setTimeout,
    emit: (e) => events.push(e), isInWater: () => false,
    findCoverCell, decideSkeletonResponse, zigzagSide, shooterSees,
    armorPoints: () => 0, attackDamage: (b) => (b.inventory.items().some((i) => /sword|axe/.test(i.name)) ? 5 : 0),
    pickCoverBlock: (b) => b.inventory.items().find((i) => i.name === 'cobblestone') || null,
    takeCover: async () => { calls.cover++; return { ok: true, placed: 2, cells: ['placed', 'placed'] }; },
    coverWhy: () => ({}), bestWeapon: (b) => b.inventory.items().find((i) => /sword/.test(i.name)) || null,
    stopMotion: () => {}, withTimeout: (p) => p, pfGoals: { GoalBlock: function () {} }, vec3Lib: (x, y, z) => ({ x, y, z }),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    fleeFrom: () => { calls.flee++; return true; }, _fightBreaker: fb,
    rushStopReason, eatDuringRush, callerFromStack, rushRearmWanted, rushEquipBlocked, taskCtl, FOODS, EMERGENCY_FOODS,
    holdGoal: goalHold.hold, releaseGoalHold: goalHold.release, _creeperHold: goalHold.createHoldState(),
    lavaNearby: (b) => !!b._lavaNear,
    _escapeWaterRaw: async () => { calls.escapeWater = (calls.escapeWater || 0) + 1; return { ok: true }; },
    restartPlannerAfterFlee: async (tok, prev, ev) => { calls.restart.push([prev, ev]); return calls.restartImpl ? calls.restartImpl(tok, prev, ev) : true; },
    rushResumesPlanner,
  };
  vm.createContext(sb);
  vm.runInContext(`'use strict';
    ${['SKEL_HOLD_MS', 'SKEL_RUSH_MS', 'SKEL_COVER_GOTO_MS', 'SKEL_RANGE', 'SKEL_HURT_MS'].map(constSrc).join('\n')}
    let _skelBusy = false; let _skelHoldUntil = 0; let _skelHurtAt = -Infinity;
    let _skelRushBusy = false; let _skelRushBlocked = { stops: 0, by: null }; let _skelPlannerPending = false; let _skelRushOwesPlanner = false;
    let _skelHpDropAt = -Infinity; let _skelEatDeferredAt = -Infinity; let _skelRushYieldBy = null;
    let _skelRushWeapon = null; let _skelRushEquipBlockedAt = -Infinity;
    let _pvpAttackRaw = (t) => { rawCalls.push(t.name); bot.pvp.target = t; };
    ${NAMES.map(fnSrc).join('\n')}
    globalThis.api = { skeletonAwareFlee, skeletonFirstFlee, skeletonRespond, get busy() { return _skelBusy; },
      hurtNow() { _skelHurtAt = Date.now(); }, stopMotion, skeletonEquipAllowed,
      escapeWater, get rushing() { return _skelRushBusy; }, get owes() { return _skelRushOwesPlanner; }, setRushing(v) { _skelRushBusy = v; }, hpDropNow() { _skelHpDropAt = Date.now(); } };`,
  Object.assign(sb, { rawCalls: calls.raw }));
  return { bot, sb, events, calls };
}

test('squelette au contact, 9 PV, épée → RUSH (pvp d\'origine, disjoncteur suspendu), aucune fuite', async () => {
  const h = setup({ health: 9 });
  assert.strictEqual(h.sb.api.skeletonAwareFlee(h.bot, 'flee'), true);
  const ev = h.events.find((e) => e.type === 'skeleton_response');
  assert.strictEqual(ev.action, 'rush');
  assert.strictEqual(ev.los, true);
  assert.strictEqual(ev.dist, 2.8);
  assert.strictEqual(ev.hp, 9);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(h.calls.raw, ['skeleton']);
  assert.strictEqual(h.calls.flee, 0);
  assert.strictEqual(h.calls.grant.length, 1);
  // squelette mort → fin de charge propre
  delete h.bot.entities[7];
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(h.events.some((e) => e.type === 'skeleton_rush_done' && e.killed === true && e.endReason === 'killed'));
  assert.strictEqual(h.sb.api.busy, false);
});

test('squelette à 12 blocs, 8 PV, terrain plat, cobble → BLOCK (muret), aucune fuite', async () => {
  const h = setup({ health: 8, skel: { x: 12, y: 64, z: 0 } });
  assert.strictEqual(h.sb.api.skeletonFirstFlee(h.bot), true);
  assert.strictEqual(h.events.find((e) => e.type === 'skeleton_response').action, 'block');
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(h.calls.cover, 1);
  assert.strictEqual(h.calls.flee, 0);
});

test('zombie collé + squelette → la réponse squelette se retire (repli historique)', () => {
  const h = setup({ health: 9, skel: { x: 10, y: 64, z: 0 }, zombie: { x: 1.5, y: 64, z: 0 } });
  assert.strictEqual(h.sb.api.skeletonAwareFlee(h.bot, 'flee'), false);
  assert.ok(!h.events.some((e) => e.type === 'skeleton_response'));
  assert.strictEqual(h.sb.api.skeletonFirstFlee(h.bot), true, 'skeletonFirstFlee retombe sur fleeFrom');
  assert.strictEqual(h.calls.flee, 1);
});

test('cartographe → jamais concerné (fuite par défaut conservée)', () => {
  const h = setup({ mapper: true });
  assert.strictEqual(h.sb.api.skeletonAwareFlee(h.bot, 'flee'), false);
});

test('sans ligne de vue → cover/no_los : on s\'arrête et on tient, puis les appels suivants « hold »', async () => {
  const h = setup({ health: 6, skel: { x: 10, y: 64, z: 0 }, los: false });
  assert.strictEqual(h.sb.api.skeletonAwareFlee(h.bot, 'flee'), true);
  const ev = h.events.find((e) => e.type === 'skeleton_response');
  assert.strictEqual(ev.action, 'cover');
  assert.strictEqual(ev.reason, 'no_los');
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(h.sb.api.skeletonRespond(null, 'survival').action, 'hold');
  assert.strictEqual(h.calls.flee, 0);
});

test('aucun squelette → false (les fuites ordinaires sont intactes)', () => {
  const h = setup({ skel: null });
  assert.strictEqual(h.sb.api.skeletonAwareFlee(h.bot, 'flee'), false);
});

test('live 23/10 : squelette à 2 blocs, 2,5 PV, derrière un muret → RUSH contact (plus jamais cover/no_los)', async () => {
  const h = setup({ health: 2.5, skel: { x: 2, y: 64, z: 0 }, los: false });
  assert.strictEqual(h.sb.api.skeletonAwareFlee(h.bot, 'survival'), true);
  const ev = h.events.find((e) => e.type === 'skeleton_response');
  assert.strictEqual(ev.action, 'rush');
  assert.strictEqual(ev.reason, 'contact');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(h.calls.raw, ['skeleton']);
});

test('« caché » mais une flèche vient de toucher → recalculé : ni no_los ni hold', async () => {
  const h = setup({ health: 8, skel: { x: 10, y: 64, z: 0 }, los: false });
  h.sb.api.hurtNow();
  h.sb.api.skeletonAwareFlee(h.bot, 'survival');
  const ev = h.events.find((e) => e.type === 'skeleton_response');
  assert.strictEqual(ev.hurt, true);
  assert.notStrictEqual(ev.reason, 'no_los');
});

test('ligne de vue calculée depuis l\'ŒIL du squelette sur le monde réel : terrain plat → los:true', () => {
  const h = setup({ health: 6, skel: { x: 10, y: 64, z: 0 }, los: true });
  h.sb.api.skeletonAwareFlee(h.bot, 'flee');
  assert.strictEqual(h.events.find((e) => e.type === 'skeleton_response').los, true);
});

const tick = (ms) => new Promise((r) => setTimeout(r, ms));
async function rushing(h) {
  h.sb.api.skeletonAwareFlee(h.bot, 'flee');
  for (let i = 0; i < 40 && !(h.sb.api.rushing && h.bot.pvp.target); i++) await tick(2);
  assert.strictEqual(h.sb.api.rushing, true, 'la charge a démarré');
}
const done = (h) => h.events.find((e) => e.type === 'skeleton_rush_done');

test('charge : préempte le planner, puis le relance (skeleton_rush_planner_restart)', async () => {
  const h = setup({ health: 12, prevTask: 'autonomous' });
  await rushing(h);
  assert.strictEqual(h.sb.taskCtl.active, 'skeleton_rush');
  delete h.bot.entities[7];
  await tick(40);
  assert.strictEqual(done(h).endReason, 'killed');
  assert.deepStrictEqual(h.calls.restart.map((r) => r.join('/')), ['autonomous/skeleton_rush_planner_restart']);
});

test('live 24/10 (NethBot1 s599) : 2e charge 200 ms après la 1re, pendant que la 1re attend de relancer → la 2e HÉRITE de la dette et relance le planner', async () => {
  const h = setup({ health: 12, prevTask: 'autonomous' });
  // la relance de la 1re attend le skill du planner (cave_stair) : elle ne rend la main qu'une fois son jeton annulé
  let firstWait = null;
  h.calls.restartImpl = (tok) => {
    if (!firstWait) { firstWait = new Promise((res) => { const iv = setInterval(() => { if (tok.cancelled) { clearInterval(iv); res(false); } }, 1); }); return firstWait; }
    return true;
  };
  await rushing(h);
  delete h.bot.entities[7];
  await tick(40);
  assert.strictEqual(done(h).endReason, 'killed');
  assert.strictEqual(h.sb.taskCtl.active, 'skeleton_rush', 'la 1re garde la main pendant que sa relance attend');
  assert.strictEqual(h.sb.api.owes, true);
  // 2e squelette (riposte) : nouvelle charge, prevTask = 'skeleton_rush'
  h.bot.entities[9] = { id: 9, name: 'skeleton', type: 'hostile', kind: 'Hostile mobs', position: Object.assign({ offset: () => ({}) }, { x: 1.9, y: 64, z: 0 }) };
  h.bot.pvp.target = null;
  await rushing(h);
  assert.ok(h.events.some((e) => e.type === 'skeleton_rush_chained' && e.owes === true), 'chaînage tracé');
  assert.strictEqual(await firstWait, false, 'la relance de la 1re est préemptée');
  delete h.bot.entities[9];
  await tick(40);
  assert.strictEqual(h.events.filter((e) => e.type === 'skeleton_rush_done').length, 2);
  assert.deepStrictEqual(h.calls.restart.map((r) => r.join('/')),
    ['autonomous/skeleton_rush_planner_restart', 'autonomous/skeleton_rush_planner_restart'],
    'la 2e charge relance le planner (avant : taskCtl.cancel(), planner mort 18 min)');
});

test('charge sans planner coupé (prevTask null) → pas de dette, taskCtl rendu', async () => {
  const h = setup({ health: 12 });
  await rushing(h);
  delete h.bot.entities[7];
  await tick(40);
  assert.deepStrictEqual(h.calls.restart, []);
  assert.strictEqual(h.sb.api.owes, false);
  assert.strictEqual(h.sb.taskCtl.active, null);
});

test('charge : stopMotion d\'un skill/timer est REFUSÉ pendant la charge et compté (blocked_by)', async () => {
  const h = setup({ health: 12 });
  await rushing(h);
  function runSkillPourDeVrai() { h.sb.api.stopMotion(); }
  runSkillPourDeVrai();
  assert.ok(h.bot.pvp.target, 'le combat continue');
  delete h.bot.entities[7];
  await tick(40);
  const d = done(h);
  assert.strictEqual(d.blocked_stops, 1);
  assert.strictEqual(d.blocked_by, 'runSkillPourDeVrai');
});

test('charge : un pvp.stop étranger → endReason target_lost, by = l\'appelant', async () => {
  const h = setup({ health: 12 });
  await rushing(h);
  function quelquUnDAutre() { h.bot.pvp.stop(); }
  quelquUnDAutre();
  await tick(300);
  const d = done(h);
  assert.strictEqual(d.endReason, 'target_lost');
  assert.strictEqual(d.by, 'quelquUnDAutre');
});

test('charge : un autre maître prend le jeton → endReason preempted, by = son nom', async () => {
  const h = setup({ health: 12 });
  await rushing(h);
  h.sb.taskCtl.begin('migration', () => {});
  await tick(300);
  const d = done(h);
  assert.strictEqual(d.endReason, 'preempted');
  assert.strictEqual(d.by, 'migration');
  assert.strictEqual(h.calls.restart.length, 0, 'on ne relance pas le planner par-dessus un autre maître');
});

test('charge : épée rengainée (repas permis, equip étranger) → rééquipée', async () => {
  const h = setup({ health: 12 });
  await rushing(h);
  h.bot.heldItem = { name: 'cooked_beef' };
  await tick(300);
  delete h.bot.entities[7];
  await tick(40);
  assert.ok((done(h).rearmed || 0) >= 1);
  assert.strictEqual(h.bot.heldItem.name, 'stone_sword');
});

test('verrou de repas : en charge, faim 14 → différé (eat_deferred) ; faim 5 et PV stables → permis ; arme jamais bloquée', () => {
  const h = setup({ health: 12, skel: null });
  h.sb.api.setRushing(true);
  h.bot.food = 14;
  assert.strictEqual(h.sb.api.skeletonEquipAllowed({ name: 'cooked_beef' }, 'hand'), false);
  assert.ok(h.events.some((e) => e.type === 'eat_deferred' && e.why === 'skeleton_rush'));
  h.bot.food = 5;
  assert.strictEqual(h.sb.api.skeletonEquipAllowed({ name: 'cooked_beef' }, 'hand'), true);
  h.sb.api.hpDropNow();
  assert.strictEqual(h.sb.api.skeletonEquipAllowed({ name: 'rotten_flesh' }, 'hand'), false, 'PV en baisse : l\'épée reste');
  assert.strictEqual(h.sb.api.skeletonEquipAllowed({ name: 'stone_sword' }, 'hand'), true);
  h.sb.api.setRushing(false);
  h.bot.food = 14;
  assert.strictEqual(h.sb.api.skeletonEquipAllowed({ name: 'cooked_beef' }, 'hand'), true, 'hors charge : inchangé');
});

test('charge : un zombie se colle → la charge cède (preempted, by melee_mix) et stopMotion redevient libre', async () => {
  const h = setup({ health: 12 });
  await rushing(h);
  h.bot.entities[8] = { id: 8, name: 'zombie', type: 'hostile', kind: 'Hostile mobs', position: { x: 1, y: 64, z: 0 } };
  await tick(300);
  const d = done(h);
  assert.strictEqual(d.endReason, 'preempted');
  assert.strictEqual(d.by, 'melee_mix');
  assert.strictEqual(h.sb.api.rushing, false);
});

test('VITAL — noyade : escapeWater pendant une charge l\'annule (preempted, by escape_water) puis nage', async () => {
  const h = setup({ health: 12 });
  await rushing(h);
  await h.sb.api.escapeWater(h.bot, {});
  assert.strictEqual(h.sb.api.rushing, false, 'la garde tombe AVANT la nage (stopMotion redevient libre)');
  assert.strictEqual(h.calls.escapeWater, 1);
  await tick(300);
  const d = done(h);
  assert.strictEqual(d.endReason, 'preempted');
  assert.strictEqual(d.by, 'escape_water');
});

test('VITAL — lave : le bot entre dans la lave en pleine charge → preempted by lava ; plus de réponse squelette dans la lave', async () => {
  const h = setup({ health: 12 });
  await rushing(h);
  h.bot.entity.isInLava = true;
  await tick(300);
  const d = done(h);
  assert.strictEqual(d.endReason, 'preempted');
  assert.strictEqual(d.by, 'lava');
  assert.strictEqual(h.sb.api.skeletonAwareFlee(h.bot, 'flee'), false, 'la fuite de lave historique garde la main');
});

test('VITAL — lave proche (lavaNearby) : aucune réponse squelette, la fuite de survie passe', () => {
  const h = setup({ health: 12 });
  h.bot._lavaNear = true;
  assert.strictEqual(h.sb.api.skeletonAwareFlee(h.bot, 'flee'), false);
});

test('VITAL — stopMotion({force, vital}) (mur de panique, sortie imminente) traverse et annule la charge', async () => {
  const h = setup({ health: 12 });
  await rushing(h);
  h.sb.api.stopMotion({ force: true, vital: 'panic_wall' });
  assert.strictEqual(h.bot.pvp.target, null, 'le combat est coupé');
  await tick(300);
  const d = done(h);
  assert.strictEqual(d.endReason, 'preempted');
  assert.strictEqual(d.by, 'panic_wall');
});

test('charge (24/10, `rearmed: 13`) : un AUTRE timer ne peut pas mettre pioche/torche en main ; blocs et arme passent', () => {
  const h = setup({ health: 12 });
  h.sb.api.setRushing(true);
  assert.strictEqual(h.sb.api.skeletonEquipAllowed({ name: 'iron_pickaxe' }, 'hand'), false);
  assert.strictEqual(h.sb.api.skeletonEquipAllowed({ name: 'torch' }, 'hand'), false);
  assert.strictEqual(h.sb.api.skeletonEquipAllowed({ name: 'cobblestone' }, 'hand'), true, 'mur de survie');
  assert.strictEqual(h.sb.api.skeletonEquipAllowed({ name: 'stone_sword' }, 'hand'), true);
  assert.ok(h.events.some((e) => e.type === 'rush_equip_blocked' && e.item === 'iron_pickaxe'));
  h.sb.api.setRushing(false);
  assert.strictEqual(h.sb.api.skeletonEquipAllowed({ name: 'iron_pickaxe' }, 'hand'), true, 'hors charge : libre');
});
