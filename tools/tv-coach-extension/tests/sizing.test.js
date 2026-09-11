'use strict';

/**
 * tests/sizing.test.js — la taille d'un scalp (module PUR).
 *
 * Le cas vécu le 11/09 sert de premier test : BTC-USD à 77 216 USD, un
 * portefeuille papier de 10 000 CHF, et l'extension ouvrait « 1 BTC » faute de
 * ticket (≈ 62 770 CHF, six fois le capital). Ici, le même état rend 0,1593 —
 * le PLAFOND DE CAPITAL, jamais une unité par défaut.
 */
const test = require('node:test');
const assert = require('node:assert');

const sizing = require('../lib/sizing.js');

/** Comparaison flottante : la distance de stop n'est pas arrondie. */
function close(actual, expected, tolerance) {
  assert.ok(Math.abs(actual - expected) < (tolerance === undefined ? 1e-9 : tolerance),
            actual + ' attendu ' + expected);
}

const BTC = {
  equity_chf: 10000,
  risk_pct: 1,
  price: 77216,
  fx_to_chf: 0.8129,
  atr: 60,
  kind: 'crypto'
};

test('le cas vécu : BTC est plafonné par le capital, jamais 1 unité', () => {
  const out = sizing.scalpQty(BTC);
  /* 2 x ATR = 120 (le plancher 0,15 % vaut 115,82, il ne mord pas). */
  close(out.stop_distance, 120);
  assert.strictEqual(out.risk_chf, 100);
  /* Le risque seul autoriserait 1,025 BTC ; le capital n'en paie que 0,1593. */
  assert.strictEqual(out.qty, 0.1593);
  assert.strictEqual(out.capped_by, 'notional');
  assert.strictEqual(out.notional_chf, 9999.08);
  assert.ok(out.qty < 1, 'plus jamais une unité de bitcoin par défaut');
  assert.ok(out.notional_chf <= BTC.equity_chf, 'exposition au-dessus du capital');
});

test('une action se compte en titres entiers', () => {
  const out = sizing.scalpQty({ equity_chf: 10000, risk_pct: 1, price: 230,
                                fx_to_chf: 0.8129, atr: 0.3, kind: 'stock' });
  /* 2 x 0,3 = 0,60 contre un plancher de 0,345 : l'ATR gagne. */
  assert.strictEqual(out.stop_distance, 0.6);
  /* Le risque paierait 205 titres, le capital 53,48 -> 53 titres pleins. */
  assert.strictEqual(out.qty, 53);
  assert.strictEqual(out.capped_by, 'notional');
  assert.strictEqual(out.notional_chf, 9909.25);
});

test('un titre plus cher que le capital rend zéro, pas une action à crédit', () => {
  const out = sizing.scalpQty({ equity_chf: 10000, risk_pct: 1, price: 700000,
                                fx_to_chf: 0.8129, kind: 'stock' });
  assert.strictEqual(out.qty, 0);
  assert.strictEqual(out.notional_chf, 0);
  assert.strictEqual(out.capped_by, 'insufficient');
});

test('une crypto sous le lot minimal rend zéro, pas une poussière', () => {
  /* 0,0001 bitcoin vaut 6,28 CHF : avec 5 CHF de capital, même le lot minimal
     est hors de portée (avec 10 CHF il passe — le test voisin le montre). */
  const out = sizing.scalpQty({ equity_chf: 5, risk_pct: 1, price: 77216,
                                fx_to_chf: 0.8129, atr: 60, kind: 'crypto' });
  assert.strictEqual(out.qty, 0);
  assert.strictEqual(out.notional_chf, 0);
  assert.strictEqual(out.capped_by, 'insufficient');

  const minimal = sizing.scalpQty({ equity_chf: 10, risk_pct: 1, price: 77216,
                                    fx_to_chf: 0.8129, atr: 60, kind: 'crypto' });
  assert.strictEqual(minimal.qty, 0.0001);
  assert.ok(minimal.notional_chf <= 10);
});

test('sans ATR, le stop implicite est 0,3 % du prix', () => {
  const out = sizing.scalpQty({ equity_chf: 10000, risk_pct: 1, price: 100,
                                fx_to_chf: 1, kind: 'stock' });
  close(out.stop_distance, 0.3);
  /* Le risque paierait 333 titres, le capital 100 : le capital borne. */
  assert.strictEqual(out.qty, 100);
  assert.strictEqual(out.capped_by, 'notional');
});

test('un ATR minuscule ne fait pas un stop minuscule (plancher 0,15 %)', () => {
  const out = sizing.scalpQty({ equity_chf: 10000, risk_pct: 1, price: 100,
                                fx_to_chf: 1, atr: 0.01, kind: 'stock' });
  close(out.stop_distance, 0.15);
});

test('un ATR large fait mordre le RISQUE avant le capital', () => {
  const out = sizing.scalpQty({ equity_chf: 10000, risk_pct: 1, price: 100,
                                fx_to_chf: 1, atr: 2, kind: 'stock' });
  close(out.stop_distance, 4);
  assert.strictEqual(out.qty, 25);            /* 100 CHF de risque / 4 */
  assert.strictEqual(out.capped_by, 'risk');
  assert.strictEqual(out.notional_chf, 2500);
});

test('un taux de change absent vaut 1 : on sous-dimensionne, jamais l’inverse', () => {
  const withFx = sizing.scalpQty(BTC);
  const noFx = sizing.scalpQty(Object.assign({}, BTC, { fx_to_chf: null }));
  const zeroFx = sizing.scalpQty(Object.assign({}, BTC, { fx_to_chf: 0 }));
  assert.deepStrictEqual(zeroFx, noFx);
  /* Un dollar compté comme un franc « coûte » plus cher -> moins d'unités. */
  assert.ok(noFx.qty < withFx.qty, 'le repli doit sous-dimensionner');
});

test('sans capital ou sans prix, on ne propose RIEN', () => {
  assert.strictEqual(sizing.scalpQty({ price: 100 }), null);
  assert.strictEqual(sizing.scalpQty({ equity_chf: 10000 }), null);
  assert.strictEqual(sizing.scalpQty({ equity_chf: 0, price: 100 }), null);
  assert.strictEqual(sizing.scalpQty({ equity_chf: 10000, price: 0 }), null);
  assert.strictEqual(sizing.scalpQty({ equity_chf: -5, price: 100 }), null);
  assert.strictEqual(sizing.scalpQty({ equity_chf: 10000, price: -3 }), null);
});

test('un risque absent, nul ou négatif vaut 1 %', () => {
  const reference = sizing.scalpQty(Object.assign({}, BTC, { risk_pct: 1 }));
  for (const value of [null, undefined, 0, -4, '']) {
    const out = sizing.scalpQty(Object.assign({}, BTC, { risk_pct: value }));
    assert.strictEqual(out.risk_chf, reference.risk_chf, 'risk_pct=' + value);
    assert.strictEqual(out.qty, reference.qty, 'risk_pct=' + value);
  }
});

test('le plafond d’exposition est réglable et reste le plafond', () => {
  const out = sizing.scalpQty(Object.assign({}, BTC, { max_notional_pct: 50 }));
  assert.strictEqual(out.capped_by, 'notional');
  assert.strictEqual(out.qty, 0.0796);
  assert.ok(out.notional_chf <= 5000, 'la moitié du capital est un plafond dur');
});

test('jamais plus que le capital, quel que soit le titre', () => {
  const cases = [
    { equity_chf: 10000, risk_pct: 5, price: 12.5, fx_to_chf: 1, atr: 3, kind: 'stock' },
    { equity_chf: 10000, risk_pct: 9, price: 0.42, fx_to_chf: 0.8129, atr: 0.2, kind: 'crypto' },
    { equity_chf: 250, risk_pct: 2, price: 31.9, fx_to_chf: 1.07, atr: 1.5, kind: 'stock' }
  ];
  for (const input of cases) {
    const out = sizing.scalpQty(input);
    assert.ok(out.notional_chf <= input.equity_chf + 0.01,
              JSON.stringify(input) + ' -> ' + out.notional_chf);
  }
});

test('une entrée absurde rend null et ne lève jamais', () => {
  for (const input of [null, undefined, 0, 'BTC', [], { equity_chf: 'beaucoup' },
                       { equity_chf: 10000, price: 'cher' },
                       { equity_chf: NaN, price: NaN }]) {
    assert.strictEqual(sizing.scalpQty(input), null, JSON.stringify(input));
  }
});

test('le module s’expose sous OmenLib comme ses voisins', () => {
  assert.ok(globalThis.OmenLib && globalThis.OmenLib.sizing);
  assert.strictEqual(globalThis.OmenLib.sizing.scalpQty, sizing.scalpQty);
});
