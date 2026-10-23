'use strict';
// ANTI-VIDE (live 22/10, NethBot3 : 17 « fell from a high place » en 40 min, base + spawnpoint posés
// au-dessus de son propre puits) — le CÂBLAGE d'index.js, EXÉCUTÉ dans un bac à sable `vm` strict
// (même méthode que index.homesafety.test.js : un identifiant oublié ou un `let` dans onSpawn lève ici).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const vec3Lib = require('vec3');
const H = require('./homeSafety');
const homewarp = require('./homewarp');
const voidGuard = require('./voidGuard');
const { HOME_SAFE, HOME_WORK } = require('./homes');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(re, label) {
  const m = SRC.match(re);
  assert.ok(m, `${label} introuvable dans index.js`);
  return m[0];
}
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);
const run = (sb, code) => vm.runInContext("'use strict';\n" + code, sb);

const GLUE = ['_groundHere', '_vgBlockAt', '_chunkLoadedBelow', 'stepToSafeGround', '_voidAnchors', 'moveOffAnchorsBeforeDescent',
  'descendDiagonal', 'mineDown', '_voidFiller', 'rescueVoidAfterTeleport', 'invalidateVoidHome', 'noteFallDeath',
  'reanchorAfterVoid', 'anchorSpawnpoint', '_campedAt'];

// Monde : puits d'air x=-344,z=358 de y43 à y74 ; plein jusqu'à y74 ailleurs (surface y75).
function mkWorld() {
  const placed = new Set();
  const blockAt = (v) => {
    const k = `${v.x},${v.y},${v.z}`;
    if (placed.has(k)) return { name: 'cobblestone', boundingBox: 'block', position: v };
    if (v.x === -344 && v.z === 358 && v.y >= 43 && v.y <= 74) return { name: 'air', boundingBox: 'empty', position: v };
    return v.y <= 74 ? { name: 'stone', boundingBox: 'block', position: v } : { name: 'air', boundingBox: 'empty', position: v };
  };
  return { placed, blockAt };
}

function glue({ pos = { x: -343.4, y: 75, z: 358.7 }, inv = [{ name: 'cobblestone', count: 10 }], memo = null, extra = {} } = {}) {
  const w = mkWorld();
  const chat = [];
  const physicsLog = [];
  const bot = {
    entity: { position: new vec3Lib.Vec3(pos.x, pos.y, pos.z), onGround: true },
    physicsEnabled: true,
    inventory: { items: () => inv },
    chat: (m) => chat.push(m),
    blockAt: (v) => { assert.ok(v instanceof vec3Lib.Vec3, 'blockAt reçoit un Vec3'); return w.blockAt(v); },
    equip: async () => {},
    placeBlock: async (ref, face) => {
      physicsLog.push(bot.physicsEnabled);
      w.placed.add(`${ref.position.x + face.x},${ref.position.y + face.y},${ref.position.z + face.z}`);
    },
    pathfinder: { goto: async (g) => { if (sb.gotoMoves) bot.entity.position = new vec3Lib.Vec3(g.x + 0.5, bot.entity.position.y, g.z + 0.5); sb.gotos.push(g); } },
    spawnPoint: null,
  };
  const disk = { memo };
  const sb = {
    events: [], chat, bot, disk, gotos: [], gotoMoves: true, physicsLog, raw: [],
    emit(e) { sb.events.push(e); },
    Date, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    withTimeout: (p) => Promise.resolve(p).catch(() => ({ ok: false })),
    stopMotion: () => {},
    vec3Lib, voidGuard, homewarp, HOME_SAFE, HOME_WORK,
    pfGoals: {
      GoalBlock: function (x, y, z) { this.x = x; this.y = y; this.z = z; },
      GoalNearXZ: function (x, z, r) { this.x = x; this.z = z; this.r = r; },
    },
    loadBaseState: () => (disk.memo ? JSON.parse(JSON.stringify(disk.memo)) : null),
    saveBaseState(st) { disk.memo = JSON.parse(JSON.stringify(st)); return true; },
    spawnpointVeto: H.spawnpointVeto, _recentDeathPositions: () => sb.deaths || [], homeCamped: H.homeCamped,
    respawnEscape: require('./respawnEscape'), _campReanchor: null, _spawnVetoLast: null, SPAWN_VETO_EVENT_EVERY_MS: 60000,
    _descendDiagonalRaw: async () => { sb.raw.push('descend'); return { ok: true }; },
    _mineDownRaw: async () => { sb.raw.push('mineDown'); return { ok: true }; },
    IS_MAPPER: false,
    // état de niveau module
    _voidRescueBusy: false, _spawnOverVoidAt: 0, _spawnOverVoidPos: null, _fallDeaths: [], _lastSpawnAt: 0, _voidReanchorBusy: false,
    _safeHomeSet: true, _safeHomeSurface: true, _safeHomePos: { x: -343, y: 75, z: 359 },
    _workSet: true, _workPos: { x: -344, z: 371 },
    _stairDepth: 0,   // descendDiagonal gardé : compteur d'escalier en cours (23/10)
    ...extra,
  };
  vm.createContext(sb);
  run(sb, grab(/^const VOID_FILLERS = \[[\s\S]*?\];/m, 'VOID_FILLERS').replace(/^const /, 'var '));
  for (const f of GLUE) run(sb, fnSrc(f));
  return sb;
}

test('index.js : l état anti-vide est de NIVEAU MODULE (colonne 0) — piège #56', () => {
  for (const v of ['_voidRescueBusy', '_spawnOverVoidAt', '_spawnOverVoidPos', '_fallDeaths', '_lastSpawnAt', '_voidReanchorBusy']) {
    assert.match(SRC, new RegExp(`^let ${v} = `, 'm'), `${v} doit être déclaré au niveau module`);
  }
  assert.match(SRC, /^bot\.on\('forcedMove', \(\) => \{\n {2}rescueVoidAfterTeleport\(\)/m, 'rattrapage branché sur forcedMove');
  assert.match(SRC, /voidGuard\.isFallDeathMessage\(msg, bot\.username\)/, 'message de mort par chute écouté');
  assert.match(SRC, /bot\._mcaOnBookmarkRefused = /, 'refus de sethome émis (jamais en silence)');
  assert.match(SRC, /^const \{ descendDiagonal: _descendDiagonalRaw \} = require/m, 'descendDiagonal brut renommé : tous les appels passent par la garde');
});

test('respawn au-dessus du puits : physique GELÉE pendant la pose, remblai sous les pieds, dégel, ré-ancrage armé', async () => {
  const sb = glue({ extra: { _lastSpawnAt: Date.now() } });
  await sb.rescueVoidAfterTeleport();
  assert.deepStrictEqual(sb.physicsLog, [false], 'la pose a lieu physique gelée');
  assert.strictEqual(sb.bot.physicsEnabled, true, 'physique TOUJOURS rétablie');
  const ev = sb.events.find((e) => e.type === 'tp_void_landing');
  assert.ok(ev && ev.placed === true && ev.via === 'respawn' && ev.drop === 32, JSON.stringify(sb.events));
  assert.ok(sb._spawnOverVoidAt > 0, 'le point de respawn sera ré-ancré au sol');
  assert.strictEqual(voidGuard.groundCheck((q) => sb.bot.blockAt(new vec3Lib.Vec3(q.x, q.y, q.z)), sb.bot.entity.position, 1).ok, true);
});

test('/home safe au-dessus du vide : home INVALIDÉ (/delhome safe + event), jamais re-visé', async () => {
  const sb = glue();
  sb.bot._mcaLastHome = { name: 'safe', at: Date.now() };
  await sb.rescueVoidAfterTeleport();
  assert.ok(sb.chat.includes('/delhome safe'), sb.chat.join(' | '));
  assert.ok(sb.events.some((e) => e.type === 'home_invalidated_void' && e.name === 'safe' && e.reason === 'tp_over_void'));
  assert.strictEqual(sb._safeHomeSet, false);
  assert.strictEqual(sb._safeHomePos, null);
});

test('TP sur la terre ferme : rien (physique jamais touchée, aucun event)', async () => {
  const sb = glue({ pos: { x: -340.5, y: 75, z: 358.5 } });
  let touched = false;
  Object.defineProperty(sb.bot, 'physicsEnabled', { get: () => true, set: () => { touched = true; } });
  await sb.rescueVoidAfterTeleport();
  assert.strictEqual(touched, false);
  assert.deepStrictEqual(sb.events, []);
});

test('sans bloc en poche : dégel quand même, et le DIT (why no_block)', async () => {
  const sb = glue({ inv: [] });
  await sb.rescueVoidAfterTeleport();
  assert.strictEqual(sb.bot.physicsEnabled, true);
  assert.ok(sb.events.some((e) => e.type === 'tp_void_landing' && e.placed === false && e.why === 'no_block'));
});

test('2 morts de chute au fond du puits : home safe + base de la colonne condamnés, ré-ancrage armé', () => {
  const sb = glue({ memo: { base: { x: -343, y: 75, z: 358 }, safeHome: { x: -343, y: 75, z: 359 } } });
  sb.noteFallDeath({ x: -343.4, y: 43, z: 358.7 });
  assert.ok(sb.chat.includes('/delhome safe'));
  assert.ok(sb.events.some((e) => e.type === 'home_invalidated_void' && e.reason === 'fall_death_below'));
  assert.ok(sb.events.some((e) => e.type === 'base_invalidated_void'));
  assert.strictEqual(sb.disk.memo.base, undefined, 'base oubliée (le bot en reposera une au sol)');
  assert.deepStrictEqual(sb.disk.memo.voidBase && sb.disk.memo.voidBase.x, -343);
  sb.noteFallDeath({ x: -343.4, y: 43, z: 358.7 });
  const last = sb.events.filter((e) => e.type === 'fall_death').pop();
  assert.strictEqual(last.loop, true);
  assert.ok(sb._spawnOverVoidAt > 0);
});

test('chute sans rapport avec la base (ailleurs) : rien n est invalidé', () => {
  const sb = glue({ memo: { base: { x: -343, y: 75, z: 358 } } });
  sb.noteFallDeath({ x: 100, y: 40, z: 100 });
  assert.ok(!sb.events.some((e) => e.type === 'home_invalidated_void' || e.type === 'base_invalidated_void'));
  assert.ok(sb.disk.memo.base);
});

test('descente partie de la base : décalée de ~7 blocs AVANT de creuser', async () => {
  const sb = glue({ pos: { x: -343.4, y: 72, z: 358.7 }, memo: { base: { x: -343, y: 75, z: 358 } } });
  const r = await sb.descendDiagonal(sb.bot, { targetY: 40 }, null);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(sb.raw, ['descend']);
  assert.strictEqual(sb.gotos.length, 1);
  const p = sb.bot.entity.position;
  assert.ok(Math.hypot(p.x - -343, p.z - 358) > 3, `décalé : ${p.x},${p.z}`);
  assert.ok(sb.events.some((e) => e.type === 'descent_offset'));
});

test('descente : décalage impossible (le bot ne bouge pas) → REFUSÉE, jamais creusée sous la base', async () => {
  const sb = glue({ pos: { x: -343.4, y: 72, z: 358.7 }, memo: { base: { x: -343, y: 75, z: 358 } } });
  sb.gotoMoves = false;
  const r = await sb.descendDiagonal(sb.bot, { targetY: 40 }, null);
  assert.strictEqual(r.reason, 'near_base');
  assert.deepStrictEqual(sb.raw, []);
  assert.ok(sb.events.some((e) => e.type === 'descent_blocked_base'));
  const r2 = await sb.mineDown(sb.bot, {}, null);
  assert.strictEqual(r2.reason, 'near_base');
});

test('descente loin de toute ancre : aucun détour', async () => {
  const sb = glue({ pos: { x: -300, y: 72, z: 358 }, memo: { base: { x: -343, y: 75, z: 358 } } });
  await sb.descendDiagonal(sb.bot, {}, null);
  assert.deepStrictEqual(sb.gotos, []);
  assert.deepStrictEqual(sb.raw, ['descend']);
});

test('anchorSpawnpoint : au-dessus du vide → veto void_below ; sur le sol → /spawnpoint', () => {
  const sb = glue();
  assert.strictEqual(sb.anchorSpawnpoint('base'), false);
  assert.ok(sb.events.some((e) => e.type === 'spawnpoint_vetoed' && e.reason === 'void_below'));
  const ok = glue({ pos: { x: -340.5, y: 75, z: 358.5 } });
  assert.strictEqual(ok.anchorSpawnpoint('base'), true);
  assert.ok(ok.chat.includes('/spawnpoint'));
});

test('ré-ancrage après vide : marche jusqu au sol sûr, /spawnpoint, base reposée là', async () => {
  const sb = glue({ memo: {}, extra: { _spawnOverVoidAt: Date.now() } });
  await sb.reanchorAfterVoid();
  assert.ok(sb.chat.includes('/spawnpoint'), sb.chat.join(' | '));
  assert.ok(sb.disk.memo.base, 'base reposée au sol');
  assert.ok(sb.events.some((e) => e.type === 'void_reanchored'));
  assert.strictEqual(sb._spawnOverVoidAt, 0);
});

test('ré-ancrage après vide : bot reparti loin (> 24 blocs) → aucun /spawnpoint posé au hasard', async () => {
  const sb = glue({ pos: { x: -200.5, y: 75, z: 358.5 }, memo: {}, extra: { _spawnOverVoidAt: Date.now(), _spawnOverVoidPos: { x: -343, z: 359 } } });
  await sb.reanchorAfterVoid();
  assert.ok(!sb.chat.includes('/spawnpoint'));
  assert.strictEqual(sb._spawnOverVoidAt, 0);
});

// ═══ Seuil « vide » (live 23/10, NethBot1 : réapparition à 4 blocs du sol → /delhome safe à chaque vie) ═══
test('voidGuard.dangerousDrop : ≤ 4 blocs n est pas du vide ; > 4 ou plafond l est ; illisible = vide seulement chunk chargé', () => {
  for (const d of [0, 1, 3, 4]) assert.strictEqual(voidGuard.dangerousDrop(d), false, `drop ${d}`);
  for (const d of [5, 12, 40]) assert.strictEqual(voidGuard.dangerousDrop(d), true, `drop ${d}`);
  assert.strictEqual(voidGuard.dangerousDrop(null), false, 'chunk pas reçu : pas de verdict');
  assert.strictEqual(voidGuard.dangerousDrop(null, { chunkLoaded: false }), false);
  assert.strictEqual(voidGuard.dangerousDrop(null, { chunkLoaded: true }), true);
  assert.strictEqual(voidGuard.dangerousDrop(NaN), false);
});

test('/home safe arrivé à 4 blocs au-dessus d un plein (feuilles, marche) → rien : home GARDÉ, physique intacte, aucun event', async () => {
  // puits de 4 blocs d'air sous les pieds (y71..74), plein à y70
  const sb = glue({ pos: { x: -344.5, y: 75, z: 358.5 } });
  const real = sb.bot.blockAt;
  sb.bot.blockAt = (v) => (v.x === -345 && v.z === 358 && v.y >= 71 && v.y <= 74
    ? { name: 'air', boundingBox: 'empty', position: v } : (v.x === -345 && v.z === 358 && v.y <= 70 ? { name: 'stone', boundingBox: 'block', position: v } : real(v)));
  sb.bot._mcaLastHome = { name: 'safe', at: Date.now() };
  let touched = false;
  Object.defineProperty(sb.bot, 'physicsEnabled', { get: () => true, set: () => { touched = true; } });
  assert.strictEqual(voidGuard.dropDepth((q) => sb.bot.blockAt(new vec3Lib.Vec3(q.x, q.y, q.z)), sb.bot.entity.position), 4);
  await sb.rescueVoidAfterTeleport();
  assert.strictEqual(touched, false);
  assert.ok(!sb.chat.includes('/delhome safe'));
  assert.deepStrictEqual(sb.events, []);
  assert.strictEqual(sb._spawnOverVoidAt, 0, 'aucun ré-ancrage forcé');
});

test('/home safe arrivé à 5 blocs au-dessus du sol → toujours traité comme un vide (home invalidé)', async () => {
  const sb = glue({ pos: { x: -344.5, y: 75, z: 358.5 } });
  const real = sb.bot.blockAt;
  sb.bot.blockAt = (v) => (v.x === -345 && v.z === 358 && v.y >= 70 && v.y <= 74
    ? { name: 'air', boundingBox: 'empty', position: v } : (v.x === -345 && v.z === 358 && v.y <= 69 ? { name: 'stone', boundingBox: 'block', position: v } : real(v)));
  sb.bot._mcaLastHome = { name: 'safe', at: Date.now() };
  await sb.rescueVoidAfterTeleport();
  assert.ok(sb.events.some((e) => e.type === 'tp_void_landing' && e.drop === 5));
  assert.ok(sb.chat.includes('/delhome safe'));
});
