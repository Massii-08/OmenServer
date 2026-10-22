'use strict';
// CÂBLAGE des correctifs du 20/10 (sessions ≥ 310) — on exécute le VRAI texte de index.js dans un bac
// à sable `vm` strict (piège #56 : un identifiant hors niveau module lève ici une ReferenceError).
//   _craftPrereqs / _craftSmartRaw : intermédiaires (planches → bâtons → table) avant la recette ;
//   pickFixPass                    : backoff du filet « pioche » quand la poche ne change pas ;
//   fleeBeforeHide / auraTick      : sprinter avant de creuser l'abri, l'aura ne casse pas le sprint.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const CP = require('./craftPlan');
const RF = require('./respawnFlee');
const GH = require('./goalHold');

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

// ─── crafts ────────────────────────────────────────────────────────────────────────────────────
function craftSandbox({ inv, tableNear = false, craftItemImpl } = {}) {
  const sb = {
    events: [], crafts: [], inv: Object.assign({}, inv),
    emit(e) { sb.events.push(e); },
    planIntermediates: CP.planIntermediates, craftSignature: CP.craftSignature, createCraftBackoff: CP.createCraftBackoff,
    TABLE_SEEK: 48, _badTables: { has: () => false },
    _nearestTable: () => (tableNear ? { position: { x: 1, y: 70, z: 0 } } : null),
    withCraftingTable: async (fn) => fn(),
    recycleNearbyTable: async () => null, blacklistBadTable: () => {},   // aucune table posée en vue (21/10)
    Date: { now: () => sb.clock.t }, clock: { t: 0 },
    withTimeout: async (p) => p,
    bot: { inventory: { items: () => Object.entries(sb.inv).filter(([, c]) => c > 0).map(([name, count]) => ({ name, count })) } },
  };
  // craftItem simulé : applique la vraie recette 2×2 pour planches / bâtons / table.
  sb.craftItem = craftItemImpl ? (b, a) => craftItemImpl(sb, a) : async (b, a) => {
    sb.crafts.push(a.name + 'x' + a.count);
    const take = (n, k) => { if ((sb.inv[n] || 0) < k) return false; sb.inv[n] -= k; return true; };
    if (a.name.endsWith('_planks')) { const base = a.name.slice(0, -7); if (!take(base + '_log', a.count)) return { ok: false, reason: 'no_recipe' }; sb.inv[a.name] = (sb.inv[a.name] || 0) + 4 * a.count; return { ok: true }; }
    if (a.name === 'stick') {
      const e = Object.keys(sb.inv).find((n) => n.endsWith('_planks') && sb.inv[n] >= 2 * a.count);
      if (!e) return { ok: false, reason: 'no_recipe' };
      sb.inv[e] -= 2 * a.count; sb.inv.stick = (sb.inv.stick || 0) + 4 * a.count; return { ok: true };
    }
    if (a.name === 'crafting_table') {
      const e = Object.keys(sb.inv).find((n) => n.endsWith('_planks') && sb.inv[n] >= 4);
      if (!e) return { ok: false, reason: 'no_recipe' };
      sb.inv[e] -= 4; sb.inv.crafting_table = (sb.inv.crafting_table || 0) + 1; return { ok: true };
    }
    return { ok: true, crafted: a.name };
  };
  vm.createContext(sb);
  run(sb, constSrc('CRAFT_PLAN_MAX_STEPS'));
  for (const f of ['_craftPrereqs', '_craftSmartRaw']) run(sb, fnSrc(f));
  return sb;
}

test('bûches seulement → craft_plan puis planches, bâtons, table, PUIS la pioche', async () => {
  const sb = craftSandbox({ inv: { cobblestone: 188, birch_log: 15, acacia_planks: 1 } });
  const r = await run(sb, "_craftSmartRaw({ name: 'stone_pickaxe', count: 1 })");
  assert.deepStrictEqual(sb.crafts, ['birch_planksx2', 'stickx1', 'crafting_tablex1', 'stone_pickaxex1']);
  assert.strictEqual(r.crafted, 'stone_pickaxe');
  const ev = sb.events.find((e) => e.type === 'craft_plan');
  assert.ok(ev && ev.item === 'stone_pickaxe' && ev.steps.length === 3, JSON.stringify(ev));
});

test('cas MapBot2 : 3 planches, pas de table, pas de bûche → no_wood:table SANS marcher ni poser', async () => {
  let walked = false;
  const sb = craftSandbox({ inv: { cobblestone: 930, birch_planks: 3, stick: 8 } });
  sb.withCraftingTable = async () => { walked = true; return { ok: false, reason: 'no_table:unknown_item' }; };
  const r = await run(sb, "_craftSmartRaw({ name: 'stone_pickaxe', count: 1 })");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { ok: false, reason: 'no_wood:table' });
  assert.deepStrictEqual(sb.crafts, [], 'aucun craft tenté');
  assert.strictEqual(walked, false);
});

test('objet hors table de recettes → chemin historique intact', async () => {
  const sb = craftSandbox({ inv: { gold_ingot: 9 } });
  const r = await run(sb, "_craftSmartRaw({ name: 'golden_apple', count: 1 })");
  assert.strictEqual(r.crafted, 'golden_apple');
  assert.ok(!sb.events.some((e) => e.type === 'craft_plan'));
});

test('étape intermédiaire ratée → raison intermediate:<étape>:<raison>', async () => {
  const sb = craftSandbox({ inv: { cobblestone: 9, oak_log: 3 }, craftItemImpl: async () => ({ ok: false, reason: 'craft_no_effect' }) });
  const r = await run(sb, "_craftSmartRaw({ name: 'stone_pickaxe', count: 1 })");
  assert.strictEqual(r.reason, 'intermediate:oak_planks:craft_no_effect');
});

function pickSandbox() {
  const sb = craftSandbox({ inv: { cobblestone: 930, birch_planks: 3, stick: 8 } });
  sb.calls = 0;
  sb.craftSmart = async (a) => { sb.calls++; return run(sb, `_craftSmartRaw(${JSON.stringify(a)})`); };
  run(sb, constSrc('_pickBackoff'));
  run(sb, fnSrc('pickFixPass'));
  return sb;
}

test('pickFixPass : poche inchangée → 1er échec puis attente 40 s, 80 s ; nouvelle bûche → retenté tout de suite', async () => {
  const sb = pickSandbox();
  const hasPick = () => false;
  sb.hasPick = hasPick;
  await run(sb, "pickFixPass(['stone_pickaxe'], hasPick)");
  assert.strictEqual(sb.calls, 1);
  let ev = sb.events.filter((e) => e.type === 'craft_backoff');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ev[0])), { type: 'craft_backoff', item: 'stone_pickaxe', reason: 'no_wood:table', wait_s: 40 });
  sb.clock.t = 20000;                                  // passe suivante du filet (20 s) : bloquée
  await run(sb, "pickFixPass(['stone_pickaxe'], hasPick)");
  assert.strictEqual(sb.calls, 1, 'pas retenté pendant le backoff');
  sb.clock.t = 40000;
  await run(sb, "pickFixPass(['stone_pickaxe'], hasPick)");
  assert.strictEqual(sb.calls, 2);
  ev = sb.events.filter((e) => e.type === 'craft_backoff');
  assert.strictEqual(ev[1].wait_s, 80, 'exponentiel');
  sb.clock.t = 41000;
  sb.inv.birch_log = 1;                                // le bûcheron livre
  await run(sb, "pickFixPass(['stone_pickaxe'], hasPick)");
  assert.strictEqual(sb.calls, 3, 'matière changée → retenté immédiatement');
});

test('pickFixPass : pioche obtenue → pickaxe_recrafted et backoff effacé', async () => {
  const sb = pickSandbox();
  sb.inv.birch_log = 4;
  let got = false;
  sb.hasPick = () => got;
  sb.craftSmart = async () => { got = true; return { ok: true }; };
  const r = await run(sb, "pickFixPass(['stone_pickaxe', 'wooden_pickaxe'], hasPick)");
  assert.strictEqual(r, true);
  assert.ok(sb.events.some((e) => e.type === 'pickaxe_recrafted' && e.name === 'stone_pickaxe'));
  assert.strictEqual(run(sb, '_pickBackoff.size()'), 0);
});

test('le filet pioche passe par pickFixPass (plus de boucle craftSmart nue)', () => {
  assert.match(SRC, /_pickFixBusy = true;\n    await pickFixPass\(plan, hasPick\);/);
});

test('withCraftingTable : table introuvable et non fabricable → no_table:no_wood_for_table (plus unknown_item)', () => {
  assert.match(fnSrc('withCraftingTable'), /return \{ ok: false, reason: 'no_table:no_wood_for_table' \};/);
});

// ─── fuite avant l'abri ────────────────────────────────────────────────────────────────────────
function fleeSandbox({ zombies, moveTo }) {
  const clock = { t: 0 };
  const sb = {
    events: [], goals: [], sprint: [], clock,
    emit(e) { sb.events.push(e); },
    Date: { now: () => clock.t },
    respawnFleePlan: RF.respawnFleePlan, fleeStuck: RF.fleeStuck,
    RESPAWN_FLEE_LEGS: RF.RESPAWN_FLEE_LEGS, RESPAWN_FLEE_LEG_MS: RF.RESPAWN_FLEE_LEG_MS, RESPAWN_STUCK_MS: RF.RESPAWN_STUCK_MS,
    holdGoal: GH.hold, holdSetGoal: GH.holdSetGoal, releaseGoalHold: GH.release,
    _creeperHold: GH.createHoldState(),
    pfGoals: { GoalNearXZ: function (x, z, r) { this.x = x; this.z = z; this.r = r; } },
    isThreatHostile: (e) => e.name === 'zombie',
    RANGED: require('./reflexes').RANGED,   // respawnThreatsNow marque les tireurs (live 22/10)
    zombies,
    bot: {
      health: 20,
      entity: { position: { x: 0, y: 70, z: 0 } },
      get entities() { return Object.fromEntries(sb.zombies.map((p, i) => [i, { name: 'zombie', position: p }])); },
      pvp: { stopped: 0, stop() { this.stopped++; } },
      pathfinder: { setGoal(g) { sb.goals.push(g); } },
      setControlState(k, v) { if (k === 'sprint') sb.sprint.push(v); },
    },
  };
  sb.sleep = async (ms) => { clock.t += ms; if (moveTo) moveTo(sb, clock.t); };
  vm.createContext(sb);
  run(sb, letSrc('_respawnFlee'));
  for (const f of ['respawnThreatsNow', 'fleeBeforeHide']) run(sb, fnSrc(f));
  return sb;
}

test('fleeBeforeHide : zombie à 2 blocs → sprint vers un but XZ à l opposé, verrou posé puis relâché', async () => {
  const sb = fleeSandbox({
    zombies: [{ x: 2, y: 70, z: 0 }],
    moveTo: (s, t) => { s.bot.entity.position = { x: -t / 100, y: 70, z: 0 }; },   // court vers l'ouest
  });
  const fled = await run(sb, "fleeBeforeHide('spawn')");
  assert.strictEqual(fled, true);
  const ev = sb.events.find((e) => e.type === 'respawn_flee');
  assert.ok(ev && ev.why === 'spawn' && ev.hostiles === 1 && ev.dist === 2, JSON.stringify(ev));
  assert.ok(sb.goals[0].x < 0, 'but à l ouest');
  assert.deepStrictEqual(sb.sprint, [true]);
  assert.strictEqual(sb.bot.pvp.stopped, 1);
  assert.strictEqual(sb._creeperHold.until, 0, 'verrou relâché');
  assert.strictEqual(run(sb, '_respawnFlee'), null);
  const done = sb.events.find((e) => e.type === 'respawn_flee_done');
  assert.ok(done && done.clear === true, JSON.stringify(done));
});

test('fleeBeforeHide : rien à ≤ 8 blocs → pas de fuite (on creuse tout de suite)', async () => {
  const sb = fleeSandbox({ zombies: [{ x: 10, y: 70, z: 0 }] });
  assert.strictEqual(await run(sb, "fleeBeforeHide('spawn')"), false);
  assert.strictEqual(sb.goals.length, 0);
  assert.strictEqual(sb.clock.t, 0);
});

test('fleeBeforeHide : coincé → _respawnFlee.stuck vrai (l aura peut frapper) ; borné à 2 jambes', async () => {
  let sawStuck = false;
  const sb = fleeSandbox({ zombies: [{ x: 2, y: 70, z: 0 }], moveTo: (s) => { if (s.bot.entity && run(s, '_respawnFlee && _respawnFlee.stuck')) sawStuck = true; } });
  await run(sb, "fleeBeforeHide('spawn')");
  assert.ok(sawStuck);
  assert.strictEqual(sb.events.filter((e) => e.type === 'respawn_flee').length, RF.RESPAWN_FLEE_LEGS);
  assert.ok(sb.clock.t <= RF.RESPAWN_FLEE_LEGS * RF.RESPAWN_FLEE_LEG_MS + 1000, 'borné');
  const done = sb.events.find((e) => e.type === 'respawn_flee_done');
  assert.strictEqual(done.clear, false);
});

test('hideFromThreat fuit avant de creuser ; auraTick se tait pendant une fuite non coincée', () => {
  const h = fnSrc('hideFromThreat');
  const iFlee = h.indexOf('fleeBeforeHide(why)');
  const iDig = h.indexOf('shelterUntilDawn(');
  assert.ok(iFlee > 0 && iFlee < iDig, 'la fuite précède le creusage');
  assert.match(fnSrc('auraTick'), /if \(_respawnFlee && !_respawnFlee\.stuck\) return;/);
});
