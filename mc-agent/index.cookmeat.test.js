'use strict';
// CÂBLAGE (23/10) : cookMeatLot / meatCookPlanNow / meatCookAccess — le VRAI texte d'index.js exécuté
// dans un bac à sable `vm` strict (pièges #56/#61 : un nom mal branché lève ici, pas en production).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const C = require('./cookMeat');
const G = require('./goals');
const { fuelUnits } = require('./skills/smelt');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(re, label) { const m = SRC.match(re); assert.ok(m, `${label} introuvable`); return m[0]; }
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);
const letSrc = (name) => grab(new RegExp(`^let ${name} = [^;]+;`, 'm'), `let ${name}`);

function sandbox(o = {}) {
  const inv = Object.entries(o.inv || {}).map(([name, count]) => ({ name, count }));
  const sb = {
    events: [], smelts: [], clock: 1000,
    emit(e) { sb.events.push(e); },
    Object, Math, Number, Array, JSON, Promise, String, Error, Set,
    Date: { now: () => sb.clock },
    cookLotPlan: C.cookLotPlan, ironFuelReserve: C.ironFuelReserve,
    COOK_LOT_MAX_MS: C.COOK_LOT_MAX_MS, COOK_LOT_HARD_MS: C.COOK_LOT_HARD_MS, COOK_FAIL_COOLDOWN_MS: C.COOK_FAIL_COOLDOWN_MS,
    fuelUnits, fuelNames: () => ['coal', 'charcoal', 'oak_planks', 'oak_log'],
    armorNeed: G.armorNeed, buildCtxInv: G.buildCtxInv,
    _wornArmor: () => new Set(o.worn || []),
    _furnaceJob: o.job || null, furnaceJobNear: () => o.jobNear !== false,
    taskToken: { cancelled: false },
    stopMotion() {},
    withTimeout: (p) => p,
    smeltWithFurnace: async (input, out, n, fuel, opts) => {
      sb.smelts.push({ input, out, n, maxMs: opts && opts.maxMs });
      sb.clock += n * 10000;
      if (o.smeltFails) return { ok: false, reason: 'no_furnace' };
      const it = inv.find((i) => i.name === input); it.count -= n;
      inv.push({ name: out, count: n });
      return { ok: true, got: n };
    },
    bot: {
      registry: { blocksByName: { furnace: { id: 61 } } },
      inventory: { items: () => inv.filter((i) => i.count > 0) },
      findBlocks: ({ maxDistance }) => (o.placedAt != null && o.placedAt <= maxDistance ? [{ x: 1, y: 2, z: 3 }] : []),
    },
  };
  vm.createContext(sb);
  vm.runInContext("'use strict';\n" + [letSrc('_cookBusy'), letSrc('_cookFailUntil'),
    fnSrc('_invTotal'), fnSrc('meatCookAccess'), fnSrc('meatCookPlanNow'), fnSrc('cookMeatLot'),
    'this.cookMeatLot = cookMeatLot; this.meatCookAccess = meatCookAccess; this.plan = meatCookPlanNow;'].join('\n'), sb);
  return sb;
}

test('cookMeatLot : 3 moutons, four en poche, 2 charbons, armure finie → cuit les 3, event meat_cooked', async () => {
  const worn = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];
  const sb = sandbox({ inv: { mutton: 3, furnace: 1, coal: 2 }, worn });
  assert.strictEqual(await sb.cookMeatLot('hunt'), 3);
  assert.deepStrictEqual(sb.smelts.map((x) => [x.input, x.n]), [['mutton', 3]]);
  const ev = sb.events.find((e) => e.type === 'meat_cooked');
  assert.strictEqual(ev.count, 3);
  assert.strictEqual(ev.via, 'hunt');
  assert.ok(typeof ev.took_ms === 'number' && ev.took_ms <= C.COOK_LOT_MAX_MS);
});

test('cookMeatLot : le combustible du FER passe avant (2 pièces d armure, 1 charbon) → pas de cuisson', async () => {
  const sb = sandbox({ inv: { beef: 5, furnace: 1, coal: 1, raw_iron: 4 }, worn: ['iron_helmet', 'iron_boots'] });
  assert.strictEqual(await sb.cookMeatLot('goal'), 0);
  assert.strictEqual(sb.smelts.length, 0);
  assert.strictEqual(sb.plan().reason, 'no_fuel');
});

test('cookMeatLot : four de mine en cours à portée → pas de cuisson (le fer d abord)', async () => {
  const sb = sandbox({ inv: { beef: 5, coal: 10 }, job: { pos: { x: 0, y: 0, z: 0 } }, placedAt: 3,
    worn: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'] });
  assert.strictEqual(sb.meatCookAccess(), null);
  assert.strictEqual(await sb.cookMeatLot('mine'), 0);
});

test('meatCookAccess : four posé à 12 blocs → atteignable en marchant, pas sans', () => {
  const sb = sandbox({ inv: { beef: 5, coal: 10 }, placedAt: 12 });
  assert.strictEqual(sb.meatCookAccess({ walk: true }), 'placed');
  assert.strictEqual(sb.meatCookAccess({ walk: false }), null);
});

test('cookMeatLot : borné ~45 s — 8 crus → 4 pièces seulement', async () => {
  const worn = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];
  const sb = sandbox({ inv: { beef: 8, furnace: 1, coal: 5 }, worn });
  assert.strictEqual(await sb.cookMeatLot('goal'), 4);
});

test('cookMeatLot : échec → meat_cooked {count:0, reason} et 3 min sans retenter', async () => {
  const worn = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];
  const sb = sandbox({ inv: { beef: 5, furnace: 1, coal: 5 }, worn, smeltFails: true });
  assert.strictEqual(await sb.cookMeatLot('goal'), 0);
  const ev = sb.events.find((e) => e.type === 'meat_cooked');
  assert.deepStrictEqual([ev.count, ev.reason], [0, 'no_furnace']);
  sb.smelts.length = 0;
  sb.clock += C.COOK_FAIL_COOLDOWN_MS - 1;
  assert.strictEqual(await sb.cookMeatLot('goal'), 0);
  assert.strictEqual(sb.smelts.length, 0, 'cooldown');
});
