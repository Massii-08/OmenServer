'use strict';
// CÂBLAGE (23/10) : tranche 'mine' du bûcheron noyée — NethBot1, 44 `lj_iron_slice` `water_ahead` en 7 s
// toutes les ~37 s au même coin (work_return (-412,52,114)), 0 fer. Vrai texte d'index.js en `vm` strict.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const L = require('./lumberjack');
const W = require('./workDrown');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const grab = (re, label) => { const m = SRC.match(re); assert.ok(m, label + ' introuvable'); return m[0]; };
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), name);
const letSrc = (name) => grab(new RegExp(`^let ${name} = [^;]+;`, 'm'), name);
const run = (sb, code) => vm.runInContext("'use strict';\n" + code, sb);
const T0 = 1_800_000_000_000;

function sandbox(o = {}) {
  const clock = { t: T0 };
  const pos = { x: -412, y: 64, z: 114 };
  const sb = {
    events: [], calls: [], clock, pos,
    emit(e) { sb.events.push(e); },
    Date: { now: () => clock.t }, Object, Math, Number, Promise,
    taskToken: { cancelled: false },
    bot: { entity: { position: pos },
      pathfinder: { goto: async (g) => { sb.calls.push(['goto', g.x, g.z]); if (o.walk !== false) { pos.x = g.x; pos.z = g.z; } } } },
    pfGoals: { GoalNearXZ: function (x, z, r) { this.x = x; this.z = z; this.r = r; } },
    withTimeout: (p) => p, stopMotion() {},
    ljMineTargetY: L.ljMineTargetY, ljMineDetour: L.ljMineDetour, isWaterFailReason: L.isWaterFailReason,
    noteDrownedSite: W.noteDrownedSite, isDrownedNear: W.isDrownedNear,
    descentSurvivalTick() {}, branchSurvivalTick() {}, TORCH_EVERY: 8, rebuildPickHere() {},
    descendDiagonal: async () => { sb.calls.push(['descend', Math.round(pos.x), Math.round(pos.z)]);
      if (o.descend) return o.descend(pos); return { ok: false, reason: 'water_ahead' }; },
    branchMine: async () => { sb.calls.push('branch'); return { ok: true }; },
  };
  vm.createContext(sb);
  run(sb, letSrc('_drownedSites') + letSrc('_drownedOffsetSeed'));
  run(sb, fnSrc('ljMineSlice'));
  run(sb, 'globalThis.__get = (n) => eval(n);');
  return sb;
}

test('échec EAU de la descente → départ banni (lj_mine_drowned) ; la tranche suivante MARCHE 30-50 blocs avant de descendre', async () => {
  const sb = sandbox();
  const r1 = await run(sb, 'ljMineSlice()');
  assert.strictEqual(r1.reason, 'water_ahead');
  const dr = sb.events.find((e) => e.type === 'lj_mine_drowned');
  assert.deepStrictEqual([dr.x, dr.z], [-412, 114]);
  assert.strictEqual(sb.__get('_drownedSites').length, 1);
  // retour au coin (comme ljMineReturn /home work) puis tranche suivante
  sb.pos.x = -412; sb.pos.z = 114; sb.calls.length = 0;
  sb.clock.t += 60000;
  await run(sb, 'ljMineSlice()');
  const rel = sb.events.find((e) => e.type === 'lj_mine_relocate');
  assert.ok(rel, 'détour annoncé');
  const d = Math.hypot(rel.x + 412, rel.z - 114);
  assert.ok(d >= 30 && d <= 51, 'décalage 30-50 : ' + d);
  assert.strictEqual(sb.calls[0][0], 'goto');
  assert.deepStrictEqual(sb.calls[1], ['descend', rel.x, rel.z], 'la descente part du point décalé');
  // 3e tranche depuis le même coin : cap différent
  const seen = [[rel.x, rel.z]];
  sb.pos.x = -412; sb.pos.z = 114; sb.events.length = 0;
  sb.clock.t += 60000;
  await run(sb, 'ljMineSlice()');
  const rel2 = sb.events.find((e) => e.type === 'lj_mine_relocate');
  assert.notDeepStrictEqual([rel2.x, rel2.z], seen[0], 'le cap tourne');
});

test('descente réussie ou échec non-eau → aucun bannissement, aucun détour', async () => {
  const ok = sandbox({ descend: (p) => { p.y = 30; return { ok: true }; } });
  await run(ok, 'ljMineSlice()');
  assert.ok(ok.calls.includes('branch'));
  assert.strictEqual(ok.__get('_drownedSites').length, 0);
  const lava = sandbox({ descend: () => ({ ok: false, reason: 'lava_ahead' }) });
  await run(lava, 'ljMineSlice()');
  assert.strictEqual(lava.__get('_drownedSites').length, 0);
});

test('bannissement expiré (30 min) → plus de détour', async () => {
  const sb = sandbox();
  await run(sb, 'ljMineSlice()');
  sb.clock.t += W.DROWNED_SITE_TTL_MS + 1000; sb.events.length = 0;
  sb.pos.x = -412; sb.pos.z = 114;
  await run(sb, 'ljMineSlice()');
  assert.ok(!sb.events.some((e) => e.type === 'lj_mine_relocate'));
});

test('bookmarkCuttingSpot : refuse de re-poser `work` dans une zone noyée', () => {
  const sb = { events: [], emit(e) { sb.events.push(e); }, Date: { now: () => T0 }, Math,
    bot: { entity: { position: { x: -410, y: 70, z: 112 } } }, isInWater: () => false, SAFE_HOME_MIN_Y: 58,
    isDrownedNear: W.isDrownedNear, _drownedSites: W.noteDrownedSite([], { x: -412, z: 114 }, T0),
    markWorkBeforeTrip: () => true, homewarp: { bookmark: () => { sb.events.push({ type: 'BOOKMARK' }); return true; } },
    HOME_WORK: 'work', _workSet: false, _workPos: null, _botXZ: () => ({}) };
  vm.createContext(sb);
  run(sb, fnSrc('bookmarkCuttingSpot'));
  assert.strictEqual(run(sb, "bookmarkCuttingSpot('wood_tpa')"), false);
  assert.ok(sb.events.some((e) => e.type === 'work_bookmark_refused' && e.reason === 'drowned_site'));
  assert.ok(!sb.events.some((e) => e.type === 'BOOKMARK'));
  sb.bot.entity.position = { x: -300, y: 70, z: 112 };
  assert.strictEqual(run(sb, "bookmarkCuttingSpot('wood_tpa')"), true);
});

test('câblage : ljIronSliceStep passe retryMs ; ljIronSlice compte les tranches ratées', () => {
  assert.match(fnSrc('ljIronSliceStep'), /retryMs: ljSliceRetryMs\(_ljSliceFails\)/);
  assert.match(fnSrc('ljIronSlice'), /_ljSliceFails = ljSliceFailsAfter\(_ljSliceFails, _end\);/);
  assert.match(SRC, /^let _ljSliceFails = 0;/m);
});
