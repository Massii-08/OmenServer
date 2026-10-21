'use strict';
// CÂBLAGE des 3 correctifs du run 20/10 (enderman, faim sous terre, boucle drop_ahead).
// La logique est dans enderman.js / foodGate.js / dropAhead.js ; ici on EXÉCUTE le vrai texte des
// fonctions de index.js dans un bac à sable `vm` strict : un identifiant lu hors niveau module
// (piège #56) → ReferenceError ici, pas en prod.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const E = require('./enderman');
const G = require('./foodGate');
const D = require('./dropAhead');
const S = require('./survival');
const { fleeTarget } = require('./skills/fleeFrom');

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
const flush = () => new Promise((r) => setImmediate(r));

function goalCtor(kind) {
  return function (...a) { this.kind = kind; this.a = a; };
}

function sandbox(o = {}) {
  const clock = o.clock || { t: 1_800_000_000_000 };
  const sb = {
    events: [], calls: [], clock, base: o.base || {},
    emit(e) { sb.events.push(e); },
    Date: { now: () => clock.t },
    Object, Math, Number, Array, JSON, Promise,
    bot: {
      health: o.health != null ? o.health : 20,
      food: o.food != null ? o.food : 20,
      entity: { position: Object.assign({ x: 0, y: 70, z: 0 }, o.pos || {}), yaw: o.yaw || 0, pitch: o.pitch || 0, eyeHeight: 1.62 },
      entities: Object.fromEntries((o.entities || []).map((e, i) => [i, e])),
      registry: require('minecraft-data')('1.21.4'),
      inventory: { items: () => (o.items || []).map((name) => ({ name, count: 1 })) },
      pvp: { target: null, attack: (e) => { sb.calls.push('attack:' + e.name); sb.bot.pvp.target = e; } },
      equip: (it) => { sb.calls.push('equip:' + it.name); return Promise.resolve(); },
      look: async (y, p, f) => { sb.calls.push(['look', Math.round(y * 100) / 100, Math.round(p * 100) / 100, !!f]); },
      findBlock: () => o.water || null,
      pathfinder: {
        setGoal: (g) => sb.calls.push(['goal', g.kind]),
        goto: async (g) => { sb.calls.push(['goto', g.kind, ...g.a.map((v) => Math.round(v))]); },
      },
    },
    pfGoals: { GoalNearXZ: goalCtor('xz'), GoalNear: goalCtor('near') },
    bestWeapon: () => null,
    withTimeout: (p) => p,
    stopMotion: () => {},
    loadBaseState: () => sb.base,
    saveBaseState: (st) => { sb.base = st; sb.calls.push('save'); return true; },
    buildCtxInv: () => ({}),
    foodPoints: () => (o.points != null ? o.points : 0),
    // modules purs réels
    lookIsUnsafe: E.lookIsUnsafe, safeLook: E.safeLook, wrapLook: E.wrapLook, creepyIndex: E.creepyIndex,
    isAngryEnderman: E.isAngryEnderman, endermanResponse: E.endermanResponse,
    angerReason: E.angerReason, hurtCulprit: E.hurtCulprit,
    IS_MAPPER: !!o.mapper, SCAFFOLD: ['dirt', 'cobblestone'], setTimeout,
    secureSpot: async (b, tactic) => { sb.calls.push('seal:' + tactic); return o.sealResult || { ok: true, tactic, placed: 4 }; },
    canDealWith: S.canDealWith, attackDamage: S.attackDamage, boldFightAdvised: S.boldFightAdvised,
    armorPoints: () => (o.armor || 0), fleeTarget,
    descentFoodGate: G.descentFoodGate, foodGateLoad: G.foodGateLoad,
    noteDropAhead: D.noteDropAhead, turnYaw: D.turnYaw, shiftTarget: D.shiftTarget,
    _imminentBusy: false, panicInFlight: false,
  };
  vm.createContext(sb);
  for (const c of ['ENDER_EVENT_EVERY_MS', 'ENDER_SCAN_RADIUS', 'ENDER_ACT_MS', 'ENDER_HOLD_MS', 'DESCEND_HEADING_TTL_MS']) run(sb, constSrc(c));
  for (const l of ['_enderBusy', '_enderBusyUntil', '_enderEvAt', '_enderCreepyIdx', '_enderHurtAt', '_enderHurtId', '_enderHoldUntil',
    '_dropSites', '_dropShiftSeed', '_descendHeading', '_foodGateEvAt']) run(sb, letSrc(l));
  for (const f of ['_enderEmit', 'enderEye', 'installEndermanGuard', 'endermanTick', 'noteEndermanHurt', 'endermanHoldWait',
    'descentFoodGateCheck', 'onDropAhead', 'applyDescendHeading']) run(sb, fnSrc(f));
  return sb;
}
const md = (creepy) => { const a = []; a[17] = creepy; return a; };
const ender = (x, z, extra = {}) => Object.assign({ id: 7, name: 'enderman', kind: 'Hostile mobs', position: { x, y: 70, z } }, extra);

// ── 1. ENDERMAN ──────────────────────────────────────────────────────────────────────────────
test('installEndermanGuard : bot.look enveloppé → pitch abaissé face à un enderman + enderman_look_avoided', async () => {
  const sb = sandbox({ entities: [ender(0, -15)] });
  run(sb, 'installEndermanGuard()');
  await run(sb, 'bot.look(0, 0, false)');
  const l = sb.calls.find((c) => c[0] === 'look');
  assert.ok(l && l[2] < 0, 'regarde le sol au lieu de la tête');
  assert.ok(sb.events.some((e) => e.type === 'enderman_look_avoided'));
});

test('endermanTick : regard fixe sur la tête (aucune visée en cours) → corrigé', async () => {
  const sb = sandbox({ entities: [ender(0, -15, { metadata: md(false) })] });
  run(sb, 'installEndermanGuard()');
  await run(sb, 'endermanTick()');
  const l = sb.calls.find((c) => c[0] === 'look');
  assert.ok(l && l[2] < 0);
  assert.ok(!sb.calls.some((c) => c[0] === 'goal'), 'calme : pas de fuite');
});

test('endermanTick : enderman en colère, eau à 4 blocs → va dans l\'eau', async () => {
  const sb = sandbox({ entities: [ender(3, 3, { metadata: md(true) })], water: { position: { x: -4, y: 70, z: 0 } } });
  await run(sb, 'endermanTick()');
  assert.ok(sb.calls.some((c) => c[0] === 'goal' && c[1] === 'near'));
  const ev = sb.events.find((e) => e.type === 'enderman_flee');
  assert.ok(ev && ev.to === 'water');
});

test('endermanTick : en colère, pas d\'eau, nu → fuite (but XZ) ; blindé et armé → combat', async () => {
  const a = sandbox({ entities: [ender(3, 3, { metadata: md(true) })] });
  await run(a, 'endermanTick()');
  assert.ok(a.calls.some((c) => c[0] === 'goal' && c[1] === 'xz'));
  assert.strictEqual(a.events.find((e) => e.type === 'enderman_flee').to, 'away');
  const b = sandbox({ entities: [ender(3, 3, { metadata: md(true) })], armor: 15, items: ['iron_sword'] });
  await run(b, 'endermanTick()');
  assert.ok(b.calls.includes('attack:enderman'));
  // et une fois la cible prise, la garde de regard le laisse viser
  run(b, 'installEndermanGuard()');
  await run(b, 'bot.look(0, 0, false)');
  assert.deepStrictEqual(b.calls.filter((c) => c[0] === 'look').pop(), ['look', 0, 0, false]);
});

test('endermanTick : calme et loin → rien ; puis noteEndermanHurt (il nous frappe) → réaction', async () => {
  const sb = sandbox({ entities: [ender(2, 2, { metadata: md(false) })] });
  await run(sb, 'endermanTick()');
  assert.ok(!sb.events.some((e) => e.type === 'enderman_flee'));
  run(sb, 'noteEndermanHurt()');
  await run(sb, 'endermanTick()');
  assert.ok(sb.events.some((e) => e.type === 'enderman_flee'));
});

// ── Live 21/10 : 3 cartographes nus tués par un enderman qu'ils avaient frappé ──
test('endermanTick : enderman CALME collé (métadonnée lue, pas creepy) → aucune réaction, aucun coup', async () => {
  const sb = sandbox({ entities: [ender(1.5, 1, { metadata: [] })], armor: 15, items: ['iron_sword'] });
  await run(sb, 'endermanTick()');
  assert.ok(!sb.calls.includes('attack:enderman'));
  assert.ok(!sb.events.some((e) => /^enderman_(flee|fight|hide)$/.test(e.type)));
});

test('noteEndermanHurt : frappé par un ZOMBIE (source) avec un enderman à côté → l\'enderman reste calme', async () => {
  const zo = { id: 9, name: 'zombie', kind: 'Hostile mobs', position: { x: 1, y: 70, z: 0 } };
  const sb = sandbox({ entities: [ender(2, 2, { metadata: [] }), zo], armor: 15, items: ['iron_sword'] });
  sb.zo = zo;
  run(sb, 'noteEndermanHurt(zo)');
  await run(sb, 'endermanTick()');
  assert.ok(!sb.calls.includes('attack:enderman'));
  assert.ok(!sb.events.some((e) => /^enderman_(flee|fight|hide)$/.test(e.type)));
});

test('endermanTick : CARTOGRAPHE face à un enderman en colère → se mure (jamais de coup) + hold, la boucle attend', async () => {
  const sb = sandbox({ mapper: true, entities: [ender(3, 3, { metadata: md(true) })], armor: 0, items: ['stone_sword', 'dirt'] });
  await run(sb, 'endermanTick()');
  assert.ok(!sb.calls.includes('attack:enderman'));
  assert.ok(sb.calls.includes('seal:seal'));
  const ev = sb.events.find((e) => e.type === 'enderman_hide');
  assert.ok(ev && ev.ok && ev.why === 'creepy');
  assert.ok(run(sb, '_enderHoldUntil') > sb.clock.t);
  // l'enderman s'est calmé → le hold rend la main tout de suite
  sb.bot.entities = {};
  await run(sb, 'endermanHoldWait()');
  assert.strictEqual(run(sb, '_enderHoldUntil'), 0);
});

test('endermanTick : CARTOGRAPHE sans blocs, ou murage raté → fuite, jamais de combat', async () => {
  const a = sandbox({ mapper: true, entities: [ender(3, 3, { metadata: md(true) })], armor: 15, items: ['iron_sword'] });
  await run(a, 'endermanTick()');
  assert.ok(!a.calls.includes('attack:enderman'));
  assert.strictEqual(a.events.find((e) => e.type === 'enderman_flee').to, 'away');
  const b = sandbox({ mapper: true, entities: [ender(3, 3, { metadata: md(true) })], items: ['dirt'], sealResult: { ok: false, placed: 0 } });
  await run(b, 'endermanTick()');
  assert.ok(b.calls.some((c) => c[0] === 'goal' && c[1] === 'xz'));
  assert.strictEqual(run(b, '_enderHoldUntil'), 0);
});

// ── 2. FAIM ──────────────────────────────────────────────────────────────────────────────────
test('descentFoodGateCheck : 0 point en surface → refus persisté + food_gate ; 3e fois → passe', () => {
  const sb = sandbox({ points: 0 });
  assert.strictEqual(run(sb, 'descentFoodGateCheck()'), false);
  assert.deepStrictEqual(sb.base.foodGate.refusals, [sb.clock.t]);
  const ev = sb.events.find((e) => e.type === 'food_gate');
  assert.ok(ev && ev.need === G.DESCENT_MIN_POINTS && ev.points === 0);
  sb.clock.t += 1000;
  assert.strictEqual(run(sb, 'descentFoodGateCheck()'), false);
  sb.clock.t += 1000;
  assert.strictEqual(run(sb, 'descentFoodGateCheck()'), true, 'au-delà de 2 refus : on descend');
});

test('descentFoodGateCheck : stock suffisant → passe sans rien écrire ; le reste du mémo est préservé', () => {
  const sb = sandbox({ points: 8, base: { deathDebt: { x: 1 } } });
  assert.strictEqual(run(sb, 'descentFoodGateCheck()'), true);
  assert.ok(!sb.calls.includes('save'));
  const sb2 = sandbox({ points: 0, base: { deathDebt: { x: 1 } } });
  run(sb2, 'descentFoodGateCheck()');
  assert.deepStrictEqual(sb2.base.deathDebt, { x: 1 }, 'saveBaseState fusionne');
});

test('le hook de descente consulte la porte nourriture et rend food_gate', () => {
  const body = fnSrc('runGoalSkill');
  assert.match(body, /descentFoodGateCheck\(\)/);
  assert.match(body, /reason: 'food_gate'/);
});

test('foodRunTick : la remontée sous terre (undergroundFoodTripDue) contourne la sourdine', () => {
  const body = fnSrc('foodRunTick');
  assert.match(body, /undergroundFoodTripDue\(/);
  assert.match(body, /returnToWork\('food'\)/);
  const ens = fnSrc('ensureFood');
  assert.match(ens, /markWorkBeforeTrip\('food'\)/);
});

// ── 3. DROP_AHEAD ────────────────────────────────────────────────────────────────────────────
test('onDropAhead : 1er → rien ; 2e au même endroit → tourne de 90° + drop_ahead_turn', async () => {
  const sb = sandbox({ yaw: 0 });
  await run(sb, 'onDropAhead()');
  assert.strictEqual(sb.events.length, 0);
  await run(sb, 'onDropAhead()');
  const ev = sb.events.find((e) => e.type === 'drop_ahead_turn');
  assert.ok(ev && ev.mode === 'turn' && ev.count === 2);
  assert.ok(Math.abs(run(sb, '_descendHeading.yaw') - Math.PI / 2) < 1e-9);
  // la descente suivante part dans le nouveau cap
  await run(sb, 'applyDescendHeading()');
  const l = sb.calls.filter((c) => c[0] === 'look').pop();
  assert.deepStrictEqual(l, ['look', 1.57, 0, true]);
});

test('onDropAhead : 3e → tourne encore (cumulé), 4e → décalage 30-50 blocs à pied', async () => {
  const sb = sandbox({ yaw: 0 });
  for (let i = 0; i < 3; i++) await run(sb, 'onDropAhead()');
  assert.ok(Math.abs(run(sb, '_descendHeading.yaw') - Math.PI) < 1e-9);
  await run(sb, 'onDropAhead()');
  const ev = sb.events.filter((e) => e.type === 'drop_ahead_turn').pop();
  assert.strictEqual(ev.mode, 'shift');
  const g = sb.calls.find((c) => c[0] === 'goto');
  assert.ok(g && g[1] === 'xz');
  const d = Math.hypot(g[2], g[3]);
  assert.ok(d >= 29 && d <= 51, `décalage ${d}`);
});

test('onDropAhead(no_progress|max_depth) : surplace de descente → même règle de cap + descend_loop_break (21/10)', async () => {
  const sb = sandbox({ yaw: 0 });
  run(sb, constSrc('DESCEND_POSITIONAL_RE'));
  assert.ok(run(sb, "DESCEND_POSITIONAL_RE.test('no_progress') && DESCEND_POSITIONAL_RE.test('max_depth') && !DESCEND_POSITIONAL_RE.test('water_ahead')"));
  await run(sb, "onDropAhead('max_depth')");
  assert.strictEqual(sb.events.length, 0, '1er : rien');
  await run(sb, "onDropAhead('no_progress')");
  const br = sb.events.find((e) => e.type === 'descend_loop_break');
  assert.ok(br && br.reason === 'no_progress' && br.action === 'turn' && br.count === 2, JSON.stringify(sb.events));
  assert.ok(sb.events.some((e) => e.type === 'drop_ahead_turn' && e.mode === 'turn'));
  for (let i = 0; i < 2; i++) await run(sb, "onDropAhead('no_progress')");
  assert.ok(sb.events.some((e) => e.type === 'descend_loop_break' && e.action === 'shift'), 'au 4e : décalage à pied');
  assert.ok(sb.calls.some((c) => c[0] === 'goto' && c[1] === 'xz'));
});

test('runGoalSkill : la descente traite no_progress/max_depth comme drop_ahead ; descend_relocate en GoalNearXZ', () => {
  const body = fnSrc('runGoalSkill');
  assert.match(body, /DESCEND_POSITIONAL_RE\.test\(String\(r\.reason \|\| ''\)\)\) await onDropAhead\(r\.reason\)/);
  assert.match(body, /descend_relocate[\s\S]{0,800}GoalNearXZ\(_tx, _tz, 3\)/);
  assert.doesNotMatch(body, /descend_relocate'[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n\s*try \{ await withTimeout\(bot\.pathfinder\.goto\(new pfGoals\.GoalNear\(_tx, Math/);
});

test('applyDescendHeading : cap périmé (> 10 min) → ignoré', async () => {
  const sb = sandbox();
  run(sb, '_descendHeading = { yaw: 1, at: Date.now() - DESCEND_HEADING_TTL_MS - 1 }');
  await run(sb, 'applyDescendHeading()');
  assert.ok(!sb.calls.some((c) => c[0] === 'look'));
});

test('runGoalSkill : la descente applique le cap mémorisé et traite drop_ahead', () => {
  const body = fnSrc('runGoalSkill');
  assert.match(body, /await applyDescendHeading\(\);\s*\n\s*(?:const|let) r = await descendDiagonal/);
  assert.match(body, /onDropAhead\(/);
});

function foodTickSandbox({ y = 15, food = 6, points = 0, tripAt = null, base = {} } = {}) {
  const C = require('./caution');
  const clock = { t: 1_800_000_000_000 };
  const log = { ensure: 0, back: [] };
  const sb = {
    events: [], log, base, clock,
    emit(e) { sb.events.push(e); },
    Date: { now: () => clock.t }, Object, Math,
    bot: { food, entity: { position: { x: 0, y, z: 0 } }, inventory: { items: () => [] } },
    _foodRunBusy: false, _imminentBusy: false, panicInFlight: false, _armorBusy: false, _baseBusy: false,
    foodStock: () => 0, foodRunNeeded: C.foodRunNeeded, foodRunCooldownAfter: C.foodRunCooldownAfter,
    _lastFoodRunAt: clock.t - 60000, _foodRunCooldownMs: 900000,           // sourdine 15 min, posée il y a 1 min
    nightLockdownNow: () => false, nightGateNote: () => {},
    withTimeout: (p) => p, FOOD_RUN_TIMEOUT_MS: 70000, FOOD_TRIP_MS: 75000, stopMotion() {},
    ensureFood: async () => { log.ensure++; if (tripAt !== null) sb._foodSurfaceTripAt = clock.t + tripAt; },
    foodPoints: () => points, buildCtxInv: () => ({}),
    loadBaseState: () => sb.base, saveBaseState: (st) => { sb.base = st; return true; },
    returnToWork: async (why) => { log.back.push(why); return true; },
    undergroundFoodTripDue: G.undergroundFoodTripDue, foodGateLoad: G.foodGateLoad, _foodSurfaceTripAt: 0,
  };
  vm.createContext(sb);
  run(sb, fnSrc('foodRunTick'));
  return sb;
}

test('foodRunTick : sous terre, faim 6, sac vide, sourdine 15 min active → la quête part quand même (persistée)', async () => {
  const sb = foodTickSandbox({ y: 15, food: 6 });
  await run(sb, 'foodRunTick()');
  assert.strictEqual(sb.log.ensure, 1);
  assert.strictEqual(sb.base.foodGate.lastUnderTripAt, sb.clock.t);
  // re-tick 1 min plus tard : cooldown propre (4 min) → rien
  sb.clock.t += 60000;
  await run(sb, 'foodRunTick()');
  assert.strictEqual(sb.log.ensure, 1);
});

test('foodRunTick : en surface la sourdine reste respectée (comportement d\'avant)', async () => {
  const sb = foodTickSandbox({ y: 70, food: 6 });
  await run(sb, 'foodRunTick()');
  assert.strictEqual(sb.log.ensure, 0);
});

test('foodRunTick : remonté et nourri → retour /home work ; remonté bredouille → reste en surface', async () => {
  const fed = foodTickSandbox({ y: 15, food: 6, points: 4, tripAt: 1 });
  await run(fed, 'foodRunTick()');
  assert.deepStrictEqual(fed.log.back, ['food']);
  const empty = foodTickSandbox({ y: 15, food: 6, points: 0, tripAt: 1 });
  await run(empty, 'foodRunTick()');
  assert.deepStrictEqual(empty.log.back, []);
});
