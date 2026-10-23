'use strict';
// CÂBLAGE « bûcheron oisif → fer » (21/10) : vrai texte de ljIronSliceStep / ljIronSlice (index.js) dans
// un bac à sable vm strict. La décision pure est testée dans lumberjack.test.js (ljIronSlicePlan).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const L = require('./lumberjack');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const grab = (re, label) => { const m = SRC.match(re); assert.ok(m, `${label} introuvable au niveau module`); return m[0]; };
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), name);
const letSrc = (name) => grab(new RegExp(`^let ${name} = [^;]+;`, 'm'), name);
const T0 = 1_800_000_000_000;

function sandbox(o = {}) {
  const clock = { t: T0 };
  const sb = {
    events: [], calls: [], clock,
    _lifeGen: 0, lifeStale: (g) => g != null && g !== sb._lifeGen, dropStaleTask: () => ({ ok: false, reason: 'cancelled', stale: true }),   // génération de vie (index.lifegen.test.js)
    emit(e) { sb.events.push(e); },
    Date: { now: () => clock.t }, Object, Math, Number, Promise, Set,
    items: (o.items || []).map((i) => Object.assign({}, i)),
    _tick: null,
    setInterval: (fn) => { sb._tick = fn; return 1; },
    clearInterval: () => { sb._tick = null; sb.calls.push('clearInterval'); },
    sleep: async (ms) => { clock.t += ms; if (sb._tick) sb._tick(); },
    taskToken: { cancelled: false },
    _ljAt: 0, LJ_CACHE_MS: 10000,
    _ljContext: () => (o.requestAt != null && clock.t >= o.requestAt ? { to: 'NethBot1' } : null),
    stopMotion: () => sb.calls.push('stop'),
    _wornArmor: () => new Set(o.worn || []),
    isNight: () => !!o.night,
    ironCaveCtx: () => (o.cave === false ? null : { key: 'c1' }),
    ljIronSlicePlan: L.ljIronSlicePlan, LJ_IRON_SLICE_MS: L.LJ_IRON_SLICE_MS, LJ_MINE_COBBLE: L.LJ_MINE_COBBLE,
    ljSliceRetryMs: L.ljSliceRetryMs, ljSliceFailsAfter: L.ljSliceFailsAfter,
    isInWater: () => false, ljMineReturn: async () => { sb.calls.push('mine_return'); },
    // tranche 'mine' (21/10) : mine 1 fer toutes les 15 s tant que le jeton CAPTURÉ n'est pas annulé
    ljMineSlice: async () => {
      const tok = sb.taskToken;
      sb.calls.push('mine');
      while (!tok.cancelled) {
        await sb.sleep(15000);
        if (!tok.cancelled) { const r = sb.items.find((i) => i.name === 'raw_iron'); if (r) r.count++; else sb.items.push({ name: 'raw_iron', count: 1 }); }
        if (clock.t - T0 > 3600000) throw new Error('jamais annulé');
      }
      return { ok: true };
    },
    // grotte : mine 1 fer toutes les 10 s tant que le jeton CAPTURÉ n'est pas annulé
    runCaveIron: async () => {
      const tok = sb.taskToken;
      sb.calls.push('cave');
      while (!tok.cancelled) {
        await sb.sleep(10000);
        if (!tok.cancelled) { const r = sb.items.find((i) => i.name === 'raw_iron'); if (r) r.count++; else sb.items.push({ name: 'raw_iron', count: 1 }); }
        if (clock.t - T0 > 3600000) throw new Error('jamais annulé');
      }
      return { ok: true };
    },
    craftSmart: async (a) => { sb.calls.push('craft:' + a.name); if (o.furnaceCraft === false) return { ok: false }; sb.items.push({ name: 'furnace', count: 1 }); return { ok: true }; },
    smeltWithFurnace: async (i, out, n) => {
      sb.calls.push(['smelt', i, n]);
      const r = sb.items.find((x) => x.name === 'raw_iron'); r.count -= n;
      sb.items.push({ name: 'iron_ingot', count: n });
      return { ok: true };
    },
    bot: { time: { timeOfDay: 6000 }, inventory: { items: () => sb.items.filter((i) => i.count > 0) } },
  };
  vm.createContext(sb);
  vm.runInContext("'use strict';\n" + letSrc('_ljIronSliceAt') + letSrc('_ljSliceFails'), sb);
  for (const f of ['ljIronSliceStep', '_ljCaveAvailable', 'ljIronSlice']) vm.runInContext("'use strict';\n" + fnSrc(f), sb);
  vm.runInContext('globalThis.__get = (n) => eval(n);', sb);
  return sb;
}
const run = (sb, code) => vm.runInContext(code, sb);
const PICK = { name: 'stone_pickaxe', count: 1 };

test('grotte connue : tranche lancée, coupée par une DEMANDE DE BOIS, jeton parent rendu', async () => {
  const sb = sandbox({ items: [PICK], requestAt: T0 + 60000 });
  const parent = sb.taskToken;
  const r = await run(sb, 'ljIronSliceStep()');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { ok: true });
  assert.strictEqual(sb.taskToken, parent, 'taskToken restauré');
  assert.ok(sb.calls.includes('stop') && sb.calls.includes('clearInterval'));
  const end = sb.events.find((e) => e.type === 'lj_iron_slice' && e.phase === 'end');
  assert.strictEqual(end.reason, 'wood_request');
  assert.ok(end.raw >= 4, `fer miné pendant la tranche (${end.raw})`);
  assert.ok(sb.clock.t - T0 < 120000, 'coupée vite après la demande');
});

test('sans demande : la tranche s\'arrête au bout de LJ_IRON_SLICE_MS (borne), puis cooldown', async () => {
  const sb = sandbox({ items: [PICK] });
  await run(sb, 'ljIronSliceStep()');
  const end = sb.events.find((e) => e.type === 'lj_iron_slice' && e.phase === 'end');
  assert.strictEqual(end.reason, 'slice_time');
  assert.ok(sb.clock.t - T0 >= L.LJ_IRON_SLICE_MS && sb.clock.t - T0 < L.LJ_IRON_SLICE_MS + 15000);
  assert.strictEqual(await run(sb, 'ljIronSliceStep()'), null, 'retry immédiat refusé');
});

test('fer brut en poche, pas de four mais 8 cobble → craft du four puis fonte de TOUT le brut', async () => {
  const sb = sandbox({ items: [PICK, { name: 'raw_iron', count: 5 }, { name: 'cobblestone', count: 8 }] });
  await run(sb, 'ljIronSliceStep()');
  assert.deepStrictEqual(sb.calls.filter((c) => c !== 'clearInterval'), ['craft:furnace', ['smelt', 'raw_iron', 5]]);
  const end = sb.events.find((e) => e.type === 'lj_iron_slice' && e.phase === 'end');
  assert.strictEqual(end.act, 'smelt');
  assert.strictEqual(end.ingots, 5);
});

test('rien d\'utile (pas de grotte, pas de fer) / nu de nuit → null : l\'attente historique reprend', async () => {
  assert.strictEqual(await run(sandbox({ items: [PICK], cave: false }), 'ljIronSliceStep()'), null);
  assert.strictEqual(await run(sandbox({ items: [PICK], night: true }), 'ljIronSliceStep()'), null);
  assert.strictEqual(await run(sandbox({ items: [] }), 'ljIronSliceStep()'), null, 'sans pioche pierre');
});

test('préemption (migration) pendant la tranche : jeton remplacé jamais écrasé, retour cancelled', async () => {
  const sb = sandbox({ items: [PICK] });
  const parent = sb.taskToken;
  const mig = { cancelled: false, mig: true };
  sb.runCaveIron = async () => { const tok = sb.taskToken; parent.cancelled = true; sb.taskToken = mig; return tok.cancelled ? { ok: false, reason: 'cancelled' } : { ok: true }; };
  const r = await run(sb, 'ljIronSliceStep()');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { ok: false, reason: 'cancelled' });
  assert.strictEqual(sb.taskToken, mig, 'le jeton de la migration reste en place');
});

test('câblage : lumberjackIdleSkill consulte ljIronSliceStep pendant l\'attente', () => {
  const src = fnSrc('lumberjackIdleSkill');
  assert.match(src, /await ljIronSliceStep\(_gen\)/);
  assert.match(SRC, /^let _ljIronSliceAt = 0;/m);
});

test('aucune grappe connue mais pioche + 8 cobble → tranche de branch-mine, coupée par la demande de bois, retour au coin', async () => {
  const sb = sandbox({ items: [PICK, { name: 'cobblestone', count: 8 }], cave: false, requestAt: T0 + 90000 });
  const parent = sb.taskToken;
  const r = await run(sb, 'ljIronSliceStep()');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { ok: true });
  assert.strictEqual(sb.taskToken, parent);
  assert.ok(sb.calls.includes('mine'));
  assert.ok(sb.calls.indexOf('mine_return') > sb.calls.indexOf('mine'), 'retour /home work APRÈS la tranche');
  const end = sb.events.find((e) => e.type === 'lj_iron_slice' && e.phase === 'end');
  assert.strictEqual(end.act, 'mine');
  assert.strictEqual(end.reason, 'wood_request');
  assert.ok(end.raw >= 4);
});

test('aucune grappe, pioche mais < 8 cobble → pas de tranche mine (attente historique)', async () => {
  assert.strictEqual(await run(sandbox({ items: [PICK, { name: 'cobblestone', count: 7 }], cave: false }), 'ljIronSliceStep()'), null);
});

test('tranches ratées d\'affilée (water_ahead, 0 fer) → répit doublé ; une tranche qui rapporte le remet à 20 s', async () => {
  const sb = sandbox({ items: [PICK, { name: 'cobblestone', count: 8 }], cave: false });
  sb.ljMineSlice = async () => ({ ok: false, reason: 'water_ahead' });
  await run(sb, 'ljIronSliceStep()');
  assert.strictEqual(sb.__get('_ljSliceFails'), 1);
  assert.strictEqual(sb.events.filter((e) => e.phase === 'end').pop().retry_s, 40);
  sb.clock.t += L.LJ_IRON_RETRY_MS + 1000;
  assert.strictEqual(await run(sb, 'ljIronSliceStep()'), null, '20 s ne suffisent plus');
  sb.clock.t += L.LJ_IRON_RETRY_MS;
  await run(sb, 'ljIronSliceStep()');
  assert.strictEqual(sb.__get('_ljSliceFails'), 2);
  sb.ljMineSlice = async () => { sb.items.push({ name: 'raw_iron', count: 3 }); return { ok: true }; };
  sb.clock.t += 4 * L.LJ_IRON_RETRY_MS + 1000;
  await run(sb, 'ljIronSliceStep()');
  assert.strictEqual(sb.__get('_ljSliceFails'), 0);
});

test('mort pendant la tranche mine (vie changée) → jeton de tranche annulé, PAS de /home work depuis le respawn', async () => {
  const sb = sandbox({ items: [PICK, { name: 'cobblestone', count: 8 }], cave: false });
  let sawCancelled = null;
  sb.ljMineSlice = async () => {
    const tok = sb.taskToken;
    sb.calls.push('mine');
    sb._lifeGen += 2;                         // mort + respawn
    sawCancelled = tok.cancelled;
    return { ok: true, cancelled: true };
  };
  await run(sb, 'ljIronSliceStep(0)');
  assert.strictEqual(sawCancelled, true, 'le jeton de la tranche voit la vie finie');
  assert.ok(sb.calls.includes('mine'));
  assert.ok(!sb.calls.includes('mine_return'), 'aucun retour /home work pour une vie finie');
});
