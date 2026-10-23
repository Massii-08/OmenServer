'use strict';
// CÂBLAGE (21/10) : nuit au travail, pioche refaite sur place, fondre en minant, bûcheron qui mine.
// Le VRAI texte des fonctions de index.js tourne dans un bac à sable `vm` strict : un identifiant lu hors
// niveau module (piège #56) → ReferenceError ici, pas en prod.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const NW = require('./nightWork');
const FJ = require('./furnaceJob');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(re, label) {
  const m = SRC.match(re);
  assert.ok(m, `${label} introuvable dans index.js`);
  return m[0];
}
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);
const constSrc = (name) => grab(new RegExp(`^const ${name} = [^;]+;`, 'm'), `const ${name}`);
const letSrc = (name) => grab(new RegExp(`^let ${name} = [^;]+;`, 'm'), `let ${name}`);
const run = (sb, code) => vm.runInContext("'use strict';\n" + code, sb);

const T0 = 1_800_000_000_000;

function sandbox(o = {}) {
  const clock = { t: T0 };
  const world = o.world || {};   // "x,y,z" → nom de bloc ; absent = pierre
  const sb = {
    events: [], clock, items: o.items || [{ name: 'stone_pickaxe', count: 1 }, { name: 'cobblestone', count: 20 }],
    emit(e) { sb.events.push(e); },
    Date: { now: () => clock.t },
    Object, Math, Number, Array, JSON, Promise, Set, Map, String, RegExp, Error,
    nightWorkPlan: NW.nightWorkPlan, nightUnderground: NW.nightUnderground, nightDeferGoal: NW.nightDeferGoal,
    nightSealCells: NW.nightSealCells, shelterCraftNext: NW.shelterCraftNext,
    migrationOwnsBot: () => false,
    hungerNetTick: async (tag, opt) => { sb.eatCalls = (sb.eatCalls || []).concat([[tag, opt]]); return !!o.eats; },
    craftLowHpBlocked: () => !!sb.lowHpBlocked,
    shelterCraftThrottled: require('./lowhp').shelterCraftThrottled,
    furnaceJobPlan: FJ.furnaceJobPlan, fuelLoadPlan: FJ.fuelLoadPlan, jobReadyAt: FJ.jobReadyAt,
    SMELT_JOB_ABANDON_DIST: FJ.SMELT_JOB_ABANDON_DIST, SMELT_JOB_COLLECT_DIST: FJ.SMELT_JOB_COLLECT_DIST,
    furnaceJobRestore: FJ.furnaceJobRestore, furnaceCollectRoute: FJ.furnaceCollectRoute, FURNACE_RETRY_MS: FJ.FURNACE_RETRY_MS,
    memo: o.memo || {},
    loadBaseState: () => sb.memo,
    saveBaseState: (st) => { sb.memo = st; return true; },
    _workSet: !!o.workPos, _workPos: o.workPos || null,
    homewarp: { goWork: () => { sb.warps = (sb.warps || 0) + 1; if (o.warpTo) Object.assign(sb.bot.entity.position, o.warpTo); } },
    awaitWarp: async () => ({ warped: true }),
    IS_MAPPER: false, isLumberjackObjective: () => false,
    nightLockdownNow: () => o.lockdown !== false,
    isInWater: () => false,
    taskToken: { cancelled: false },
    vec3Lib: (x, y, z) => ({ x, y, z }),
    respawnThreatsNow: () => o.threats || [],
    fleeBeforeHide: async () => { sb.fled = (sb.fled || 0) + 1; return true; },
    descentSurvivalTick: async () => {},
    withTimeout: (p) => p,
    stopMotion: () => {},
    sleep: async (ms) => { clock.t += ms; },
    require: (m) => { if (m === './skills/shelter') return { cellBlockItem: () => sb.items.find((i) => i.name === 'cobblestone') }; throw new Error(m); },
    descendDiagonal: async (bot, a) => {
      sb.descended = a;
      if (o.descentFails) return { ok: false, reason: 'water_ahead' };
      bot.entity.position.y = a.targetY; return { ok: true };
    },
    craftSmart: async (a) => { sb.crafted = (sb.crafted || []).concat(a.name); if (a.name === 'stone_pickaxe' && !o.craftFails) sb.items.push({ name: 'stone_pickaxe', count: 1 }); return { ok: !o.craftFails }; },
    placeBlockNear: async () => ({ ok: true, pos: { x: 1, y: 16, z: 0 } }),
    waitForBlock: async () => true,
    reclaimBlock: async () => { sb.reclaimed = true; },
    pfGoals: { GoalNear: function (x, y, z) { this.x = x; this.y = y; this.z = z; }, GoalBlock: function (x, y, z) { this.x = x; this.y = y; this.z = z; } },
    bot: {
      time: { day: 7, timeOfDay: 14000 },
      entity: { position: Object.assign({ x: 0.5, y: 70, z: 0.5, floored() { return { offset: (a, b, c) => ({ x: Math.floor(this.x) + a, y: Math.floor(this.y) + b, z: Math.floor(this.z) + c }) }; } }, o.pos || {}), onGround: true },
      inventory: { items: () => sb.items },
      registry: { itemsByName: { raw_iron: { id: 1 }, coal: { id: 2 }, oak_planks: { id: 3 } } },
      blockAt: (v) => {
        const n = world[`${v.x},${v.y},${v.z}`];
        if (n === 'furnace') return { name: 'furnace', boundingBox: 'block', position: v };
        if (n) return { name: n, boundingBox: n === 'air' ? 'empty' : 'block', position: v };
        return { name: 'stone', boundingBox: 'block', position: v };
      },
      equip: async () => {},
      placeBlock: async (ref, f) => { sb.placed = (sb.placed || []).concat([{ x: ref.position.x + f.x, y: ref.position.y + f.y, z: ref.position.z + f.z }]); },
      openFurnace: async () => {
        const f = { put: [], outputItem: () => ({ count: 9 }), inputItem: () => null, fuelItem: () => null,
          putFuel: async (id, m, q) => { f.put.push(['fuel', id, q]); }, putInput: async (id, m, q) => { f.put.push(['in', id, q]); },
          takeOutput: async () => { sb.items.push({ name: 'iron_ingot', count: 9 }); return { count: 9 }; },
          takeInput: async () => {}, takeFuel: async () => {}, close: () => {} };
        sb.furnace = f; return f;
      },
      pathfinder: { goto: async () => {} },
    },
  };
  vm.createContext(sb);
  run(sb, [letSrc('_nightWork'), letSrc('_nightWorkTriedNight'), constSrc('_nightDeferAt'), constSrc('NIGHT_WORK_DESCENT_MS'),
    "const { cellBlockItem: _nightCellItem } = require('./skills/shelter');",
    fnSrc('_nightId'), fnSrc('nightUndergroundNow'), fnSrc('nightSkipGoal'), fnSrc('_nearestThreatDist'),
    fnSrc('_nightFill'), fnSrc('nightSeal'), fnSrc('nightTorch'), fnSrc('tryNightWork'), letSrc('_lastPickRebuildWhy'), fnSrc('rebuildPickHere'),
    letSrc('_shelterCraft'), constSrc('SHELTER_CRAFT_MS'), fnSrc('_shelterRecenter'), fnSrc('shelterWhileSealed'),
    'this.shelterWhileSealed = shelterWhileSealed; this.shelterCraft = () => _shelterCraft;',
    letSrc('_furnaceJob'), letSrc('_furnaceJobBusy'), constSrc('FURNACE_JOB_KEEP_SKILLS'),
    fnSrc('_furnaceDist'), fnSrc('furnaceJobNear'), fnSrc('setFurnaceJob'), letSrc('_furnaceJobRestored'), fnSrc('restoreFurnaceJob'),
    fnSrc('deferFurnaceJob'), fnSrc('startFurnaceJob'), fnSrc('collectFurnaceJob'), fnSrc('furnaceJobTick'), fnSrc('finishFurnaceJob'),
    'this.tryNightWork = tryNightWork; this.nightUndergroundNow = nightUndergroundNow; this.nightSkipGoal = nightSkipGoal;',
    'this.rebuildPickHere = rebuildPickHere; this.furnaceJobTick = furnaceJobTick; this.finishFurnaceJob = finishFurnaceJob;',
    'this.job = () => _furnaceJob; this.restoreFurnaceJob = restoreFurnaceJob; this.collectFurnaceJob = collectFurnaceJob;',
    'this.furnaceJobNear = furnaceJobNear;'].join('\n'));
  return sb;
}

test('nuit au travail : pioche en poche → descente à 12 sous la surface, sceau, puis « sous terre »', async () => {
  const sb = sandbox({ world: { '-1,59,0': 'air', '0,60,0': 'air' } });
  assert.strictEqual(sb.nightUndergroundNow(), false);
  assert.strictEqual(await sb.tryNightWork(), true);
  assert.strictEqual(sb.descended.targetY, 58);
  assert.strictEqual(sb.nightUndergroundNow(), true, 'y 58 compte comme sous-sol cette nuit');
  const sealed = sb.events.find((e) => e.type === 'night_work' && e.phase === 'sealed');
  assert.ok(sealed, 'event night_work sealed');
  assert.strictEqual(sealed.sealed, 2, 'la marche d où il vient et le dessus de la tête bouchés');
  assert.strictEqual(sealed.y, 58);
  assert.strictEqual(sealed.torch, false, 'pas de torche en poche');
  // Buts de surface différés, minage pas.
  assert.strictEqual(sb.nightSkipGoal({ name: 'plank_buffer', skill: 'gatherLog' }), true);
  assert.strictEqual(sb.nightSkipGoal({ name: 'iron_deep', skill: 'branchMine' }), false);
  assert.ok(sb.events.some((e) => e.type === 'night_defer' && e.goal === 'plank_buffer'));
});

test('nuit au travail : sans pioche → false (abri historique), aucune descente', async () => {
  const sb = sandbox({ items: [{ name: 'cobblestone', count: 5 }] });
  assert.strictEqual(await sb.tryNightWork(), false);
  assert.strictEqual(sb.descended, undefined);
});

test('nuit au travail : descente ratée → false, et une seule tentative par nuit', async () => {
  const sb = sandbox({ descentFails: true });
  assert.strictEqual(await sb.tryNightWork(), false);
  assert.ok(sb.events.some((e) => e.type === 'night_work' && e.phase === 'failed'));
  sb.descended = undefined;
  assert.strictEqual(await sb.tryNightWork(), false);
  assert.strictEqual(sb.descended, undefined, 'pas de 2e essai la même nuit');
});

test('nuit au travail : hostile à 5 blocs → fuite d abord', async () => {
  const sb = sandbox({ threats: [{ x: 3, y: 70, z: 4 }] });
  await sb.tryNightWork();
  assert.strictEqual(sb.fled, 1);
});

test('nightSkipGoal : hors lockdown rien n est différé', () => {
  const sb = sandbox({ lockdown: false, pos: { y: 30 } });
  assert.strictEqual(sb.nightSkipGoal({ name: 'logs', skill: 'gatherLog' }), false);
});

test('pioche cassée en bas : 3 cobble + 2 bâtons → pioche pierre refaite, event pick_rebuilt', async () => {
  const sb = sandbox({ items: [{ name: 'cobblestone', count: 10 }, { name: 'stick', count: 4 }] });
  assert.strictEqual(await sb.rebuildPickHere('branch'), true);
  assert.deepStrictEqual(sb.crafted, ['stone_pickaxe']);
  assert.ok(sb.events.some((e) => e.type === 'pick_rebuilt' && e.where === 'branch'));
});

test('pioche cassée : planches seulement → bâtons puis pioche ; sans matière → false', async () => {
  const sb = sandbox({ items: [{ name: 'cobblestone', count: 10 }, { name: 'oak_planks', count: 4 }] });
  // craftSmart('stick') du bac à sable ne crée pas de bâton → sans bâtons, pas de pioche (et on le dit)
  assert.strictEqual(await sb.rebuildPickHere('branch'), false);
  assert.deepStrictEqual(sb.crafted, ['stick']);
  assert.ok(sb.events.some((e) => e.type === 'pick_rebuild_failed' && e.reason === 'no_matter'));
});

test('fondre en minant : 9 minerais + charbon au fond → four posé, chargé, le bot repart ; ramassé une fois cuit', async () => {
  const sb = sandbox({ pos: { y: 16 }, world: { '1,16,0': 'furnace' },
    items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'raw_iron', count: 9 }, { name: 'furnace', count: 1 }, { name: 'coal', count: 4 }] });
  await sb.furnaceJobTick();
  const st = sb.events.find((e) => e.type === 'smelt_while_mining' && e.phase === 'start');
  assert.ok(st, 'event start');
  assert.strictEqual(st.raw, 9);
  assert.strictEqual(st.fuel, 'coalx2');
  assert.deepStrictEqual(sb.furnace.put, [['fuel', 2, 2], ['in', 1, 9]]);
  assert.ok(sb.job(), 'four de mine en cours');
  await sb.furnaceJobTick();                         // pas encore cuit → rien
  assert.ok(sb.job());
  sb.clock.t += 95000;
  await sb.furnaceJobTick();
  assert.strictEqual(sb.job(), null);
  const c = sb.events.find((e) => e.type === 'smelt_while_mining' && e.phase === 'collect');
  assert.strictEqual(c.ingots, 9);
  assert.strictEqual(sb.reclaimed, true, 'le four revient en poche');
});

test('fondre en minant : en surface (y > 30) on ne pose pas de four de mine', async () => {
  const sb = sandbox({ pos: { y: 64 }, items: [{ name: 'raw_iron', count: 9 }, { name: 'furnace', count: 1 }, { name: 'coal', count: 4 }] });
  await sb.furnaceJobTick();
  assert.strictEqual(sb.job(), null);
});

test('finishFurnaceJob : attend la fin de cuisson (bornée) puis ramasse', async () => {
  const sb = sandbox({ pos: { y: 16 }, world: { '1,16,0': 'furnace' },
    items: [{ name: 'raw_iron', count: 8 }, { name: 'furnace', count: 1 }, { name: 'coal', count: 1 }] });
  await sb.furnaceJobTick();
  assert.ok(sb.job());
  await sb.finishFurnaceJob('goal');
  assert.strictEqual(sb.job(), null);
  assert.ok(sb.clock.t - T0 >= 80000, 'il a attendu la cuisson');
});

test('câblage : holdForNight tente la nuit au travail et lit nightUndergroundNow ; la chaîne passe skip', () => {
  const h = fnSrc('holdForNight');
  assert.match(h, /await tryNightWork\(\)/);
  assert.match(h, /underground: nightUndergroundNow\(\)/);
  assert.match(SRC, /skip: nightSkipGoal/);
  assert.match(fnSrc('maybeNightShelter'), /underground: nightUndergroundNow\(\)/);
  assert.match(fnSrc('branchSurvivalTick'), /furnaceJobTick\(\)/);
  assert.match(fnSrc('smeltWithFurnace'), /if \(_furnaceJob && furnaceJobNear\(\)\) return \{ ok: false, reason: 'furnace_job_running' \}/);
  assert.match(fnSrc('runSkillWithTelemetry'), /finishFurnaceJob\('goal'\)/);
  assert.match(h, /nightDeferGoal\(\{ lockdown: true, underground: nightUndergroundNow\(\), skill: g\.skill \}\)/);
  assert.match(SRC, /onNoPickaxe: \(\) => rebuildPickHere\('branch'\)/);
  assert.match(fnSrc('ljIronSlice'), /act === 'mine'/);
  assert.match(fnSrc('ljIronSliceStep'), /canMine:/);
});

test('bûcheron, tranche mine : descente de 28 blocs puis branch-mine borné au fer, retour par /home work', async () => {
  const L = require('./lumberjack');
  const calls = [];
  const sb = {
    emit(e) { calls.push(['emit', e.type, e.ctx]); },
    taskToken: { cancelled: false }, TORCH_EVERY: 8,
    ljMineTargetY: L.ljMineTargetY,
    bot: { entity: { position: { x: 0, y: 70, z: 0 } } },
    descentSurvivalTick: async () => {}, branchSurvivalTick: async () => {},
    rebuildPickHere: async () => true,
    descendDiagonal: async (bot, a) => { calls.push(['descend', a.targetY]); bot.entity.position.y = a.targetY; return { ok: true }; },
    branchMine: async (bot, a) => { calls.push(['branch', a.targetY, a.stopOre.items[0], typeof a.onNoPickaxe]); return { ok: true }; },
    finishFurnaceJob: async () => { calls.push(['finish']); },
    homewarp: { goHome: (bot, name, o) => { calls.push(['home', name, o.ctx]); return true; } },
    HOME_WORK: 'work', awaitWarp: async () => {}, Math,
    ljMineDetour: L.ljMineDetour, isWaterFailReason: L.isWaterFailReason, _drownedSites: [], _drownedOffsetSeed: 0,
    Date,
  };
  vm.createContext(sb);
  run(sb, fnSrc('ljMineSlice') + '\n' + fnSrc('ljMineReturn') + '\nthis.s = ljMineSlice; this.r = ljMineReturn;');
  await sb.s();
  await sb.r();
  assert.deepStrictEqual(calls.filter((c) => c[0] !== 'emit'), [
    ['descend', 42], ['branch', 42, 'raw_iron', 'function'], ['finish'], ['home', 'work', 'lj_mine_return']]);
  assert.ok(calls.some((c) => c[1] === 'work_return'));
});

// ─── CRAFTER DANS LE TROU (22/10) ───────────────────────────────────────────────────────────────
const PIT = (y) => ({ mode: 'pit', depth: 3, anchor: { x: 0.5, y, z: 0.5 } });

test('trou de nuit : bûches en poche, pas de pioche → un craft par pas, SUR PLACE (_inPlace), event night_craft', async () => {
  const sb = sandbox({ items: [{ name: 'oak_log', count: 3 }], pos: { y: 67 } });
  const asked = [];
  sb.craftSmart = async (a) => { asked.push(a); return { ok: true }; };
  assert.strictEqual(await sb.shelterWhileSealed(PIT(67)), null, 'pas encore de pioche : on reste');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(asked)), [{ name: 'oak_planks', count: 3, _inPlace: true }]);
  const ev = sb.events.find((e) => e.type === 'night_craft');
  assert.strictEqual(ev.goal, 'oak_planks');
  assert.strictEqual(ev.ok, true);
});

test('trou de nuit : craft raté → pas retenté cette nuit ; PV critiques → retenté', async () => {
  const sb = sandbox({ items: [{ name: 'oak_planks', count: 12 }], pos: { y: 67 } });
  const asked = [];
  sb.craftSmart = async (a) => { asked.push(a.name); return { ok: false, reason: asked.length === 1 ? 'low_hp_skip' : 'no_table:no_space' }; };
  await sb.shelterWhileSealed(PIT(67));
  await sb.shelterWhileSealed(PIT(67));
  await sb.shelterWhileSealed(PIT(67));
  assert.deepStrictEqual(asked, ['crafting_table', 'crafting_table'], 'low_hp_skip retenté, no_space non');
  assert.ok(sb.events.some((e) => e.type === 'night_craft' && e.ok === false && e.reason === 'no_table:no_space'));
});

test('trou de nuit : PV bas + de quoi manger → manger AVANT tout craft (muré : sealed)', async () => {
  const sb = sandbox({ items: [{ name: 'oak_planks', count: 12 }], pos: { y: 67 }, eats: true });
  sb.craftSmart = async () => { throw new Error('ne doit pas crafter ce pas-ci'); };
  assert.strictEqual(await sb.shelterWhileSealed(PIT(67)), null);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sb.eatCalls)), [['shelter', { sealed: true }]]);
});

test('trou de nuit : craft refusé à PV critiques → une tentative par minute, pas à chaque pas', async () => {
  const sb = sandbox({ items: [{ name: 'oak_planks', count: 12 }], pos: { y: 67 } });
  const asked = [];
  sb.lowHpBlocked = true;
  sb.craftSmart = async (a) => { asked.push(a.name); return { ok: false, reason: 'low_hp_skip' }; };
  await sb.shelterWhileSealed(PIT(67));
  sb.clock.t += 5000; await sb.shelterWhileSealed(PIT(67));
  sb.clock.t += 5000; await sb.shelterWhileSealed(PIT(67));
  assert.deepStrictEqual(asked, ['crafting_table'], '10 s : une seule tentative');
  assert.strictEqual(sb.events.filter((e) => e.type === 'night_craft').length, 1, 'pas de spam night_craft');
  sb.clock.t += 60000; await sb.shelterWhileSealed(PIT(67));
  assert.deepStrictEqual(asked, ['crafting_table', 'crafting_table'], 'une minute plus tard : on retente');
  sb.lowHpBlocked = false; sb.craftSmart = async (a) => { asked.push(a.name); return { ok: true }; };
  sb.clock.t += 1000; await sb.shelterWhileSealed(PIT(67));
  assert.strictEqual(asked.length, 3, 'PV remontés : craft tout de suite');
});

test('trou de nuit : pioche en main → leave_down, surface = fond + profondeur, puis tryNightWork depuis l abri (hostile ignoré)', async () => {
  const sb = sandbox({ items: [{ name: 'wooden_pickaxe', count: 1 }], pos: { y: 67 }, threats: [{ x: 1, y: 70, z: 1 }] });
  assert.strictEqual(await sb.shelterWhileSealed(PIT(67)), 'leave_down');
  const ho = sb.shelterCraft().handoff;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ho)), { surfaceY: 70, cellMode: 'pit' });
  assert.strictEqual(await sb.tryNightWork({ fromShelter: ho }), true);
  assert.strictEqual(sb.fled, undefined, 'pas de fuite : l hostile est au-dessus du toit');
  assert.strictEqual(sb.descended.targetY, 58, '12 sous la SURFACE');
  assert.ok(sb.events.some((e) => e.type === 'night_work' && e.phase === 'from_shelter' && e.target === 58));
  assert.ok(sb.events.some((e) => e.type === 'night_work' && e.phase === 'sealed'));
});

test('trou de nuit : cellule murée, cartographe, hors lockdown → jamais de descente', async () => {
  const a = sandbox({ items: [{ name: 'wooden_pickaxe', count: 1 }], pos: { y: 67 } });
  assert.strictEqual(await a.shelterWhileSealed({ mode: 'walled', depth: 0, anchor: { x: 0.5, y: 67, z: 0.5 } }), null);
  const b = sandbox({ items: [{ name: 'wooden_pickaxe', count: 1 }], pos: { y: 67 } });
  b.IS_MAPPER = true;
  assert.strictEqual(await b.shelterWhileSealed(PIT(67)), null);
  const c = sandbox({ lockdown: false, items: [{ name: 'oak_log', count: 3 }], pos: { y: 67 } });
  c.craftSmart = async () => { throw new Error('ne doit pas crafter'); };
  assert.strictEqual(await c.shelterWhileSealed(PIT(67)), null);
});

test('câblage : l abri reçoit whileSealed, maybeNightShelter enchaîne tryNightWork({ fromShelter }), les crafts ne marchent pas', () => {
  const m = fnSrc('maybeNightShelter');
  assert.match(m, /whileSealed: shelterWhileSealed/);
  assert.match(m, /sres\.handoff === 'night_work'/);
  assert.match(m, /await tryNightWork\(\{ fromShelter: ho \}\)/);
  const w = fnSrc('withCraftingTable');
  assert.match(w, /inPlace \? TABLE_REACH : TABLE_SEEK/);
  assert.match(w, /const spot = inPlace \? null : findLandTarget/);
  assert.match(w, /tableSeen: !inPlace &&/);
  assert.match(fnSrc('_craftSmartRaw'), /withCraftingTable\(\(\) => craftItem\(bot, args\), \{ inPlace \}\)/);
});

// ─── FOUR DE MINE DURABLE (22/10, NethBot1/3 : 44 + 13 minerais de fer laissés dans des fours) ──────────
test('four de mine : persisté dans le mémo base au lancement, effacé au ramassage', async () => {
  const sb = sandbox({ pos: { y: 16 }, world: { '1,16,0': 'furnace' },
    items: [{ name: 'raw_iron', count: 9 }, { name: 'furnace', count: 1 }, { name: 'coal', count: 4 }], memo: { base: { x: 1 } } });
  await sb.furnaceJobTick();
  assert.ok(sb.memo.furnaceJob, 'job écrit dans le mémo');
  assert.strictEqual(sb.memo.furnaceJob.count, 9);
  assert.deepStrictEqual(sb.memo.base, { x: 1 }, 'fusion : le reste du mémo est gardé');
  sb.clock.t += 95000;
  await sb.furnaceJobTick();
  assert.strictEqual(sb.job(), null);
  assert.strictEqual(sb.memo.furnaceJob, undefined, 'effacé une fois ramassé');
});

test('four de mine : relance du process → le job est relu du mémo (une seule fois)', () => {
  const job = { pos: { x: 1, y: 16, z: 0 }, count: 13, at: T0 - 60000, readyAt: T0 + 70000 };
  const sb = sandbox({ memo: { furnaceJob: job } });
  sb.restoreFurnaceJob();
  assert.deepStrictEqual(sb.job(), job);
  assert.ok(sb.events.some((e) => e.type === 'smelt_while_mining' && e.phase === 'restored' && e.count === 13));
});

test('four de mine : chunk pas chargé → PAS perdu, job gardé et re-tenté dans 3 min', async () => {
  const job = { pos: { x: 1, y: 16, z: 0 }, count: 13, at: T0 - 200000, readyAt: T0 - 60000 };
  const sb = sandbox({ pos: { y: 16 }, memo: { furnaceJob: job } });
  sb.restoreFurnaceJob();
  sb.bot.blockAt = () => null;
  assert.strictEqual(await sb.collectFurnaceJob('goal'), false);
  assert.ok(sb.job(), 'job gardé');
  assert.ok(!sb.events.some((e) => e.phase === 'lost'));
  assert.ok(sb.events.some((e) => e.phase === 'open_failed' && e.reason === 'unloaded'));
  assert.ok(sb.job().retryAt > T0);
  sb.events.length = 0;
  assert.strictEqual(await sb.collectFurnaceJob('goal'), false);
  assert.strictEqual(sb.events.length, 0, 'pas de nouvel essai avant 3 min');
});

test('four de mine 40 blocs plus bas, chantier `work` à côté → /home work puis ramassage', async () => {
  const job = { pos: { x: 1, y: 26, z: 0 }, count: 14, at: T0 - 200000, readyAt: T0 - 60000 };
  const sb = sandbox({ pos: { x: 3, y: 66, z: 1 }, world: { '1,26,0': 'furnace' }, memo: { furnaceJob: job },
    workPos: { x: 3, z: 2 }, warpTo: { x: 2.5, y: 26, z: 1.5 } });
  sb.restoreFurnaceJob();
  assert.strictEqual(sb.furnaceJobNear(), true, '40 blocs : à portée');
  assert.strictEqual(await sb.collectFurnaceJob('goal'), true);
  assert.strictEqual(sb.warps, 1);
  assert.strictEqual(sb.job(), null);
  assert.ok(sb.events.some((e) => e.phase === 'collect' && e.ingots === 9));
});

test('four de mine loin sans raccourci : ni oublié, ni ouvert à distance ; ne bloque plus les autres fours', async () => {
  const job = { pos: { x: 1, y: 16, z: 0 }, count: 13, at: T0 - 200000, readyAt: T0 - 60000 };
  const sb = sandbox({ pos: { x: 300, y: 64, z: 0 }, world: { '1,16,0': 'furnace' }, memo: { furnaceJob: job } });
  sb.restoreFurnaceJob();
  await sb.finishFurnaceJob('goal');
  assert.ok(sb.job(), 'gardé');
  assert.strictEqual(sb.furnace, undefined, 'aucune ouverture tentée');
  assert.strictEqual(sb.furnaceJobNear(), false);
});
