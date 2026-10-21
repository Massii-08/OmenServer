'use strict';
// CÂBLAGE du lit (20/10) dans index.js. La logique pure est testée dans bed.test.js ; ici on exécute le
// VRAI texte des fonctions de index.js dans un bac à sable `vm` strict (même technique que
// index.dawnwait.test.js) : un identifiant oublié lève une ReferenceError au lieu de rendre la
// fonctionnalité morte en silence (piège #61).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const B = require('./bed');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(re, label) {
  const m = SRC.match(re);
  assert.ok(m, `${label} introuvable dans index.js (déplacé, renommé, ou déclaré hors niveau module ?)`);
  return m[0];
}
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);
const run = (sb, code) => vm.runInContext("'use strict';\n" + code, sb);

class V { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
  distanceTo(o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z); } }

/** Monde jouet : sol plein à y=63, air au-dessus ; `blocks` = surcharges { "x,y,z": name }. */
function makeBot({ pos = new V(0.5, 64, 0.5), entities = [], inv = {}, night = false } = {}) {
  const blocks = {};
  const bot = {
    entity: { position: pos },
    time: { timeOfDay: night ? 18000 : 6000 },
    isSleeping: false,
    _inv: Object.assign({}, inv),
    placed: [], slept: 0, activated: 0, listeners: {},
    inventory: { items: () => Object.entries(bot._inv).filter(([, c]) => c > 0).map(([name, count]) => ({ name, count })) },
    nearestEntity: (f) => entities.filter(f).sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))[0] || null,
    blockAt: (v) => {
      const k = `${v.x},${v.y},${v.z}`;
      if (k in blocks) return { name: blocks[k], boundingBox: blocks[k] === 'air' || blocks[k].endsWith('_bed') ? 'empty' : 'block', position: v };
      return v.y <= 63 ? { name: 'grass_block', boundingBox: 'block', position: v } : { name: 'air', boundingBox: 'empty', position: v };
    },
    equip: async () => {},
    placeBlock: async (ref) => { const n = Object.keys(bot._inv).find((x) => x.endsWith('_bed') && bot._inv[x] > 0);
      bot._inv[n]--; blocks[`${ref.position.x},${ref.position.y + 1},${ref.position.z}`] = n; bot.placed.push(ref.position); },
    activateBlock: async () => { bot.activated++; },
    sleep: async () => { bot.slept++; bot.isSleeping = true; },
    wake: async () => { bot.isSleeping = false; },
    once: (ev, f) => { bot.listeners[ev] = f; },
    removeListener: (ev) => { delete bot.listeners[ev]; },
    pathfinder: { goto: async () => {} },
    _blocks: blocks,
  };
  return bot;
}

function sandbox(bot, extra = {}) {
  const sb = {
    bot, events: [], memo: {}, now: 1_700_000_000_000,
    emit(e) { sb.events.push(e); },
    loadBaseState() { return sb.memo; },
    saveBaseState(m) { sb.memo = m; return true; },
    Date: { now: () => sb.now },
    sleep: async (ms) => { sb.now += ms || 0; },   // l'horloge avance : aucune boucle d'attente infinie
    withTimeout: (p) => p,
    stopMotion() {},
    pfGoals: { GoalNear: function GoalNear() {} },
    vec3Lib: { Vec3: V },
    isNight: (b) => b.time.timeOfDay >= 13000,
    buildCtxInv: (b) => Object.assign({}, b._inv),
    taskToken: { cancelled: false },
    nightLockdownNow: () => sb.lockdown === true,   // 21/10 : but `bed` sauté la nuit (bot nu)
    homewarp: { goHome() { return false; } }, HOME_SAFE: 'safe', _safeHomeSet: false,
    awaitWarp: async () => ({ warped: false }),
    huntPassive: async () => ({ ok: false, kills: 0 }),
    craftSmart: async () => ({ ok: false, reason: 'no_recipe' }),
    _bedLastSheep: null, _bedLastMsg: null, _bedSleeping: false,
    BED_SHEEP_HUNT_RADIUS: 48, BED_HOME_NEAR: 48, BED_SPAWN_MSG_WAIT_MS: 2500, BED_SLEEP_MAX_MS: 13 * 60 * 1000,
    ...B,
    ...extra,
  };
  vm.createContext(sb);
  for (const f of ['bedCtxNow', 'bedFail', 'noteBedMissing', 'onBedMessage', 'setSpawnAtBed', 'placeBedNear', 'ensureBedGoal', 'trySleepInBedTonight']) run(sb, fnSrc(f));
  return sb;
}

const sheep = (x, z) => ({ name: 'sheep', position: new V(x, 64, z), isValid: true });

test('bedCtxNow : mouton vu → sheepNear et mémorisé ; plus vu mais récent et proche → toujours connu', () => {
  const bot = makeBot({ entities: [sheep(10, 0)] });
  const sb = sandbox(bot);
  assert.strictEqual(sb.bedCtxNow().sheepNear, true);
  assert.ok(sb._bedLastSheep && sb._bedLastSheep.x === 10);
  bot.nearestEntity = () => null;
  sb.now += 60000;
  assert.strictEqual(sb.bedCtxNow().sheepNear, true, 'vu il y a 1 min à 10 blocs');
  sb.now += 11 * 60000;
  assert.strictEqual(sb.bedCtxNow().sheepNear, false, 'trop vieux');
});

test('bedCtxNow : lit posé et essai raté lus dans le MÉMO DE BASE (survivent au respawn)', () => {
  const sb = sandbox(makeBot());
  assert.deepStrictEqual({ ...sb.bedCtxNow() }, { bedPlaced: false, bedRetryLater: false, nightLockdown: false, sheepNear: false });
  sb.lockdown = true;
  assert.strictEqual(sb.bedCtxNow().nightLockdown, true);
  sb.lockdown = false;
  sb.memo = B.bedRetryMemo({ base: { x: 0, y: 64, z: 0 } }, sb.now);
  assert.strictEqual(sb.bedCtxNow().bedRetryLater, true);
  sb.memo = B.bedMemoWith(sb.memo, { x: 1, y: 64, z: 0 }, sb.now);
  const c = sb.bedCtxNow();
  assert.strictEqual(c.bedPlaced, true);
  assert.strictEqual(c.bedRetryLater, false, 'un lit posé efface le retry');
});

test('ensureBedGoal : chasse 3 moutons → craft → pose → mémo → réapparition fixée (clic)', async () => {
  const bot = makeBot({ inv: { oak_planks: 3 } });
  const sb = sandbox(bot, {
    huntPassive: async (b, opts) => { assert.deepStrictEqual([...opts.names], ['sheep']); b._inv.white_wool = (b._inv.white_wool || 0) + 1; return { ok: true, kills: 1 }; },
    craftSmart: async (a) => { assert.strictEqual(a.name, 'white_bed'); bot._inv.white_wool -= 3; bot._inv.white_bed = 1; return { ok: true }; },
  });
  sb.memo = { base: { x: 0, y: 64, z: 0 }, zone: { keep: 1 } };
  bot.activateBlock = async () => { bot.activated++; sb.onBedMessage('Respawn point set'); };
  const r = await sb.ensureBedGoal();
  assert.strictEqual(r.ok, true);
  const types = sb.events.map((e) => e.type);
  assert.ok(types.includes('bed_crafted'));
  const placed = sb.events.find((e) => e.type === 'bed_placed');
  assert.ok(placed && Number.isFinite(placed.x));
  assert.strictEqual(bot.activated, 1);
  const ss = sb.events.find((e) => e.type === 'spawn_set');
  assert.strictEqual(ss.how, 'activate');
  assert.strictEqual(ss.confirmed, true);
  assert.ok(B.bedOf(sb.memo), 'position du lit persistée');
  assert.deepStrictEqual(sb.memo.zone, { keep: 1 }, 'le mémo est FUSIONNÉ');
});

test('ensureBedGoal : aucun mouton tué → échec + nouvel essai dans 10 min (but sauté d\'ici là)', async () => {
  const sb = sandbox(makeBot({ inv: { oak_planks: 3 } }));
  const r = await sb.ensureBedGoal();
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /no_wool/);
  assert.strictEqual(B.bedRetryActive(sb.memo, sb.now + 1000), true);
  assert.ok(sb.events.some((e) => e.type === 'bed_failed'));
});

test('ensureBedGoal : lit déjà en poche → pas de chasse ni de craft, seulement la pose', async () => {
  const bot = makeBot({ inv: { red_bed: 1 } });
  let hunted = 0; let crafted = 0;
  const sb = sandbox(bot, { huntPassive: async () => { hunted++; return { kills: 0 }; }, craftSmart: async () => { crafted++; return { ok: true }; } });
  const r = await sb.ensureBedGoal();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(hunted + crafted, 0);
  assert.ok(bot.placed.length === 1);
});

test('ensureBedGoal : loin de la base → /home safe avant de poser', async () => {
  const bot = makeBot({ inv: { white_bed: 1 } });
  const homes = [];
  const sb = sandbox(bot, { _safeHomeSet: true, homewarp: { goHome(b, n, o) { homes.push([n, o && o.ctx]); return n; } } });
  sb.memo = { base: { x: 300, y: 64, z: 0 } };
  await sb.ensureBedGoal();
  assert.deepStrictEqual(homes, [['safe', 'bed']]);
});

test('onBedMessage : « no home bed » → le lit mémorisé est oublié (bed_missing) ; message de joueur ignoré', () => {
  const sb = sandbox(makeBot());
  sb.memo = B.bedMemoWith({ base: {} }, { x: 1, y: 64, z: 0 }, sb.now);
  assert.strictEqual(sb.onBedMessage('<Bob> salut'), null);
  assert.strictEqual(sb.onBedMessage('You have no home bed or charged respawn anchor, or it was obstructed'), 'spawn_missing');
  assert.strictEqual(B.bedOf(sb.memo), null);
  assert.ok(sb.events.some((e) => e.type === 'bed_missing' && e.why === 'server_message'));
  assert.ok(sb.events.some((e) => e.type === 'bed_msg' && e.kind === 'spawn_missing'), 'tracé pour confirmer le texte en live');
});

function bedSandbox({ night = true, sleepImpl, bedName = 'white_bed', pos } = {}) {
  const bot = makeBot({ night, pos });
  bot._blocks['5,64,0'] = bedName;
  if (sleepImpl) bot.sleep = sleepImpl(bot);
  const sb = sandbox(bot);
  sb.memo = B.bedMemoWith({}, { x: 5, y: 64, z: 0 }, sb.now);
  return { bot, sb };
}

test('trySleepInBedTonight : nuit + lit à ≤ 16 blocs → couché, réveil de JOUR → true', async () => {
  const { bot, sb } = bedSandbox({ sleepImpl: (b) => async () => {
    b.slept++; b.isSleeping = true;
    setImmediate(() => { b.time.timeOfDay = 0; b.isSleeping = false; if (b.listeners.wake) b.listeners.wake(); });
  } });
  sb.sleep = (ms) => new Promise((r) => { sb.now += ms || 0; setImmediate(r); });
  assert.strictEqual(await sb.trySleepInBedTonight(sb.taskToken), true);
  assert.strictEqual(bot.slept, 1);
  assert.ok(sb.events.some((e) => e.type === 'bed_sleep' && e.ok === true && e.why === 'asleep'));
  assert.ok(sb.events.some((e) => e.type === 'spawn_set' && e.how === 'sleep'));
  assert.ok(sb.events.some((e) => e.type === 'bed_sleep' && e.why === 'dawn'));
  assert.strictEqual(sb._bedSleeping, false);
});

test('trySleepInBedTonight : « monstres à proximité » → false (l\'abri historique prend le relais)', async () => {
  const { sb } = bedSandbox({ sleepImpl: () => async () => { throw new Error('there are monsters nearby'); } });
  assert.strictEqual(await sb.trySleepInBedTonight(sb.taskToken), false);
  assert.ok(sb.events.some((e) => e.type === 'bed_sleep' && e.ok === false && e.why === 'monsters'));
});

test('trySleepInBedTonight : réveillé en pleine nuit (coup reçu) → false', async () => {
  const { sb } = bedSandbox({ sleepImpl: (b) => async () => {
    b.isSleeping = true; setImmediate(() => { b.isSleeping = false; });
  } });
  sb.sleep = (ms) => new Promise((r) => { sb.now += ms || 0; setImmediate(r); });
  assert.strictEqual(await sb.trySleepInBedTonight(sb.taskToken), false);
  assert.ok(sb.events.some((e) => e.type === 'bed_sleep' && e.why === 'woken_at_night'));
});

test('trySleepInBedTonight : de jour, trop loin, ou lit DÉTRUIT → false sans dormir ; détruit → bed_missing', async () => {
  let { bot, sb } = bedSandbox({ night: false });
  assert.strictEqual(await sb.trySleepInBedTonight(sb.taskToken), false);
  assert.strictEqual(bot.slept, 0);
  ({ bot, sb } = bedSandbox({ pos: new V(60, 64, 0) }));
  assert.strictEqual(await sb.trySleepInBedTonight(sb.taskToken), false);
  assert.strictEqual(bot.slept, 0);
  ({ bot, sb } = bedSandbox({ bedName: 'air' }));
  assert.strictEqual(await sb.trySleepInBedTonight(sb.taskToken), false);
  assert.strictEqual(B.bedOf(sb.memo), null);
  assert.ok(sb.events.some((e) => e.type === 'bed_missing' && e.why === 'block_gone'));
});

test('index.js : le lit est BRANCHÉ (abri de nuit, planner, ctxExtra, messages serveur)', () => {
  const shelter = fnSrc('maybeNightShelter');
  const iSleep = shelter.indexOf('trySleepInBedTonight(taskToken)');
  assert.ok(iSleep > 0, 'maybeNightShelter ne tente jamais le lit');
  assert.ok(iSleep < shelter.indexOf('shelterUntilDawn(bot'), 'le lit AVANT le trou');
  assert.match(fnSrc('ctxExtra'), /bedCtxNow\(\)/);
  assert.match(fnSrc('ctxExtra'), /\.\.\.bedCtx,/);
  assert.match(fnSrc('runGoalSkill'), /if \(goal\.skill === 'ensureBed'\) return ensureBedGoal\(\);/);
  assert.match(SRC, /bot\.on\('messagestr', \(msg\) => \{ try \{ onBedMessage\(msg\); \}/);
  assert.match(SRC, /ensureBed: 240000/);
  // niveau MODULE (piège #56) : lus par ctxExtra, le handler messagestr et l'abri de nuit
  for (const v of ['_bedLastSheep', '_bedLastMsg', '_bedSleeping']) assert.match(SRC, new RegExp(`^let ${v} = `, 'm'), v);
});

test('ensureBedGoal : chasse BORNÉE dans le temps (21/10) — 60 s par mouton sans laine → arrêt après 90 s, no_wool', async () => {
  const bot = makeBot({ inv: { oak_planks: 3 } });
  let hunts = 0;
  const sb = sandbox(bot, { huntPassive: async () => { hunts++; sb.now += 60000; return { ok: true, kills: 1 }; } });
  const r = await sb.ensureBedGoal();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'bed:no_wool');
  assert.strictEqual(hunts, 2, '2 chasses (120 s > budget 90 s) au lieu de 6');
});
