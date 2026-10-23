'use strict';
// CÂBLAGE (23/10) : buts de CRAFT bois sans matière → demande au bûcheron AVANT le trajet surface ;
// zone prouvée sans bois → la demande vaut aussi au-dessus de y 50 ; fournées de bâtons sur plusieurs
// essences. Vrai texte d'index.js exécuté en `vm` strict (piège #56 : un identifiant hors niveau module
// → ReferenceError ici).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const L = require('./lumberjack');
const { buildCtxInv } = require('./goals');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const grab = (re, label) => { const m = SRC.match(re); assert.ok(m, label + ' introuvable'); return m[0]; };
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), name);
const constSrc = (name) => grab(new RegExp(`^const ${name} = [^;]+;`, 'm'), name);
const run = (sb, code) => vm.runInContext("'use strict';\n" + code, sb);

function sandbox(o = {}) {
  const sb = {
    waits: [], Set, Object, Number, Math,
    bot: { inventory: { items: () => (o.items || []) } },
    IS_MAPPER: !!o.mapper, isLumberjackObjective: () => !!o.lj, _nearestTable: () => (o.table ? {} : null),
    isWoodGoal: L.isWoodGoal, woodGoalShortage: L.woodGoalShortage, buildCtxInv,
    woodWaitStep: async (g, why) => { sb.waits.push({ g, why }); return o.wait === undefined ? { ok: true } : o.wait; },
    _zoneLogsNotFound: o.logsNotFound || 0, LOGS_NOT_FOUND_MAX: 8, _needsWoodTrip: !!o.needsTrip,
  };
  vm.createContext(sb);
  run(sb, constSrc('WOOD_GOALS'));
  run(sb, fnSrc('woodGoalRequestStep') + fnSrc('woodNoWoodHere'));
  return sb;
}

test('woodGoalRequestStep : `sticks` avec 1 planche → demande au bûcheron (gatherLog 16, why wood_goal_short)', async () => {
  const sb = sandbox({ items: [{ name: 'oak_planks', count: 1 }, { name: 'stick', count: 1 }] });
  const r = await run(sb, "woodGoalRequestStep({ name: 'sticks', skill: 'craft', args: { name: 'stick', count: 4 } })");
  assert.deepStrictEqual(r, { ok: true });
  assert.strictEqual(sb.waits.length, 1);
  assert.strictEqual(sb.waits[0].g.skill, 'gatherLog');
  assert.strictEqual(sb.waits[0].g.args.count, 16);
  assert.strictEqual(sb.waits[0].why, 'wood_goal_short');
});

test('woodGoalRequestStep : matière en poche, but non-bois, but gatherLog, cartographe, bûcheron → null sans demande', async () => {
  const has = [{ name: 'birch_planks', count: 6 }, { name: 'oak_planks', count: 2 }];
  for (const [o, g] of [
    [{ items: has }, "{ name: 'sticks', skill: 'craft' }"],
    [{ items: [] }, "{ name: 'iron_deep', skill: 'branchMine' }"],
    [{ items: [] }, "{ name: 'logs', skill: 'gatherLog' }"],
    [{ items: [], mapper: true }, "{ name: 'sticks', skill: 'craft' }"],
    [{ items: [], lj: true }, "{ name: 'crafting_table', skill: 'craft' }"],
  ]) {
    const sb = sandbox(o);
    assert.strictEqual(await run(sb, `woodGoalRequestStep(${g})`), null);
    assert.strictEqual(sb.waits.length, 0);
  }
});

test('woodNoWoodHere : verrou noWood (≥ 8 bois introuvables) ou échec bois prouvé', () => {
  assert.strictEqual(run(sandbox(), 'woodNoWoodHere()'), false);
  assert.strictEqual(run(sandbox({ logsNotFound: 8 }), 'woodNoWoodHere()'), true);
  assert.strictEqual(run(sandbox({ needsTrip: true }), 'woodNoWoodHere()'), true);
});

test('câblage : woodWaitStep passe noWoodHere ; le planner tente la demande de craft bois AVANT le skill ; craft réduit', () => {
  assert.match(fnSrc('woodWaitStep'), /noWoodHere: woodNoWoodHere\(\),/);
  assert.match(fnSrc('runSkillWithTelemetry'), /const _wood = \(await woodWaitStep\(g\)\) \|\| \(await woodGoalRequestStep\(g\)\);/);
  const sm = fnSrc('_craftSmartRaw');
  assert.match(sm, /woodCountFallback\(args\.name, items0,/);
  assert.ok(sm.indexOf('woodCountFallback') < sm.indexOf('_craftPrereqs(args)'), 'la réduction précède le plan');
});
