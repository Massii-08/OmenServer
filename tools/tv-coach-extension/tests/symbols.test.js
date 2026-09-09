'use strict';

/**
 * tests/symbols.test.js — la table du plan §1.1, cas par cas.
 *
 * MIROIR : le test jumeau côté serveur (``test_tvcoach_brief.py``) couvre la
 * MÊME table. Si l'un des deux change, l'autre doit changer aussi.
 */
const test = require('node:test');
const assert = require('node:assert');

const symbols = require('../lib/symbols.js');

test('actions US : le ticker passe tel quel', () => {
  assert.strictEqual(symbols.tvToYahoo('NASDAQ:AAPL'), 'AAPL');
  assert.strictEqual(symbols.tvToYahoo('BATS:AAPL'), 'AAPL');
  assert.strictEqual(symbols.tvToYahoo('NYSE:KO'), 'KO');
  assert.strictEqual(symbols.tvToYahoo('AMEX:SPY'), 'SPY');
});

test('classes d’actions US : le point devient un tiret', () => {
  assert.strictEqual(symbols.tvToYahoo('NYSE:BRK.B'), 'BRK-B');
});

test('places suisses, allemandes, françaises, anglaises, italiennes', () => {
  assert.strictEqual(symbols.tvToYahoo('SIX:NESN'), 'NESN.SW');
  assert.strictEqual(symbols.tvToYahoo('SIX:ROG'), 'ROG.SW');
  assert.strictEqual(symbols.tvToYahoo('BX:NESR'), 'NESN.SW');
  assert.strictEqual(symbols.tvToYahoo('XETR:SAP'), 'SAP.DE');
  assert.strictEqual(symbols.tvToYahoo('FWB:SAP'), 'SAP.DE');
  assert.strictEqual(symbols.tvToYahoo('EURONEXT:MC'), 'MC.PA');
  assert.strictEqual(symbols.tvToYahoo('EURONEXT:AIR'), 'AIR.PA');
  assert.strictEqual(symbols.tvToYahoo('LSE:SHEL'), 'SHEL.L');
  assert.strictEqual(symbols.tvToYahoo('MIL:ENI'), 'ENI.MI');
});

test('crypto : toutes les places mènent au même symbole Yahoo', () => {
  assert.strictEqual(symbols.tvToYahoo('BITSTAMP:BTCUSD'), 'BTC-USD');
  assert.strictEqual(symbols.tvToYahoo('BINANCE:BTCUSDT'), 'BTC-USD');
  assert.strictEqual(symbols.tvToYahoo('KRAKEN:XBTUSD'), 'BTC-USD');
  assert.strictEqual(symbols.tvToYahoo('COINBASE:BTCUSD'), 'BTC-USD');
  assert.strictEqual(symbols.tvToYahoo('CRYPTO:BTCUSD'), 'BTC-USD');
});

test('crypto : le suffixe .P du perpétuel est retiré', () => {
  assert.strictEqual(symbols.tvToYahoo('BINANCE:BTCUSDT.P'), 'BTC-USD');
  assert.strictEqual(symbols.isPerp('BINANCE:BTCUSDT.P'), true);
  assert.strictEqual(symbols.isPerp('BINANCE:BTCUSDT'), false);
  assert.strictEqual(symbols.isPerp('NASDAQ:AAPL'), false);
});

test('crypto : ETH, SOL, XRP suivent la même règle', () => {
  assert.strictEqual(symbols.tvToYahoo('BINANCE:ETHUSDT'), 'ETH-USD');
  assert.strictEqual(symbols.tvToYahoo('COINBASE:SOLUSD'), 'SOL-USD');
  assert.strictEqual(symbols.tvToYahoo('BITSTAMP:XRPUSD'), 'XRP-USD');
});

test('devises', () => {
  assert.strictEqual(symbols.tvToYahoo('FX:EURUSD'), 'EURUSD=X');
  assert.strictEqual(symbols.tvToYahoo('OANDA:EURUSD'), 'EURUSD=X');
  assert.strictEqual(symbols.tvToYahoo('FX_IDC:EURUSD'), 'EURUSD=X');
});

test('matières premières et contrat CME', () => {
  assert.strictEqual(symbols.tvToYahoo('TVC:UKOIL'), 'BZ=F');
  assert.strictEqual(symbols.tvToYahoo('TVC:USOIL'), 'CL=F');
  assert.strictEqual(symbols.tvToYahoo('TVC:GOLD'), 'GC=F');
  assert.strictEqual(symbols.tvToYahoo('CME:BTC1!'), 'BTC=F');
});

test('la casse et les espaces n’ont aucune importance', () => {
  assert.strictEqual(symbols.tvToYahoo('bats:aapl'), 'AAPL');
  assert.strictEqual(symbols.tvToYahoo('  six:nesn  '), 'NESN.SW');
  assert.strictEqual(symbols.tvToYahoo('binance:btcusdt.p'), 'BTC-USD');
  assert.strictEqual(symbols.tvToYahoo('tvc:ukoil'), 'BZ=F');
});

test('inconnu -> null, jamais une invention', () => {
  assert.strictEqual(symbols.tvToYahoo('WTF:XYZ'), null);
  assert.strictEqual(symbols.tvToYahoo('TVC:SILVER'), null);
  assert.strictEqual(symbols.tvToYahoo('BINANCE:DOGEUSDT'), null);
  assert.strictEqual(symbols.tvToYahoo('FX:EUR'), null);
  assert.strictEqual(symbols.tvToYahoo('AAPL'), null);
  assert.strictEqual(symbols.tvToYahoo(''), null);
  assert.strictEqual(symbols.tvToYahoo(null), null);
  assert.strictEqual(symbols.tvToYahoo('NASDAQ:'), null);
});

test('kindOf déduit la famille du symbole Yahoo', () => {
  assert.strictEqual(symbols.kindOf('AAPL'), 'stock');
  assert.strictEqual(symbols.kindOf('NESN.SW'), 'stock');
  assert.strictEqual(symbols.kindOf('BTC-USD'), 'crypto');
  assert.strictEqual(symbols.kindOf('EURUSD=X'), 'forex');
  assert.strictEqual(symbols.kindOf('BZ=F'), 'commodity');
  assert.strictEqual(symbols.kindOf('^GSPC'), 'index');
  assert.strictEqual(symbols.kindOf(''), null);
});

test('describe rassemble ce dont le panneau a besoin', () => {
  assert.deepStrictEqual(symbols.describe('BINANCE:BTCUSDT.P'), {
    tv_symbol: 'BINANCE:BTCUSDT.P',
    symbol: 'BTC-USD',
    kind: 'crypto',
    perp: true
  });
  assert.deepStrictEqual(symbols.describe('WTF:XYZ'), {
    tv_symbol: 'WTF:XYZ',
    symbol: null,
    kind: null,
    perp: false
  });
});

test('split rend l’exchange et le ticker, ou null', () => {
  assert.deepStrictEqual(symbols.split('SIX:NESN'), { exchange: 'SIX', ticker: 'NESN' });
  assert.strictEqual(symbols.split('NESN'), null);
});
