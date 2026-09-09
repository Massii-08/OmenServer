/**
 * lib/alerts.js — évaluation PURE des alertes de prix côté extension.
 *
 * Le prix vient du titre de l'onglet TradingView (1 Hz) : l'alerte tire dans
 * la seconde au lieu d'attendre le guetteur serveur (15 min). Le serveur garde
 * son évaluation comme filet (spec §7, levier 5) ; côté extension on ne fait
 * QUE décider, l'appel réseau (``POST /alerts/{id}/fire``) est fait par
 * ``content.js``.
 *
 * Forme d'une alerte = celle de ``price_alerts.new_alert`` :
 * ``{id, symbol, op: 'above'|'below', price, status: 'armed'|'triggered',
 *   triggered_at, trigger_price}``. Les alertes déjà déclenchées sont ignorées
 * (ONE-SHOT, comme côté serveur) ; ``fired: true`` est aussi accepté (marquage
 * local posé par le panneau entre le tir et la confirmation du serveur).
 *
 * HYSTÉRÉSIS : le prix doit dépasser le niveau de 0,05 % pour déclencher. Sans
 * elle, un cours qui oscille sur le niveau (spread, dernier chiffre qui danse)
 * ferait tirer l'alerte sur du bruit.
 */
(function () {
  'use strict';

  /* En POURCENT (0,05 % = cinq points de base). */
  var HYSTERESIS_PCT = 0.05;

  function toNumber(value) {
    if (value === null || value === undefined || value === '') { return null; }
    var n = Number(value);
    return isFinite(n) ? n : null;
  }

  /** Une alerte encore armée ? (déclenchée ou mal formée -> non) */
  function isArmed(alert) {
    if (!alert || typeof alert !== 'object') { return false; }
    if (alert.fired === true) { return false; }
    if (alert.status && String(alert.status) !== 'armed') { return false; }
    if (alert.triggered_at) { return false; }
    if (alert.op !== 'above' && alert.op !== 'below') { return false; }
    return toNumber(alert.price) !== null && toNumber(alert.price) > 0;
  }

  /**
   * Le niveau RÉEL à franchir, hystérésis comprise.
   * ``above`` -> niveau + 0,05 % ; ``below`` -> niveau - 0,05 %.
   */
  function thresholdFor(alert) {
    var level = toNumber(alert && alert.price);
    if (level === null) { return null; }
    var margin = level * (HYSTERESIS_PCT / 100);
    return alert.op === 'above' ? level + margin : level - margin;
  }

  /**
   * ``evaluate(alerts, price, prevPrice) -> [ids déclenchées]``.
   *
   * Déclenche au FRANCHISSEMENT : le tick précédent doit être du bon côté du
   * seuil. Au tout premier tick (``prevPrice`` absent) on tire si la condition
   * est vraie — une alerte n'est jamais posée sur un niveau déjà dépassé (le
   * serveur refuse à la création), donc être au-delà signifie que le niveau a
   * bien été franchi pendant que le panneau ne regardait pas.
   */
  function evaluate(alerts, price, prevPrice) {
    var current = toNumber(price);
    if (current === null) { return []; }
    var previous = toNumber(prevPrice);
    var list = Array.isArray(alerts) ? alerts : [];
    var fired = [];

    for (var i = 0; i < list.length; i += 1) {
      var alert = list[i];
      if (!isArmed(alert)) { continue; }
      var threshold = thresholdFor(alert);
      if (threshold === null) { continue; }
      var crossed = false;
      if (alert.op === 'above') {
        crossed = current >= threshold && (previous === null || previous < threshold);
      } else {
        crossed = current <= threshold && (previous === null || previous > threshold);
      }
      if (crossed) { fired.push(String(alert.id)); }
    }
    return fired;
  }

  /** Les alertes du symbole affiché, dans l'ordre reçu. */
  function forSymbol(alerts, symbol) {
    var wanted = String(symbol || '').toUpperCase();
    if (!wanted) { return []; }
    var list = Array.isArray(alerts) ? alerts : [];
    var out = [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && String(list[i].symbol || '').toUpperCase() === wanted) {
        out.push(list[i]);
      }
    }
    return out;
  }

  var api = {
    evaluate: evaluate,
    isArmed: isArmed,
    thresholdFor: thresholdFor,
    forSymbol: forSymbol,
    HYSTERESIS_PCT: HYSTERESIS_PCT
  };

  globalThis.OmenLib = globalThis.OmenLib || {};
  globalThis.OmenLib.alerts = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})();
