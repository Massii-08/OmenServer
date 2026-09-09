/**
 * Bougies 1 minute, ATR de Wilder, haut/bas du jour et spread — mode scalp.
 *
 * PUR : aucun DOM, aucun `chrome.*`, aucun réseau, jamais `Date.now()`. Tout
 * le temps vient des `ts_ms` passés par l'appelant (le tick live lu par
 * `bridge.js`) — c'est ce qui rend le module testable à la seconde près et
 * rejouable à l'identique.
 *
 * Bougies FERMÉES uniquement dans bars() : une bougie ne se ferme jamais sur
 * un minuteur, elle se ferme quand le PREMIER tick de la minute suivante
 * arrive (comme un flux de ticks réel n'a pas d'horloge à lui). Conséquence
 * assumée : la minute en cours n'apparaît jamais dans bars() tant qu'aucun
 * tick de la minute suivante n'est arrivé — sur une séquence qui s'arrête en
 * plein milieu d'une minute, cette dernière minute reste ouverte pour
 * toujours (documenté aussi dans tests/bars.test.js).
 *
 * ATR de Wilder : même algorithme que `backend/bots/paper/ta.py::atr14`
 * (amorce = moyenne simple des 14 premiers true ranges, puis lissage
 * `(precedent * 13 + courant) / 14`), retranscrit ici pour rester sans
 * dépendance côté extension. Il faut n+1 bougies fermées (15 par défaut)
 * pour la première valeur — en dessous, `null`, jamais un chiffre inventé.
 *
 * `vwap()` rend toujours `null` : sans le volume (TradingView ne l'expose pas
 * de façon fiable sur les pastilles lues par `bridge.js`), calculer un VWAP
 * serait fabriquer un chiffre qui prétend peser les prix par un volume qu'on
 * n'a pas. Le VWAP réel vient de `brief.ta.vwap`, calculé côté serveur sur
 * les bougies Yahoo qui, elles, portent un volume.
 */
(function (root) {
  "use strict";

  var MINUTE_MS = 60000;
  var DAY_MS = 86400000;
  var ATR_DEFAULT_PERIOD = 14;
  var MEDIAN_ATR_DEFAULT_HOURS = 4;
  var SPREAD_WINDOW = 200;

  function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function minuteStart(ts_ms) {
    return Math.floor(ts_ms / MINUTE_MS) * MINUTE_MS;
  }

  function utcDayKey(ts_ms) {
    return Math.floor(ts_ms / DAY_MS);
  }

  function median(values) {
    if (!values || values.length === 0) return null;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var n = sorted.length;
    var mid = Math.floor(n / 2);
    if (n % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
    return sorted[mid];
  }

  /**
   * Série des ATR(period) glissants alignée sur l'index des bougies :
   * `series[i]` est l'ATR calculé en n'utilisant que les bougies `[0..i]`,
   * défini seulement pour `i >= period` (il faut `period + 1` bougies).
   * Partagée par `atr()` (dernier élément) et `medianAtr()` (filtre par
   * fenêtre temporelle puis médiane) — un seul passage de lissage de Wilder,
   * jamais deux implémentations qui pourraient diverger.
   */
  function rollingAtrSeries(closedBars, period) {
    var series = new Array(closedBars.length);
    if (closedBars.length < period + 1) return series;

    var ranges = [];
    for (var i = 1; i < closedBars.length; i++) {
      var bar = closedBars[i];
      var previousClose = closedBars[i - 1].c;
      var trueRange = bar.h - bar.l;
      if (isFiniteNumber(previousClose)) {
        trueRange = Math.max(
          trueRange,
          Math.abs(bar.h - previousClose),
          Math.abs(bar.l - previousClose)
        );
      }
      ranges.push(trueRange);

      if (ranges.length === period) {
        var seed = 0;
        for (var k = 0; k < period; k++) seed += ranges[k];
        series[i] = seed / period;
      } else if (ranges.length > period) {
        var previousAtr = series[i - 1];
        series[i] = (previousAtr * (period - 1) + trueRange) / period;
      }
    }
    return series;
  }

  function createBars() {
    var closed = []; // [{t,o,h,l,c}] — FERMÉES uniquement
    var current = null; // {t,o,h,l,c} en cours de formation, jamais exposée
    var lastTs = null; // ts_ms du dernier push() valide — sert de "now" pour
    // le rollover de jour UTC et la fenêtre de medianAtr : ce module ne lit
    // jamais l'horloge système, "maintenant" est toujours défini par le
    // dernier tick reçu.

    var day = { key: null, high: null, low: null };
    var spreadSamples = [];

    function push(ts_ms, price) {
      if (!isFiniteNumber(ts_ms) || !isFiniteNumber(price)) return;

      var mStart = minuteStart(ts_ms);
      if (current === null) {
        current = { t: mStart, o: price, h: price, l: price, c: price };
      } else if (mStart === current.t) {
        if (price > current.h) current.h = price;
        if (price < current.l) current.l = price;
        current.c = price;
      } else if (mStart > current.t) {
        closed.push(current);
        current = { t: mStart, o: price, h: price, l: price, c: price };
      } else {
        // Tick en retard sur une minute déjà refermée ou en cours : ignoré
        // plutôt que de réécrire une bougie qu'on a déjà considérée close.
        return;
      }

      lastTs = ts_ms;

      var dayKey = utcDayKey(ts_ms);
      if (day.key === null || dayKey !== day.key) {
        day.key = dayKey;
        day.high = price;
        day.low = price;
      } else {
        if (price > day.high) day.high = price;
        if (price < day.low) day.low = price;
      }
    }

    function bars() {
      return closed.map(function (bar) {
        return { t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c };
      });
    }

    function atr(n) {
      var period = isFiniteNumber(n) ? n : ATR_DEFAULT_PERIOD;
      if (closed.length < period + 1) return null;
      var series = rollingAtrSeries(closed, period);
      var value = series[closed.length - 1];
      return isFiniteNumber(value) ? value : null;
    }

    function medianAtr(hours) {
      var period = ATR_DEFAULT_PERIOD;
      if (closed.length < period + 1 || lastTs === null) return null;
      var windowHours = isFiniteNumber(hours) ? hours : MEDIAN_ATR_DEFAULT_HOURS;
      var series = rollingAtrSeries(closed, period);
      var windowStart = lastTs - windowHours * 3600000;

      var values = [];
      for (var i = period; i < closed.length; i++) {
        if (closed[i].t >= windowStart && isFiniteNumber(series[i])) {
          values.push(series[i]);
        }
      }
      return median(values);
    }

    function dayHigh() {
      return day.high;
    }

    function dayLow() {
      return day.low;
    }

    function pushSpread(bid, ask) {
      if (!isFiniteNumber(bid) || !isFiniteNumber(ask)) return;
      var mid = (bid + ask) / 2;
      if (mid === 0) return;
      var pct = ((ask - bid) / mid) * 100;
      spreadSamples.push(pct);
      if (spreadSamples.length > SPREAD_WINDOW) spreadSamples.shift();
    }

    function spread() {
      if (spreadSamples.length === 0) return null;
      return spreadSamples[spreadSamples.length - 1];
    }

    function medianSpread() {
      return median(spreadSamples);
    }

    function vwap() {
      return null;
    }

    return {
      push: push,
      bars: bars,
      atr: atr,
      medianAtr: medianAtr,
      dayHigh: dayHigh,
      dayLow: dayLow,
      pushSpread: pushSpread,
      spread: spread,
      medianSpread: medianSpread,
      vwap: vwap
    };
  }

  var api = { createBars: createBars };
  root.OmenLib = root.OmenLib || {};
  root.OmenLib.bars = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
