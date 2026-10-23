'use strict';
// CÂBLAGE des correctifs du run 10 (20/10, 375 morts / 10 h, vie médiane d'un ouvrier 3,2 min) :
//   guardSpawn / senseSpawnDanger / hideFromThreat  — se terrer dans les secondes qui suivent un respawn ;
//   escapeDeathCamp                                 — la fuite à pied s'interrompt si un danger surgit ;
//   gatherWoodSafely / woodDangerNow                — le bois sans mourir ;
//   bot.on('death') + recoverDeathDebt              — keepInventory mesuré, la dette se lève d'elle-même.
// Les DÉCISIONS sont testées pures (test/respawnGuard.test.js). Ici on EXÉCUTE le texte réel des fonctions
// de index.js dans un bac à sable `vm` strict dont le seul contenu est ce que le module fournit au niveau
// module : un identifiant oublié ou un `let` déclaré dans onSpawn lève une ReferenceError ICI (pièges #56/#61).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const U = require('./unstuck');
const G = require('./skills/gather');
const Homes = require('./homes');
const { isFleeHostile } = require('./skills/fleeFrom');
const { NEUTRAL_NO_PROVOKE } = require('./survival');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(re, label) {
  const m = SRC.match(re);
  assert.ok(m, `${label} introuvable dans index.js (déplacé, renommé, ou déclaré hors niveau module ?)`);
  return m[0];
}
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);
const constSrc = (name) => grab(new RegExp(`^const ${name} = [^;]+;`, 'm'), `const ${name}`);
const run = (sb, code) => vm.runInContext("'use strict';\n" + code, sb);

const T0 = 1_700_000_000_000;
const DAY = 6000;
const NIGHT = 18000;
const mob = (x, z = 0, name = 'skeleton') => ({ name, kind: 'Hostile mobs', position: { x, y: 70, z }, isValid: true });

/** Horloge virtuelle partagée : `sleep` l'avance (aucune vraie attente sauf mention). */
function clockSb(extra = {}) {
  const clock = { t: T0 };
  const sb = {
    events: [], calls: [], clock,
    emit(e) { sb.events.push(e); },
    Date: { now: () => clock.t },
    sleep: async (ms) => { clock.t += ms; },
    Math, Number, Object, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    ...extra,
  };
  return sb;
}

// ═════════════════════════════ 1. guardSpawn : observer, décider, agir ═════════════════════════════
/**
 * `appearAtMs` : l'hostile n'est livré qu'après ce délai (c'est ce que le run 10 a montré : le relevé à
 * l'instant 0 ne voyait jamais rien). `worn`, `night`, `armed` : l'état du bot au spawn.
 */
function guardSandbox({ appearAtMs = null, dist = 6, worn = 0, night = false, armed = false, hideRes = { ok: true }, escapeRes = { escaped: true } } = {}) {
  const sb = clockSb();
  const bot = {
    entity: { position: { x: 0, y: 70, z: 0 } },
    time: { timeOfDay: night ? NIGHT : DAY },
    get entities() { return (appearAtMs != null && sb.clock.t - T0 >= appearAtMs) ? { 1: mob(dist) } : {}; },
  };
  Object.assign(sb, {
    bot, isFleeHostile, NEUTRAL_NO_PROVOKE, creeperIsThreat: require('./creeper').creeperIsThreat,
    spawnDanger: U.spawnDanger, spawnGuardPlan: U.spawnGuardPlan,
    isNight: (b) => !!(b && b.time && b.time.timeOfDay >= 12800 && b.time.timeOfDay <= 23200),
    _wornArmor: () => new Set(['a', 'b', 'c', 'd'].slice(0, worn)),
    _escapeOnSpawn: armed,
    taskCtl: { cancel: () => sb.calls.push('cancel') },
    stopMotion: () => sb.calls.push('stop'),
    hideFromThreat: async (why, d) => { sb.calls.push('hide:' + why + ':' + (d ? d.mob : 'none')); return hideRes; },
    escapeDeathCamp: async () => { sb.calls.push('escape'); return escapeRes; },
    // camp de réapparition (23/10) : testé dans index.respawncamp.test.js ; ici, pas de camp.
    respawnCampRescue: async () => null,
  });
  vm.createContext(sb);
  run(sb, constSrc('SPAWN_SENSE_MS'));
  run(sb, constSrc('SPAWN_SENSE_STEP_MS'));
  for (const f of ['isThreatHostile', 'spawnDangerNow', 'senseSpawnDanger', 'guardSpawn']) run(sb, fnSrc(f));
  return sb;
}

test('guardSpawn : squelette livré 2 s APRÈS le spawn, bot nu → il est VU (fenêtre d observation) et le bot se TERRE', async () => {
  const sb = guardSandbox({ appearAtMs: 2000 });
  const plan = await sb.guardSpawn();
  assert.deepStrictEqual({ act: plan.act, reason: plan.reason }, { act: 'hide', reason: 'hostile_near' });
  assert.deepStrictEqual(sb.calls, ['cancel', 'stop', 'hide:spawn:skeleton'], 'coupe la vie précédente, puis se terre — PAS de fuite');
  const ev = sb.events.find((e) => e.type === 'spawn_guard');
  assert.ok(ev && ev.act === 'hide' && ev.mob === 'skeleton' && ev.dist === 6);
  assert.ok(sb.clock.t - T0 < 4000, 'sort de l observation dès que le danger est vu');
});

test('guardSpawn : rien en vue pendant 4 s, rien d armé → aucune action, aucun event (et l observation est bornée)', async () => {
  const sb = guardSandbox({ appearAtMs: null });
  const plan = await sb.guardSpawn();
  assert.strictEqual(plan.act, 'none');
  assert.deepStrictEqual(sb.calls, []);
  assert.strictEqual(sb.events.length, 0);
  assert.ok(sb.clock.t - T0 >= 4000 && sb.clock.t - T0 <= 4400, `observation bornée à ~4 s (${sb.clock.t - T0} ms)`);
});

test('guardSpawn : hostile à 20 blocs → pas de repli (rayon 12)', async () => {
  const sb = guardSandbox({ appearAtMs: 0, dist: 20 });
  assert.strictEqual((await sb.guardSpawn()).act, 'none');
});

test('guardSpawn : camp armé, de JOUR, rien en vue → la fuite à pied d avant (et le drapeau est consommé)', async () => {
  const sb = guardSandbox({ armed: true });
  const plan = await sb.guardSpawn();
  assert.strictEqual(plan.act, 'escape');
  assert.deepStrictEqual(sb.calls, ['escape']);
  assert.strictEqual(sb._escapeOnSpawn, false);
});

test('guardSpawn : camp armé, de NUIT, nu → se terre, et ne court PAS ensuite (la nuit tient toujours)', async () => {
  const sb = guardSandbox({ armed: true, night: true });
  const plan = await sb.guardSpawn();
  assert.deepStrictEqual({ act: plan.act, reason: plan.reason }, { act: 'hide', reason: 'camp_night' });
  assert.ok(sb.calls.includes('hide:spawn:none'));
  assert.ok(!sb.calls.includes('escape'), 'pas de course nocturne à découvert');
  assert.strictEqual(sb._escapeOnSpawn, false);
});

test('guardSpawn : camp armé + hostile de jour → se terre PUIS fuit si la zone est vide au sortir du trou', async () => {
  const sb = guardSandbox({ armed: true, appearAtMs: 0 });
  // au sortir du trou, plus personne : on retire l'hostile
  sb.hideFromThreat = async () => { sb.calls.push('hide'); sb.bot = Object.assign({}, sb.bot, { entities: {} }); return { ok: true }; };
  run(sb, fnSrc('spawnDangerNow'));
  await sb.guardSpawn();
  assert.deepStrictEqual(sb.calls.filter((c) => c === 'hide' || c === 'escape'), ['hide', 'escape']);
  assert.ok(sb.events.some((e) => e.type === 'spawn_guard' && e.reason === 'camp_after_hide'));
});

test('guardSpawn : la fuite rapporte une menace en route → abri aussitôt', async () => {
  const sb = guardSandbox({ armed: true, escapeRes: { escaped: false, threat: { mob: 'zombie', dist: 7 } } });
  await sb.guardSpawn();
  assert.deepStrictEqual(sb.calls, ['escape', 'hide:escape:zombie']);
});

test('guardSpawn : armuré → aucun repli, l évasion d avant seulement si armée', async () => {
  assert.strictEqual((await guardSandbox({ worn: 4, appearAtMs: 0 }).guardSpawn()).act, 'none');
  const sb = guardSandbox({ worn: 4, armed: true, night: true });
  assert.strictEqual((await sb.guardSpawn()).act, 'escape');
  assert.deepStrictEqual(sb.calls, ['escape']);
});

// ═════════════════════════════ 2. hideFromThreat : UN abri, borné, jeton propre ═════════════════════
function hideSandbox({ inFlight = null, night = false, shelter = null, fled = false } = {}) {
  const sb = clockSb();
  const captured = { calls: [] };
  Object.assign(sb, {
    captured,
    bot: { time: { timeOfDay: night ? NIGHT : DAY }, entity: { position: { x: 0, y: 70, z: 0 } } },
    isNight: (b) => !!(b && b.time && b.time.timeOfDay >= 12800 && b.time.timeOfDay <= 23200),
    _shelterInFlight: inFlight, _shelterTok: null, _shelterStartedAt: 0, deriveToken: require('./plannerWatchdog').deriveToken, shelterToken: require('./shelterToken').shelterToken, shelterCancelLoopNote: require('./shelterToken').shelterCancelLoopNote, taskCtl: require('./tasks').createTaskController(), _shelterCancelLoop: null, _shelterFreshNext: false, SHELTER_HARD_MAX_MS: 13 * 60 * 1000 + Math.max(require('./skills/shelter').DAWN_WAIT_MAX_MS, require('./skills/shelter').DAWN_SAFE_EXIT_MAX_MS), _stillBusy: false, lastShelterT: 0,
    hostilesNearNow: () => 0, _wornArmor: () => new Set(), nightLockdownNow: () => false,
    dawnExitThreatsNow: () => ({ hostiles: 0, creepers: 0 }), exitAwayFromThreats: () => {},
    stopMotion: () => sb.calls.push('stop'),
    // fuite d'avant-abri (fix 20/10) : testée dans index.craftplan.test.js ; ici on fixe l'ordre.
    fleeBeforeHide: async (why) => { sb.calls.push('flee:' + why); return fled; },
    spawnDangerNow: () => null,
    // pilier anti-mêlée (22/10) : testé dans index.meleepillar.test.js ; ici aucune grappe au contact.
    meleePillarPlanNow: () => ({ act: 'none', reason: 'few_mobs' }), meleePillarRun: async () => ({ ok: false }),
    shelterUntilDawn: shelter || (async (b, tok, deps) => { captured.calls.push({ tok, deps, busy: sb._stillBusy }); return { ok: true }; }),
  });
  vm.createContext(sb);
  run(sb, constSrc('THREAT_HIDE_MAX_MS'));
  run(sb, fnSrc('withTimeout'));
  run(sb, fnSrc('hideFromThreat'));
  return sb;
}

test('hideFromThreat : creuse avec un jeton PROPRE non annulé, la borne 90 s, le relevé d hostiles et le compte de pièces', async () => {
  const sb = hideSandbox();
  const r = await sb.hideFromThreat('spawn', { mob: 'skeleton', dist: 6.04 });
  assert.deepStrictEqual(r, { ok: true });
  assert.strictEqual(sb.captured.calls.length, 1);
  const { tok, deps, busy } = sb.captured.calls[0];
  assert.strictEqual(tok.cancelled, false, 'jamais le taskToken (annulé) de la vie précédente');
  assert.strictEqual(deps.dawnWaitMaxMs, 90000);
  assert.strictEqual(typeof deps.hostilesNear, 'function');
  assert.strictEqual(typeof deps.worn, 'function');
  assert.strictEqual(busy, true, 'terré = immobilité légitime pendant l abri');
  assert.strictEqual(sb._stillBusy, false);
  assert.strictEqual(sb._shelterInFlight, null, 'l abri en cours est libéré');
  assert.strictEqual(sb.lastShelterT, T0);
  const a = sb.events.find((e) => e.type === 'threat_hide');
  assert.deepStrictEqual({ why: a.why, mob: a.mob, dist: a.dist, night: a.night }, { why: 'spawn', mob: 'skeleton', dist: 6, night: false });
  assert.ok(sb.events.some((e) => e.type === 'threat_hide_done' && e.ok === true));
});

test('hideFromThreat : fuit AVANT de creuser (fleeBeforeHide), puis creuse ; noFlee la saute', async () => {
  const sb = hideSandbox({ fled: true });
  const r = await sb.hideFromThreat('spawn', { mob: 'zombie', dist: 2 });
  assert.deepStrictEqual(r, { ok: true });
  assert.deepStrictEqual(sb.calls, ['flee:spawn']);
  assert.strictEqual(sb.captured.calls.length, 1, 'creuse après la fuite');
  const sb2 = hideSandbox();
  await sb2.hideFromThreat('spawn', null, { noFlee: true });
  assert.deepStrictEqual(sb2.calls, []);
});

test('hideFromThreat : un abri déjà en cours est REJOINT (jamais deux trous)', async () => {
  let release;
  const inFlight = new Promise((r) => { release = r; });
  const sb = hideSandbox({ inFlight });
  const p = sb.hideFromThreat('wood', null);
  release();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await p)), { ok: true, joined: true });
  assert.strictEqual(sb.captured.calls.length, 0);
});

test('hideFromThreat : borne custom (bois 60 s) et abri raté → rendu tel quel, garde relâchée', async () => {
  const sb = hideSandbox({ shelter: async (b, tok, deps) => { sb.captured.calls.push(deps.dawnWaitMaxMs); return { ok: false, reason: 'spot_failed' }; } });
  const r = await sb.hideFromThreat('wood', null, { maxWaitMs: 60000 });
  assert.deepStrictEqual(r, { ok: false, reason: 'spot_failed' });
  assert.deepStrictEqual(sb.captured.calls, [60000]);
  assert.strictEqual(sb._shelterInFlight, null);
  assert.ok(sb.events.some((e) => e.type === 'threat_hide_done' && e.reason === 'spot_failed'));
});

// ═════════════════════════════ 3. escapeDeathCamp : une menace en route coupe la course ═════════════
test('escapeDeathCamp : un danger qui surgit pendant la course → stopMotion, death_camp_escape_threat, pas d ancrage', async () => {
  let rejectGoto;
  let seen = 0;
  const sb = clockSb();
  Object.assign(sb, {
    bot: {
      entity: { position: { x: 0, y: 70, z: 0 } },
      nearestEntity: () => null,
      pathfinder: { goto: () => new Promise((res, rej) => { rejectGoto = rej; }) },
    },
    isFleeHostile, NO_GIVE: true,
    escapePlan: U.escapePlan, escapeReached: U.escapeReached, canReanchorSpawn: U.canReanchorSpawn, ESCAPE_SAFE_RADIUS: U.ESCAPE_SAFE_RADIUS,
    pfGoals: { GoalNearXZ: function (x, z, r) { this.x = x; this.z = z; this.r = r; } },
    _escapeGen: 0, _escaping: false,
    taskCtl: { cancel: () => {} },
    stopMotion: () => { sb.calls.push('stop'); if (rejectGoto) rejectGoto(new Error('stopped')); },
    // 2e relevé : le squelette est là
    spawnDangerNow: () => (++seen >= 2 ? { flee: true, mob: 'skeleton', dist: 8.04, worn: 0 } : null),
    anchorSpawnpoint: () => { sb.calls.push('anchor'); return true; },
    relocateToRegion: async () => {},
    nearbyHostiles: () => [],
  });
  vm.createContext(sb);
  run(sb, constSrc('ESCAPE_WALK_TIMEOUT_MS'));
  run(sb, constSrc('ESCAPE_THREAT_POLL_MS'));
  run(sb, fnSrc('withTimeout'));
  run(sb, fnSrc('escapeDeathCamp'));
  const r = await sb.escapeDeathCamp();
  assert.ok(r && r.threat && r.threat.mob === 'skeleton', 'la menace remonte à guardSpawn');
  assert.strictEqual(r.escaped, false);
  assert.ok(sb.calls.includes('stop'));
  assert.ok(!sb.calls.includes('anchor'), 'jamais de /spawnpoint après une fuite interrompue');
  assert.ok(sb.events.some((e) => e.type === 'death_camp_escape_threat' && e.mob === 'skeleton' && e.dist === 8));
  assert.strictEqual(sb._escaping, false, 'la garde de fuite est relâchée');
});

// ═════════════════════════════ 4. gatherWoodSafely : le bois sans mourir (ni se terrer en boucle) ═══
const TG = require('./threatgate');
const thr = (id, dist, x = dist) => ({ id, mob: 'skeleton', dist, x, y: 70, z: 0 });
function woodSandbox({ worn = 0, dangerSeq = [], gatherSeq = [], night = false, hideMs = 0, state = null } = {}) {
  const sb = clockSb();
  let di = 0, gi = 0;
  Object.assign(sb, {
    bot: { time: { timeOfDay: night ? NIGHT : DAY } }, taskToken: { cancelled: false },
    isNight: (b) => !!(b && b.time && b.time.timeOfDay >= 12800 && b.time.timeOfDay <= 23200),
    woodExploreShape: G.woodExploreShape,
    woodHidePlan: TG.woodHidePlan, woodHideStateAt: TG.woodHideStateAt,
    _woodHide: state,
    _exploreBusy: false,
    _wornArmor: () => new Set(['a', 'b', 'c', 'd'].slice(0, worn)),
    // La menace « réelle » : la séquence, MOINS les entrées ignorées (même règle que realThreat).
    woodThreatNow: (ignore) => {
      const v = dangerSeq[Math.min(di, dangerSeq.length - 1)]; di++;
      if (!v) return null;
      const ign = (ignore || []).some((i) => i.id === v.id && v.dist >= i.dist - 2);
      return ign ? null : v;
    },
    hideFromThreat: async (why, d, o) => { sb.clock.t += hideMs; sb.calls.push(`hide:${why}:${o && o.maxWaitMs}`); return { ok: true }; },
    gather: async (b, args, tok) => { sb.calls.push({ args, tok }); const r = gatherSeq[Math.min(gi, gatherSeq.length - 1)]; gi++; return r; },
  });
  vm.createContext(sb);
  run(sb, constSrc('WOOD_HIDE_MAX_MS'));
  run(sb, constSrc('WOOD_HIDE_WINDOW_MS'));
  run(sb, fnSrc('gatherWoodSafely'));
  return sb;
}
const hides = (sb) => sb.calls.filter((c) => typeof c === 'string' && c.startsWith('hide:')).length;
const gathers = (sb) => sb.calls.filter((c) => typeof c === 'object').length;

test('gatherWoodSafely : nu + menace réelle → se terre (60 s) AVANT de récolter, puis récolte avec la forme courte', async () => {
  const sb = woodSandbox({ dangerSeq: [thr(1, 10), null], gatherSeq: [{ ok: true, got: 3 }] });
  const r = await sb.gatherWoodSafely({ name: ['oak_log'], count: 3, explore: true });
  assert.deepStrictEqual(r, { ok: true, got: 3 });
  assert.strictEqual(sb.calls[0], 'hide:wood:60000');
  const g = sb.calls[1];
  assert.deepStrictEqual(g.args.exploreShape, { step: 48, maxRadius: 144 });
  assert.strictEqual(typeof g.args.danger, 'function', 'le danger est relu PENDANT la récolte');
  assert.strictEqual(g.args.explore, true);
  assert.strictEqual(g.tok, sb.taskToken);
});

test('gatherWoodSafely : run 12 — même squelette immobile à 10.5 après la cachette → PAS de 2e cachette, on récolte', async () => {
  const sb = woodSandbox({ dangerSeq: [thr(7, 10.5)], gatherSeq: [{ ok: true, got: 3 }] });
  const r = await sb.gatherWoodSafely({ name: ['oak_log'], count: 3, explore: true });
  assert.deepStrictEqual(r, { ok: true, got: 3 });
  assert.strictEqual(hides(sb), 1, 'une seule cachette pour une menace statique');
  const sk = sb.events.find((e) => e.type === 'threat_hide_skipped');
  assert.ok(sk && sk.why === 'static' && sk.mob === 'skeleton' && sk.dist === 10.5);
  assert.strictEqual(gathers(sb), 1);
});

test('gatherWoodSafely : la borne de 2 cachettes TIENT à travers les rappels du planner (niveau module)', async () => {
  // Trois menaces DIFFÉRENTES, une par tentative de `logs` : 2 cachettes max sur la séquence.
  const sb = woodSandbox({ dangerSeq: [thr(1, 10), thr(2, 9, -9), thr(3, 8, 20)], gatherSeq: [{ ok: false, got: 0, reason: 'not_found' }] });
  await sb.gatherWoodSafely({ name: ['oak_log'], count: 3, explore: true });
  await sb.gatherWoodSafely({ name: ['oak_log'], count: 3, explore: true });
  assert.strictEqual(hides(sb), 2);
  assert.ok(sb.events.some((e) => e.type === 'threat_hide_skipped' && e.why === 'max_hides'));
});

test('gatherWoodSafely : une récolte réussie remet la séquence à zéro', async () => {
  const sb = woodSandbox({ dangerSeq: [null], gatherSeq: [{ ok: true, got: 4 }], state: { hides: 2, since: T0, last: null, ignore: [] } });
  await sb.gatherWoodSafely({ name: ['oak_log'], count: 3, explore: true });
  assert.strictEqual(sb._woodHide, null);
});

test('gatherWoodSafely : danger PENDANT la récolte → borné (pas de boucle infinie)', async () => {
  const sb = woodSandbox({ dangerSeq: [null], gatherSeq: [{ ok: false, got: 0, reason: 'danger' }] });
  const r = await sb.gatherWoodSafely({ name: ['oak_log'], count: 3, explore: true });
  assert.strictEqual(r.reason, 'danger');
  assert.ok(gathers(sb) <= 12);
});

test('gatherWoodSafely : lot partiel déjà en poche quand le danger tombe → rendu ok (le planner re-dérive)', async () => {
  const sb = woodSandbox({ dangerSeq: [null], gatherSeq: [{ ok: true, got: 2, reason: 'danger' }] });
  const r = await sb.gatherWoodSafely({ name: ['oak_log'], count: 12, explore: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(gathers(sb), 1);
});

test('gatherWoodSafely : armuré → forme d exploration d origine (pas d exploreShape)', async () => {
  const sb = woodSandbox({ worn: 2, dangerSeq: [null], gatherSeq: [{ ok: true, got: 1 }] });
  await sb.gatherWoodSafely({ name: ['oak_log'], count: 1, explore: true });
  assert.strictEqual(sb.calls[0].args.exploreShape, undefined);
});

test('woodThreatNow : rayon 16 (pas 12), nu seulement, et un mur coupe la ligne de vue', () => {
  const mk = (worn, d, wallX = null) => {
    const sb = clockSb({
      bot: {
        entity: { position: { x: 0, y: 70, z: 0 } }, entities: { 1: mob(d, 0, 'zombie') },
        blockAt: (p) => ({ boundingBox: (wallX != null && p.x === wallX) ? 'block' : 'empty' }),
      },
      vec3Lib: (x, y, z) => ({ x, y, z }),
      realThreat: TG.realThreat, SPAWN_DANGER_MIN_WORN: U.SPAWN_DANGER_MIN_WORN, isFleeHostile, NEUTRAL_NO_PROVOKE, creeperIsThreat: require('./creeper').creeperIsThreat,
      _wornArmor: () => new Set(['a', 'b', 'c', 'd'].slice(0, worn)),
    });
    vm.createContext(sb);
    run(sb, constSrc('WOOD_DANGER_RADIUS'));
    run(sb, fnSrc('isThreatHostile'));
    run(sb, fnSrc('woodThreatNow'));
    return sb.woodThreatNow([]);
  };
  assert.ok(mk(0, 15), '15 blocs, nu, champ libre → menace');
  assert.strictEqual(mk(0, 17), null);
  assert.strictEqual(mk(2, 5), null, 'armuré : pas de repli');
  assert.strictEqual(mk(0, 12, 6), null, 'mur entre les deux, > 6 blocs → pas une menace');
  assert.ok(mk(0, 5, 3), '≤ 6 blocs : compte même derrière un mur');
});

test('index.js : la branche gatherLog passe par gatherWoodSafely (plus d appel nu à gather pour le bois)', () => {
  // (20/10 soir) l'objet d'appel peut recevoir le `collectTimeoutMs` du but (bûcheron) par Object.assign.
  assert.match(SRC, /return gatherWoodSafely\(Object\.assign\(\{ name: logNames\.length \? logNames : 'oak_log', count: _count, explore: true \}, _ct\)\);/);
  assert.ok(!/return gather\(bot, \{ name: logNames\.length/.test(SRC));
});

// ═════════════════════════════ 5. keepInventory : la dette se lève d'elle-même ═════════════════════
function debtSandbox({ invAtDeath, invNow, night = false, worn = 0 }) {
  const sb = clockSb();
  Object.assign(sb, {
    bot: { time: { timeOfDay: night ? NIGHT : DAY }, entity: { position: { x: 0, y: 70, z: 0 } }, entities: {} },
    isNight: (b) => !!(b && b.time && b.time.timeOfDay >= 12800 && b.time.timeOfDay <= 23200),
    _deathDebtBusy: false, _invAtDeath: invAtDeath,
    _invTotal: () => invNow,
    _wornArmor: () => new Set(['a', 'b', 'c', 'd'].slice(0, worn)),
    loadDeathDebt: () => ({ x: 5, y: 70, z: 5, at: T0 - 20000 }),
    debtAction: Homes.debtAction, inventoryKept: Homes.inventoryKept,
    settleDeathDebt: (reason) => sb.calls.push('settle:' + reason),
    deferDeathDebt: (d, reason) => sb.calls.push('defer:' + reason),
    homewarp: { goHome: () => sb.calls.push('tp_death'), dropsWithin: () => [] },
    HOME_DEATH: 'death', DEATH_DROP_RADIUS: 16,
    awaitWarp: async () => ({ warped: true }),
    clearHostilesAround: async () => sb.calls.push('clear'),
    collectDeathDrops: async () => sb.calls.push('collect'),
  });
  vm.createContext(sb);
  run(sb, fnSrc('recoverDeathDebt'));
  return sb;
}

test('recoverDeathDebt : keepInventory ON (inventaire revenu) → dette LEVÉE sans téléportation au camp', async () => {
  const sb = debtSandbox({ invAtDeath: 40, invNow: 40 });
  await sb.recoverDeathDebt();
  assert.deepStrictEqual(sb.calls, ['settle:kept_inventory']);
});

test('recoverDeathDebt : inventaire livré APRÈS la 1re décision → la 2e (après 1,5 s) lève la dette, pas de TP', async () => {
  let n = 0;
  const sb = debtSandbox({ invAtDeath: 40, invNow: 0 });
  sb._invTotal = () => (n++ === 0 ? 0 : 38);
  await sb.recoverDeathDebt();
  assert.deepStrictEqual(sb.calls, ['settle:kept_inventory']);
  assert.strictEqual(sb._deathDebtBusy, false, 'la garde est relâchée');
});

test('recoverDeathDebt : keepInventory OFF (inventaire vide au respawn) → récupération d origine (TP + ramassage)', async () => {
  const sb = debtSandbox({ invAtDeath: 40, invNow: 0 });
  await sb.recoverDeathDebt();
  assert.deepStrictEqual(sb.calls, ['tp_death', 'clear', 'collect', 'settle:recovered']);
});

test('handler death : relève l inventaire AU MOMENT de la mort (avant que le serveur ne le vide)', () => {
  const h = grab(/^bot\.on\('death', \(\) => \{[\s\S]*?^\}\);$/m, "bot.on('death')");
  const rec = h.indexOf('_invAtDeath = _invTotal(() => true)');
  assert.ok(rec > 0 && rec < h.indexOf('persistDeathHistory()'), 'relevé en tête du handler');
  assert.match(SRC, /^let _invAtDeath = -1;/m, '_invAtDeath au niveau MODULE (lu par recoverDeathDebt, timer compris)');
});

test('gatherWoodSafely : plus aucune cachette commencée après 90 s (le skill est borné à 180 s)', async () => {
  const sb = woodSandbox({ dangerSeq: [thr(1, 10), thr(2, 9, -9), null], gatherSeq: [{ ok: true, got: 3 }], hideMs: 95000 });
  await sb.gatherWoodSafely({ name: ['oak_log'], count: 3, explore: true });
  assert.strictEqual(hides(sb), 1, 'la 2e menace arrive après 95 s : on récolte au lieu de se recacher');
  assert.ok(sb.events.some((e) => e.type === 'threat_hide_skipped' && e.why === 'window'));
});

test('gatherWoodSafely : de NUIT, rend la main sur danger sans creuser (la discipline de nuit possède le trou)', async () => {
  const sb = woodSandbox({ night: true, dangerSeq: [{ mob: 'zombie', dist: 9 }], gatherSeq: [{ ok: false, got: 0, reason: 'danger' }] });
  const r = await sb.gatherWoodSafely({ name: ['oak_log'], count: 3, explore: true });
  assert.strictEqual(r.reason, 'danger');
  assert.strictEqual(sb.calls.filter((c) => typeof c === 'string').length, 0);
});

// ═════════════════════════════ 6. kit de secours en coffre (glue) ═════════════════════════════════
const S = require('./stash');
const H = require('./homeSafety');
function stashSandbox({ memo = null, inv = [], pos = { x: 0, y: 70, z: 0 }, night = false, danger = false, bank = null, chestItems = null, gotoErr = null, blockName = 'chest' } = {}) {
  const sb = clockSb();
  const disk = { memo };
  let invNow = inv.slice();
  const withdrawn = [];
  Object.assign(sb, {
    disk, withdrawn,
    bot: {
      entity: { position: pos }, time: { timeOfDay: night ? NIGHT : DAY },
      inventory: { items: () => invNow },
      blockAt: () => (blockName ? { name: blockName } : null),
      openContainer: async () => ({
        containerItems: () => (chestItems || []).filter((i) => !withdrawn.includes(i.name)).map((i, k) => ({ ...i, type: k })),
        withdraw: async (type) => { const it = (chestItems || [])[type]; withdrawn.push(it.name); },
        close: () => {},
      }),
    },
    NO_GIVE: true, IS_MAPPER: false, SAFE_HOME_MIN_Y: 58, STASH_NEAR_BASE: S.STASH_NEAR_BASE,
    isNight: (b) => !!(b && b.time && b.time.timeOfDay >= 12800 && b.time.timeOfDay <= 23200),
    depositPlan: S.depositPlan, restorePlan: S.restorePlan,
    loadBaseState: () => (disk.memo ? JSON.parse(JSON.stringify(disk.memo)) : null),
    saveBaseState: (st) => { disk.memo = JSON.parse(JSON.stringify(st)); return true; },
    woodDangerNow: () => (danger ? { mob: 'zombie', dist: 9 } : null),
    craftSmart: async () => { sb.calls.push('craft'); },
    bankDeposit: bank || (async (list) => {
      const before = invNow.slice();
      for (const d of list) {
        invNow = invNow.map((i) => (i.name === d.name ? { name: i.name, count: i.count - d.count } : i)).filter((i) => i.count > 0);
      }
      return { ok: true, before, after: invNow.slice(), pos: { x: 1.2, y: 70, z: -2.6 } };
    }),
    _campedAt: (p) => H.homeCamped({ home: p, deaths: (disk.memo && disk.memo.deathPos) || [], now: sb.clock.t }),
    gotoWithTimeout: async () => { if (gotoErr) throw new Error(gotoErr); },
    pfGoals: { GoalNear: function (x, y, z, r) { Object.assign(this, { x, y, z, r }); } },
    vec3Lib: (x, y, z) => ({ x, y, z }),
    _stashCheckedAt: 0, _stashBusy: false, _lastRespawnPos: { x: 0, y: 70, z: 0 },
  });
  vm.createContext(sb);
  run(sb, constSrc('STASH_CHECK_EVERY_MS'));
  run(sb, constSrc('STASH_WALK_MS'));
  for (const f of ['_invSnapshot', '_stashedDiff', 'stashKitIfReady', 'restoreStashIfUseful']) run(sb, fnSrc(f));
  return sb;
}
const KIT = [{ name: 'stone_pickaxe', count: 1 }, { name: 'furnace', count: 1 }, { name: 'oak_log', count: 12 },
  { name: 'oak_planks', count: 10 }, { name: 'stick', count: 6 }, { name: 'cooked_beef', count: 8 }];

test('stashKitIfReady : outils pierre + four au point de respawn → coffre posé, kit PERSISTÉ en fusion, stash_deposit', async () => {
  const sb = stashSandbox({ memo: { deaths: [1], zone: { anchoredAt: 5 } }, inv: KIT });
  const plan = await sb.stashKitIfReady();
  assert.strictEqual(plan.act, 'deposit');
  const st = sb.disk.memo.stash;
  assert.deepStrictEqual({ x: st.x, y: st.y, z: st.z }, { x: 1, y: 70, z: -3 });
  assert.ok(st.items.some((i) => i.name === 'oak_log' && i.count === 8));
  assert.deepStrictEqual(sb.disk.memo.deaths, [1], 'fusion : les autres champs du mémo survivent');
  assert.ok(sb.events.some((e) => e.type === 'stash_deposit'));
  // relevé suivant dans la minute → rien (pas de re-dépôt en boucle)
  assert.strictEqual(await sb.stashKitIfReady(), null);
});

test('stashKitIfReady : de nuit, menace en vue, ou loin du point de respawn → rien', async () => {
  assert.strictEqual((await stashSandbox({ inv: KIT, night: true }).stashKitIfReady()).reason, 'unsafe');
  assert.strictEqual((await stashSandbox({ inv: KIT, danger: true }).stashKitIfReady()).reason, 'unsafe');
  assert.strictEqual((await stashSandbox({ inv: KIT, pos: { x: 100, y: 70, z: 0 } }).stashKitIfReady()).reason, 'not_at_base');
});

test('stashKitIfReady : coffre impossible → stash_failed, rien de persisté', async () => {
  const sb = stashSandbox({ inv: KIT, bank: async () => ({ ok: false, reason: 'no_chest_item' }) });
  await sb.stashKitIfReady();
  assert.ok(sb.events.some((e) => e.type === 'stash_failed' && e.reason === 'no_chest_item'));
  assert.ok(!(sb.disk.memo && sb.disk.memo.stash));
});

const STASH = { x: 10, y: 70, z: 0, at: T0, items: [{ name: 'oak_log', count: 8 }, { name: 'stone_pickaxe', count: 1 }] };
test('restoreStashIfUseful : nu, coffre à 10 blocs → retire tout, efface le kit, stash_restore ok', async () => {
  const sb = stashSandbox({ memo: { stash: STASH, base: { x: 1, y: 70, z: 1 } }, inv: [], chestItems: STASH.items });
  const plan = await sb.restoreStashIfUseful();
  assert.strictEqual(plan.act, 'restore');
  assert.deepStrictEqual(sb.withdrawn, ['oak_log', 'stone_pickaxe']);
  assert.strictEqual(sb.disk.memo.stash, null);
  assert.deepStrictEqual(sb.disk.memo.base, { x: 1, y: 70, z: 1 });
  const ev = sb.events.find((e) => e.type === 'stash_restore');
  assert.strictEqual(ev.ok, true);
  assert.strictEqual(ev.items.length, 2);
});

test('restoreStashIfUseful : keepInventory ON (pioche gardée) → rien, en silence ; coffre campé → stash_skip', async () => {
  const kept = stashSandbox({ memo: { stash: STASH }, inv: [{ name: 'stone_pickaxe', count: 1 }], chestItems: STASH.items });
  assert.strictEqual((await kept.restoreStashIfUseful()).reason, 'has_pickaxe');
  assert.strictEqual(kept.events.length, 0);
  assert.deepStrictEqual(kept.withdrawn, []);
  const deathPos = [{ x: 11, y: 70, z: 0, at: T0 - 60000 }, { x: 9, y: 70, z: 1, at: T0 - 30000 }];
  const camp = stashSandbox({ memo: { stash: STASH, deathPos }, inv: [], chestItems: STASH.items });
  assert.strictEqual((await camp.restoreStashIfUseful()).reason, 'camped');
  assert.ok(camp.events.some((e) => e.type === 'stash_skip' && e.reason === 'camped'));
});

test('restoreStashIfUseful : menace en route → abandon (danger) ; coffre disparu → kit oublié', async () => {
  const d = stashSandbox({ memo: { stash: STASH }, inv: [], chestItems: STASH.items, gotoErr: 'goto_danger' });
  await d.restoreStashIfUseful();
  assert.ok(d.events.some((e) => e.type === 'stash_restore' && e.ok === false && e.reason === 'danger'));
  assert.ok(d.disk.memo.stash, 'le kit reste pour la prochaine vie');
  const gone = stashSandbox({ memo: { stash: STASH }, inv: [], blockName: 'air' });
  await gone.restoreStashIfUseful();
  assert.strictEqual(gone.disk.memo.stash, null);
  assert.ok(gone.events.some((e) => e.reason === 'chest_missing'));
});

test('index.js : onSpawn reprend le kit APRÈS guardSpawn ; le planner passe par stashKitIfReady avant chaque but', () => {
  const body = grab(/^async function onSpawn\(\) \{[\s\S]*?^\}$/m, 'onSpawn');
  const g = body.indexOf('await guardSpawn()');
  const r = body.indexOf('await restoreStashIfUseful()');
  assert.ok(g > 0 && r > g, 'retrait du kit après la décision de spawn');
  assert.ok(body.indexOf('loadDeathDebt()') > r && body.indexOf('startAutonomous(null)') > r);
  assert.match(SRC, /runSkill: async \(g\) => \{ try \{ await stashKitIfReady\(\); \} catch \(e\) \{ \/\* best-effort \*\/ \} return runSkillWithTelemetry\(g\); \},/);
  assert.match(SRC, /^let _lastRespawnPos = null;/m);
});

test('index.js : noyade — un 2e warp /home safe en < 60 s est remplacé par la nage (warp futile), garde au NIVEAU MODULE', () => {
  assert.match(SRC, /^let _lastDrownWarpAt = 0;/m);
  const i = SRC.indexOf("ctx: 'warp_futile'");
  const j = SRC.indexOf("emit({ type: 'water_rescue_home_safe' });");
  assert.ok(i > 0 && j > i, 'le test de futilité précède le warp');
  assert.match(SRC, /_lastDrownWarpAt = Date\.now\(\);\n\s+emit\(\{ type: 'water_rescue_home_safe' \}\);/);
});
