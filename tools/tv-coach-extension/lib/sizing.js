/**
 * lib/sizing.js — combien d'unités pour un scalp (PUR).
 *
 * POURQUOI CE MODULE EXISTE. En mode scalp il n'y a le plus souvent PAS de
 * ticket, donc pas de quantité calculée par le serveur : ``openScalp`` tombait
 * sur son défaut, ``1``. Le 11/09, « 1 » voulait dire UN BITCOIN — 77 216 USD,
 * soit 62 770 CHF d'exposition pour un portefeuille papier de 10 000 CHF, six
 * fois le capital, 326 CHF de frais aller-retour pour 43 secondes de position.
 * La spec (§6, « Ticket ») demandait depuis le début une quantité AUTOMATIQUE
 * ``risk_pct x equity / distance stop`` ; elle vit ici, et elle est BORNÉE par
 * le capital.
 *
 * DEUX BORNES, LA PLUS PETITE GAGNE.
 *   1. le RISQUE : ``equity x risk_pct / 100`` francs perdus si le stop tombe,
 *      divisé par la distance de stop (convertie en francs) ;
 *   2. le CAPITAL : ``equity x max_notional_pct / 100`` francs d'exposition,
 *      100 % par défaut — comptant, pas de levier : on ne peut pas engager plus
 *      d'argent qu'on n'en a.
 * ``capped_by`` dit laquelle a mordu, pour que l'écran puisse l'expliquer.
 *
 * LA DISTANCE DE STOP EST IMPLICITE. Un scalp n'a pas de stop saisi : on prend
 * ``2 x ATR`` (la respiration de la minute), avec un PLANCHER à 0,15 % du prix
 * — sans lui, un ATR endormi (marché plat, début de séance) ferait un stop
 * minuscule, donc une quantité énorme. Sans ATR du tout : 0,3 % du prix.
 *
 * TOUT REPLI SOUS-DIMENSIONNE, JAMAIS L'INVERSE. Le taux de change manquant
 * vaut 1 : un dollar compté comme un franc coûte PLUS cher que la réalité, donc
 * on achète MOINS. C'est le sens sûr de l'erreur.
 *
 * ARRONDI PAR LE BAS, toujours : 4 décimales pour une crypto (on achète des
 * fractions de bitcoin), l'entier pour tout le reste (on n'achète pas 53,4
 * actions). Sous le lot minimal, la réponse est ZÉRO et ``capped_by`` vaut
 * ``insufficient`` — le panneau refuse le scalp au lieu d'en ouvrir un faux.
 *
 * Double usage : ``globalThis.OmenLib.sizing`` en content script,
 * ``module.exports`` sous ``node --test``.
 */
(function () {
  'use strict';

  var DEFAULT_RISK_PCT = 1;
  var DEFAULT_MAX_NOTIONAL_PCT = 100;
  var ATR_MULTIPLE = 2;
  var MIN_STOP_PCT = 0.0015;          /* plancher : 0,15 % du prix */
  var NO_ATR_STOP_PCT = 0.003;        /* sans ATR : 0,3 % du prix */
  var CRYPTO_DECIMALS = 4;

  function num(value) {
    if (value === null || value === undefined || value === '') { return null; }
    if (typeof value === 'boolean') { return null; }
    var parsed = Number(value);
    return isFinite(parsed) ? parsed : null;
  }

  /** Strictement positif, sinon ``null`` : un prix nul n'est pas un prix. */
  function positive(value) {
    var parsed = num(value);
    return (parsed === null || parsed <= 0) ? null : parsed;
  }

  function round2(value) {
    return Math.round(value * 100) / 100;
  }

  /**
   * Plancher à ``decimals`` décimales, avec une tolérance RELATIVE : sans elle,
   * une quantité qui vaut mathématiquement 0,5 mais 0,49999999999999994 en
   * flottant tomberait à 0,4999. La tolérance ne peut pas faire monter d'un
   * cran une valeur franchement inférieure (elle vaut un milliardième).
   */
  function floorTo(value, decimals) {
    var factor = Math.pow(10, decimals);
    var units = value * factor;
    return Math.floor(units + Math.abs(units) * 1e-9) / factor;
  }

  /**
   * ``scalpQty({equity_chf, risk_pct, price, fx_to_chf, atr, kind,
   * max_notional_pct})`` ->
   * ``{qty, notional_chf, stop_distance, risk_chf, capped_by}``.
   *
   * ``null`` quand le capital ou le prix manquent (ou ne sont pas positifs) :
   * sans l'un des deux il n'y a rien d'honnête à proposer, et l'appelant doit
   * refuser le scalp plutôt que d'inventer une unité.
   *
   * ``capped_by`` : ``'risk'`` (la distance de stop borne), ``'notional'`` (le
   * capital borne), ``'insufficient'`` (même le lot minimal est hors de
   * portée — ``qty`` et ``notional_chf`` valent alors 0).
   *
   * ``price`` et ``atr`` sont dans la devise du titre ; ``equity_chf`` et le
   * résultat sont en francs. ``fx_to_chf`` fait le pont.
   */
  function scalpQty(input) {
    var data = (input && typeof input === 'object') ? input : {};
    var equity = positive(data.equity_chf);
    var price = positive(data.price);
    if (equity === null || price === null) { return null; }

    var fx = positive(data.fx_to_chf);
    if (fx === null) { fx = 1; }

    var riskPct = positive(data.risk_pct);
    if (riskPct === null) { riskPct = DEFAULT_RISK_PCT; }

    var maxNotionalPct = positive(data.max_notional_pct);
    if (maxNotionalPct === null) { maxNotionalPct = DEFAULT_MAX_NOTIONAL_PCT; }

    var atr = positive(data.atr);
    var stopDistance = atr === null
      ? price * NO_ATR_STOP_PCT
      : Math.max(ATR_MULTIPLE * atr, price * MIN_STOP_PCT);

    var riskChf = equity * riskPct / 100;
    var qtyRisk = riskChf / (stopDistance * fx);
    var qtyCap = (equity * maxNotionalPct / 100) / (price * fx);

    var cappedBy = qtyCap < qtyRisk ? 'notional' : 'risk';
    var raw = Math.min(qtyRisk, qtyCap);

    var decimals = data.kind === 'crypto' ? CRYPTO_DECIMALS : 0;
    var qty = floorTo(raw, decimals);
    var minimum = 1 / Math.pow(10, decimals);

    if (!(qty >= minimum)) {
      return { qty: 0, notional_chf: 0, stop_distance: stopDistance,
               risk_chf: round2(riskChf), capped_by: 'insufficient' };
    }

    return {
      qty: qty,
      notional_chf: round2(qty * price * fx),
      stop_distance: stopDistance,
      risk_chf: round2(riskChf),
      capped_by: cappedBy
    };
  }

  var api = {
    scalpQty: scalpQty,
    DEFAULT_RISK_PCT: DEFAULT_RISK_PCT,
    DEFAULT_MAX_NOTIONAL_PCT: DEFAULT_MAX_NOTIONAL_PCT,
    ATR_MULTIPLE: ATR_MULTIPLE,
    MIN_STOP_PCT: MIN_STOP_PCT,
    NO_ATR_STOP_PCT: NO_ATR_STOP_PCT
  };

  globalThis.OmenLib = globalThis.OmenLib || {};
  globalThis.OmenLib.sizing = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})();
