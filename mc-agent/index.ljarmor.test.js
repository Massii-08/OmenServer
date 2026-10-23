'use strict';
// CÂBLAGE armure + expédition forestière du bûcheron (20/10 soir). La logique est dans lumberjack.js ;
// ici on EXÉCUTE le vrai texte des fonctions de index.js dans un bac à sable `vm` strict : un
// identifiant lu hors niveau module (piège #56) → ReferenceError ici, pas en prod.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const L = require('./lumberjack');
const { buildCtxInv } = require('./goals');

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

const T0 = 1_800_000_000_000;
const mapper = (name, o = {}) => Object.assign({ name, role: 'mapper', at: T0 - 1000, x: 0, z: 0, armor: 0 }, o);

function fakeClaims(sb) {
  return {
    map: {},
    tryClaim(k) { const c = this.map[k]; if (c && c.by !== sb.bot.username) return false; this.map[k] = { by: sb.bot.username, at: sb.clock.t }; return true; },
    release(k) { const c = this.map[k]; if (!c || c.by !== sb.bot.username) return false; delete this.map[k]; return true; },
  };
}

function sandbox(o = {}) {
  const clock = { t: T0 };
  const sb = {
    events: [], calls: [], clock, base: o.base || {}, mates: o.mates || [],
    emit(e) { sb.events.push(e); },
    Date: { now: () => clock.t },
    Object, Math, Number, Array, JSON, Promise, Set, Map, String, RegExp,
    items: (o.items || []).map((i) => Object.assign({}, i)),
    bot: {
      username: o.name || 'NethBot3',
      entity: { position: Object.assign({ x: -40, y: 70, z: 46 }, o.pos || {}) },
      inventory: { items: () => sb.items },
      tossStack: async (it) => { sb.calls.push('toss:' + it.name); sb.items.splice(sb.items.indexOf(it), 1); },
    },
    world: { objective: { type: o.objective || 'lumberjack', status: 'in_progress' } },
    presence: o.noPresence ? null : { list: () => sb.mates },
    taskToken: { cancelled: false },
    whitelist: null,
    isAllowed: () => o.tpa !== false,
    isNearlyBroken: (it) => !!it.worn,
    _wornArmor: () => new Set(o.worn || []),
    isNight: (b) => !!(b && b.time && b.time.timeOfDay >= 13000),
    loadBaseState: () => sb.base,
    saveBaseState: (st) => { sb.base = st; return true; },
    buildCtxInv,
    craftSmart: async ({ name }) => {
      sb.calls.push('craft:' + name);
      if (o.craftFails) return { ok: false };
      sb.items.push({ name, count: 1 });
      return { ok: true };
    },
    runGoalSkill: async (g) => { sb.calls.push('skill:' + g.skill); return o.ensureArmorResult || { ok: true }; },
    loadWorldCells: () => ({ biomes: o.biomes || [], depleted: o.depleted || [], ores: [] }),
    currentAnchor: () => (o.anchor === undefined ? { x: -40, z: 40 } : o.anchor),
    _foodTripBusy: false,
    foodTripLock: () => { if (sb._foodTripBusy) return false; sb._foodTripBusy = true; return true; },
    foodTripUnlock: () => { sb._foodTripBusy = false; },
    foodTripWalk: async ({ cell, ms }) => { sb.calls.push(['walk', cell.x, cell.z, ms]); return o.walk || { ok: true, arrived: true, legs: 2, moved: 100 }; },
    bookmarkCuttingSpot: (why) => { sb.calls.push('work:' + why); return true; },
    logCount: L.logCount, LUMBERJACK_STOCK: L.LUMBERJACK_STOCK, LJ_FOREST_TRIP_MS: L.LJ_FOREST_TRIP_MS,
    ownArmorAction: L.ownArmorAction, pickMapperForLumberjack: L.pickMapperForLumberjack, ljGiftReady: L.ljGiftReady,
    pickArmorTargetForLumberjack: L.pickArmorTargetForLumberjack,
    stockFailsPrune: L.stockFailsPrune, stockFailsAdd: L.stockFailsAdd, needsForestTrip: L.needsForestTrip,
    forestTriedAdd: L.forestTriedAdd, pickForestCell: L.pickForestCell,
  };
  sb._teamClaims = fakeClaims(sb);
  vm.createContext(sb);
  for (const c of ['GIFT_CACHE_MS', 'GIFT_DONE_TTL_MS', '_giftDone', 'LJ_FORGE_HOLD_MS', 'LJ_GIFT_FAIL_TTL_MS',
    '_LJ_ARMOR_RE', '_ljGiftFailed']) run(sb, constSrc(c));
  for (const l of ['_giftTarget', '_giftAt', '_ljGift', '_ljGiftAt', '_ljForgeHoldUntil', '_ljStockFails', '_ljStockFailsLoaded', '_ljNotFound']) run(sb, letSrc(l));
  for (const f of ['releaseGiftTarget', 'isLumberjackObjective', '_ljPocketArmor', '_ljReleaseGift', '_ljArmorContext',
    'ljGiftPiecesFor', 'ljAfterGift', '_ljTossWornArmor', 'lumberjackArmorSkill', 'ljCraftGiftSkill',
    '_ljLoadStockFails', '_ljSaveStockFails', 'noteLumberjackStockFail', '_ljForestNeeded', 'lumberjackForestTripSkill']) run(sb, fnSrc(f));
  run(sb, 'globalThis.__get = (n) => eval(n); globalThis.__set = (n, v) => eval(n + " = v");');
  return sb;
}
const plain = (x) => JSON.parse(JSON.stringify(x));

// ─── SES pièces d'abord ───────────────────────────────────────────────────────────────────────────
test('bûcheron 2/4 + 10 lingots (NethBot3 réel) → forge SES jambières, ne réserve aucun cartographe', () => {
  const sb = sandbox({ worn: ['iron_helmet', 'iron_boots'], items: [{ name: 'iron_ingot', count: 10 }], mates: [mapper('MapBot2')] });
  const c = run(sb, '_ljArmorContext()');
  assert.deepStrictEqual(plain(c), { own: { act: 'forge', piece: 'iron_leggings', ingots: 7 }, gift: null });
  assert.deepStrictEqual(sb._teamClaims.map, {});
});

test('une pièce USÉE en poche ne compte pas : il forge quand même (et la jette avant)', async () => {
  const sb = sandbox({ worn: ['iron_helmet', 'iron_boots', 'iron_chestplate'],
    items: [{ name: 'iron_ingot', count: 8 }, { name: 'iron_leggings', count: 1, worn: true }] });
  const c = run(sb, '_ljArmorContext()');
  assert.strictEqual(c.own.act, 'forge');
  const r = await run(sb, 'lumberjackArmorSkill()');
  assert.deepStrictEqual(plain(r), { ok: true });
  assert.deepStrictEqual(sb.calls.slice(0, 2), ['toss:iron_leggings', 'skill:ensureArmor']);
  assert.ok(sb.events.some((e) => e.type === 'armor_worn_tossed' && e.item === 'iron_leggings'));
  assert.ok(sb.events.some((e) => e.type === 'lumberjack_armor' && e.ok === true && e.piece === 'iron_leggings'));
});

test('forge ratée → 10 min sans réessayer (le but est sauté, pas de boucle)', async () => {
  const sb = sandbox({ worn: ['iron_helmet', 'iron_boots'], items: [{ name: 'iron_ingot', count: 10 }],
    ensureArmorResult: { ok: false, reason: 'armor_no_progress' } });
  const r = await run(sb, 'lumberjackArmorSkill()');
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(plain(run(sb, '_ljArmorContext()')), { own: null, gift: null });
  sb.clock.t += 600001;
  assert.strictEqual(run(sb, '_ljArmorContext()').own.piece, 'iron_leggings');
});

// ─── Puis un cartographe ──────────────────────────────────────────────────────────────────────────
test('bûcheron complet + 10 lingots → réserve le cartographe le plus nu et prévoit bottes + casque', () => {
  const sb = sandbox({ worn: ['iron_helmet', 'iron_boots', 'iron_leggings', 'iron_chestplate'],
    items: [{ name: 'iron_ingot', count: 10 }],
    mates: [mapper('MapBot1', { armor: 1, missing: ['iron_boots', 'iron_leggings', 'iron_chestplate'] }),
      mapper('MapBot2', { missing: ['iron_boots', 'iron_helmet', 'iron_leggings', 'iron_chestplate'] })] });
  const c = run(sb, '_ljArmorContext()');
  assert.deepStrictEqual(plain(c), { own: null, gift: { to: 'MapBot2', pieces: ['iron_boots', 'iron_helmet'], ready: false } });
  assert.ok(sb._teamClaims.map['marmor:MapBot2'], 'même réservation que les ouvriers en mapper_armor');
  assert.strictEqual(sb.__get('_giftTarget'), 'MapBot2', 'deliverMapperArmor (réutilisé) lit _giftTarget');
  assert.deepStrictEqual(plain(run(sb, 'ljGiftPiecesFor("MapBot2")')), ['iron_boots', 'iron_helmet']);
});

test('cartographe déjà réservé par un ouvrier → le suivant', () => {
  const sb = sandbox({ worn: ['iron_helmet', 'iron_boots', 'iron_leggings', 'iron_chestplate'],
    items: [{ name: 'iron_ingot', count: 10 }],
    mates: [mapper('MapBot1', { armor: 1, missing: ['iron_boots'] }), mapper('MapBot2')] });
  sb._teamClaims.map['marmor:MapBot2'] = { by: 'NethBot1', at: T0 };
  assert.strictEqual(run(sb, '_ljArmorContext()').gift.to, 'MapBot1');
});

test('ljCraftGiftSkill forge les pièces prévues manquantes, puis le but est prêt ; livraison → plan oublié', async () => {
  const sb = sandbox({ worn: ['iron_helmet', 'iron_boots', 'iron_leggings', 'iron_chestplate'],
    items: [{ name: 'iron_ingot', count: 10 }], mates: [mapper('MapBot2')] });
  run(sb, '_ljArmorContext()');
  const r = await run(sb, 'ljCraftGiftSkill()');
  assert.deepStrictEqual(plain(r), { ok: true });
  assert.deepStrictEqual(sb.calls, ['craft:iron_boots', 'craft:iron_helmet']);
  assert.strictEqual(run(sb, '_ljArmorContext()').gift.ready, true);
  run(sb, 'ljAfterGift("MapBot2", 2)');
  assert.strictEqual(sb.__get('_ljGift'), null);
});

test('/tpa raté vers un cartographe → écarté 5 min (pas de boucle de /tpa)', () => {
  const sb = sandbox({ worn: ['iron_helmet', 'iron_boots', 'iron_leggings', 'iron_chestplate'],
    items: [{ name: 'iron_ingot', count: 10 }], mates: [mapper('MapBot2')] });
  run(sb, '_ljArmorContext()');
  run(sb, 'ljAfterGift("MapBot2", 0)');
  sb._teamClaims.map = {};
  assert.strictEqual(run(sb, '_ljArmorContext()').gift, null);
  sb.clock.t += 300001;
  sb.mates[0].at = sb.clock.t - 1000;                            // présence rafraîchie entre-temps
  assert.strictEqual(run(sb, '_ljArmorContext()').gift.to, 'MapBot2');
});

test('forge du don impossible → hold + réservation rendue', async () => {
  const sb = sandbox({ worn: ['iron_helmet', 'iron_boots', 'iron_leggings', 'iron_chestplate'],
    items: [{ name: 'iron_ingot', count: 10 }], mates: [mapper('MapBot2')], craftFails: true });
  run(sb, '_ljArmorContext()');
  const r = await run(sb, 'ljCraftGiftSkill()');
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(sb._teamClaims.map, {});
  assert.strictEqual(run(sb, '_ljArmorContext()').gift, null);
});

test('hors rôle bûcheron : ljGiftPiecesFor rend null (le set complet historique des ouvriers)', () => {
  const sb = sandbox({ objective: 'mapper_armor' });
  assert.strictEqual(run(sb, 'ljGiftPiecesFor("MapBot2")'), null);
});

// ─── Expédition forestière ────────────────────────────────────────────────────────────────────────
const FOREST = [{ name: 'old_growth_birch_forest', x: -128, z: 0 }, { name: 'forest', x: 0, z: -128 }];

test('2 échecs lj_stock (timeout, not_found) en 10 min → expédition ; persistés dans le mémo base', () => {
  const sb = sandbox({ base: { safeHome: { x: 1 } } });
  run(sb, 'noteLumberjackStockFail("lj_stock", "timeout")');
  assert.strictEqual(run(sb, '_ljForestNeeded()'), false);
  run(sb, 'noteLumberjackStockFail("logs", "timeout")');        // pas le but du bûcheron
  run(sb, 'noteLumberjackStockFail("lj_stock", "cancelled")');  // pas un échec de bois
  sb.clock.t += 60000;
  run(sb, 'noteLumberjackStockFail("lj_stock", "not_found")');
  assert.strictEqual(run(sb, '_ljForestNeeded()'), true);
  assert.strictEqual(sb.base.ljStockFails.length, 2);
  assert.deepStrictEqual(sb.base.safeHome, { x: 1 }, 'FUSION du mémo (la base y vit aussi)');
  // un process neuf (respawn) relit le mémo
  run(sb, '_ljStockFailsLoaded = false; _ljStockFails = [];');
  assert.strictEqual(run(sb, '_ljForestNeeded()'), true);
  // de nuit → pas de marche (les échecs restent comptés pour l'aube)
  sb.bot.time = { timeOfDay: 18000 };
  assert.strictEqual(run(sb, '_ljForestNeeded()'), false);
  sb.bot.time = { timeOfDay: 1000 };
  assert.strictEqual(run(sb, '_ljForestNeeded()'), true);
  // stock plein → pas d'expédition
  sb.items.push({ name: 'oak_log', count: 64 });
  assert.strictEqual(run(sb, '_ljForestNeeded()'), false);
});

test('expédition : marche vers la forêt connue la plus proche puis pose `work` ; échecs consommés', async () => {
  const sb = sandbox({ biomes: FOREST, base: { ljStockFails: [T0 - 1000, T0 - 500] } });
  const r = await run(sb, 'lumberjackForestTripSkill()');
  assert.deepStrictEqual(plain(r), { ok: true });
  assert.deepStrictEqual(sb.calls, [['walk', 32, -33, L.LJ_FOREST_TRIP_MS], 'work:lumberjack_forest']);
  const ev = sb.events.find((e) => e.type === 'lumberjack_forest_trip');
  assert.deepStrictEqual(plain(ev), { type: 'lumberjack_forest_trip', to: { x: 32, z: -33 }, biome: 'forest', dist: 107, ok: true, moved: 100, legs: 2 });
  assert.deepStrictEqual(plain(sb.base.ljStockFails), []);
  assert.strictEqual(run(sb, '_ljForestNeeded()'), false);
  assert.strictEqual(sb._foodTripBusy, false, 'verrou rendu');
});

test('expédition ratée → forêt écartée 30 min, pas de `work` ; aucune forêt connue → event, ok', async () => {
  const sb = sandbox({ biomes: FOREST, walk: { ok: true, arrived: false, legs: 3, moved: 20 } });
  await run(sb, 'lumberjackForestTripSkill()');
  assert.ok(!sb.calls.includes('work:lumberjack_forest'));
  assert.deepStrictEqual(sb.base.ljForestTried.map((e) => [e.x, e.z]), [[32, -33]]);
  assert.strictEqual(sb.events.find((e) => e.type === 'lumberjack_forest_trip').ok, false);
  // la seule forêt éligible est écartée → plus rien
  sb.events = [];
  await run(sb, 'lumberjackForestTripSkill()');
  assert.deepStrictEqual(plain(sb.events.find((e) => e.type === 'lumberjack_forest_trip')),
    { type: 'lumberjack_forest_trip', to: null, dist: null, ok: false, reason: 'no_forest' });
});

test('expédition : verrou d\'expédition déjà pris (gibier) → on ne marche pas', async () => {
  const sb = sandbox({ biomes: FOREST });
  sb._foodTripBusy = true;
  await run(sb, 'lumberjackForestTripSkill()');
  assert.ok(!sb.calls.some((c) => Array.isArray(c) && c[0] === 'walk'));
  assert.strictEqual(sb.events.find((e) => e.type === 'lumberjack_forest_trip').reason, 'busy');
});

// ─── Points de câblage ────────────────────────────────────────────────────────────────────────────
test('câblage : ctxExtra, dispatch, télémétrie, heartbeat `missing`, timeouts', () => {
  assert.match(SRC, /ljOwnArmor: ljArmor \? ljArmor\.own : null,/);
  assert.match(SRC, /ljForestTrip: isLumberjackObjective\(\) \? _ljForestNeeded\(\) : false,/);
  assert.match(SRC, /if \(goal\.skill === 'lumberjackArmor'\) return lumberjackArmorSkill\(\);/);
  assert.match(SRC, /if \(goal\.skill === 'lumberjackForestTrip'\) return lumberjackForestTripSkill\(\);/);
  assert.match(SRC, /if \(isLumberjackObjective\(\)\) return ljCraftGiftSkill\(\);/);
  assert.match(SRC, /const _pieces = ljGiftPiecesFor\(to\) \|\| \(_batch \? _batch\.pieces\.slice\(\) : null\) \|\| GIFT_PIECES;/);   // + lot (20/10)
  assert.match(SRC, /for \(const piece of _pieces\) \{/);
  assert.match(SRC, /noteLumberjackStockFail\(g\.name, r && r\.reason\);/);
  assert.match(SRC, /if \(st\) st\.missing = missingIronPieces\(invB, \[\.\.\._wornArmor\(\)\]\);/);
  assert.match(SRC, /lumberjackArmor: 160000, lumberjackForestTrip: LJ_FOREST_TRIP_MS \+ 20000/);
  // ljAfterGift sur TOUS les chemins de deliverMapperArmor (sinon _ljGift resterait posé → boucle)
  const deliver = SRC.slice(SRC.indexOf("if (goal.skill === 'deliverMapperArmor')"), SRC.indexOf("if (goal.skill === 'ensureArmor')"));
  assert.strictEqual((deliver.match(/ljAfterGift\(to, /g) || []).length, 4);
});

// ─── MINEURS D'ABORD (23/10, run live : bottes+casque livrés à MapBot2, NethBot2/3 à 2 pièces) ──────
const worker = (name, o = {}) => Object.assign({ name, role: 'worker', at: T0 - 1000, x: 0, z: 0, armor: 0 }, o);

test('bûcheron 4/4 + 9 lingots, NethBot2 à 2 pièces portées, MapBot2 nu → jambières pour NethBot2, pas de cartographe', () => {
  const sb = sandbox({ name: 'NethBot1', worn: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'],
    items: [{ name: 'iron_ingot', count: 9 }],
    mates: [mapper('MapBot2', { missing: ['iron_boots', 'iron_helmet', 'iron_leggings', 'iron_chestplate'], worn: 0 }),
      worker('NethBot2', { armor: 2, worn: 2, missing: ['iron_leggings', 'iron_chestplate'] })] });
  const c = run(sb, '_ljArmorContext()');
  assert.deepStrictEqual(plain(c), { own: null, gift: { to: 'NethBot2', pieces: ['iron_leggings'], ready: false } });
  assert.deepStrictEqual(Object.keys(sb._teamClaims.map), ['marmor:NethBot2']);
  assert.strictEqual(run(sb, '_giftTarget'), 'NethBot2');
});

test('mineur en manque mais 6 lingots seulement → aucune cible (le cartographe nu attend, rien n\'est réservé)', () => {
  const sb = sandbox({ name: 'NethBot1', worn: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'],
    items: [{ name: 'iron_ingot', count: 6 }],
    mates: [mapper('MapBot2', { missing: ['iron_boots'], worn: 0 }),
      worker('NethBot2', { armor: 2, worn: 2, missing: ['iron_leggings', 'iron_chestplate'] })] });
  assert.deepStrictEqual(plain(run(sb, '_ljArmorContext()')), { own: null, gift: null });
  assert.deepStrictEqual(sb._teamClaims.map, {});
});

test('forge pour un mineur : l\'event gift_craft porte role:worker', async () => {
  const sb = sandbox({ name: 'NethBot1', worn: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'],
    items: [{ name: 'iron_ingot', count: 9 }],
    mates: [worker('NethBot2', { armor: 2, worn: 2, missing: ['iron_leggings', 'iron_chestplate'] })] });
  run(sb, '_ljArmorContext()');
  await run(sb, 'ljCraftGiftSkill()');
  assert.ok(sb.events.some((e) => e.type === 'gift_craft' && e.to === 'NethBot2' && e.item === 'iron_leggings' && e.role === 'worker'));
});


// ─── Bûcheron sans arbres → migration bois (23/10, live NethBot1 : lj_stock not_found ×12 en 10 min) ──
test('lj_stock not_found comptés à part, persistés, et survivent à l expédition forestière', async () => {
  const sb = sandbox({ biomes: FOREST, base: {} });
  run(sb, 'noteLumberjackStockFail("lj_stock", "timeout")');
  run(sb, 'noteLumberjackStockFail("lj_stock", "not_found")');
  run(sb, 'noteLumberjackStockFail("lj_stock", "not_found")');
  assert.strictEqual(sb.base.ljNotFound.length, 2, 'seuls les not_found');
  await run(sb, 'lumberjackForestTripSkill()');
  assert.strictEqual(sb.base.ljStockFails.length, 0, 'échecs de l expédition consommés');
  assert.strictEqual(sb.base.ljNotFound.length, 2, 'les not_found restent : au 3ᵉ, migration');
  run(sb, '_ljStockFailsLoaded = false; _ljNotFound = [];');
  run(sb, '_ljLoadStockFails()');
  assert.strictEqual(sb.__get('_ljNotFound').length, 2, 'relus après respawn');
});

test('ljWoodMigrationDue : 3 not_found en 10 min, de jour, hors cooldown', () => {
  const now = T0;
  const nf = [now - 60000, now - 30000, now - 1000];
  assert.strictEqual(L.ljWoodMigrationDue({ notFound: nf, now }), true);
  assert.strictEqual(L.ljWoodMigrationDue({ notFound: nf.slice(1), now }), false);
  assert.strictEqual(L.ljWoodMigrationDue({ notFound: nf, now, isNight: true }), false);
  assert.strictEqual(L.ljWoodMigrationDue({ notFound: nf, now, lastMigrationAt: now - 60000 }), false);
  assert.strictEqual(L.ljWoodMigrationDue({ notFound: nf, now, migrating: true }), false);
  assert.strictEqual(L.ljWoodMigrationDue({ notFound: [now - 11 * 60000, now - 1000, now], now }), false, 'fenêtre de 10 min');
});

test('câblage : checkZoneVerdict migre le bûcheron pour le BOIS quand ljWoodMigrationDue', () => {
  const src = fnSrc('checkZoneVerdict');
  const i = src.indexOf('ljWoodMigrationDue(');
  assert.ok(i > 0 && src.indexOf("migrateZone('wood')", i) > i);
  assert.ok(i < src.indexOf('const v = zoneVerdict('), 'avant le verdict d hystérésis');
});
