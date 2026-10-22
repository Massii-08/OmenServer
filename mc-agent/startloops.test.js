'use strict';
// Trois boucles du démarrage « zéro → armure de fer » (mesure du 21/10, inventaires vidés au départ) :
//   1. NethBot3 : `help_pick` en boucle 15 min — objectif persisté iron_help alors que l'armure avait
//      disparu (RCON clear) → objectiveForStart ramène à iron_armor (chaîne de démarrage complète).
//   2. NethBot2 : `crafting_table` craft_no_effect ×4 — table du four abandonnée à côté, re-craft sans
//      effet → le but REPREND d'abord une table posée (recycleNearbyTable), le craft fait Échap + 1 retry.
//   3. NethBot1 : but `bed` retenu 455 s par l'abri de nuit → sauté la nuit (bot nu), chasse bornée.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const G = require('./goals');
const B = require('./bed');

const IRON_SET = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];

// ─── 1. objectiveForStart ───────────────────────────────────────────────────────────────────────
test('objectiveForStart : iron_help / mapper_armor sans armure (inventaire vidé) → iron_armor', () => {
  for (const o of ['iron_help', 'mapper_armor']) {
    assert.strictEqual(G.objectiveForStart(o, { inv: {}, worn: [] }), 'iron_armor', o);
    // 3 pièces portées sur 4 : l'armure n'est plus couverte → on la finit d'abord.
    assert.strictEqual(G.objectiveForStart(o, { inv: {}, worn: IRON_SET.slice(0, 3) }), 'iron_armor', o + ' 3/4');
  }
});

test('objectiveForStart : armure fer couverte (portée OU en poche) → objectif conservé', () => {
  assert.strictEqual(G.objectiveForStart('iron_help', { inv: {}, worn: IRON_SET }), 'iron_help');
  assert.strictEqual(G.objectiveForStart('mapper_armor', { inv: { iron_boots: 1 }, worn: IRON_SET.slice(0, 3) }), 'mapper_armor');
});

test('objectiveForStart : les autres objectifs ne bougent jamais (diamond lançable sans armure)', () => {
  for (const o of ['iron_armor', 'diamond', 'mapper', 'resource', 'stone_pickaxe', 'iron_pickaxe']) {
    assert.strictEqual(G.objectiveForStart(o, { inv: {}, worn: [] }), o);
  }
  assert.strictEqual(G.objectiveForStart('iron_help', null), 'iron_help', 'contexte illisible : inchangé');
});

test('objectiveForStart (22/10, NethBot1 session 239) : bûcheron sans 4/4 PORTÉES → iron_armor', () => {
  // inventaire vidé (RCON clear, armure comprise) : la règle d'éligibilité (4/4 portées) vaut au démarrage
  assert.strictEqual(G.objectiveForStart('lumberjack', { inv: {}, worn: [] }), 'iron_armor');
  assert.strictEqual(G.objectiveForStart('lumberjack', { inv: {}, worn: IRON_SET.slice(0, 3) }), 'iron_armor', '3/4');
  // en poche ne suffit pas : le bûcheron est élu sur l'armure PORTÉE
  assert.strictEqual(G.objectiveForStart('lumberjack', { inv: { iron_boots: 1 }, worn: IRON_SET.slice(0, 3) }), 'iron_armor');
  assert.strictEqual(G.objectiveForStart('lumberjack', { inv: {}, worn: IRON_SET }), 'lumberjack');
  assert.strictEqual(G.objectiveForStart('lumberjack',
    { inv: {}, worn: ['diamond_helmet', 'iron_chestplate', 'netherite_leggings', 'iron_boots'] }), 'lumberjack', 'fer ou mieux');
  assert.strictEqual(G.objectiveForStart('lumberjack', null), 'lumberjack', 'contexte illisible : inchangé');
});

test('NethBot3 : à vide, iron_help commence par help_pick ; iron_armor commence par logs', () => {
  const ctx = { inv: {}, worn: [], y: 64 };
  assert.strictEqual(G.firstUnmet(G.chainFor('iron_help'), ctx).name, 'help_pick', 'le piège mesuré');
  const fixed = G.objectiveForStart('iron_help', ctx);
  assert.strictEqual(G.firstUnmet(G.chainFor(fixed), ctx).name, 'logs', 'la chaîne de démarrage normale reprend la main');
});

// ─── 3. lit ─────────────────────────────────────────────────────────────────────────────────────
test('bedGoalMet : nuit (bot nu) → sauté, même avec un mouton connu ; un lit en poche se pose quand même', () => {
  const base = { inv: { oak_log: 5 }, sheepNear: true, planksOk: true };
  assert.strictEqual(B.bedGoalMet(base), false, 'de jour : à faire');
  assert.strictEqual(B.bedGoalMet(Object.assign({}, base, { nightLockdown: true })), true);
  assert.strictEqual(B.bedGoalMet({ inv: { white_bed: 1 }, nightLockdown: true }), false);
  assert.strictEqual(B.bedGoalMet({ inv: {}, sheepNear: false }), true, 'aucun mouton connu : sauté (inchangé)');
});

test('ensureBedGoal : chasse bornée par BED_HUNT_BUDGET_MS (lu dans la boucle) ; bedCtxNow expose nightLockdown', () => {
  const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const fn = SRC.match(/^async function ensureBedGoal\(\) \{[\s\S]*?^\}$/m)[0];
  assert.match(fn, /if \(Date\.now\(\) - huntT0 > BED_HUNT_BUDGET_MS\) break;/);
  const ctx = SRC.match(/^function bedCtxNow\(\) \{[\s\S]*?^\}$/m)[0];
  assert.match(ctx, /nightLockdown:/);
  assert.ok(B.BED_HUNT_BUDGET_MS > 0 && B.BED_HUNT_BUDGET_MS < 240000, 'sous le délai de skill (240 s)');
});

// ─── 2. table : reprise avant craft (VRAI texte d'index.js en bac à sable vm) ───────────────────
const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const fnSrc = (name) => {
  const m = SRC.match(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'));
  assert.ok(m, name + ' introuvable au niveau module');
  return m[0];
};
const run = (sb, code) => vm.runInContext("'use strict';\n" + code, sb);

function tableSandbox({ tableSeen = true, reclaimWorks = true } = {}) {
  const inv = {};
  const sb = {
    events: [], crafts: [], reclaims: [], blacklisted: [],
    emit(e) { sb.events.push(e); },
    TABLE_SEEK: 48, TABLE_REACH: 6, _badTables: { has: () => false, add: () => {} },
    recycleWorthIt: require('./tableSpot').recycleWorthIt,           // 22/10 : table du même étage
    tableKey: (p) => `${p.x},${p.y},${p.z}`,
    pfGoals: { GoalNear: function () {} },
    withTimeout: async (p) => p, stopMotion: () => {},
    _nearestTable: () => (tableSeen && !inv.crafting_table && !sb.reclaimed ? { position: { x: 2, y: 64, z: 0 } } : null),
    reclaimBlock: async (pos) => { sb.reclaims.push(pos); if (reclaimWorks) { sb.reclaimed = true; inv.crafting_table = 1; } },
    craftItem: async (b, a) => { sb.crafts.push(a.name); return { ok: false, reason: 'craft_no_effect' }; },
    _craftPrereqs: async () => null,
    withCraftingTable: async (fn) => fn(),
    bot: {
      // 10 blocs avant le trajet, 2 après (22/10 : la reprise n'est tentée que si le goto est ARRIVÉ)
      entity: { position: { y: 64, distanceTo: () => (sb.arrived ? 2 : 10) } },
      pathfinder: { goto: async () => { sb.arrived = true; } },
      blockAt: () => (sb.reclaimed ? { name: 'air' } : { name: 'crafting_table' }),
      inventory: { items: () => Object.entries(inv).filter(([, c]) => c > 0).map(([name, count]) => ({ name, count })) },
    },
  };
  vm.createContext(sb);
  for (const f of ['recycleNearbyTable', 'blacklistBadTable', '_craftSmartRaw']) run(sb, fnSrc(f));
  return sb;
}

test('but crafting_table : une table posée reprenable est REPRISE, aucun craft', async () => {
  const sb = tableSandbox();
  const r = await run(sb, "_craftSmartRaw({ name: 'crafting_table', count: 1 })");
  assert.deepStrictEqual({ ...r }, { ok: true, recycled: true });   // objet du bac à sable : autre realm
  assert.deepStrictEqual(sb.crafts, []);
  assert.ok(sb.events.some((e) => e.type === 'table_recycled' && e.ok === true));
});

test('but crafting_table : reprise ratée → table en liste noire, puis craft (vraie raison remontée)', async () => {
  const sb = tableSandbox({ reclaimWorks: false });
  const r = await run(sb, "_craftSmartRaw({ name: 'crafting_table', count: 1 })");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'craft_no_effect');
  assert.deepStrictEqual(sb.crafts, ['crafting_table']);
  assert.ok(sb.events.some((e) => e.type === 'table_blacklisted' && e.why === 'reclaim_failed'));
});

test('but crafting_table : aucune table en vue → craft direct ; table déjà en poche / autre item → pas de reprise', async () => {
  const sb = tableSandbox({ tableSeen: false });
  await run(sb, "_craftSmartRaw({ name: 'crafting_table', count: 1 })");
  assert.deepStrictEqual(sb.crafts, ['crafting_table']);
  assert.deepStrictEqual(sb.reclaims, []);
  const sb2 = tableSandbox();
  await run(sb2, "_craftSmartRaw({ name: 'stick', count: 1 })");
  assert.deepStrictEqual(sb2.reclaims, [], 'seul le but table reprend une table');
});

test('startAutonomous : objectiveForStart branché AVANT setObjective, event objective_regressed', () => {
  const fn = fnSrc('startAutonomous');
  const i = fn.indexOf('objectiveForStart(objType');
  assert.ok(i > 0 && i < fn.indexOf('setObjective(world'), 'la régression précède la persistance');
  assert.match(fn, /type: 'objective_regressed'/);
});
