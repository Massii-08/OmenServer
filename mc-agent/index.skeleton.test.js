'use strict';
// Câblage index.js de la réponse au squelette (22/10). Sandbox vm : fonctions de NIVEAU MODULE extraites
// (piège #56), exécutées sur un faux bot. Mesure live d'origine : `aura_hit {skeleton, dist:2.8}` →
// `fight_refused low_hp` → `reflex flee` → « shot by Skeleton ».
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { decideSkeletonResponse, findCoverCell, zigzagSide } = require('./skeletonResponse');
const { RANGED } = require('./reflexes');
const { isFleeHostile } = require('./skills/fleeFrom');
const { createFightBreaker } = require('./fightBreaker');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(re, label) {
  const m = SRC.match(re);
  assert.ok(m, `${label} introuvable dans index.js`);
  return m[0];
}
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);
const constSrc = (name) => grab(new RegExp(`^const ${name} = [^;]+;`, 'm'), `const ${name}`);
const NAMES = ['skeletonSituation', '_skelWeapon', '_skelShield', '_skelShieldUp', '_skelRush', '_skelCover',
  'skeletonRespond', 'skeletonAwareFlee', 'skeletonFirstFlee'];

function setup({ health = 9, skel = { x: 2.8, y: 64, z: 0 }, zombie = null, items = null, los = true, mapper = false } = {}) {
  const ents = {};
  const s = skel && { id: 7, name: 'skeleton', type: 'hostile', kind: 'Hostile mobs', position: Object.assign({ offset: () => ({}) }, skel) };
  if (s) ents[7] = s;
  if (zombie) ents[8] = { id: 8, name: 'zombie', type: 'hostile', kind: 'Hostile mobs', position: zombie };
  const calls = { raw: [], flee: 0, cover: 0, grant: [], stop: 0 };
  const bot = {
    health, entity: { position: { x: 0, y: 64, z: 0 }, onGround: true }, entities: ents,
    inventory: { items: () => items || [{ name: 'stone_sword', count: 1 }, { name: 'cobblestone', count: 32 }], slots: [] },
    pvp: { target: null, stop() { calls.stop++; this.target = null; } },
    blockAt: (v) => ({ boundingBox: v.y <= 63 ? 'block' : 'empty' }),
    setControlState() {}, equip: async () => {}, lookAt: async () => {}, activateItem() {}, deactivateItem() {},
    pathfinder: { goto: async () => {}, setGoal() {} },
  };
  const fb = createFightBreaker();
  const grant = fb.grant;
  fb.grant = (o) => { calls.grant.push(o); grant(o); };
  const events = [];
  const sb = {
    bot, IS_MAPPER: mapper, RANGED, isFleeHostile, Date, Math, Object, String, Number, Promise, setInterval, clearInterval, setTimeout,
    emit: (e) => events.push(e), canSeeEntityNow: () => los, isInWater: () => false,
    findCoverCell, decideSkeletonResponse, zigzagSide,
    armorPoints: () => 0, attackDamage: (b) => (b.inventory.items().some((i) => /sword|axe/.test(i.name)) ? 5 : 0),
    pickCoverBlock: (b) => b.inventory.items().find((i) => i.name === 'cobblestone') || null,
    takeCover: async () => { calls.cover++; return { ok: true, placed: 2, cells: ['placed', 'placed'] }; },
    coverWhy: () => ({}), bestWeapon: (b) => b.inventory.items().find((i) => /sword/.test(i.name)) || null,
    stopMotion: () => {}, withTimeout: (p) => p, pfGoals: { GoalBlock: function () {} }, vec3Lib: (x, y, z) => ({ x, y, z }),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    fleeFrom: () => { calls.flee++; return true; }, _fightBreaker: fb,
  };
  vm.createContext(sb);
  vm.runInContext(`'use strict';
    ${['SKEL_HOLD_MS', 'SKEL_RUSH_MS', 'SKEL_COVER_GOTO_MS', 'SKEL_RANGE'].map(constSrc).join('\n')}
    let _skelBusy = false; let _skelHoldUntil = 0;
    let _pvpAttackRaw = (t) => { rawCalls.push(t.name); bot.pvp.target = t; };
    ${NAMES.map(fnSrc).join('\n')}
    globalThis.api = { skeletonAwareFlee, skeletonFirstFlee, skeletonRespond, get busy() { return _skelBusy; } };`,
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
  assert.ok(h.events.some((e) => e.type === 'skeleton_rush_done' && e.killed === true));
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
