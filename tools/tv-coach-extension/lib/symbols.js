/**
 * lib/symbols.js — TradingView -> Yahoo, table PURE (zéro I/O, zéro chrome.*).
 *
 * MIROIR OBLIGATOIRE de ``brief.tv_to_yahoo`` (backend) : la table du plan §1.1
 * est la source de vérité des DEUX côtés, et les deux suites de tests la
 * couvrent à l'identique. Toute entrée ajoutée ici doit l'être là-bas — sinon
 * l'extension demande une fiche que le serveur ne sait pas construire.
 *
 * Un symbole inconnu rend ``null`` (jamais une invention) : le panneau affiche
 * alors « titre non suivi par l'Omen » (spec §11).
 *
 * Double usage : ``globalThis.OmenLib.symbols`` en content script,
 * ``module.exports`` sous ``node --test``.
 */
(function () {
  'use strict';

  /* Places US : le ticker Yahoo est le ticker TradingView tel quel (le point
     des classes d'actions devient un tiret : NYSE:BRK.B -> BRK-B). */
  var US_EXCHANGES = ['NASDAQ', 'NYSE', 'AMEX', 'BATS'];

  /* Places à suffixe Yahoo. EURONEXT couvre plusieurs pays chez TradingView ;
     ``.PA`` est le repli documenté (les cas d'Amsterdam/Bruxelles se règlent
     par une entrée dans FULL_OVERRIDES, pas par une devinette). */
  var SUFFIX_BY_EXCHANGE = {
    SIX: '.SW',
    BX: '.SW',
    XETR: '.DE',
    FWB: '.DE',
    EURONEXT: '.PA',
    LSE: '.L',
    MIL: '.MI'
  };

  /* Cas nommés : le ticker de la place ne se déduit pas du ticker Yahoo. */
  var FULL_OVERRIDES = {
    'BX:NESR': 'NESN.SW',      /* Nestlé sur BX Swiss */
    'TVC:UKOIL': 'BZ=F',
    'TVC:USOIL': 'CL=F',
    'TVC:GOLD': 'GC=F',
    'CME:BTC1!': 'BTC=F'
  };

  /* Places dont AUCUN ticker ne se déduit : seule FULL_OVERRIDES répond. */
  var LOOKUP_ONLY_EXCHANGES = ['TVC', 'CME'];

  var CRYPTO_EXCHANGES = ['BITSTAMP', 'BINANCE', 'KRAKEN', 'COINBASE', 'CRYPTO'];
  var CRYPTO_BASES = { BTC: 'BTC', XBT: 'BTC', ETH: 'ETH', SOL: 'SOL', XRP: 'XRP' };
  var CRYPTO_QUOTES = { USD: 'USD', USDT: 'USD', USDC: 'USD' };

  var FX_EXCHANGES = ['FX', 'OANDA', 'FX_IDC'];

  /** Nettoyage commun : trim + majuscules. Rend '' pour une entrée vide. */
  function normalize(tvSymbol) {
    if (tvSymbol === null || tvSymbol === undefined) { return ''; }
    return String(tvSymbol).trim().toUpperCase();
  }

  /**
   * Coupe ``EXCHANGE:TICKER``. Sans deux-points -> ``null`` : TradingView
   * qualifie TOUJOURS ses symboles, un ticker nu est trop ambigu pour être
   * mappé sans risque (AAPL sur quelle place ? BTCUSD chez qui ?).
   */
  function split(tvSymbol) {
    var cleaned = normalize(tvSymbol);
    var cut = cleaned.indexOf(':');
    if (cut <= 0 || cut === cleaned.length - 1) { return null; }
    return { exchange: cleaned.slice(0, cut), ticker: cleaned.slice(cut + 1) };
  }

  /** Le contrat perpétuel de TradingView porte le suffixe ``.P``. */
  function isPerp(tvSymbol) {
    var parts = split(tvSymbol);
    if (parts === null) { return false; }
    if (CRYPTO_EXCHANGES.indexOf(parts.exchange) === -1) { return false; }
    return /\.P$/.test(parts.ticker);
  }

  function stripPerp(ticker) {
    return String(ticker).replace(/\.P$/, '');
  }

  function cryptoToYahoo(ticker) {
    var pair = stripPerp(ticker);
    var bases = Object.keys(CRYPTO_BASES);
    for (var i = 0; i < bases.length; i += 1) {
      var base = bases[i];
      if (pair.indexOf(base) !== 0) { continue; }
      var quote = pair.slice(base.length);
      if (Object.prototype.hasOwnProperty.call(CRYPTO_QUOTES, quote)) {
        return CRYPTO_BASES[base] + '-' + CRYPTO_QUOTES[quote];
      }
    }
    return null;
  }

  function fxToYahoo(ticker) {
    if (!/^[A-Z]{6}$/.test(ticker)) { return null; }
    return ticker + '=X';
  }

  /**
   * ``tvToYahoo('SIX:NESN') -> 'NESN.SW'`` ; inconnu -> ``null``.
   * Insensible à la casse, tolère les espaces autour.
   */
  function tvToYahoo(tvSymbol) {
    var cleaned = normalize(tvSymbol);
    if (!cleaned) { return null; }
    if (Object.prototype.hasOwnProperty.call(FULL_OVERRIDES, cleaned)) {
      return FULL_OVERRIDES[cleaned];
    }
    var parts = split(cleaned);
    if (parts === null) { return null; }
    var exchange = parts.exchange;
    var ticker = parts.ticker;

    if (CRYPTO_EXCHANGES.indexOf(exchange) !== -1) { return cryptoToYahoo(ticker); }
    if (FX_EXCHANGES.indexOf(exchange) !== -1) { return fxToYahoo(ticker); }
    if (LOOKUP_ONLY_EXCHANGES.indexOf(exchange) !== -1) { return null; }
    if (US_EXCHANGES.indexOf(exchange) !== -1) {
      if (!/^[A-Z0-9.\-]+$/.test(ticker)) { return null; }
      return ticker.replace(/\./g, '-');
    }
    if (Object.prototype.hasOwnProperty.call(SUFFIX_BY_EXCHANGE, exchange)) {
      if (!/^[A-Z0-9]+$/.test(ticker)) { return null; }
      return ticker + SUFFIX_BY_EXCHANGE[exchange];
    }
    return null;
  }

  /**
   * Famille d'un symbole YAHOO (plan §1.1) : ``-USD``/``-EUR`` -> crypto,
   * ``=X`` -> forex, ``=F`` -> commodity, ``^`` -> index, sinon action.
   */
  function kindOf(yahooSymbol) {
    var symbol = normalize(yahooSymbol);
    if (!symbol) { return null; }
    if (symbol.charAt(0) === '^') { return 'index'; }
    if (/-(USD|EUR|USDT|CHF)$/.test(symbol)) { return 'crypto'; }
    if (/=X$/.test(symbol)) { return 'forex'; }
    if (/=F$/.test(symbol)) { return 'commodity'; }
    return 'stock';
  }

  /** Le raccourci du panneau : tout ce qu'il faut savoir d'un onglet. */
  function describe(tvSymbol) {
    var symbol = tvToYahoo(tvSymbol);
    return {
      tv_symbol: normalize(tvSymbol) || null,
      symbol: symbol,
      kind: symbol === null ? null : kindOf(symbol),
      perp: isPerp(tvSymbol)
    };
  }

  var api = {
    tvToYahoo: tvToYahoo,
    kindOf: kindOf,
    describe: describe,
    isPerp: isPerp,
    split: split,
    normalize: normalize,
    US_EXCHANGES: US_EXCHANGES,
    SUFFIX_BY_EXCHANGE: SUFFIX_BY_EXCHANGE,
    FULL_OVERRIDES: FULL_OVERRIDES,
    CRYPTO_EXCHANGES: CRYPTO_EXCHANGES,
    FX_EXCHANGES: FX_EXCHANGES
  };

  globalThis.OmenLib = globalThis.OmenLib || {};
  globalThis.OmenLib.symbols = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})();
