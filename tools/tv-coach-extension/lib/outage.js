/**
 * lib/outage.js — la machine à états qui décide QUAND l'Omen est « injoignable »
 * (PURE : sans horloge, sans réseau, sans DOM — ``content.js`` fournit tout le
 * temps via ``now_ms``, exactement comme ``lib/idle.js``).
 *
 * Le problème qu'elle résout : l'auto-déploiement de l'Omen redémarre le
 * serveur à chaque push sur ``main`` (quelques secondes de trou), et le
 * premier appel raté pendant ce trou verrouillait le ticket et affichait
 * « Omen injoignable » jusqu'au prochain appel réussi (5 min plus tard, ou
 * 2 min pour le focus) — un simple redémarrage se lisait comme une panne.
 *
 * États :
 *   - ``ok``      : tout va bien, rien à l'écran ;
 *   - ``suspect``  : UN échec, encore invisible (peut n'être qu'un blip) ;
 *   - ``down``     : DEUX échecs consécutifs (ou plus) — vraie coupure, le
 *                    bandeau s'affiche.
 *
 * Un succès depuis N'IMPORTE QUEL état repart directement à ``ok`` : la
 * reprise est immédiate, jamais progressive.
 *
 * ``next_probe_at`` porte la date (ms) du prochain essai autorisé : le
 * premier depuis ``ok`` arrive vite (``PROBE_FIRST_MS``, ça pourrait n'être
 * qu'un blip), les suivants s'espacent (``PROBE_MS``, pour ne pas marteler un
 * serveur qui redémarre réellement). ``shouldProbe()`` n'est qu'un test de
 * date — c'est l'appelant (``content.js``) qui décide QUOI rejouer comme
 * sonde (la fiche, ``GET /brief``).
 */
(function () {
  'use strict';

  var PROBE_FIRST_MS = 6000;    /* ok -> suspect : premier ré-essai, vite (blip ?) */
  var PROBE_MS = 15000;         /* suspect/down -> ré-essai suivant, plus espacé */

  function num(value) {
    if (value === null || value === undefined || value === '') { return null; }
    var parsed = Number(value);
    return isFinite(parsed) ? parsed : null;
  }

  /** État initial : tout va bien, aucune sonde programmée. */
  function create() {
    return { status: 'ok', failures: 0, next_probe_at: null };
  }

  /** Normalise une entrée quelconque (absente, partielle, corrompue) en un
   *  état valide — jamais de throw sur un ``state.outage`` mal formé. */
  function clone(st) {
    var base = (st && typeof st === 'object') ? st : {};
    var status = (base.status === 'suspect' || base.status === 'down') ? base.status : 'ok';
    var failures = num(base.failures);
    return {
      status: status,
      failures: failures === null || failures < 0 ? 0 : failures,
      next_probe_at: num(base.next_probe_at)
    };
  }

  /**
   * Un appel a échoué à ``now_ms``. Rend un NOUVEL état (jamais de mutation
   * de ``st``) :
   *   ok      -> suspect (invisible), prochaine sonde dans PROBE_FIRST_MS ;
   *   suspect -> down (bandeau), prochaine sonde dans PROBE_MS ;
   *   down    -> down (inchangé), prochaine sonde repoussée de PROBE_MS.
   * Un ``now_ms`` illisible ne fait pas planter l'appelant : la transition de
   * statut a quand même lieu, seule ``next_probe_at`` reste ``null`` (aucune
   * sonde ne sera programmée tant qu'une date valable n'arrive pas).
   */
  function onFailure(st, now_ms) {
    var current = clone(st);
    var stamp = num(now_ms);
    var nextStatus = current.status === 'ok' ? 'suspect' : 'down';
    var delay = current.status === 'ok' ? PROBE_FIRST_MS : PROBE_MS;
    return {
      status: nextStatus,
      failures: current.failures + 1,
      next_probe_at: stamp === null ? null : (stamp + delay)
    };
  }

  /** Un appel a réussi : reprise immédiate, depuis n'importe quel état. */
  function onSuccess(st) {
    return create();
  }

  /** Vrai si la prochaine sonde est due (ou en retard). Jamais vrai sans date
   *  programmée : ``ok`` n'a rien à sonder. */
  function shouldProbe(st, now_ms) {
    var current = clone(st);
    var stamp = num(now_ms);
    if (current.next_probe_at === null || stamp === null) { return false; }
    return stamp >= current.next_probe_at;
  }

  var api = {
    create: create,
    onFailure: onFailure,
    onSuccess: onSuccess,
    shouldProbe: shouldProbe,
    PROBE_FIRST_MS: PROBE_FIRST_MS,
    PROBE_MS: PROBE_MS
  };

  globalThis.OmenLib = globalThis.OmenLib || {};
  globalThis.OmenLib.outage = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})();
