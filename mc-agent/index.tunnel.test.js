'use strict';
// Câblage index.js — défense en tunnel + torches avant de descendre (run 21/10 soir, NethBot2/3 :
// 14 morts en `iron_deep`, dont 5 « combat puis fuite dans le noir »). Sandbox vm : on extrait les
// fonctions de NIVEAU MODULE (piège #56) et on vérifie ce qu'elles appellent réellement.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(re, label) {
  const m = SRC.match(re);
  assert.ok(m, `${label} introuvable dans index.js (déplacé, renommé, ou déclaré hors niveau module ?)`);
  return m[0];
}
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);
const run = (sb, code) => vm.runInContext("'use strict';\n" + code, sb);

test('tunnelAwareFlee : délègue à tunnelFlee avec la VRAIE fuite en repli (fleeFrom) et de quoi murer/manger', () => {
  const seen = [];
  const sb = {
    bot: { id: 'b' }, emit() {}, eat: async () => {}, withTimeout: (p) => p, stopMotion: () => seen.push('stop'),
    fleeFrom: () => 'flee', tunnelFlee: (b, deps) => { seen.push(deps); return 'hold'; },
  };
  vm.createContext(sb);
  run(sb, fnSrc('tunnelAwareFlee'));
  assert.strictEqual(run(sb, 'tunnelAwareFlee(bot)'), 'hold');
  const d = seen[0];
  assert.strictEqual(d.fleeFrom, sb.fleeFrom, 'le repli est fleeFrom, inchangé');
  assert.strictEqual(d.eat, sb.eat);
  assert.strictEqual(typeof d.stopMotion, 'function');
  assert.strictEqual(d.withTimeout, sb.withTimeout);
});

test('les ticks de survie du tunnel et de la descente fuient via tunnelAwareFlee (plus fleeFrom brut)', async () => {
  for (const name of ['branchSurvivalTick', 'descentSurvivalTick']) {
    const got = [];
    const sb = {
      bot: { entity: null, inventory: { emptySlotCount: () => 30 } }, emit() {},
      survivalTick: async (b, deps) => { got.push(deps.fleeFrom); },
      eat: async () => {}, fleeFrom: () => {}, tunnelAwareFlee: () => {},
      withTimeout: async () => {}, ensureTorches: async () => {}, furnaceJobTick: async () => {},
      recordAnchor: (a) => a, tossJunk: async () => {}, stopMotion: () => {},
      fightGateDeps: () => ({}),   // disjoncteur de combat (22/10) : sans effet ici
    };
    vm.createContext(sb);
    run(sb, fnSrc(name));
    await run(sb, `${name}()`);
    assert.strictEqual(got[0], sb.tunnelAwareFlee, `${name} passe tunnelAwareFlee à survivalTick`);
  }
});

test('les réflexes (fuite à PV bas / swarm) passent par tunnelAwareFlee', () => {
  const i = SRC.indexOf('installReflexes(bot, {');
  assert.ok(i > 0);
  const head = SRC.slice(i, i + 400);
  assert.match(head, /fleeFrom: tunnelAwareFlee/);
});

test('ensureTorches({charcoal}) : sans charbon, avec un four et ≥ 2 bûches → fond UNE bûche puis crafte les torches', async () => {
  const inv = [{ name: 'oak_log', count: 3 }, { name: 'furnace', count: 1 }, { name: 'stick', count: 4 }];
  const calls = [];
  const sb = {
    emit: (e) => calls.push(['emit', e.type]),
    taskToken: null,
    gather: async () => ({ ok: false }),
    logBase: (n) => (/_log$/.test(n) && !/^stripped_/.test(n) ? n.replace(/_log$/, '') : null),
    smeltWithFurnace: async (input, output, count) => { calls.push(['smelt', input, output, count]); inv.push({ name: 'charcoal', count: 1 }); return { ok: true }; },
    craftSmart: async (a) => { calls.push(['craft', a.name, a.count]); return { ok: true }; },
    bot: { registry: { blocksByName: {} }, findBlock: () => null, inventory: { items: () => inv } },
  };
  vm.createContext(sb);
  run(sb, fnSrc('ensureTorches'));
  await run(sb, 'ensureTorches({ charcoal: true })');
  assert.deepStrictEqual(calls.find((c) => c[0] === 'smelt'), ['smelt', 'oak_log', 'charcoal', 1]);
  assert.deepStrictEqual(calls.find((c) => c[0] === 'craft'), ['craft', 'torch', 1]);
});

test('ensureTorches() sans option (tick du tunnel) : JAMAIS de fonte (elle immobiliserait le bot au fond)', async () => {
  const inv = [{ name: 'oak_log', count: 3 }, { name: 'furnace', count: 1 }, { name: 'stick', count: 4 }];
  let smelted = 0;
  const sb = {
    emit() {}, taskToken: null, gather: async () => ({ ok: false }), logBase: (n) => n,
    smeltWithFurnace: async () => { smelted++; return { ok: true }; }, craftSmart: async () => ({ ok: true }),
    bot: { registry: { blocksByName: {} }, findBlock: () => null, inventory: { items: () => inv } },
  };
  vm.createContext(sb);
  run(sb, fnSrc('ensureTorches'));
  await run(sb, 'ensureTorches()');
  assert.strictEqual(smelted, 0);
});

test('le hook de descente demande des torches (charbon de bois au besoin) AVANT de descendre, en surface', () => {
  const body = fnSrc('runGoalSkill');
  assert.match(body, /ensureTorches\(\{ charcoal: true \}\)/);
});
