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
    events: [], eaten: [],
    emit(e) { sb.events.push(e); },
    Object, Math, Number, Array, JSON, Promise, String, Error,
    pickFood: R.pickFood, eatWanted: R.eatWanted,
    withTimeout: (p) => p,
    _nearestThreatDist: () => (o.threat == null ? null : o.threat),
    bot: {
      food: o.food, health: o.health,
      pvp: { target: o.fighting ? { name: 'zombie' } : null },
      inventory: { items: () => (o.items || []).map((name) => ({ name, count: 1 })) },
      stopDigging() {},
      equip: async (it) => { sb.eaten.push(it.name); },
      consume: async () => { if (o.consumeThrows) throw new Error('busy'); },
    },
  };
  vm.createContext(sb);
  vm.runInContext("'use strict';\n" + [letSrc('_hungerBusy'), fnSrc('hungerNetTick'),
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
