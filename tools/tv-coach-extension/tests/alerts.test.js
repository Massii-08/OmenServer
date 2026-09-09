'use strict';

/**
 * tests/alerts.test.js — l'évaluation locale des alertes de prix.
 * Franchissement, hystérésis 0,05 %, one-shot.
 */
const test = require('node:test');
const assert = require('node:assert');

const alerts = require('../lib/alerts.js');

function armed(id, op, price) {
  return { id: id, symbol: 'BTC-USD', op: op, price: price, status: 'armed',
           triggered_at: null, trigger_price: null };
}

test('above : ne tire pas AU niveau, tire au-delà de l’hystérésis', () => {
  const rows = [armed('a1', 'above', 1000)];
  /* seuil = 1000 + 0,05 % = 1000,5 */
  assert.deepStrictEqual(alerts.evaluate(rows, 1000, 999), []);
  assert.deepStrictEqual(alerts.evaluate(rows, 1000.4, 999), []);
  assert.deepStrictEqual(alerts.evaluate(rows, 1000.5, 999), ['a1']);
  assert.deepStrictEqual(alerts.evaluate(rows, 1200, 999), ['a1']);
});

test('below : symétrique', () => {
  const rows = [armed('b1', 'below', 1000)];
  /* seuil = 1000 - 0,05 % = 999,5 */
  assert.deepStrictEqual(alerts.evaluate(rows, 1000, 1001), []);
  assert.deepStrictEqual(alerts.evaluate(rows, 999.6, 1001), []);
  assert.deepStrictEqual(alerts.evaluate(rows, 999.5, 1001), ['b1']);
});

test('un seul tir par franchissement : le tick suivant se tait', () => {
  const rows = [armed('a1', 'above', 1000)];
  assert.deepStrictEqual(alerts.evaluate(rows, 1001, 999), ['a1']);
  /* le prix reste au-dessus : plus de franchissement, donc plus de tir */
  assert.deepStrictEqual(alerts.evaluate(rows, 1002, 1001), []);
});

test('sans tick précédent, la condition vraie suffit', () => {
  const rows = [armed('a1', 'above', 1000)];
  assert.deepStrictEqual(alerts.evaluate(rows, 1200, null), ['a1']);
  assert.deepStrictEqual(alerts.evaluate(rows, 900, undefined), []);
});

test('les alertes déjà déclenchées sont ignorées', () => {
  const triggered = armed('a1', 'above', 1000);
  triggered.status = 'triggered';
  triggered.triggered_at = '2026-09-09T10:00:00Z';
  assert.deepStrictEqual(alerts.evaluate([triggered], 1200, 999), []);

  const localFired = armed('a2', 'above', 1000);
  localFired.fired = true;
  assert.deepStrictEqual(alerts.evaluate([localFired], 1200, 999), []);
});

test('entrées mal formées : ignorées sans exception', () => {
  const rows = [
    null,
    { id: 'x', op: 'sideways', price: 10, status: 'armed' },
    { id: 'y', op: 'above', price: null, status: 'armed' },
    { id: 'z', op: 'above', price: 0, status: 'armed' }
  ];
  assert.deepStrictEqual(alerts.evaluate(rows, 1200, 1), []);
  assert.deepStrictEqual(alerts.evaluate(null, 1200, 1), []);
  assert.deepStrictEqual(alerts.evaluate([armed('a', 'above', 10)], null, 1), []);
});

test('plusieurs alertes peuvent tirer sur le même tick', () => {
  const rows = [armed('a1', 'above', 1000), armed('a2', 'above', 1100),
                armed('b1', 'below', 900)];
  assert.deepStrictEqual(alerts.evaluate(rows, 1200, 950), ['a1', 'a2']);
});

test('thresholdFor expose le seuil réellement utilisé', () => {
  assert.strictEqual(alerts.thresholdFor(armed('a', 'above', 1000)), 1000.5);
  assert.strictEqual(alerts.thresholdFor(armed('b', 'below', 1000)), 999.5);
  assert.strictEqual(alerts.HYSTERESIS_PCT, 0.05);
});

test('forSymbol filtre sur le symbole affiché', () => {
  const rows = [armed('a', 'above', 1), { id: 'b', symbol: 'AAPL', op: 'above',
                                          price: 2, status: 'armed' }];
  assert.deepStrictEqual(alerts.forSymbol(rows, 'btc-usd').map((r) => r.id), ['a']);
  assert.deepStrictEqual(alerts.forSymbol(rows, 'AAPL').map((r) => r.id), ['b']);
  assert.deepStrictEqual(alerts.forSymbol(rows, ''), []);
});
