/**
 * lib/price_axis.js — l'ordonnée d'un clic sur le graphique -> un PRIX (PUR).
 *
 * Alt+clic sur le graphique pose une alerte (spec §8). Pour savoir SUR QUEL
 * niveau on vient de cliquer, ``bridge.js`` mesure le pane (son
 * ``getBoundingClientRect``) et lit la plage de prix affichée
 * (``chart.getVisiblePriceRange() -> {from, to}``), puis interpole : c'est
 * cette interpolation qui vit ici, seule et testable hors navigateur.
 *
 * CONVENTION D'AXE : à l'écran, y CROÎT vers le BAS ; le prix, lui, croît vers
 * le HAUT. Le bord SUPÉRIEUR du pane porte donc ``to`` (le prix le plus haut)
 * et le bord INFÉRIEUR ``from`` (le plus bas). ``getVisiblePriceRange`` rend
 * bien ``from`` = bas et ``to`` = haut ; si jamais les deux arrivaient
 * inversés, l'interpolation reste juste (elle ne suppose pas ``to > from``).
 *
 * ÉCHELLE LOGARITHMIQUE : NON GÉRÉE en v1, et c'est assumé. Sur une échelle
 * log, le prix rendu ici est faux d'autant plus que le clic s'éloigne du
 * milieu du pane — le panneau propose donc un prix ÉDITABLE, jamais une
 * création d'alerte à l'aveugle. (Le passage au log demanderait de lire l'état
 * de l'échelle, que l'API publique de TradingView n'expose pas.)
 *
 * Double usage : ``globalThis.OmenLib.price_axis`` en content script,
 * ``module.exports`` sous ``node --test``.
 */
(function () {
  'use strict';

  function num(value) {
    if (value === null || value === undefined || value === '') { return null; }
    var parsed = Number(value);
    return isFinite(parsed) ? parsed : null;
  }

  /**
   * ``priceAtY(y, top, height, from, to)`` -> le prix sous le curseur, ou
   * ``null`` si une des mesures manque (hauteur nulle ou négative comprise :
   * un pane replié n'a pas d'échelle).
   *
   * Le ratio est BORNÉ à [0, 1] : un clic ramassé au bord (la marge du pane,
   * l'axe des temps) rend le prix du bord, jamais une extrapolation farfelue
   * hors de la plage affichée.
   */
  function priceAtY(y, top, height, from, to) {
    var yy = num(y);
    var topPx = num(top);
    var heightPx = num(height);
    var low = num(from);
    var high = num(to);
    if (yy === null || topPx === null || heightPx === null) { return null; }
    if (low === null || high === null) { return null; }
    if (heightPx <= 0) { return null; }

    var ratio = (yy - topPx) / heightPx;
    if (ratio < 0) { ratio = 0; }
    if (ratio > 1) { ratio = 1; }
    /* ratio 0 = haut du pane = ``to`` ; ratio 1 = bas du pane = ``from``. */
    return high - (ratio * (high - low));
  }

  /**
   * ``roundPrice(price)`` — arrondi d'affichage, calqué sur ``fmtPrice`` du
   * panneau : 2 décimales au-dessus de 100, 4 entre 1 et 100, 6 en dessous.
   * Le prix proposé dans la confirmation d'alerte est ainsi celui que Massii
   * LIT, pas un 78760.103129384 sorti d'une interpolation.
   */
  function roundPrice(price) {
    var value = num(price);
    if (value === null) { return null; }
    var abs = Math.abs(value);
    var digits = 2;
    if (abs < 1) { digits = 6; } else if (abs < 100) { digits = 4; }
    return Number(value.toFixed(digits));
  }

  /**
   * ``opForPrice(target, live)`` -> ``'above'`` ou ``'below'``.
   *
   * Un niveau AU-DESSUS du cours se surveille à la hausse, un niveau EN
   * DESSOUS à la baisse : c'est la seule des deux conditions que le serveur
   * accepte (``paper_router.paper_create_alert`` refuse en 400 une condition
   * DÉJÀ vraie, ``condition_met`` étant inclusive). Sans prix live, on ne
   * devine pas : ``'above'`` par défaut, et l'humain a les deux boutons.
   */
  function opForPrice(target, live) {
    var level = num(target);
    var current = num(live);
    if (level === null || current === null) { return 'above'; }
    return level >= current ? 'above' : 'below';
  }

  /**
   * ``wouldBeRefused(op, target, live)`` — le serveur refuserait-il cette
   * alerte parce que la condition est DÉJÀ vraie ? Miroir exact de
   * ``price_alerts.condition_met`` (franchissement inclusif). Sert à prévenir
   * AVANT l'appel plutôt qu'à afficher un 400 sec.
   */
  function wouldBeRefused(op, target, live) {
    var level = num(target);
    var current = num(live);
    if (level === null || current === null) { return false; }
    if (op === 'above') { return current >= level; }
    if (op === 'below') { return current <= level; }
    return false;
  }

  var api = {
    priceAtY: priceAtY,
    roundPrice: roundPrice,
    opForPrice: opForPrice,
    wouldBeRefused: wouldBeRefused
  };

  globalThis.OmenLib = globalThis.OmenLib || {};
  globalThis.OmenLib.price_axis = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})();
