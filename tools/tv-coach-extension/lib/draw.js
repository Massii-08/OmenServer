/**
 * lib/draw.js — construction PURE des ordres de dessin envoyés à ``bridge.js``.
 *
 * Ce module ne touche JAMAIS TradingView : il rend une liste de commandes
 * typées, que le pont (monde MAIN) exécute avec ``createShape`` /
 * ``createMultipointShape`` / ``createOrderLine``. Toute la logique est donc
 * testable hors navigateur (``tests/draw.test.js``).
 *
 * Vocabulaire des commandes (contrat avec ``bridge.js``) :
 *   {kind: 'orderline',  key, price, text, quantity}
 *   {kind: 'shape',      shape, point: {time, price}, text, overrides}
 *   {kind: 'multipoint', shape, points: [{time, price}, ...], text, overrides}
 *   {kind: 'clear'}
 *
 * Tout texte posé sur le graphique commence par ``⌂ coach`` (spec §6.1) : le
 * pont garde les ids qu'il a créés et ``clear()`` ne retire QUE ceux-là — les
 * dessins de Massii ne sont jamais touchés.
 */
(function () {
  'use strict';

  var TAG = '⌂ coach';                 /* ⌂ coach */
  var MOVE_THRESHOLD_PCT = 3;               /* ±3 % à l'horizon (spec §6.1) */
  var TARGET_BAND_PCT = 0.5;                /* épaisseur de la zone cible */

  var COLOR_UP = '#00FFB0';
  var COLOR_DOWN = '#F87171';
  var COLOR_NEUTRAL = '#8FA3C4';
  var COLOR_TARGET = '#00D2FF';

  var CONFIDENCE_WORDS = {
    haute: 'haute', high: 'haute', alta: 'haute', forte: 'haute',
    moyenne: 'moyenne', medium: 'moyenne', media: 'moyenne', moyen: 'moyenne',
    faible: 'faible', low: 'faible', bassa: 'faible'
  };
  var GRADE_BY_WORD = { haute: 'A', moyenne: 'B', faible: 'C' };

  var OPEN_STATUSES = ['open', 'ouverte', 'ouvert', 'active', 'en cours', 'aperta'];

  function num(value) {
    if (value === null || value === undefined || value === '') { return null; }
    var n = Number(value);
    return isFinite(n) ? n : null;
  }

  function text(parts) {
    var kept = [TAG];
    for (var i = 0; i < parts.length; i += 1) {
      if (parts[i] !== null && parts[i] !== undefined && parts[i] !== '') {
        kept.push(String(parts[i]));
      }
    }
    return kept.join(' · ');            /* séparateur « · » */
  }

  /**
   * Note de confiance -> ``{grade, word}`` : haute -> A, moyenne -> B,
   * faible -> C. Accepte les mots FR/IT/EN et un nombre de 0 à 1.
   */
  function gradeOf(confidence) {
    if (typeof confidence === 'number' && isFinite(confidence)) {
      var scaled = confidence > 1 ? confidence / 100 : confidence;
      if (scaled >= 0.66) { return { grade: 'A', word: 'haute' }; }
      if (scaled >= 0.33) { return { grade: 'B', word: 'moyenne' }; }
      return { grade: 'C', word: 'faible' };
    }
    var key = String(confidence || '').trim().toLowerCase();
    var word = Object.prototype.hasOwnProperty.call(CONFIDENCE_WORDS, key)
      ? CONFIDENCE_WORDS[key] : 'moyenne';
    return { grade: GRADE_BY_WORD[word], word: word };
  }

  /** Sens du pari : +1 (hausse) ou -1 (baisse). Défaut : hausse. */
  function directionOf(hypothesis) {
    var raw = String((hypothesis && (hypothesis.direction || hypothesis.side
      || hypothesis.bias)) || '').trim().toLowerCase();
    if (raw === 'down' || raw === 'short' || raw === 'baisse' || raw === 'bearish'
        || raw === 'ribasso' || raw === 'sell') {
      return -1;
    }
    return 1;
  }

  /** Un pari encore ouvert ? (statut absent = ouvert, comme côté serveur) */
  function isOpen(hypothesis) {
    if (!hypothesis || typeof hypothesis !== 'object') { return false; }
    if (hypothesis.status === null || hypothesis.status === undefined
        || hypothesis.status === '') {
      return true;
    }
    return OPEN_STATUSES.indexOf(String(hypothesis.status).toLowerCase()) !== -1;
  }

  /**
   * ``levels({entry, stop, target, side, qty, label})`` -> lignes d'ordre
   * DÉPLAÇABLES (le pont renvoie ``tv:line_moved`` à chaque déplacement, ce
   * qui relance le pré-check).
   */
  function levels(spec) {
    var conf = spec || {};
    var out = [];
    var side = String(conf.side || '').toLowerCase();
    var qty = num(conf.qty);
    var quantity = qty === null ? '' : String(qty);
    var suffix = conf.label ? String(conf.label) : '';

    var entry = num(conf.entry);
    if (entry !== null) {
      out.push({
        kind: 'orderline', key: 'entry', price: entry, quantity: quantity,
        text: text([suffix, side === 'sell' || side === 'short' ? 'vente' : 'entrée']),
        color: side === 'sell' || side === 'short' ? COLOR_DOWN : COLOR_UP
      });
    }
    var stop = num(conf.stop);
    if (stop !== null) {
      out.push({
        kind: 'orderline', key: 'stop', price: stop, quantity: quantity,
        text: text([suffix, 'stop']), color: COLOR_DOWN
      });
    }
    var target = num(conf.target);
    if (target !== null) {
      out.push({
        kind: 'orderline', key: 'target', price: target, quantity: quantity,
        text: text([suffix, 'cible']), color: COLOR_TARGET
      });
    }
    return out;
  }

  /**
   * ``bets(hypotheses, price, nowSec)`` — les paris ouverts du coach :
   * une ligne de tendance du prix courant vers ±3 % à l'horizon, une verticale
   * d'échéance, et une zone cible quand ``target`` existe.
   */
  function bets(hypotheses, price, nowSec) {
    var start = num(price);
    var now = num(nowSec);
    var list = Array.isArray(hypotheses) ? hypotheses : [];
    if (start === null || now === null) { return []; }
    var out = [];

    for (var i = 0; i < list.length; i += 1) {
      var hypothesis = list[i];
      if (!isOpen(hypothesis)) { continue; }
      var horizonDays = num(hypothesis.horizon_days);
      if (horizonDays === null || horizonDays <= 0) { horizonDays = 30; }
      var end = Math.round(now + (horizonDays * 86400));
      var direction = directionOf(hypothesis);
      var endPrice = start * (1 + (direction * MOVE_THRESHOLD_PCT / 100));
      var mark = gradeOf(hypothesis.confidence);
      var label = text([mark.grade, mark.word]);
      var color = direction > 0 ? COLOR_UP : COLOR_DOWN;

      out.push({
        kind: 'multipoint', shape: 'trend_line',
        points: [{ time: Math.round(now), price: start }, { time: end, price: endPrice }],
        text: label,
        overrides: { linecolor: color, linewidth: 2, showLabel: true, textcolor: color },
        meta: { id: hypothesis.id === undefined ? null : hypothesis.id, role: 'bet' }
      });

      out.push({
        kind: 'shape', shape: 'vertical_line',
        point: { time: end, price: start },
        text: text([mark.grade, 'échéance']),
        overrides: { linecolor: COLOR_NEUTRAL, linewidth: 1, linestyle: 2 },
        meta: { id: hypothesis.id === undefined ? null : hypothesis.id, role: 'deadline' }
      });

      var target = num(hypothesis.target);
      if (target !== null) {
        var band = target * (TARGET_BAND_PCT / 100);
        out.push({
          kind: 'multipoint', shape: 'rectangle',
          points: [
            { time: Math.round(now), price: target + band },
            { time: end, price: target - band }
          ],
          text: text([mark.grade, 'zone cible']),
          overrides: {
            color: COLOR_TARGET, backgroundColor: COLOR_TARGET,
            fillBackground: true, transparency: 85, linewidth: 1
          },
          meta: { id: hypothesis.id === undefined ? null : hypothesis.id, role: 'target' }
        });
      }
    }
    return out;
  }

  /**
   * ``scalp({vwap, day_high, day_low, cme_gap}, nowSec, price)`` — les repères
   * du mode scalp. Un gap CME déjà comblé (``open: false``) n'est pas dessiné.
   *
   * ``price`` (optionnel) est le cours COURANT du titre affiché : un niveau
   * hors de ``[price × 0.8, price × 1.2]`` appartient forcément à un AUTRE
   * marché (fiche pas encore rafraîchie après un changement de titre — vécu :
   * bas du jour d'EURUSD à 1,16 dessiné sur BTC à 77 000, TradingView recadre
   * son échelle sur ce tracé et le graphique s'écrase) : il est IGNORÉ plutôt
   * que dessiné. Sans ``price`` (ou une valeur ≤ 0/illisible), aucun filtre —
   * comportement inchangé.
   */
  function scalp(levelsSpec, nowSec, price) {
    var conf = levelsSpec || {};
    var now = num(nowSec);
    if (now === null) { now = Math.floor(Date.now() / 1000); }
    var ref = num(price);
    var hasRef = ref !== null && ref > 0;
    var lo = hasRef ? ref * 0.8 : null;
    var hi = hasRef ? ref * 1.2 : null;
    var out = [];

    function line(levelPrice, label, color, style) {
      var value = num(levelPrice);
      if (value === null) { return; }
      if (hasRef && (value < lo || value > hi)) { return; }
      out.push({
        kind: 'shape', shape: 'horizontal_line',
        point: { time: Math.round(now), price: value },
        text: text([label]),
        overrides: {
          linecolor: color, linewidth: 1, linestyle: style,
          showLabel: true, textcolor: color
        },
        meta: { role: 'scalp' }
      });
    }

    line(conf.vwap, 'VWAP', COLOR_TARGET, 0);
    line(conf.day_high, 'haut du jour', COLOR_NEUTRAL, 2);
    line(conf.day_low, 'bas du jour', COLOR_NEUTRAL, 2);

    var gap = conf.cme_gap;
    if (gap && typeof gap === 'object' && gap.open !== false) {
      line(gap.level, 'gap CME', COLOR_DOWN, 1);
    }
    return out;
  }

  /** Efface les tracés POSÉS PAR L'EXTENSION (le pont connaît leurs ids). */
  function clear() {
    return [{ kind: 'clear' }];
  }

  var api = {
    levels: levels,
    bets: bets,
    scalp: scalp,
    clear: clear,
    gradeOf: gradeOf,
    directionOf: directionOf,
    isOpen: isOpen,
    text: text,
    TAG: TAG,
    MOVE_THRESHOLD_PCT: MOVE_THRESHOLD_PCT,
    TARGET_BAND_PCT: TARGET_BAND_PCT
  };

  globalThis.OmenLib = globalThis.OmenLib || {};
  globalThis.OmenLib.draw = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})();
