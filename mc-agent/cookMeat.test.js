'use strict';
// CUIRE LA VIANDE (23/10) — décisions PURES. Mesure live sur 6 h (NethBot1-3) : 288 viandes CRUES
// mangées pour 8 cuites, 102 `hunt_cook_done` sur 103 à `cooked:0`.
const test = require('node:test');
const assert = require('node:assert');
const C = require('./cookMeat');

const inv = (o) => Object.entries(o).map(([name, count]) => ({ name, count }));

test('rawMeatStacks : piles crues cuisables, la plus abondante d abord ; la chair putréfiée ne se cuit pas', () => {
  const st = C.rawMeatStacks(inv({ mutton: 2, beef: 5, rotten_flesh: 9, cooked_beef: 3, stick: 4 }));
  assert.deepStrictEqual(st, [
    { name: 'beef', out: 'cooked_beef', count: 5 },
    { name: 'mutton', out: 'cooked_mutton', count: 2 },
  ]);
  assert.strictEqual(C.rawMeatCount(inv({ mutton: 2, beef: 5, rotten_flesh: 9 })), 7);
  assert.strictEqual(C.isRawMeat('chicken'), true);
  assert.strictEqual(C.isRawMeat('rotten_flesh'), false);
  assert.strictEqual(C.isRawMeat('cooked_beef'), false);
});

test('ironFuelReserve : le fer en poche + ce qui reste à fondre pour l armure + une marge', () => {
  assert.strictEqual(C.ironFuelReserve({ rawIron: 6, smeltNeed: 10 }), 6 + 10 + C.COOK_FUEL_MARGIN);
  assert.strictEqual(C.ironFuelReserve({}), C.COOK_FUEL_MARGIN);
});

test('cookLotPlan : moins de 3 crus → on ne sort pas le four', () => {
  const p = C.cookLotPlan({ items: inv({ beef: 2 }), furnace: 'pocket', fuelUnits: 80, reserveUnits: 0 });
  assert.strictEqual(p.go, false);
  assert.strictEqual(p.reason, 'few_raw');
});

test('cookLotPlan : 3 crus de types MÉLANGÉS comptent (un mouton + deux poulets)', () => {
  const p = C.cookLotPlan({ items: inv({ mutton: 1, chicken: 2 }), furnace: 'pocket', fuelUnits: 80, reserveUnits: 0 });
  assert.strictEqual(p.go, true);
  assert.strictEqual(p.pieces, 3);
});

test('cookLotPlan : pas de four (ni en poche ni posé) → non', () => {
  const p = C.cookLotPlan({ items: inv({ beef: 5 }), furnace: null, fuelUnits: 80, reserveUnits: 0 });
  assert.deepStrictEqual([p.go, p.reason], [false, 'no_furnace']);
});

test('cookLotPlan : le combustible RÉSERVÉ au fer n est jamais brûlé pour la viande', () => {
  // 2 charbons = 16 unités ; il en faut 14 pour le fer → il en reste 2 : on ne cuit que 2 pièces
  const p = C.cookLotPlan({ items: inv({ beef: 6 }), furnace: 'pocket', fuelUnits: 16, reserveUnits: 14 });
  assert.strictEqual(p.go, true);
  assert.strictEqual(p.pieces, 2);
  // plus rien au-delà de la réserve → no_fuel
  const q = C.cookLotPlan({ items: inv({ beef: 6 }), furnace: 'pocket', fuelUnits: 16, reserveUnits: 16 });
  assert.deepStrictEqual([q.go, q.reason], [false, 'no_fuel']);
});

test('cookLotPlan : borné par le temps (~45 s → 4 pièces à 10 s), réparti par abondance', () => {
  const p = C.cookLotPlan({ items: inv({ beef: 3, mutton: 5 }), furnace: 'pocket', fuelUnits: 200, reserveUnits: 0 });
  assert.strictEqual(p.go, true);
  assert.strictEqual(p.pieces, 4);
  assert.deepStrictEqual(p.lots, [{ name: 'mutton', out: 'cooked_mutton', count: 4 }]);
  const q = C.cookLotPlan({ items: inv({ beef: 2, mutton: 1 }), furnace: 'placed', fuelUnits: 200, reserveUnits: 0 });
  assert.deepStrictEqual(q.lots, [{ name: 'beef', out: 'cooked_beef', count: 2 }, { name: 'mutton', out: 'cooked_mutton', count: 1 }]);
});

test('cookLotPlan : entrées illisibles → non, sans exception', () => {
  assert.strictEqual(C.cookLotPlan().go, false);
  assert.strictEqual(C.cookLotPlan({ items: null, furnace: 'pocket', fuelUnits: NaN }).go, false);
});

test('rawEatAllowed : le cru seulement si faim ≤ 6 OU s il est impossible de cuire', () => {
  assert.strictEqual(C.rawEatAllowed({ food: 6, canCook: true }), true);
  assert.strictEqual(C.rawEatAllowed({ food: 7, canCook: true }), false);
  assert.strictEqual(C.rawEatAllowed({ food: 14, canCook: false }), true);
  // on a différé trop longtemps (aucune occasion de cuire) : on mange quand même
  assert.strictEqual(C.rawEatAllowed({ food: 14, canCook: true, deferredMs: C.RAW_DEFER_MAX_MS }), true);
  assert.strictEqual(C.rawEatAllowed({ food: 14, canCook: true, deferredMs: C.RAW_DEFER_MAX_MS - 1 }), false);
});

test('ateFields : `raw`/`cooked` dans l event ate', () => {
  assert.deepStrictEqual(C.ateFields('beef'), { raw: true, cooked: false });
  assert.deepStrictEqual(C.ateFields('cooked_beef'), { raw: false, cooked: true });
  assert.deepStrictEqual(C.ateFields('bread'), { raw: false, cooked: false });
});

// 24/10 : à 1,1 PV et faim 13 la règle « cru seulement à faim ≤ 6 » laissait le bot SANS régénération.
test('rawEatAllowed : BLESSÉ (faim < 18 coupe la régénération) → le cru se mange tout de suite', () => {
  assert.strictEqual(C.rawEatAllowed({ food: 13, canCook: true, hurt: true }), true);
  assert.strictEqual(C.rawEatAllowed({ food: 13, canCook: true, hurt: false }), false, 'indemne : on diffère comme avant');
});
