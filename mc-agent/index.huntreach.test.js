'use strict';
// CÂBLAGE (22/10) : le filet « manger » de index.js mange aussi BLESSÉ sous 18 (sinon les PV ne remontent
// jamais), choisit le poulet cru en dernier, attend la fin du corps-à-corps sauf muré dans l'abri.
// Le VRAI texte de la fonction tourne dans un bac à sable `vm` strict (piège #56).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const R = require('./reflexes');
const C = require('./cookMeat');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(re, label) {
  const m = SRC.match(re);
  assert.ok(m, `${label} introuvable dans index.js`);
  return m[0];
}
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);
const letSrc = (name) => grab(new RegExp(`^let ${name} = [^;]+;`, 'm'), `let ${name}`);

function sandbox(o = {}) {
  const sb = {
    events: [], eaten: [], cooks: [], cookFailed: false,
    inv: (o.items || []).map((name) => ({ name, count: 1 })),
    emit(e) { sb.events.push(e); },
    Object, Math, Number, Array, JSON, Promise, String, Error,
    pickFood: R.pickFood, eatWanted: R.eatWanted,
    isRawMeat: C.isRawMeat, rawEatAllowed: C.rawEatAllowed, ateFields: C.ateFields,
    // Cuisson (23/10) : par défaut IMPOSSIBLE (ni four ni combustible) → le cru se mange comme avant.
    netMeatCookable: () => !!o.cookable && !sb.cookFailed,
    netCookFree: () => o.free !== false,
    cookMeatLot: async (tag, opts) => {
      sb.cooks.push([tag, opts]);
      if (o.cookWorks === false) { sb.cookFailed = true; return 0; }
      const it = sb.inv.find((i) => C.isRawMeat(i.name));
      if (it) it.name = C.RAW2COOKED[it.name];
      return 1;
    },
    Date: o.now ? { now: () => o.now } : Date,
    withTimeout: (p) => p,
    _nearestThreatDist: () => (o.threat == null ? null : o.threat),
    bot: {
      food: o.food, health: o.health,
      pvp: { target: o.fighting ? { name: 'zombie' } : null },
      inventory: { items: () => sb.inv.map((i) => ({ name: i.name, count: i.count })) },
      stopDigging() {},
      equip: async (it) => { sb.eaten.push(it.name); },
      consume: async () => { if (o.consumeThrows) throw new Error('busy'); },
    },
  };
  vm.createContext(sb);
  vm.runInContext("'use strict';\n" + [letSrc('_hungerBusy'), letSrc('_rawDeferSince'), fnSrc('hungerNetTick'),
    'this.hungerNetTick = hungerNetTick;'].join('\n'), sb);
  return sb;
}

test('filet : blessé (PV 5) à faim 14 avec du porc cru → il MANGE (le cas du chrono du 22/10)', async () => {
  const sb = sandbox({ food: 14, health: 5, items: ['porkchop'] });
  assert.strictEqual(await sb.hungerNetTick(), true);
  assert.deepStrictEqual(sb.eaten, ['porkchop']);
  assert.ok(sb.events.some((e) => e.type === 'ate' && e.via === 'net'));
});

test('filet : rassasié (18) ou indemne → ne mange pas', async () => {
  assert.strictEqual(await sandbox({ food: 18, health: 5, items: ['beef'] }).hungerNetTick(), false);
  assert.strictEqual(await sandbox({ food: 14, health: 20, items: ['beef'] }).hungerNetTick(), false);
});

test('filet : poulet cru en DERNIER recours', async () => {
  const sb = sandbox({ food: 4, health: 20, items: ['chicken', 'beef'] });
  await sb.hungerNetTick();
  assert.deepStrictEqual(sb.eaten, ['beef']);
});

test('filet : blessé en plein corps-à-corps → attend (épée en main) ; affamé (≤ 8) → mange quand même', async () => {
  assert.strictEqual(await sandbox({ food: 14, health: 5, items: ['beef'], threat: 3 }).hungerNetTick(), false);
  assert.strictEqual(await sandbox({ food: 14, health: 5, items: ['beef'], fighting: true }).hungerNetTick(), false);
  assert.strictEqual(await sandbox({ food: 6, health: 5, items: ['beef'], threat: 3 }).hungerNetTick(), true);
});

test('filet : muré dans l abri (sealed) → le zombie derrière la paroi ne l empêche pas de manger', async () => {
  const sb = sandbox({ food: 14, health: 5, items: ['beef'], threat: 2 });
  assert.strictEqual(await sb.hungerNetTick('shelter', { sealed: true }), true);
  assert.ok(sb.events.some((e) => e.type === 'ate' && e.via === 'shelter'));
});

test('filet : échec de consommation → eat_failed tracé, rend false', async () => {
  const sb = sandbox({ food: 4, health: 20, items: ['beef'], consumeThrows: true });
  assert.strictEqual(await sb.hungerNetTick(), false);
  assert.ok(sb.events.some((e) => e.type === 'eat_failed'));
});

test('index.js : timers et état de la chasse/des troupeaux au NIVEAU MODULE (piège #56)', () => {
  assert.match(SRC, /^let _hungerBusy = false;$/m);
  assert.match(SRC, /^let _herdSavedAt = 0;$/m);
  assert.match(SRC, /^setInterval\(\(\) => \{ herdScanTick\(\); \}, HERD_SCAN_MS\);$/m);
  assert.match(SRC, /^setInterval\(\(\) => \{ hungerNetTick\(\)\.catch\(\(\) => \{\}\); \}, 5000\);$/m);
  assert.ok(SRC.indexOf('const HERD_SCAN_MS') < SRC.indexOf('}, HERD_SCAN_MS);'), 'constante déclarée avant le timer');
});


// ─── CUIRE AVANT D'AVALER DU CRU (23/10) — 286 `ate via:net` sur 296 étaient du cru ──────────────
test('filet : du cuit en poche → le CUIT d abord, event ate {raw:false, cooked:true}', async () => {
  const sb = sandbox({ food: 10, health: 5, items: ['beef', 'cooked_beef'], cookable: true });
  assert.strictEqual(await sb.hungerNetTick(), true);
  assert.deepStrictEqual(sb.eaten, ['cooked_beef']);
  const ate = sb.events.find((e) => e.type === 'ate');
  assert.strictEqual(ate.raw, false);
  assert.strictEqual(ate.cooked, true);
  assert.strictEqual(sb.cooks.length, 0);
});

test('filet : cru + four et combustible + faim 14 → il CUIT puis mange le cuit', async () => {
  const sb = sandbox({ food: 14, health: 5, items: ['mutton', 'mutton', 'mutton'], cookable: true });
  assert.strictEqual(await sb.hungerNetTick(), true);
  assert.deepStrictEqual(sb.cooks.map((c) => c[0]), ['net']);
  assert.strictEqual(sb.cooks[0][1].walk, false, 'depuis un timer : jamais de marche');
  assert.deepStrictEqual(sb.eaten, ['cooked_mutton']);
});

test('filet : cru, cuisson possible mais bot OCCUPÉ → il diffère (ne mange pas le cru)', async () => {
  const sb = sandbox({ food: 14, health: 5, items: ['beef'], cookable: true, free: false });
  assert.strictEqual(await sb.hungerNetTick(), false);
  assert.deepStrictEqual(sb.eaten, []);
});

test('filet : différé plus de 90 s sans occasion de cuire → il mange le cru', async () => {
  const sb = sandbox({ food: 14, health: 5, items: ['beef'], cookable: true, free: false, now: 1000 });
  assert.strictEqual(await sb.hungerNetTick(), false);
  sb.Date = { now: () => 1000 + C.RAW_DEFER_MAX_MS };
  assert.strictEqual(await sb.hungerNetTick(), true);
  assert.deepStrictEqual(sb.eaten, ['beef']);
  assert.strictEqual(sb.events.find((e) => e.type === 'ate').raw, true);
});

test('filet : faim ≤ 6 → le cru tout de suite, même si on pourrait cuire', async () => {
  const sb = sandbox({ food: 6, health: 20, items: ['beef'], cookable: true });
  assert.strictEqual(await sb.hungerNetTick(), true);
  assert.deepStrictEqual(sb.eaten, ['beef']);
  assert.strictEqual(sb.cooks.length, 0);
});

test('filet : cuisson ratée → le cru se mange dans le même tick (pas de bot affamé qui attend)', async () => {
  const sb = sandbox({ food: 14, health: 5, items: ['beef'], cookable: true, cookWorks: false });
  assert.strictEqual(await sb.hungerNetTick(), true);
  assert.deepStrictEqual(sb.eaten, ['beef']);
});

test('filet : muré dans l abri → pas de four posé dans le mur, le cru se mange', async () => {
  const sb = sandbox({ food: 14, health: 5, items: ['beef'], cookable: true });
  assert.strictEqual(await sb.hungerNetTick('shelter', { sealed: true }), true);
  assert.strictEqual(sb.cooks.length, 0);
  assert.deepStrictEqual(sb.eaten, ['beef']);
});

test('index.js : état de la cuisson au NIVEAU MODULE (lu par le timer du filet, piège #56)', () => {
  for (const name of ['_cookBusy', '_cookFailUntil', '_rawDeferSince']) {
    assert.match(SRC, new RegExp(`^let ${name}\\b`, 'm'), `${name} doit être un let de colonne 0`);
  }
  for (const fn of ['cookMeatLot', 'meatCookAccess', 'meatCookPlanNow', 'netMeatCookable', 'netCookFree']) {
    assert.match(SRC, new RegExp(`^(?:async )?function ${fn}\\(`, 'm'), `${fn} doit être de niveau module`);
  }
  assert.match(SRC, /cookLot: \(\) => cookMeatLot\('hunt'\)/, 'la chasse cuit son lot');
  assert.match(SRC, /await cookMeatLot\('mine', \{ walk: false \}\)/, 'le hook du branch-mine cuit sans marcher');
  assert.match(SRC, /await cookMeatLot\('goal'\)/, 'entre deux buts');
  assert.match(SRC, /await cookBetweenGoals\(g\);/, 'runSkillWithTelemetry cuit entre deux buts');
});
